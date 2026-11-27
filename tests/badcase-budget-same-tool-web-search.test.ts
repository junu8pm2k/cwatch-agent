import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RetrievalSchema, type AgentState, type CompetitorTask, type Decision, type ModelPort } from '@cwatch/core/types';
import { DEFAULT_LIMITS, resolveLimits } from '@cwatch/shared/agent/core/budgets';
import { ContextPipeline, buildCacheableContextParts } from '@cwatch/shared/agent/core/prompt-builder';
import { ActionPolicy } from '@cwatch/shared/agent/core/permission-manager';
import { PiModel, ReplayModel } from '@cwatch/shared/agent/models';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { SourceConfigsSchema } from '@cwatch/shared/sources/server-builder';
import { readSearchMcp } from '@cwatch/shared/sources/web-mcp';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import { PiBuiltinSource } from '@cwatch/shared/tools/pi-builtins';
import { ToolExecutor } from '@cwatch/shared/tools/executor';
import { ApprovalManager } from '@cwatch/shared/agent/core/permission-manager';
import { Trace } from '@cwatch/shared/sessions/trace';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ToolResultGovernor, projectSessionEntries } from '@cwatch/shared/agent/backend/pi/tool-result-context';
import { PiSessionMemory } from '@cwatch/shared/agent/backend/pi/session-memory';
import { SessionMemoryPolicySchema } from '@cwatch/core/types/session-memory';
import { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { runInvestigation } from '@cwatch/server-core/runtime/investigation';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { WorkingStateTracker } from '@cwatch/server-core/runtime/working-state';
import { check, CountingClient, fixture, json, store, task } from './harness.ts';

const live = new AbortController().signal;

check('contract', 'examples/sources-web.json configures searchMcp.requestTimeoutMs=60000 for slow remote web_fetch backends', () => {
  const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync(resolve('examples/sources-web.json'), 'utf8')));
  const web = configs.find(item => item.slug === 'web');
  assert.ok(web && web.kind === 'web' && web.searchMcp && web.searchMcp.type !== 'api');
  assert.equal(web.searchMcp.requestTimeoutMs, 60000);
  const resolved = readSearchMcp(web.searchMcp, { SEARCH_MCP_URL: 'https://search.example/mcp', SEARCH_MCP_TOKEN: 'tok' });
  assert.equal(resolved?.url, 'https://search.example/mcp');
  assert.equal(resolved?.requestTimeoutMs, 60000);
});

