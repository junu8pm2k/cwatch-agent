import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { id, type AgentSessionHooks } from '@cwatch/core/types';
import { SessionMemoryPolicySchema } from '@cwatch/core/types/session-memory';
import { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { PiSessionMemory } from '@cwatch/shared/agent/backend/pi/session-memory';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { assertCompleteApiRounds } from '@cwatch/shared/agent/backend/pi/api-rounds';
import { ToolResultGovernor } from '@cwatch/shared/agent/backend/pi/tool-result-context';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { check, store } from './harness.ts';

const usage = {
  input: 200,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 240,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const validState = (goal: string) => ({
  userGoal: goal,
  completedWork: ['completed parallel web search round'],
  keyFiles: [],
  errorsAndFixes: [],
  unfinishedTasks: ['synthesize findings'],
  nextSteps: ['fetch top candidate pages'],
  references: ['https://zcode.z.ai/'],
  sourceGaps: [],
});

/**
 * Badcase ID: bad-session-memory-multicall-delta-too-large
 * Origin: .runtime/web/72192b1b-4157-4cb3-b66c-84377ecaecb0 (2026-11-21)
 *
 * Reproduces a real multi-call web_search round where 4 parallel tool calls return
 * >16KB each (snipped to 16KB by ToolResultGovernor, total >60KB JSON-escaped),
 * which previously threw `session_memory_delta_too_large` against the default 48KB
 * SessionMemoryPolicy.maxInputChars budget and aborted the entire run.
 */
check('contract', 'Badcase bad-session-memory-multicall-delta-too-large: 4 parallel 16KB tool results fit session memory without crashing or mutating transcript', async () => {
  const data = store(), sessionId = id(), manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const redactor = new Redactor([]);
  const transcript = new SessionTranscript(data, sessionId, redactor);
  // Default maxInputChars = 48_000; lower initialize/growth thresholds for deterministic trigger.
  const policy = SessionMemoryPolicySchema.parse({ initializeTokens: 100, growthTokens: 50, toolCalls: 2, maxInputChars: 48_000 });
  const memory = new SessionMemoryStore(data, transcript, 'badcase-multicall', policy, redactor);
  const governor = new ToolResultGovernor(manager, 150_000, { canRead: true, microcompactTools: ['web_search'] });

  let sent = 0, headerSent = false;
  const requests: Array<{ chars: number; input: { newMessages: Array<{ entryId: string; message: any }> } }> = [];
  const flush = () => {
    transcript.append([...(!headerSent ? [manager.getHeader()!] : []), ...manager.getEntries().slice(sent)].map(e => ({ ...e })));
    headerSent = true;
    sent = manager.getEntries().length;
  };
  const hooks: Pick<AgentSessionHooks, 'sessionMemory' | 'beforeRequest' | 'onUsage'> = {
    sessionMemory: req => memory.handle(req),
    beforeRequest: () => ({ maxOutputTokens: 4096 }),
    onUsage: () => {},
  };
  const archive = async (type: string, value: unknown) => { manager.appendCustomEntry(type, value); flush(); };
  const updater = new PiSessionMemory(manager, hooks, policy, 150_000, 32_000, archive);
  const { model } = await createPiRuntime('badcase-fixture', 'fixture', { apiKey: 'key', baseUrl: 'http://127.0.0.1/unused' }, new AbortController().signal);
  const runtime = {
    completeSimple: async (_model: unknown, context: any) => {
      const chars = JSON.stringify(context).length;
      const input = JSON.parse(context.messages[0].content);
      requests.push({ chars, input });
      return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(validState('memory rev ' + requests.length)) }], usage, stopReason: 'stop' };
    },
  } as unknown as ModelRuntime;

  // Round 1: initial user prompt + plan call (with large private thinking block)
  manager.appendMessage({ role: 'user', content: 'Investigate Zhipu ZCode pricing and releases', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'T'.repeat(7000) },
      { type: 'text', text: 'Saving plan.' },
      { type: 'toolCall', id: 'call-plan', name: 'workflow__save_plan', arguments: { taskId: 'badcase-multicall' } },
    ],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now(),
  });
  manager.appendMessage({
    role: 'toolResult', toolCallId: 'call-plan', toolName: 'workflow__save_plan',
    content: [{ type: 'text', text: '{"submitted":true}' }], details: { submitted: true }, isError: false, timestamp: Date.now(),
  });

  // Round 2: 4 parallel web_search calls returning 25KB each (same shape as failing run 72192b1b)
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'R'.repeat(5000) },
      { type: 'text', text: 'Running 4 parallel web searches.' },
      { type: 'toolCall', id: 'ws-1', name: 'web_search', arguments: { query: 'site:zcode.z.ai pricing', limit: 10 } },
      { type: 'toolCall', id: 'ws-2', name: 'web_search', arguments: { query: 'site:bigmodel.cn coding plan', limit: 10 } },
      { type: 'toolCall', id: 'ws-3', name: 'web_search', arguments: { query: 'site:open.bigmodel.cn pricing', limit: 10 } },
      { type: 'toolCall', id: 'ws-4', name: 'web_search', arguments: { query: 'site:z.ai Zcode release', limit: 10 } },
    ],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now(),
  });
  let lastResultId = '';
  for (let i = 1; i <= 4; i++) {
    const payload = `RESULT_${i}_HEAD ` + 'A'.repeat(24_000) + ` RESULT_${i}_TAIL`;
    lastResultId = manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'ws-' + i,
      toolName: 'web_search',
      content: [{ type: 'text', text: payload }],
      details: { raw: 'D'.repeat(20_000), index: i },
      isError: false,
      timestamp: Date.now(),
    });
  }

  // Apply host ToolResultGovernor capping (16KB per tool result) just like PiContextManager.prepare()
  assert.equal(governor.capResults(), true);
  flush();

  // First advance initializes memory on Round 1 (leaving Round 2 pending because R1+R2 > 48KB)
  await updater.prepare(15_000, runtime, model, 4096, new AbortController().signal);
  assert.equal(memory.load()?.pendingMessages, true);

  // Second advance MUST fit Round 2 (all 4 parallel tool results) instead of throwing session_memory_delta_too_large
  await updater.prepare(22_000, runtime, model, 4096, new AbortController().signal);
  const committed = memory.load()!;
  assert.equal(committed.revision, 2);
  assert.equal(committed.lastMessageId, lastResultId);
  assert.equal(committed.pendingMessages, false);
  assert.equal(committed.toolCallCount, 5);

  const secondReq = requests[1];
  assert.ok(secondReq.chars <= 48_000, `expected memory request <= 48000 chars, got ${secondReq.chars}`);
  assertCompleteApiRounds(secondReq.input.newMessages.map(item => item.message));
  // Verify private thinking and redundant details were stripped from memory input
  assert.ok(!JSON.stringify(secondReq.input).includes('RRRRRRRR'));
  assert.ok(!JSON.stringify(secondReq.input).includes('DDDDDDDD'));
  // Verify all 4 tool results remained paired with their toolCallIds
  const resultIds = secondReq.input.newMessages.filter(item => item.message.role === 'toolResult').map(item => item.message.toolCallId);
  assert.deepEqual(resultIds, ['ws-1', 'ws-2', 'ws-3', 'ws-4']);
  // Verify original transcript entry was NOT mutated
  const originalEntry = manager.getEntries().find(entry => entry.id === lastResultId);
  assert.ok(originalEntry && originalEntry.type === 'message' && originalEntry.message.role === 'toolResult');
  assert.ok(JSON.stringify(originalEntry.message).includes('RESULT_4_HEAD'));
  assert.ok(JSON.stringify(originalEntry.message).includes('RESULT_4_TAIL'));
});

