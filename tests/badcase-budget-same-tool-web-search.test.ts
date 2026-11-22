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
  assert.ok(defaults.maxSameToolCalls >= 12);
  assert.ok(defaults.maxToolCalls >= 36);
  assert.ok(defaults.maxSteps >= 32);

  const data = store();
  const service = new RunService({
    root: process.cwd(),
    outputRoot: resolve(data.root, 'runs'),
    modelFactory: () => new ReplayModel([{ kind: 'respond', text: 'done' }]),
  });
  try {
    // Reject unsafe bounds on the new step/tool limit fields before creating a run.
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxSameToolCalls: 0 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxSameToolCalls: 61 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxToolCalls: 201 } }));
    assert.throws(() => service.start({ profile: 'agent', mode: 'replay', permission: 'explore', limits: { maxSteps: 121 } }));

    const runLimits = async (limits?: Parameters<RunService['start']>[0]['limits']) => {
      const started = service.start({ profile: 'agent', mode: 'replay', permission: 'explore', ...(limits ? { limits } : {}) });
      const finished = await service.wait(started.id);
      const events = new FileStore(resolve(data.root, 'runs', started.id)).lines<TraceEvent>('traces/' + finished.traceRunId + '.jsonl');
      assert.deepEqual(validateTrace(events), []);
      const startedEvent = events.find(e => e.type === 'run_started')!;
      return startedEvent.data.limits as Record<string, number>;
    };

    const standard = await runLimits();
    assert.equal(standard.maxSteps, 40);
    assert.equal(standard.maxToolCalls, 48);
    assert.equal(standard.maxSameToolCalls, 16);

    const fast = await runLimits({ timeoutMs: 120_000, maxTokens: 150_000 });
    assert.equal(fast.maxSteps, 24);
    assert.equal(fast.maxToolCalls, 28);
    assert.equal(fast.maxSameToolCalls, 12);

    const deep = await runLimits({ timeoutMs: 600_000, maxTokens: 1_000_000 });
    assert.equal(deep.maxSteps, 80);
    assert.equal(deep.maxToolCalls, 96);
    assert.equal(deep.maxSameToolCalls, 30);

    const explicit = await runLimits({ timeoutMs: 300_000, maxTokens: 400_000, maxSteps: 50, maxToolCalls: 60, maxSameToolCalls: 22 });
    assert.equal(explicit.maxSteps, 50);
    assert.equal(explicit.maxToolCalls, 60);
    assert.equal(explicit.maxSameToolCalls, 22);
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
      budgets: { steps: 5, maxSteps: 40, toolCalls: 12, maxToolCalls: 48, maxSameToolCalls: 16, callsByTool: { web_search: 8, web_fetch: 3 } },
    });
    const status = JSON.parse(attachments.find(item => item.name === 'Execution and agent status')!.content);
    assert.equal(status.budgets.steps, '5/40');
    assert.equal(status.budgets.tools, '12/48');
    assert.equal(status.budgets.sameToolCap, 16);
    assert.equal(status.budgets.byTool.web_search, 8);

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

check('contract', 'Hard budget_same_tool guard still fails closed if a provider emits an excess web_search call after deactivation', async () => {
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
        ],
      },
    },
    // Rogue provider ignores deactivated tool list and forces a 3rd web_search beyond maxSameToolCalls=2.
    { decision: { kind: 'call_tool', name: 'web_search', args: { query: 'Node.js 3', limit: 5 } } },
  ]);

  try {
    const result = await runInvestigation(t, provider.model(), registry, data, 'live', {
      builtinTools: false,
      sessionMemory: false,
      maxSteps: 10,
      maxToolCalls: 16,
      maxSameToolCalls: 2,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /budget_same_tool: 3\/2 tool=web_search/);
    assert.equal(web.searches(), 2);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.deepEqual(validateTrace(events), []);
    assert.ok(events.some(e => e.type === 'budget_exceeded' && e.data.budget === 'same_tool' && e.data.tool === 'web_search'));
  } finally {
    await provider.close();
    await registry.close();
  }
});