check('contract', 'Default and RunService tool budgets scale with depth tiers and reject unsafe overrides', async () => {
  const defaults = resolveLimits();
  assert.equal(defaults.maxSteps, DEFAULT_LIMITS.maxSteps);
  assert.equal(defaults.maxSameToolCalls, defaults.maxToolCalls);
  assert.equal(defaults.maxToolCalls, 128);
  assert.equal(defaults.maxConsecutiveToolFailures, 4);

  const data = store();
  const service = new RunService({
    root: process.cwd(),
    outputRoot: resolve(data.root, 'runs'),
    modelFactory: () => new ReplayModel([{ kind: 'respond', text: 'done' }]),
  });
  try {
    // Reject unsafe bounds on the new step/tool limit fields before creating a run.
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxSameToolCalls: 0 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxSameToolCalls: 481 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxToolCalls: 481 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxSteps: 181 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxConsecutiveToolFailures: 21 } }));

    const runLimits = async (limits?: Parameters<RunService['start']>[0]['limits']) => {
      const started = service.start({ profile: 'agent', mode: 'replay', permission: 'explore', ...(limits ? { limits } : {}) });
      const finished = await service.wait(started.id);
      const events = new FileStore(resolve(data.root, 'runs', started.id)).lines<TraceEvent>('traces/' + finished.traceRunId + '.jsonl');
      assert.deepEqual(validateTrace(events), []);
      const startedEvent = events.find(e => e.type === 'run_started')!;
      return startedEvent.data.limits as Record<string, number>;
    };

    const standard = await runLimits();
    assert.equal(standard.maxSteps, 72);
    assert.equal(standard.maxToolCalls, 160);
    assert.equal(standard.maxSameToolCalls, 160);
    assert.equal(standard.timeoutMs, 0);
    assert.equal(standard.toolTimeoutMs, 120_000);
    assert.equal(standard.maxTokens, 750_000);

    const fast = await runLimits({ toolTimeoutMs: 75_000, maxTokens: 250_000 });
    assert.equal(fast.timeoutMs, 0);
    assert.equal(fast.toolTimeoutMs, 75_000);
    assert.equal(fast.maxSteps, 40);
    assert.equal(fast.maxToolCalls, 80);
    assert.equal(fast.maxSameToolCalls, 80);

    const deep = await runLimits({ maxTokens: 1_500_000 });
    assert.equal(deep.maxSteps, 120);
    assert.equal(deep.maxToolCalls, 300);
    assert.equal(deep.maxSameToolCalls, 300);

    const explicit = await runLimits({ timeoutMs: 300_000, maxTokens: 400_000, maxSteps: 50, maxToolCalls: 60, maxSameToolCalls: 22, maxConsecutiveToolFailures: 6 });
    assert.equal(explicit.timeoutMs, 300_000);
    assert.equal(explicit.maxSteps, 50);
    assert.equal(explicit.maxToolCalls, 60);
    assert.equal(explicit.maxSameToolCalls, 22);
    assert.equal(explicit.maxConsecutiveToolFailures, 6);

    // Competitor investigation runs in RunService must not expose local workspace builtin tools (ls/find/grep/read), while generic agent runs keep them.
    const agentStarted = service.start({ profile: 'agent', mode: 'replay', permission: 'explore' });
    const agentDone = await service.wait(agentStarted.id);
    const agentEvents = new FileStore(resolve(data.root, 'runs', agentStarted.id)).lines<TraceEvent>('traces/' + agentDone.traceRunId + '.jsonl');
    const agentTools = (agentEvents.find(e => e.type === 'context_prepared')!.data.tools as Array<{ proxyName: string }>).map(t => t.proxyName);
    assert.ok(agentTools.includes('read') && agentTools.includes('ls') && agentTools.includes('find'));

    const invStarted = service.start({ profile: 'standard', mode: 'replay', permission: 'explore' });
    const invDone = await service.wait(invStarted.id);
    const invEvents = new FileStore(resolve(data.root, 'runs', invStarted.id)).lines<TraceEvent>('traces/' + invDone.traceRunId + '.jsonl');
    const invTools = (invEvents.find(e => e.type === 'context_prepared')!.data.tools as Array<{ proxyName: string }>).map(t => t.proxyName);
    for (const localTool of ['read', 'ls', 'find', 'grep', 'write', 'edit', 'bash']) {
      assert.equal(invTools.includes(localTool), false);
    }
  } finally {
    await service.close();
  }
});

check('contract', 'Prompt budget disclosure keeps prefixHash and stable prompt cache invariant, and WorkingStateTracker retains budgets', async () => {
  const registry = new ToolRegistry(), data = store();
  const t: CompetitorTask = { ...task(), allowedSources: ['official'] };
  await registry.register('official', 'mcp', new CountingClient(), live);
  try {
    const state: AgentState = { task: t, observations: [], decisions: [], iteration: 0 };
    const pipeline = new ContextPipeline('static-skill'), policy = new ActionPolicy('explore');
    const limits = { maxSteps: 40, maxToolCalls: 48, maxSameToolCalls: 16 };
    const first = pipeline.prepareTurn(state, registry, policy, 150_000, true, limits);
    const prefix = buildCacheableContextParts(state, 'static-skill').join('\n\n');
    assert.ok(first.stable.startsWith(prefix));
    assert.match(first.stable, /RUN BUDGETS: steps=40, tools=48, sameTool=16/);

    state.observations.push({ name: 'mcp__official__search_news', result: { status: 'success_empty' } });
    state.iteration++;
    const next = pipeline.prepareTurn(state, registry, policy, 150_000, true, limits);
    assert.equal(next.stable, first.stable);
    assert.equal(next.prefixHash, first.prefixHash);

    const tracker = new WorkingStateTracker();
    const attachments = tracker.attachments({
      task: t, runId: 'budget-snapshot-run', state, store: data, registry, permissionMode: 'explore', visibleTools: registry.list(),
      budgets: { steps: 5, maxSteps: 40, toolCalls: 12, maxToolCalls: 48, maxSameToolCalls: 16, callsByTool: { web_search: 8, web_fetch: 3 }, tokensUsed: 120_000, maxTokens: 400_000 },
    });
    const status = JSON.parse(attachments.find(item => item.name === 'Execution and agent status')!.content);
    assert.equal(status.budgets.steps, '5/40');
    assert.equal(status.budgets.tools, '12/48');
    assert.equal(status.budgets.sameToolCap, 16);
    assert.equal(status.budgets.byTool.web_search, 8);
    assert.equal(status.budgets.tokens, '120000/400000');

    const webDefs = createWebToolDefinitions({ allowedDomains: ['bigmodel.cn'], urls: [] });
    assert.match(webDefs.find(d => d.name === 'web_search')!.description, /budgets/i);
    assert.match(webDefs.find(d => d.name === 'web_fetch')!.description, /systematically unavailable/i);
  } finally {
    await registry.close();
  }
});