check('contract', 'Badcase bad-session-memory-multicall-delta-too-large: RunService binds live web allowedDomains from user task/webDomains and rejects forbidden hosts', async () => {
  const data = store(), root = resolve(data.root, 'workspace');
  mkdirSync(resolve(root, 'examples'), { recursive: true });
  for (const name of ['task.json', 'task-web.json', 'task-adapters.json', 'sources.json', 'sources-web.json', 'sources-adapters.json']) {
    copyFileSync(resolve('examples', name), resolve(root, 'examples', name));
  }
  const captured: Array<{ slug: string; allowedDomains?: string[] }> = [];
  const service = new RunService({
    root,
    outputRoot: resolve(data.root, 'runs'),
    modelFactory: (_mode, _task, configs) => {
      captured.push(...configs.map(c => ({ slug: c.slug, allowedDomains: c.allowedDomains })));
      return new ReplayModel([{ kind: 'respond', text: 'ok' }]);
    },
  });
  try {
    // 1. Generic agent exposes `web` source and accepts live webDomains
    const agentProfile = service.profiles().find(p => p.id === 'agent')!;
    assert.ok(agentProfile.sources.some(s => s.slug === 'web'));
    const run = service.start({
      profile: 'agent',
      mode: 'live',
      permission: 'explore',
      task: { kind: 'agent', taskId: 'badcase-web-agent', instruction: '查询智谱 Coding Plan 价格', allowedSources: ['web'] },
      webDomains: ['bigmodel.cn', 'zcode.z.ai'],
    });
    await service.wait(run.id);
    assert.deepEqual(captured.find(c => c.slug === 'web')?.allowedDomains, ['bigmodel.cn', 'zcode.z.ai']);

    // 2. Investigation web profile also binds task.competitor.domains to live web allowedDomains
    const invTemplate = service.profiles().find(p => p.id === 'web')!.task;
    assert.ok(!('kind' in invTemplate));
    const invRun = service.start({
      profile: 'web',
      mode: 'live',
      permission: 'explore',
      task: {
        ...invTemplate,
        taskId: 'badcase-web-inv',
        competitor: { id: 'zhipu', name: '智谱', aliases: [], domains: ['zcode.z.ai', 'open.bigmodel.cn'] },
        product: 'Zcode',
      },
    });
    await service.wait(invRun.id);
    assert.deepEqual(captured.at(-1)?.allowedDomains, ['zcode.z.ai', 'open.bigmodel.cn']);

    // 3. Forbidden hosts (api.github.com, localhost) remain strictly blocked
    assert.throws(() => service.start({
      profile: 'agent',
      mode: 'live',
      permission: 'explore',
      task: { kind: 'agent', taskId: 'badcase-github-block', instruction: 'check github api', allowedSources: ['web'] },
      webDomains: ['api.github.com'],
    }), /github_api_disabled|web_scope/);
    assert.throws(() => service.start({
      profile: 'agent',
      mode: 'live',
      permission: 'explore',
      task: { kind: 'agent', taskId: 'badcase-local-block', instruction: 'check local', allowedSources: ['web'] },
      webDomains: ['localhost'],
    }), /web_scope/);
  } finally {
    await service.close();
  }
});
