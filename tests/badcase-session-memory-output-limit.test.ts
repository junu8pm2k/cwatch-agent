import assert from 'node:assert/strict';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { id, type AgentSessionHooks, type CompetitorTask } from '@cwatch/core/types';
import { SessionMemoryPolicySchema } from '@cwatch/core/types/session-memory';
import { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { PiSessionMemory } from '@cwatch/shared/agent/backend/pi/session-memory';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { assertCompleteApiRounds } from '@cwatch/shared/agent/backend/pi/api-rounds';
import { ToolResultGovernor } from '@cwatch/shared/agent/backend/pi/tool-result-context';
import { PreferredWebSource } from '@cwatch/shared/sources/web';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import { check, store } from './harness.ts';

const usage = {
  input: 300,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 380,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const validState = (goal: string) => ({
  userGoal: goal,
  completedWork: ['Ran bigmodel.cn GLM searches'],
  keyFiles: ['plans/test-plan.json'],
  errorsAndFixes: [],
  unfinishedTasks: ['Fetch release pages'],
  nextSteps: ['Fetch https://docs.bigmodel.cn/cn/update/new-releases'],
  references: ['https://docs.bigmodel.cn/cn/update/new-releases'],
  sourceGaps: ['discovery_only'],
});

function buildRealisticWebSearchPayload(query: string, idx: number): string {
  const hits = Array.from({ length: 10 }, (_, j) => ({
    url: `https://docs.bigmodel.cn/cn/update/item-${idx}-${j}`,
    title: `GLM 发布记录 ${idx}-${j}`,
    snippet: `GLM-5.${j} 更新说明与详细基准测试内容 ` + '详情'.repeat(280),
    published_at: null,
    retrieved_at: '2026-11-21T08:07:51.657Z',
  }));
  const rawEnvelope = JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ query, results: hits }) }],
  });
  return JSON.stringify({
    status: 'success_with_data',
    signals: [],
    raw: rawEnvelope,
    provenance: 'live',
    backend: 'mcp.remote',
    searchResults: hits,
    rawTruncated: true,
    snapshot: { path: `retrievals/snap-${idx}.txt`, hash: `hash-${idx}` },
  });
}

/**
 * Badcase ID: bad-session-memory-output-limit-and-site-scope
 * Origin: .runtime/web/c5f82be8-80d5-437d-abac-96c4d8204a65 (2026-11-21)
 */