interface ScriptedPiStep {
  decision: Decision;
}

async function startBudgetPiProvider(steps: Array<ScriptedPiStep | ((request: any, turn: number) => Decision)>) {
  let turn = 0;
  const requests: any[] = [];
  const errors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(request);
      const entry = steps[turn++];
      if (!entry) throw new Error('unexpected_turn:' + turn);
      const step = structuredClone(typeof entry === 'function' ? entry(request, turn) : entry.decision);
      if (step.kind === 'call_tool' && step.name === 'workflow__draft') {
        const analyzeCall = request.messages
          .flatMap((m: { tool_calls?: Array<{ id: string; function: { name: string } }> }) => m.tool_calls ?? [])
          .find((call: { function: { name: string } }) => call.function.name === 'workflow__analyze');
        const analyzeObs = request.messages.find((m: { role: string; tool_call_id?: string }) => m.role === 'tool' && m.tool_call_id === analyzeCall?.id);
        if (analyzeObs) step.args.claimIds = JSON.parse(analyzeObs.content).claims.map((c: { id: string }) => c.id);
      }
      const calls = step.kind === 'respond' ? [] : step.kind === 'call_tools' ? step.calls : [step];
      const delta = step.kind === 'respond'
        ? { role: 'assistant', content: step.text }
        : {
          role: 'assistant',
          tool_calls: calls.map((call, index) => ({
            index,
            id: 'sdkToolCallId' in call ? call.sdkToolCallId : `budget-call-${turn}-${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        };
      const chunk = { id: 'budget-resp-' + turn, object: 'chat.completion.chunk', created: 1, model: 'budget-fixture', choices: [{ index: 0, delta, finish_reason: null }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step.kind === 'respond' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end('fixture provider failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('invalid_address');
  return {
    model: () => PiModel.fromEnvironment({ MODEL_PROVIDER: 'budget-fixture-provider', MODEL_ID: 'budget-fixture', API_KEY: 'fixture-key', BASE_URL: `http://127.0.0.1:${address.port}/v1` }),
    requests,
    errors,
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); },
  };
}

function webTestSource() {
  let searches = 0;
  return {
    client: {
      listTools: async () => createWebToolDefinitions({ allowedDomains: ['nodejs.org'], urls: [] }),
      callTool: async (name: string) => {
        if (name === 'web_search') {
          searches++;
          return {
            status: 'success_with_data' as const,
            signals: [],
            raw: JSON.stringify({ queryIndex: searches }),
            provenance: 'fixture' as const,
            backend: 'mcp.remote',
            searchResults: [{ url: 'https://nodejs.org/en/blog/release/v24.0.0', title: 'Release ' + searches, snippet: 'Snippet ' + searches, published_at: null, retrieved_at: '2025-05-12T10:00:00Z' }],
          };
        }
        const data = fixture();
        data.signals.forEach(s => { s.sourceSlug = 'web'; });
        return data;
      },
      close: async () => {},
    },
    searches: () => searches,
  };
}

check('integration', 'Pi session surfaces _hostBudgetNotice cleanly without polluting observations and deactivates exhausted web_search so investigation finishes', async () => {
  const data = store(), registry = new ToolRegistry(), web = webTestSource();
  const t: CompetitorTask = { ...task(), allowedSources: ['web'] };
  await registry.register('web', 'builtin', web.client, live);
  const initialPlan = json<Decision[]>('fixtures/model-script.json')[0] as Extract<Decision, { kind: 'call_tool' }>;
  const planDecision: Decision = { ...initialPlan, args: { ...initialPlan.args, taskId: t.taskId, sources: ['web'] } };

  const provider = await startBudgetPiProvider([
    // Turn 1: Save plan
    { decision: planDecision },
    // Turn 2: 2 web_search calls -> 2/4 used (2 remaining -> triggers _hostBudgetNotice on tool results)
    {
      decision: {
        kind: 'call_tools',
        calls: [
          { sdkToolCallId: 's1', name: 'web_search', args: { query: 'Node.js release 1', limit: 5 } },
          { sdkToolCallId: 's2', name: 'web_search', args: { query: 'Node.js release 2', limit: 5 } },
        ],
      },
    },
    // Turn 3: 2 more web_search calls -> 4/4 used (0 remaining -> web_search deactivated on Turn 4)
    {
      decision: {
        kind: 'call_tools',
        calls: [
          { sdkToolCallId: 's3', name: 'web_search', args: { query: 'Node.js release 3', limit: 5 } },
          { sdkToolCallId: 's4', name: 'web_search', args: { query: 'Node.js release 4', limit: 5 } },
        ],
      },
    },
    // Turn 4: Proceed with web_fetch (web_search must no longer be in active tools!)
    { decision: { kind: 'call_tool', name: 'web_fetch', args: { url: 'https://nodejs.org/en/blog/release/v24.0.0' } } },
    // Turn 5-8: analyze -> review -> draft -> respond
    { decision: { kind: 'call_tool', name: 'workflow__analyze', args: {} } },
    { decision: { kind: 'call_tool', name: 'workflow__review', args: {} } },
    { decision: { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Completed within per-tool budget without crashing.', claimIds: [] } } },
    { decision: { kind: 'respond', text: 'Investigation finished cleanly.' } },
  ]);

  try {
    const result = await runInvestigation(t, provider.model(), registry, data, 'live', {
      builtinTools: false,
      sessionMemory: false,
      maxSteps: 12,
      maxToolCalls: 16,
      maxSameToolCalls: 4,
    });
    assert.equal(result.status, 'partial', result.error);
    assert.ok(result.report);
    assert.deepEqual(provider.errors, []);
    assert.equal(web.searches(), 4);

    // Static RUN BUDGETS disclosed in system prompt from Turn 1.
    const systemPrompt = String(provider.requests[0].messages[0].content);
    assert.match(systemPrompt, /RUN BUDGETS: steps=12, tools=16, sameTool=4/);

    // Turn 3 sees _hostBudgetNotice in s2 tool result (2/4 used, 2 remaining) as valid JSON.
    const s2Msg = provider.requests[2].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 's2');
    assert.ok(s2Msg);
    const s2Parsed = JSON.parse(s2Msg.content);
    assert.match(s2Parsed._hostBudgetNotice, /web_search: 2\/4 used \(2 remaining\)/);

    // Turn 4 sees exhausted _hostBudgetNotice in s4 AND web_search is deactivated from request.tools while web_fetch/workflow tools stay active.
    const s4Msg = provider.requests[3].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 's4');
    assert.ok(s4Msg);
    const s4Parsed = JSON.parse(s4Msg.content);
    assert.match(s4Parsed._hostBudgetNotice, /web_search: 4\/4 used \(0 remaining\)/);
    assert.match(s4Parsed._hostBudgetNotice, /Do NOT call web_search again/);

    const turn3Tools = (provider.requests[2].tools ?? []).map((tool: any) => tool.function.name);
    const turn4Tools = (provider.requests[3].tools ?? []).map((tool: any) => tool.function.name);
    assert.ok(turn3Tools.includes('web_search'));
    assert.ok(!turn4Tools.includes('web_search'));
    assert.ok(turn4Tools.includes('web_fetch'));
    assert.ok(turn4Tools.includes('workflow__analyze'));
    assert.ok(turn4Tools.includes('workflow__review'));
    assert.ok(turn4Tools.includes('workflow__draft'));

    // Host state.observations remain pure RetrievalSchema objects without _hostBudgetNotice pollution.
    const savedState = data.read<AgentState>('states/' + result.runId + '.json', null!);
    const searchObs = savedState.observations.filter(o => o.name === 'web_search');
    assert.equal(searchObs.length, 4);
    for (const obs of searchObs) {
      assert.equal('_hostBudgetNotice' in (obs.result as Record<string, unknown>), false);
      assert.equal(RetrievalSchema.safeParse(obs.result).success, true);
    }

    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.deepEqual(validateTrace(events), []);
  } finally {
    await provider.close();
    await registry.close();
  }
});

check('integration', 'Pi skips web_search above an explicit cap within a batch and after deactivation', async () => {
  const data = store(), registry = new ToolRegistry(), web = webTestSource();
  const t: CompetitorTask = { ...task(), allowedSources: ['web'] };
  await registry.register('web', 'builtin', web.client, live);
  const initialPlan = json<Decision[]>('fixtures/model-script.json')[0] as Extract<Decision, { kind: 'call_tool' }>;
  const planDecision: Decision = { ...initialPlan, args: { ...initialPlan.args, taskId: t.taskId, sources: ['web'] } };

  const provider = await startBudgetPiProvider([
    { decision: planDecision },
    {
      decision: {
        kind: 'call_tools',
        calls: [
          { sdkToolCallId: 'x1', name: 'web_search', args: { query: 'Node.js 1', limit: 5 } },
          { sdkToolCallId: 'x2', name: 'web_search', args: { query: 'Node.js 2', limit: 5 } },
          { sdkToolCallId: 'x3', name: 'web_search', args: { query: 'Node.js 3', limit: 5 } },
        ],
      },
    },
    { decision: { kind: 'call_tool', name: 'web_search', args: { query: 'Node.js 4', limit: 5 } } },
    { decision: { kind: 'call_tool', name: 'workflow__analyze', args: {} } },
    { decision: { kind: 'call_tool', name: 'workflow__review', args: {} } },
    { decision: { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Summarized the available search results.', claimIds: [] } } },
    { decision: { kind: 'respond', text: 'Draft saved.' } },
  ]);

  try {
    const result = await runInvestigation(t, provider.model(), registry, data, 'live', {
      builtinTools: false,
      sessionMemory: false,
      maxSteps: 10,
      maxToolCalls: 16,
      maxSameToolCalls: 2,
    });
    assert.equal(result.status, 'partial', result.error);
    assert.ok(result.report);
    assert.deepEqual(provider.errors, []);
    assert.equal(web.searches(), 2);
    assert.ok(provider.requests[2].tools.every((tool: any) => tool.function.name !== 'web_search'));
    assert.match(JSON.stringify(provider.requests[3].messages), /tool_budget_skipped/);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.deepEqual(validateTrace(events), []);
    assert.equal(events.filter(e => e.type === 'budget_exceeded' && e.data.budget === 'same_tool' && e.data.tool === 'web_search').length, 2);
  } finally {
    await provider.close();
    await registry.close();
  }
});

check('contract', 'PiBuiltinSource resolves read-only retrievals/<hash>.txt from store.root while blocking writes, and workflow__extract_signal corroborates same-URL date quotes', async () => {
  const workspace = store(), audit = store(), registry = new ToolRegistry(), t: CompetitorTask = { ...task(), allowedSources: ['web'] };
  const snapRel = 'retrievals/0e2caa7352a1c11bb954328445a615828fc5aac127ee56c0d8143cb3dd5409b0.txt';
  audit.text(snapRel, '2026-08-26\nGLM-5.3-Flash 原生多模态模型上线\n2026-08-19\nGLM-5.3 新一代旗舰模型上线\n');
  const builtins = new PiBuiltinSource(workspace.root, [audit.root]);
  const trace = new Trace(audit, t.taskId, 'store-read-run');
  trace.emit('run_started', { task: t });
  await registry.register('pi', 'builtin', builtins, live);
  try {
    const executor = new ToolExecutor(registry, new ActionPolicy('allow-all'), new ApprovalManager(async () => true), audit, trace, t, 10_000);
    // Read-only access to retrievals/<hash>.txt resolves cleanly to audit.root/retrievals/<hash>.txt instead of throwing Path not found in workspace.root.
    assert.equal(builtins.validateScope('read', { path: snapRel }), undefined);
    assert.equal(builtins.validateScope('grep', { path: snapRel, pattern: '2026-08-26' }), undefined);
    const readRes = await executor.execute('read', { path: snapRel }, live) as { content: Array<{ type: string; text: string }> };
    assert.match(readRes.content.map(c => c.text).join('\n'), /GLM-5\.3-Flash 原生多模态模型上线/);
    // Writes to retrievals/<hash>.txt or non-whitelisted store paths remain blocked.
    assert.equal(builtins.validateScope('write', { path: snapRel, content: 'forged' }), 'builtin_protected_path');
    await assert.rejects(executor.execute('write', { path: snapRel, content: 'forged' }, live), /builtin_protected_path/);
  } finally {
    await registry.close();
  }

  // Test same-URL date-corroborated quote extraction when web_fetch markdown stripped date headers that web_search preserved for the exact same URL.
  const runData = store(), runReg = new ToolRegistry();
  const changelogUrl = 'https://docs.bigmodel.cn/cn/update/new-releases';
  const zhipuTask: CompetitorTask = {
    ...task(),
    competitor: { id: 'zhipu', name: '智谱', aliases: [], domains: ['bigmodel.cn'] },
    product: 'GLM',
    allowedSources: ['web'],
  };
  await runReg.register('web', 'builtin', {
    listTools: async () => createWebToolDefinitions({ allowedDomains: ['bigmodel.cn'], urls: [] }),
    callTool: async (name: string) => {
      if (name === 'web_search') {
        const raw = JSON.stringify({ url: changelogUrl, snippet: '2026-08-26\nGLM-5.3-Flash 原生多模态模型上线\n原生融入视觉能力' });
        return {
          status: 'success_with_data' as const,
          signals: [],
          raw,
          provenance: 'live' as const,
          backend: 'mcp.remote',
          searchResults: [{ url: changelogUrl, title: '模型与产品发布记录', snippet: '2026-08-26\nGLM-5.3-Flash 原生多模态模型上线\n原生融入视觉能力', published_at: null, retrieved_at: '2026-11-22T06:00:34Z' }],
        };
      }
      const pageBody = '## 公告通知\n\nGLM-5.3-Flash 原生多模态模型上线\n\n原生融入视觉能力，使模型能够主动观察界面。';
      return {
        status: 'success_with_data' as const,
        signals: [],
        raw: JSON.stringify({ page: { url: changelogUrl, markdown: pageBody } }),
        provenance: 'live' as const,
        backend: 'mcp.remote',
        pages: [{ url: changelogUrl, title: '模型与产品发布记录', text: pageBody, published_at: null, retrieved_at: '2026-11-22T06:01:29Z', truncated: false }],
      };
    },
    close: async () => {},
  }, live);
  try {
    const initialPlan = json<Decision[]>('fixtures/model-script.json')[0] as Extract<Decision, { kind: 'call_tool' }>;
    const planStep: Decision = { ...initialPlan, args: { ...initialPlan.args, taskId: zhipuTask.taskId, sources: ['web'] } };
    let cursor = 0;
    const steps: Decision[] = [
      planStep,
      { kind: 'call_tool', name: 'web_search', args: { query: 'site:bigmodel.cn GLM 发布', limit: 5 } },
      { kind: 'call_tool', name: 'web_fetch', args: { url: changelogUrl } },
      {
        kind: 'call_tool',
        name: 'workflow__extract_signal',
        args: {
          url: changelogUrl,
          signalType: 'release',
          eventKey: 'release:glm-5.3-flash',
          title: 'GLM-5.3-Flash 原生多模态模型上线',
          value: '原生多模态模型上线',
          quote: '2026-08-26 GLM-5.3-Flash 原生多模态模型上线',
          publishedAt: '2026-08-26T00:00:00+08:00',
        },
      },
      { kind: 'call_tool', name: 'workflow__analyze', args: {} },
      { kind: 'call_tool', name: 'workflow__review', args: {} },
      { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Verified GLM-5.3-Flash release.', claimIds: [] } },
      { kind: 'respond', text: 'Done.' },
    ];
    const model: ModelPort = {
      async decide(input) {
        const step = structuredClone(steps[cursor++]);
        if (step.kind === 'call_tool' && step.name === 'workflow__draft') {
          const latest = [...input.state.observations].reverse().find(o => o.name === 'workflow__analyze')?.result as { claims?: Array<{ id: string }> } | undefined;
          step.args.claimIds = latest?.claims?.map(c => c.id) ?? [];
        }
        return step;
      },
    };
    const res = await runInvestigation(zhipuTask, model, runReg, runData, 'replay');
    assert.ok(['complete', 'partial'].includes(res.status), res.error);
    const saved = runData.read<AgentState>('states/' + res.runId + '.json', null!);
    const ext = saved.observations.find(o => o.name === 'workflow__extract_signal')?.result as Record<string, unknown>;
    assert.equal(ext.extracted, true);
    assert.equal(ext.attribution, 'matched');
    assert.equal(ext.timeStatus, 'in_window');
  } finally {
    await runReg.close();
  }
});

check('contract', 'ToolResultGovernor strips large details without adding fake [...snipped...] to <=16KB content, and PiSessionMemory compacts readback pages with 6144 incremental step-5 budget', async () => {
  const manager = SessionManager.inMemory(process.cwd(), { id: 'no-false-snip' });
  manager.appendMessage({ role: 'user', content: 'Investigate GLM releases', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: 'https://docs.bigmodel.cn/cn/update/new-releases' } }],
    api: 'openai-completions', provider: 'stepfun', model: 'step-5-preview',
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: Date.now(),
  });
  const cleanContent = JSON.stringify({
    status: 'success_with_data',
    signals: [],
    provenance: 'live',
    pages: [{ url: 'https://docs.bigmodel.cn/cn/update/new-releases', title: '模型与产品发布记录', text: 'GLM-5.3-Flash 原生多模态模型上线\n'.repeat(240), published_at: null, retrieved_at: '2026-11-22T08:08:49Z', truncated: false }],
  });
  assert.ok(cleanContent.length > 6_000 && cleanContent.length < 12_000);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'fetch-1',
    toolName: 'web_fetch',
    content: [{ type: 'text', text: cleanContent }],
    details: { status: 'success_with_data', raw: 'R'.repeat(16_000), pages: [{ text: 'P'.repeat(7_500) }] },
    isError: false,
    timestamp: Date.now(),
  } as any);

  const governor = new ToolResultGovernor(manager, 150_000, { canRead: true, microcompactTools: ['web_fetch'] });
  const changed = governor.capResults();
  assert.equal(changed, true);
  const projected = projectSessionEntries(manager, manager.getEntries());
  const toolMsg = projected.find(m => m.role === 'toolResult')!;
  assert.equal('details' in toolMsg, false);
  const projectedText = toolMsg.content.map(c => c.type === 'text' ? c.text : '').join('\n');
  assert.equal(projectedText, cleanContent);
  assert.equal(projectedText.includes('[...snipped...]'), false);
  assert.equal(projectedText.includes('Archived tool result (snip)'), false);

  // Verify PiSessionMemory compacts session__read_tool_result payloads and grants 4096/6144 maxTokens on step-5 updates.
  const data = store(), sessionId = 'step5-incremental-mem', memManager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const redactor = new Redactor([]);
  const transcript = new SessionTranscript(data, sessionId, redactor);
  const policy = SessionMemoryPolicySchema.parse({ initializeTokens: 100, growthTokens: 50, toolCalls: 1, maxInputChars: 48_000 });
  const memStore = new SessionMemoryStore(data, transcript, 'step5-inc-task', policy, redactor);
  let sent = 0, headerSent = false;
  const flush = () => {
    const entries = memManager.getEntries();
    const pending = [...(!headerSent ? [memManager.getHeader()!] : []), ...entries.slice(sent)];
    if (pending.length) { transcript.append(pending.map(e => ({ ...e }))); headerSent = true; sent = entries.length; }
  };
  const maxTokensSeen: number[] = [];
  const inputsSeen: any[] = [];
  const step5Model = {
    id: 'step-5-preview', name: 'step-5-preview', api: 'openai-completions', provider: 'stepfun',
    baseUrl: 'https://api.stepfun.com/v1', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 64_000,
  } as any;
  const validMem = {
    userGoal: 'Collect GLM releases',
    completedWork: Array.from({ length: 8 }, (_, i) => `Work item ${i}`),
    keyFiles: ['plans/p1.json'],
    errorsAndFixes: [],
    unfinishedTasks: ['Extract signals'],
    nextSteps: ['Call workflow__extract_signal'],
    references: Array.from({ length: 8 }, (_, i) => `https://docs.bigmodel.cn/ref-${i}`),
    sourceGaps: ['discovery_only'],
  };
  const runtime = {
    completeSimple: async (_m: unknown, context: any, options: { maxTokens?: number }) => {
      maxTokensSeen.push(options.maxTokens ?? 0);
      inputsSeen.push(JSON.parse(context.messages[0].content));
      return {
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(validMem) }],
        usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
      };
    },
  } as unknown as ModelRuntime;
  const updater = new PiSessionMemory(memManager, {
    sessionMemory: req => memStore.handle(req),
    beforeRequest: () => ({ maxOutputTokens: 12_288 }),
    onUsage: () => {},
  }, policy, 150_000, 32_000, async (customType, entryData) => {
    memManager.appendCustomEntry(customType, entryData);
    flush();
  });

  memManager.appendMessage({ role: 'user', content: 'Task', timestamp: Date.now() });
  memManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'workflow__save_plan', arguments: {} }],
    api: 'openai-completions', provider: 'stepfun', model: 'step-5-preview',
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: Date.now(),
  });
  memManager.appendMessage({ role: 'toolResult', toolCallId: 'c1', toolName: 'workflow__save_plan', content: [{ type: 'text', text: '{"submitted":true}' }], isError: false, timestamp: Date.now() });
  flush();
  await updater.prepare(500, runtime, step5Model, 12_288, live);

  // Round 2: session__read_tool_result with 4096-char content slice -> incremental revision (loaded !== null)
  memManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c2', name: 'session__read_tool_result', arguments: { entryId: 'e1', toolCallId: 't1', offset: 0, limit: 4096 } }],
    api: 'openai-completions', provider: 'stepfun', model: 'step-5-preview',
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: Date.now(),
  });
  memManager.appendMessage({
    role: 'toolResult',
    toolCallId: 'c2',
    toolName: 'session__read_tool_result',
    content: [{ type: 'text', text: JSON.stringify({ entryId: 'e1', toolCallId: 't1', toolName: 'web_fetch', format: 'text', offset: 0, totalChars: 7565, content: 'PAGE_SLICE_'.repeat(380), nextOffset: 4096 }) }],
    isError: false,
    timestamp: Date.now(),
  });
  flush();
  await updater.prepare(1200, runtime, step5Model, 12_288, live);

  // Revision 1 gets 4096; Revision 2 (with existing currentMemory) gets 6144 so incremental merge succeeds on Attempt 1.
  assert.deepEqual(maxTokensSeen, [4096, 6144]);
  // currentMemory arrays are pre-trimmed to <= 6 items and session__read_tool_result is compacted to a memoryDigest.
  assert.ok(inputsSeen[1].currentMemory.references.length <= 6);
  const readDigest = JSON.parse(inputsSeen[1].newMessages.find((m: any) => m.message.role === 'toolResult').message.content[0].text);
  assert.equal(readDigest.memoryDigest, true);
  assert.ok(readDigest.preview.length <= 240);
});

check('integration', 'Pi session injects token budget warning in _hostBudgetNotice at >=75% maxTokens without mutating system prompt or observations', async () => {
  const data = store(), registry = new ToolRegistry(), web = webTestSource();
  const t: CompetitorTask = { ...task(), allowedSources: ['web'] };
  await registry.register('web', 'builtin', web.client, live);
  const initialPlan = json<Decision[]>('fixtures/model-script.json')[0] as Extract<Decision, { kind: 'call_tool' }>;
  const planDecision: Decision = { ...initialPlan, args: { ...initialPlan.args, taskId: t.taskId, sources: ['web'] } };

  // 8 turns * 150 tokens = 1200 maxTokens: Turn 5 = 750 (63%, no notice), Turn 6 = 900 (75%, token notice on review), Turn 7 = 1050 (88%, suppressed on draft), Turn 8 = 1200 (respond).
  const provider = await startBudgetPiProvider([
    { decision: planDecision },
    { decision: { kind: 'call_tool', name: 'web_search', args: { query: 'Node.js release 1', limit: 5 } } },
    { decision: { kind: 'call_tool', name: 'web_search', args: { query: 'Node.js release 2', limit: 5 } } },
    { decision: { kind: 'call_tool', name: 'web_fetch', args: { url: 'https://nodejs.org/en/blog/release/v24.0.0' } } },
    { decision: { kind: 'call_tool', name: 'workflow__analyze', args: {} } },
    { decision: { kind: 'call_tool', name: 'workflow__review', args: {} } },
    { decision: { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Finished cleanly after token budget notice.', claimIds: [] } } },
    { decision: { kind: 'respond', text: 'Completed within token budget.' } },
  ]);

  try {
    const result = await runInvestigation(t, provider.model(), registry, data, 'live', {
      builtinTools: false,
      sessionMemory: false,
      maxSteps: 20,
      maxToolCalls: 30,
      maxSameToolCalls: 30,
      maxTokens: 1200,
    });
    assert.equal(result.status, 'partial', result.error);
    assert.ok(result.report);
    assert.deepEqual(provider.errors, []);

    // System prompt remains identical across all turns (prompt cache prefix preserved).
    const firstSystem = provider.requests[0].messages[0].content;
    for (const req of provider.requests) assert.equal(req.messages[0].content, firstSystem);

    const toolMessageFor = (reqIndex: number, toolCallId: string) => {
      const msg = provider.requests[reqIndex].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === toolCallId);
      assert.ok(msg, `missing tool message ${toolCallId} in turn ${reqIndex + 1}`);
      return JSON.parse(msg.content) as Record<string, unknown>;
    };
    // Turn 5 analyze result (750/1200 = 63%) has no token budget notice yet.
    const analyzeMsg = toolMessageFor(5, 'budget-call-5-0');
    assert.equal('_hostBudgetNotice' in analyzeMsg, false);
    // Turn 6 review result (900/1200 = 75%) carries proactive token budget warning.
    const reviewMsg = toolMessageFor(6, 'budget-call-6-0');
    assert.match(String(reviewMsg._hostBudgetNotice), /Token budget: 900\/1200 \(75% used, 300 remaining\)/);
    // Turn 7 draft result suppresses redundant token warning.
    const draftMsg = toolMessageFor(7, 'budget-call-7-0');
    assert.equal('_hostBudgetNotice' in draftMsg, false);

    // Host state.observations never persist _hostBudgetNotice.
    const state = data.read<AgentState>('states/' + result.runId + '.json', null!);
    for (const obs of state.observations) {
      if (obs.result && typeof obs.result === 'object') assert.equal('_hostBudgetNotice' in (obs.result as Record<string, unknown>), false);
    }
  } finally {
    await provider.close();
    await registry.close();
  }
});