check('contract', 'Badcase bad-session-memory-output-limit-and-site-scope: structured RetrievalResult tool outputs are compacted for session memory instead of dumping 48KB escaped raw JSON', async () => {
  const data = store(), sessionId = id(), manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const redactor = new Redactor([]);
  const transcript = new SessionTranscript(data, sessionId, redactor);
  const policy = SessionMemoryPolicySchema.parse({ initializeTokens: 100, growthTokens: 50, toolCalls: 2, maxInputChars: 48_000 });
  const memory = new SessionMemoryStore(data, transcript, 'badcase-output-limit', policy, redactor);
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
  const { model } = await createPiRuntime('badcase-step5', 'fixture', { apiKey: 'key', baseUrl: 'http://127.0.0.1/unused' }, new AbortController().signal);
  const runtime = {
    completeSimple: async (_model: unknown, context: any) => {
      const chars = JSON.stringify(context).length;
      const input = JSON.parse(context.messages[0].content);
      requests.push({ chars, input });
      return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(validState('rev ' + requests.length)) }], usage, stopReason: 'stop' };
    },
  } as unknown as ModelRuntime;

  manager.appendMessage({ role: 'user', content: 'Collect GLM releases on bigmodel.cn', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running 4 web searches.' },
      { type: 'toolCall', id: 's1', name: 'web_search', arguments: { query: 'site:bigmodel.cn GLM 发布', limit: 10 } },
      { type: 'toolCall', id: 's2', name: 'web_search', arguments: { query: 'site:bigmodel.cn GLM release', limit: 10 } },
      { type: 'toolCall', id: 's3', name: 'web_search', arguments: { query: 'site:bigmodel.cn GLM-4.5', limit: 10 } },
      { type: 'toolCall', id: 's4', name: 'web_search', arguments: { query: 'site:bigmodel.cn GLM 开源', limit: 10 } },
    ],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now(),
  });
  let lastId = '';
  for (let i = 1; i <= 4; i++) {
    lastId = manager.appendMessage({
      role: 'toolResult',
      toolCallId: 's' + i,
      toolName: 'web_search',
      content: [{ type: 'text', text: buildRealisticWebSearchPayload(`site:bigmodel.cn GLM ${i}`, i) }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  // ToolResultGovernor caps each 22KB payload to a truncated HEAD snip first (exact run c5f82be8 behavior)
  assert.equal(governor.capResults(), true);
  flush();

  await updater.prepare(25_000, runtime, model, 4096, new AbortController().signal);
  assert.equal(requests.length, 1);
  // Compact retrieval digest shrinks 4x22KB (previously 47,995 chars) well below 12KB while retaining URLs & snapshot paths
  assert.ok(requests[0].chars < 12_000, `expected compacted retrieval memory input < 12000 chars, got ${requests[0].chars}`);
  const serialized = JSON.stringify(requests[0].input);
  assert.ok(serialized.includes('https://docs.bigmodel.cn/cn/update/item-1-0'));
  assert.ok(serialized.includes('retrievals/snap-4.txt'));
  assert.ok(!serialized.includes('详情详情详情详情详情详情详情详情详情详情'));
  assertCompleteApiRounds(requests[0].input.newMessages.map(m => m.message));

  // Verify original transcript entry remains intact
  const original = manager.getEntries().find(e => e.id === lastId);
  assert.ok(original && original.type === 'message' && original.message.role === 'toolResult');
  assert.ok(JSON.stringify(original.message).includes('详情详情详情详情'));

  // Verify microcompacted short stub is NOT re-expanded by retrieval digest
  assert.equal(governor.microcompactNext(), true);
  flush();
  const s1Id = manager.getEntries().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 's1')!.id;
  assert.ok(s1Id);
});

check('contract', 'Badcase bad-session-memory-output-limit-and-site-scope: attempt 2 recovery after output_limit aggressively shrinks bloated single-round tool payloads', async () => {
  const data = store(), sessionId = id(), manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const redactor = new Redactor([]);
  const transcript = new SessionTranscript(data, sessionId, redactor);
  const policy = SessionMemoryPolicySchema.parse({ initializeTokens: 100, growthTokens: 50, toolCalls: 2, maxInputChars: 48_000 });
  const memory = new SessionMemoryStore(data, transcript, 'badcase-recovery-shrink', policy, redactor);

  let sent = 0, headerSent = false;
  const requests: Array<{ chars: number; systemPrompt: string; input: { newMessages: Array<{ entryId: string; message: any }> } }> = [];
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
  const { model } = await createPiRuntime('badcase-step5', 'fixture', { apiKey: 'key', baseUrl: 'http://127.0.0.1/unused' }, new AbortController().signal);
  const runtime = {
    completeSimple: async (_model: unknown, context: any) => {
      const chars = JSON.stringify(context).length;
      const input = JSON.parse(context.messages[0].content);
      requests.push({ chars, systemPrompt: context.systemPrompt, input });
      if (requests.length === 1) {
        // Attempt 1 exhausts output limit in thinking (0 text chars)
        return { role: 'assistant', content: [{ type: 'thinking', thinking: 'long reasoning '.repeat(200) }], usage, stopReason: 'length' };
      }
      return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(validState('recovered compact state')) }], usage, stopReason: 'stop' };
    },
  } as unknown as ModelRuntime;

  // Single multi-tool round with 4 large non-JSON text tool results (~40KB total)
  manager.appendMessage({ role: 'user', content: 'Analyze large local documentation', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading 4 big files.' },
      { type: 'toolCall', id: 'f1', name: 'read', arguments: { path: 'a.md' } },
      { type: 'toolCall', id: 'f2', name: 'read', arguments: { path: 'b.md' } },
      { type: 'toolCall', id: 'f3', name: 'read', arguments: { path: 'c.md' } },
      { type: 'toolCall', id: 'f4', name: 'read', arguments: { path: 'd.md' } },
    ],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now(),
  });
  let lastId = '';
  for (let i = 1; i <= 4; i++) {
    lastId = manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'f' + i,
      toolName: 'read',
      content: [{ type: 'text', text: `DOC_${i}_START ` + 'L'.repeat(9_500) + ` DOC_${i}_END` }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  flush();

  await updater.prepare(20_000, runtime, model, 4096, new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].chars > 35_000, `attempt 1 should carry full round (${requests[0].chars} chars)`);
  // Attempt 2 recovery MUST dramatically shrink the input instead of resending the exact same ~40KB wall
  assert.ok(requests[1].chars <= 12_000, `attempt 2 recovery should shrink input <= 12000 chars, got ${requests[1].chars}`);
  assert.ok(requests[1].chars < requests[0].chars / 2, `attempt 2 (${requests[1].chars}) must be < half of attempt 1 (${requests[0].chars})`);
  assertCompleteApiRounds(requests[1].input.newMessages.map(m => m.message));
  const resultIds = requests[1].input.newMessages.filter(m => m.message.role === 'toolResult').map(m => m.message.toolCallId);
  assert.deepEqual(resultIds, ['f1', 'f2', 'f3', 'f4']);
  const saved = memory.load()!;
  assert.equal(saved.revision, 1);
  assert.equal(saved.lastMessageId, lastId);
  assert.equal(saved.pendingMessages, false);
});

check('contract', 'Badcase bad-session-memory-output-limit-and-site-scope: validateScope allows competitor configured domain site: queries while rejecting spoofed or unrelated queries', () => {
  const source = new PreferredWebSource({ slug: 'web', allowedDomains: ['bigmodel.cn'] });
  const zhipuTask: CompetitorTask = {
    taskId: 'web-badcase-scope',
    competitor: { id: 'target-mwq4krts', name: '智谱', aliases: [], domains: ['bigmodel.cn'] },
    product: 'GLM',
    signalTypes: ['release'],
    window: { start: '2025-05-01T00:00:00+08:00', end: '2026-11-01T00:00:00+08:00', basis: 'published_at', timezone: 'Asia/Shanghai' },
    allowedSources: ['web'],
    outputScope: 'draft',
  };

  // Exact query from failing run c5f82be8 + subdomain site: query MUST be allowed
  assert.equal(source.validateScope('web_search', { query: 'site:bigmodel.cn 更新日志 changelog' }, zhipuTask), undefined);
  assert.equal(source.validateScope('web_search', { query: 'site:docs.bigmodel.cn 更新日志' }, zhipuTask), undefined);
  assert.equal(source.validateScope('web_search', { query: 'site:bigmodel.cn GLM 发布' }, zhipuTask), undefined);

  // Spoofed lookalike domain and unrelated queries MUST remain blocked
  assert.equal(source.validateScope('web_search', { query: 'site:evilbigmodel.cn 更新日志 changelog' }, zhipuTask), 'web_query_outside_entity_scope');
  assert.equal(source.validateScope('web_search', { query: 'unrelated company changelog' }, zhipuTask), 'web_query_outside_entity_scope');

  // Open public domains (`['*']`) must NOT bypass entity scope for unrelated queries
  const openTask: CompetitorTask = { ...zhipuTask, competitor: { ...zhipuTask.competitor, domains: ['*'] } };
  assert.equal(source.validateScope('web_search', { query: 'unrelated company changelog' }, openTask), 'web_query_outside_entity_scope');
  assert.equal(source.validateScope('web_search', { query: '智谱 更新日志' }, openTask), undefined);

  // web_fetch tool description warns against http:// downgrade and repeating timed-out URLs
  const fetchDef = createWebToolDefinitions({ allowedDomains: ['bigmodel.cn'], urls: [] }).find(t => t.name === 'web_fetch')!;
  assert.match(fetchDef.description, /Only https:\/\/ URLs are permitted/);
  assert.match(fetchDef.description, /do not retry the same URL or downgrade to http:\/\//);
});

check('contract', 'Badcase bad-session-memory-output-limit-and-site-scope: Step-5 reasoning model gets 2048 attempt-1 memory output budget to avoid per-turn pendingMessages retry cascade', async () => {
  const data = store(), sessionId = id(), manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const redactor = new Redactor([]);
  const transcript = new SessionTranscript(data, sessionId, redactor);
  const policy = SessionMemoryPolicySchema.parse({ initializeTokens: 100, growthTokens: 50, toolCalls: 2, maxInputChars: 48_000 });
  const memory = new SessionMemoryStore(data, transcript, 'badcase-step5-cap', policy, redactor);
  let sent = 0, headerSent = false;
  const maxTokensSeen: number[] = [];
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
  const { model } = await createPiRuntime('stepfun', 'step-5-preview', { apiKey: 'key', baseUrl: 'https://api.stepfun.com/v1' }, new AbortController().signal);
  const runtime = {
    completeSimple: async (_model: unknown, _context: any, options: { maxTokens?: number }) => {
      maxTokensSeen.push(options.maxTokens ?? 0);
      return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(validState('step5 single-shot memory')) }], usage, stopReason: 'stop' };
    },
  } as unknown as ModelRuntime;

  manager.appendMessage({ role: 'user', content: 'Investigate GLM releases', timestamp: Date.now() });
  for (let r = 1; r <= 2; r++) {
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Round ' + r }, { type: 'toolCall', id: 'c' + r, name: 'web_search', arguments: { query: 'GLM ' + r, limit: 5 } }],
      api: 'openai-completions', provider: 'stepfun', model: 'step-5-preview', usage, stopReason: 'toolUse', timestamp: Date.now(),
    });
    manager.appendMessage({
      role: 'toolResult', toolCallId: 'c' + r, toolName: 'web_search',
      content: [{ type: 'text', text: '{"status":"success_empty","signals":[],"raw":"{}"}' }], isError: false, timestamp: Date.now(),
    });
  }
  flush();

  await updater.prepare(15_000, runtime, model, 4096, new AbortController().signal);
  assert.deepEqual(maxTokensSeen, [2048]);
  assert.equal(memory.load()?.pendingMessages, false);
});
