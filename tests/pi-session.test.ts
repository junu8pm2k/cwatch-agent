import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type FileStore } from "@cwatch/shared/sessions/storage";
import { check, CountingClient, deferred, emptySchema, fixture, json, store, task, waitTick } from './harness.ts';
import { PiModel } from "@cwatch/shared/agent/models";
import { runInvestigation, replayState, type RuntimeOptions } from "@cwatch/server-core/runtime/investigation";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
import { validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { hash, type CompetitorTask, type Decision } from "@cwatch/core/types";
import { PrerequisiteManager } from '@cwatch/shared/agent/core/prerequisite-manager';

type Step = Exclude<Decision, { kind: 'call_tools' }> | { calls: Array<{ id?: string; name: string; args: unknown }>; finish?: string; text?: string; thinking?: string } | { http: number } | { hold: true };
let providerSequence = 0;
const op = (action: 'collect' | 'modify' | 'send' | 'publish' = 'collect') => ({ name: 'op', description: 'test source', action, inputSchema: emptySchema });
const plan = (value = { ...task(), allowedSources: ['official'] }) => ({ ...json<Decision[]>('fixtures/model-script.json')[0], args: { ...json('fixtures/model-script.json')[0].args, taskId: value.taskId, sources: value.allowedSources } }) as Decision;
const call = (name: string, args: Record<string, unknown> = {}): Decision => ({ kind: 'call_tool', name, args });
const done: Decision = { kind: 'respond', text: 'Saved.' };
const full = (value?: CompetitorTask): Step[] => [plan(value), call('mcp__official__op'), call('workflow__analyze'), call('workflow__review'), call('workflow__draft', { narrative: 'Fixture report.', claimIds: '$analyzed_claim_ids' }), done];

interface Options {
  runtime?: RuntimeOptions; client?: CountingClient; task?: CompetitorTask;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | null;
  signal?: AbortSignal; policy?: ActionPolicy; approvals?: ApprovalManager;
  setup?: (registry: ToolRegistry, data: FileStore, source: CountingClient) => Promise<void>;
  memoryResponse?: string;
  memorySteps?: Step[];
  providerError?: (request: any) => { status: number; message: string; code?: string } | undefined;
  onRequest?: (request: any, index: number, registry: ToolRegistry, data: FileStore) => Promise<void> | void;
}
async function sessionCase(steps: Step[], options: Options = {}) {
  const value = options.task ?? { ...task(), allowedSources: ['official'] };
  const registry = new ToolRegistry(), data = store();
  const source = options.client ?? new CountingClient([op()], async () => fixture());
  await registry.register('official', 'mcp', source, new AbortController().signal);
  await options.setup?.(registry, data, source);
  const requests: any[] = [];
  let scriptIndex = 0, memoryIndex = 0;
  const serverErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(request);
      await options.onRequest?.(request, requests.length, registry, data);
      const injected = options.providerError?.(request);
      if (injected) { res.writeHead(injected.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: injected.message, code: injected.code, type: 'invalid_request_error' } })); return; }
      const summaryRequest = !request.tools?.length;
      const memoryRequest = JSON.stringify(request.messages[0]).includes('SESSION MEMORY UPDATE.');
      const step = memoryRequest && options.memorySteps ? structuredClone(options.memorySteps[memoryIndex++]) : summaryRequest ? { kind: 'respond' as const, text: memoryRequest && options.memoryResponse !== undefined ? options.memoryResponse : JSON.stringify({ userGoal: 'The investigation plan is saved.', completedWork: ['Saved investigation plan'], keyFiles: [], errorsAndFixes: [], unfinishedTasks: ['Finish evidence-backed draft'], nextSteps: ['Continue collecting, then analyze, review and draft using exact tool-returned claim IDs'], references: [], sourceGaps: [] }) } : structuredClone(steps[scriptIndex++]);
      if (!step) throw new Error('unexpected extra provider request');
      if ('hold' in step) return;
      if ('http' in step) { res.writeHead(step.http, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture provider failure', type: 'fixture' } })); return; }
      if ('kind' in step && step.kind === 'call_tool' && step.args.claimIds === '$analyzed_claim_ids') {
        const analysisCall = request.messages.flatMap((message: any) => message.tool_calls ?? []).find((item: any) => item.function.name === 'workflow__analyze');
        step.args.claimIds = JSON.parse(request.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === analysisCall.id).content).claims.map((claim: any) => claim.id);
      }
      if ('kind' in step && step.kind === 'call_tool' && step.name === 'session__read_tool_result' && step.args.entryId === '$first_source_result') {
        const transcriptFile = readdirSync(data.path('sessions')).find(name => name.endsWith('.jsonl'))!;
        const original = data.lines<any>('sessions/' + transcriptFile).find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'mcp__official__op');
        step.args.entryId = original.id; step.args.toolCallId = original.message.toolCallId;
      }
      if ('kind' in step && step.kind === 'call_tool' && step.name === 'session__read_transcript' && step.args.throughEntryId === '$latest_compact') {
        const transcriptFile = readdirSync(data.path('sessions')).find(name => name.endsWith('.jsonl'))!;
        const boundary = data.lines<any>('sessions/' + transcriptFile).filter(entry => entry.type === 'compaction').at(-1);
        step.args.throughEntryId = JSON.parse(boundary.summary).transcript.throughEntryId;
      }
      const calls = 'calls' in step ? step.calls : step.kind === 'call_tool' ? [step] : [];
      const delta = calls.length
        ? { role: 'assistant', ...('text' in step ? { content: step.text } : {}), tool_calls: calls.map((item, index) => ({ index, id: 'id' in item ? item.id : 'call-' + requests.length + '-' + index, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) }
        : { role: 'assistant', content: 'kind' in step && step.kind === 'respond' ? step.text : 'text' in step ? step.text : '', ...('thinking' in step ? { reasoning_content: step.thinking } : {}) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = { id: 'fixture-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'fixture-session', choices: [{ index: 0, delta, finish_reason: null as string | null }] };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'calls' in step && step.finish ? step.finish : calls.length ? 'tool_calls' : 'stop' }], usage: options.usage === null ? undefined : options.usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) { serverErrors.push(error); if (!res.headersSent) res.writeHead(500); res.end('fixture server failure'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const model = PiModel.fromEnvironment({ MODEL_PROVIDER: 'fixture-session-' + ++providerSequence, MODEL_ID: 'fixture-session', API_KEY: 'fixture-session-key', BASE_URL: 'http://127.0.0.1:' + address.port + '/v1' });
    // The investigation must use the SDK session, never fall back to completeSimple/decide.
    model.decide = async () => { throw new Error('single-step Pi path must not run'); };
    // Most cases isolate business/compaction behavior; memory cases explicitly enable maintenance.
    const result = await runInvestigation(value, model, registry, data, 'replay', { timeoutMs: 30_000, sessionMemory: false, ...options.runtime }, options.signal, options.policy, options.approvals);
    assert.deepEqual(serverErrors, []);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.equal(events[0].data.engine, 'pi-agent-session');
    assert.deepEqual(validateTrace(events, ['fixture-session-key']), []);
    assert.ok(requests.every(request => (request.tools ?? []).every((tool: any) => /^(mcp__official__|workflow__|session__)/.test(tool.function.name) || ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'].includes(tool.function.name))));
    return { result, events, data, requests, source, state: replayState(data, result.runId) };
  } finally {
    await registry.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
check('integration', 'Pi AgentSession owns complete tool loop, usage and normalized audit replay', async () => {
  const value = { ...task(), allowedSources: ['official'] };
  const actual = await sessionCase(full(value));
  assert.equal(actual.result.status, 'complete', actual.result.error);
  assert.equal(actual.requests.length, 6); assert.equal(actual.source.calls.length, 1);
  assert.equal(actual.state.observations.length, 5); assert.equal(actual.state.decisions.length, 6);
  assert.equal(actual.requests[1].messages.filter((message: any) => message.role === 'tool').length, 1);
  assert.equal((actual.events.find(event => event.type === 'usage_reported')!.data.modelUsage as unknown[]).length, 6);
});

check('integration', 'real Pi subprocess uses all seven SDK builtins through host policy before the investigation workflow', async () => {
  const workspace = store();
  writeFileSync(resolve(workspace.root, 'input.txt'), 'local-input-marker\n');
  const actual = await sessionCase([
    call('read', { path: 'input.txt' }),
    call('write', { path: 'working.txt', content: 'initial-marker\n' }),
    call('edit', { path: 'working.txt', edits: [{ oldText: 'initial-marker', newText: 'updated-marker' }] }),
    call('bash', { command: "printf 'sdk-shell-marker'" }),
    call('grep', { path: '.', pattern: 'updated-marker' }),
    call('find', { path: '.', pattern: '*.txt' }),
    call('ls', { path: '.' }),
    ...full(),
  ], { runtime: { workspaceRoot: workspace.root }, policy: new ActionPolicy('allow-all') });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  assert.equal(readFileSync(resolve(workspace.root, 'working.txt'), 'utf8'), 'updated-marker\n');
  for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']) {
    assert.ok(actual.requests[0].tools.some((tool: any) => tool.function.name === name));
    assert.ok(actual.events.some(event => event.type === 'backend_started' && event.data.backend === 'pi.builtin.' + name));
    assert.ok(actual.data.executions().some(record => record.toolBinding.proxy_name === name && record.toolBinding.source_slug === 'pi' && record.execute_count === 1));
  }
  const nativeRead = actual.requests[1].messages.find((message: any) => message.role === 'tool');
  assert.match(nativeRead.content, /local-input-marker/);
  assert.ok(!nativeRead.content.includes('pi_builtin_result'));
  assert.deepEqual(validateTrace(actual.events, ['fixture-session-key']), []);
});

check('integration', 'Stable system and tool definitions repeat while provider cache telemetry preserves full token accounting', async () => {
  const actual = await sessionCase(full(), { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } } });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  assert.ok(actual.requests.every(request => JSON.stringify(request.messages[0]) === JSON.stringify(actual.requests[0].messages[0])));
  assert.ok(actual.requests.every(request => JSON.stringify(request.tools) === JSON.stringify(actual.requests[0].tools)));
  const contexts = actual.events.filter(event => event.type === 'context_prepared');
  assert.equal(new Set(contexts.map(event => event.data.prefixHash)).size, 1);
  assert.equal(new Set(contexts.map(event => event.data.toolsetHash)).size, 1);
  const usages = actual.events.filter(event => event.type === 'model_usage');
  assert.ok(usages.every(event => (event.data.cache as any).readTokens === 60 && (event.data.cache as any).creationTokens === 10));
  assert.ok(usages.every(event => (event.data.usage as any).input === 30 && (event.data.cache as any).reportedCacheReadInputShare === .6));
  const totals = actual.events.find(event => event.type === 'usage_reported')!.data;
  assert.equal(totals.totalTokens, 120 * actual.requests.length);
  assert.equal((totals.cacheUsage as any).byPurpose.turn.readTokens, 60 * actual.requests.length);
  assert.equal((totals.cacheUsage as any).financialSavings, 'not_estimated');
  // Unknown compatible servers receive only fields chosen by the SDK; no invented cache protocol.
  assert.ok(actual.requests.every(request => !request.prompt_cache_key && !request.prompt_cache_retention && !JSON.stringify(request).includes('cache_control')));
});

check('contract', 'Disabling SDK cache controls retains transcript history, normal usage accounting and explicit request metadata', async () => {
  const actual = await sessionCase(full(), { runtime: { promptCache: 'none' }, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } } });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  const requests = entries.filter(entry => entry.customType === 'cwatch.model_request');
  assert.ok(requests.every(entry => entry.data.promptCache.requestedRetention === 'none' && entry.data.promptCache.providerSupport === 'not_asserted'));
  assert.equal(entries.filter(entry => entry.type === 'message').length, 12);
  assert.equal(actual.events.find(event => event.type === 'usage_reported')!.data.totalTokens, actual.requests.length * 120);
  assert.equal((actual.events.find(event => event.type === 'usage_reported')!.data.cacheUsage as any).byPurpose.turn.reuseReportedResponses, actual.requests.length);
});

function reactiveSteps(): Step[] {
  const steps = full();
  steps.splice(1, 1, ...[1, 2, 3].map(index => ({ calls: [{ name: 'mcp__official__op', args: { index } }], text: 'Retained investigation reasoning ' + index + ': ' + 'a'.repeat(6000) })));
  return steps;
}
const reactiveSource = () => new CountingClient([{ ...op(), inputSchema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false } }], async () => { const value = fixture(); value.raw = 'source-original:' + 'r'.repeat(6000); return value; });

check('integration', 'Explicit provider context rejection below the proactive threshold compacts and retries without repeating completed tools', async () => {
  let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), providerError: request => request.tools?.length && ++business === 5 ? { status: 400, message: 'maximum context length is 32000 tokens; requested 33000', code: 'context_length_exceeded' } : undefined });
  assert.equal(actual.result.status, 'complete', actual.result.error); assert.equal(actual.source.calls.length, 3);
  const rejected = actual.requests[4]; assert.ok(JSON.stringify(rejected).length < 150_000 * .8);
  assert.ok(!actual.requests.slice(0, 5).some(request => !request.tools?.length));
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  const error = entries.find(entry => entry.type === 'message' && entry.message.stopReason === 'error');
  assert.ok(error); assert.match(error.message.errorMessage, /context/);
  assert.ok(entries.some(entry => entry.customType === 'cwatch.provider_rejection' && entry.data.entryId === error.id));
  assert.ok(entries.some(entry => entry.type === 'compaction'));
  const retry = entries.find(entry => entry.customType === 'cwatch.reactive_compact' && entry.data.stage === 'retry');
  assert.ok(retry.data.charsAfter < retry.data.charsBefore);
  assert.ok(entries.some(entry => entry.customType === 'cwatch.reactive_compact' && entry.data.stage === 'recovered'));
  assert.ok(!JSON.stringify(actual.requests.slice(5)).includes('requested 33000'));
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { getMessagesAfterCompactBoundary } = await import('@cwatch/shared/agent/backend/pi/context');
  const loaded = SessionManager.open(actual.data.path('sessions/' + actual.result.runId + '.jsonl'));
  assert.ok(!JSON.stringify(getMessagesAfterCompactBoundary(loaded)).includes('requested 33000'));
  const invalid = structuredClone(actual.events); invalid.find(event => event.type === 'provider_rejected')!.data.iteration = 999;
  assert.ok(validateTrace(invalid).includes('invalid provider rejection'));
});

check('contract', 'A second consecutive context rejection opens the circuit without another compression request', async () => {
  let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), providerError: request => request.tools?.length && ++business >= 5 ? { status: 400, message: 'prompt is too long: 33000 tokens > 32000 maximum' } : undefined });
  assert.match(actual.result.error!, /context_recovery_circuit_open/); assert.equal(actual.source.calls.length, 3);
  assert.equal(actual.requests.filter(request => !request.tools?.length).length, 1);
  assert.equal(business, 6);
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  assert.equal(entries.filter(entry => entry.customType === 'cwatch.provider_rejection').length, 2);
  assert.ok(entries.some(entry => entry.customType === 'cwatch.reactive_compact' && entry.data.stage === 'stopped' && entry.data.open));
});

check('contract', 'An oversized initial prompt has no reducible history and never retries an identical request', async () => {
  const actual = await sessionCase(full(), { providerError: () => ({ status: 400, message: 'context_length_exceeded' }) });
  assert.match(actual.result.error!, /context_recovery_unavailable/); assert.equal(actual.requests.length, 1); assert.equal(actual.source.calls.length, 0);
});

check('contract', 'A rejected reactive summary stops and opens the circuit instead of recursively summarizing errors', async () => {
  let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), providerError: request => !request.tools?.length || ++business === 5 ? { status: 400, message: 'prompt is too long' } : undefined });
  assert.equal(actual.result.status, 'failed'); assert.equal(actual.requests.length, 6); assert.equal(actual.source.calls.length, 3);
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  assert.ok(!entries.some(entry => entry.type === 'compaction'));
  assert.ok(entries.some(entry => entry.customType === 'cwatch.reactive_compact' && entry.data.open && entry.data.stage === 'stopped'));
});

check('contract', 'Cancellation during reactive summarization prevents the retry and retains completed source actions', async () => {
  const controller = new AbortController(); let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), signal: controller.signal,
    onRequest: request => { if (!request.tools?.length) controller.abort(new Error('cancel-reactive-summary')); },
    providerError: request => request.tools?.length && ++business === 5 ? { status: 400, message: 'prompt too long' } : undefined });
  assert.equal(actual.result.status, 'cancelled'); assert.equal(business, 5); assert.equal(actual.source.calls.length, 3);
});

check('contract', 'Reactive recovery respects the remaining business request budget before spending a summary request', async () => {
  let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), runtime: { maxSteps: 5 }, providerError: request => request.tools?.length && ++business === 5 ? { status: 400, message: 'context_length_exceeded' } : undefined });
  assert.match(actual.result.error!, /budget_iterations/); assert.equal(actual.requests.length, 5); assert.equal(actual.source.calls.length, 3);
});

check('integration', 'Reactive continuation refreshes revoked bindings instead of restoring the failed request tool surface', async () => {
  let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), onRequest: async (request, index, registry) => { if (index === 5 && request.tools?.length) await registry.revoke('official'); },
    providerError: request => request.tools?.length && ++business === 5 ? { status: 400, message: 'context_length_exceeded' } : undefined });
  assert.equal(actual.result.status, 'partial', actual.result.error); assert.equal(actual.source.calls.length, 3);
  const retry = actual.requests.slice(5).find(request => request.tools?.length);
  assert.ok(retry); assert.ok(!retry.tools.some((tool: any) => tool.function.name.startsWith('official__')));
});

check('contract', 'Provider rate limits mentioning context length do not trigger compression or a retry', async () => {
  const actual = await sessionCase(full(), { providerError: () => ({ status: 429, message: 'rate limit: context_length_exceeded' }) });
  assert.equal(actual.result.status, 'failed'); assert.equal(actual.requests.length, 1);
  assert.ok(!actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl').some(entry => entry.customType === 'cwatch.reactive_compact'));
});

check('integration', 'Incremental session memory excludes rejected responses and continues after reactive compression', async () => {
  let business = 0;
  const actual = await sessionCase(reactiveSteps(), { client: reactiveSource(), runtime: { sessionMemory: { initializeTokens: 1, growthTokens: 1, toolCalls: 1 } },
    providerError: request => request.tools?.length && ++business === 5 ? { status: 400, message: 'context_length_exceeded' } : undefined });
  assert.equal(actual.result.status, 'complete', actual.result.error); assert.equal(actual.source.calls.length, 3);
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  const failed = entries.find(entry => entry.type === 'message' && entry.message.stopReason === 'error');
  const deltas = entries.filter(entry => entry.customType === 'cwatch.memory_request').map(entry => JSON.parse(entry.data.context.messages[0].content).newMessages);
  assert.ok(deltas.length > 4); assert.ok(deltas.every(messages => messages.every((message: any) => message.entryId !== failed.id)));
  assert.equal(actual.data.read<any>('session-memory/' + actual.result.runId + '.json', null).memory.toolCallCount, 7);
});
check('integration', 'Real Pi session incrementally persists isolated session memory with metered usage and a readable current checkpoint', async () => {
  const steps = full(); steps.splice(2, 0, call('session__read_session_memory'));
  const actual = await sessionCase(steps, { runtime: { sessionMemory: { initializeTokens: 1, growthTokens: 1, toolCalls: 1 } } });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  const maintenance = actual.requests.filter(request => JSON.stringify(request.messages[0]).includes('SESSION MEMORY UPDATE.'));
  assert.equal(maintenance.length, steps.length - 1);
  const inputs = maintenance.map(request => JSON.parse(request.messages.at(-1).content));
  assert.equal(inputs[0].currentMemory, null);
  assert.ok(inputs.slice(1).every(input => input.currentMemory?.nextSteps.length));
  const ids = inputs.flatMap(input => input.newMessages.map((entry: any) => entry.entryId));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(maintenance.every(request => !request.tools?.length && request.messages.length === 2));
  const saved = actual.data.read<any>('session-memory/' + actual.result.runId + '.json', null).memory;
  assert.equal(saved.sessionId, actual.result.runId); assert.equal(saved.revision, maintenance.length);
  assert.equal(saved.toolCallCount, steps.length - 1); assert.equal(saved.pendingMessages, false);
  assert.equal(actual.source.calls.length, 1);
  assert.equal(actual.events.filter(event => event.type === 'session_memory_updated').length, maintenance.length);
  assert.equal(actual.events.filter(event => event.type === 'model_usage' && event.data.purpose === 'memory').length, maintenance.length);
  assert.equal(actual.events.find(event => event.type === 'usage_reported')!.data.totalTokens, 120 * actual.requests.length);
  const read = actual.state.observations.find(observation => observation.name === 'session__read_session_memory')!.result as any;
  assert.equal(read.revision, 2);
});

check('contract', 'Real Pi invalid memory response stops without a memory cursor or further business action', async () => {
  const actual = await sessionCase(full(), { runtime: { sessionMemory: { initializeTokens: 1 } }, memoryResponse: 'vague unsupported memory' });
  assert.match(actual.result.error!, /session_memory_update_failed/); assert.equal(actual.source.calls.length, 0);
  assert.equal(actual.requests.length, 2);
  assert.equal(actual.data.read('session-memory/' + actual.result.runId + '.json', null), null);
  assert.ok(actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl').some(entry => entry.customType === 'cwatch.memory_response'));
});

check('integration', 'Real Pi memory thinking-only truncation retries once, meters both responses and commits only valid JSON', async () => {
  const state = { userGoal: 'Finish investigation', completedWork: ['Plan saved'], keyFiles: [], errorsAndFixes: [], unfinishedTasks: ['Collect evidence'], nextSteps: ['Read official source'], references: [], sourceGaps: [] };
  const actual = await sessionCase(full(), { runtime: { maxOutputTokens: 2048, sessionMemory: { initializeTokens: 1, growthTokens: 1_000_000, toolCalls: 1000 } }, memorySteps: [
    { calls: [], thinking: 'reasoning consumed the limit', finish: 'length' }, { kind: 'respond', text: JSON.stringify(state) },
  ] });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  const maintenance = actual.requests.filter(request => !request.tools?.length);
  assert.equal(maintenance.length, 2);
  assert.deepEqual(maintenance.map(request => request.max_tokens ?? request.max_completion_tokens), [1024, 2048]);
  assert.ok(maintenance.every(request => !request.enable_thinking && !request.reasoning_effort));
  assert.equal(actual.events.filter(event => event.type === 'model_usage' && event.data.purpose === 'memory').length, 2);
  assert.equal(actual.events.filter(event => event.type === 'session_memory_updated').length, 1);
  const saved = actual.data.read<any>('session-memory/' + actual.result.runId + '.json', null).memory;
  assert.deepEqual(saved.content, state); assert.equal(saved.revision, 1);
});

check('integration', 'Real Pi repeated memory exhaustion stops without committing or executing subsequent business tools', async () => {
  const actual = await sessionCase(full(), { runtime: { sessionMemory: { initializeTokens: 1 } }, memorySteps: [
    { calls: [], thinking: 'first exhausted', finish: 'length' }, { calls: [], thinking: 'second exhausted', finish: 'length' },
  ] });
  assert.match(actual.result.error!, /output limit exhausted after 2 attempts/);
  assert.equal(actual.requests.length, 3); assert.equal(actual.source.calls.length, 0);
  assert.equal(actual.events.filter(event => event.type === 'model_usage' && event.data.purpose === 'memory').length, 2);
  assert.equal(actual.data.read('session-memory/' + actual.result.runId + '.json', null), null);
});

check('integration', 'Real Pi hanging memory recovery remains cancellable and cannot commit a checkpoint', async () => {
  const controller = new AbortController();
  const actual = await sessionCase(full(), { signal: controller.signal, runtime: { sessionMemory: { initializeTokens: 1 } }, memorySteps: [
    { calls: [], thinking: 'first exhausted', finish: 'length' }, { hold: true },
  ], onRequest: (request, index) => { if (index === 3 && !request.tools?.length) setTimeout(() => controller.abort(new Error('cancel-memory-recovery')), 30); } });
  assert.notEqual(actual.result.status, 'complete'); assert.equal(actual.requests.length, 3);
  assert.equal(actual.source.calls.length, 0); assert.equal(actual.data.read('session-memory/' + actual.result.runId + '.json', null), null);
  // The cancelled request never reports usage: preserve the completed attempt, do not fabricate a second bill.
  assert.equal(actual.events.filter(event => event.type === 'model_usage' && event.data.purpose === 'memory').length, 1);
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  assert.equal(entries.filter(entry => entry.customType === 'cwatch.memory_wire_request').length, 2);
});

check('integration', 'Session memory stays separate from compaction and is reattached with its processed-message freshness', async () => {
  const steps = full(); steps.splice(1, 1, ...[1, 2, 3].map(index => ({ calls: [{ name: 'mcp__official__op', args: { index } }], text: 'Long investigation reasoning ' + index + ': ' + 'a'.repeat(12_000) })));
  const source = new CountingClient([{ ...op(), inputSchema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false } }], async () => { const result = fixture(); result.raw = 'source-raw:' + 'x'.repeat(12_000); return result; });
  const actual = await sessionCase(steps, { client: source, runtime: { contextChars: 70_000, sessionMemory: {} } });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  const updates = actual.requests.filter(request => JSON.stringify(request.messages[0]).includes('SESSION MEMORY UPDATE.')).length;
  assert.ok(updates >= 1);
  const entries = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  assert.ok(entries.some(entry => entry.type === 'compaction'));
  assert.ok(entries.some(entry => entry.customType === 'cwatch.post_compact_attachment' && String(entry.content).includes('Session memory')));
  assert.match(JSON.stringify(actual.requests.at(-1)), /State as of lastMessageId/);
  const saved = actual.data.read<any>('session-memory/' + actual.result.runId + '.json', null).memory;
  assert.equal(saved.revision, updates); assert.equal(saved.policy.initializeTokens, 12_000);
  assert.equal(actual.source.calls.length, 3);
});
check('contract', 'Pi session step budget prevents the next HTTP request', async () => {
  const actual = await sessionCase([plan()], { runtime: { maxSteps: 1 } });
  assert.match(actual.result.error!, /budget_iterations/); assert.equal(actual.requests.length, 1);
  assert.equal(actual.data.executions().length, 1); assert.equal(actual.state.observations.length, 1);
});
check('contract', 'Pi session tool budget rejects before any tool side effect', async () => {
  const actual = await sessionCase([plan()], { runtime: { maxToolCalls: 0 } });
  assert.match(actual.result.error!, /budget_tools/); assert.equal(actual.requests.length, 1);
  assert.equal(actual.data.executions().length, 0);
});
check('integration', 'Pi session executes every call in a response serially with complete identity-matched results', async () => {
  const first = plan(); assert.equal(first.kind, 'call_tool'); if (first.kind !== 'call_tool') throw Error('invalid fixture');
  const actual = await sessionCase([{ calls: [first, { name: 'mcp__official__op', args: {} }] }, ...full().slice(2)]);
  assert.equal(actual.result.status, 'complete', actual.result.error);
  assert.equal(actual.requests.length, 5); assert.equal(actual.source.calls.length, 1);
  const firstResults = actual.requests[1].messages.filter((message: { role: string }) => message.role === 'tool');
  assert.deepEqual(firstResults.map((message: { tool_call_id: string }) => message.tool_call_id), ['call-1-0', 'call-1-1']);
  assert.equal(actual.state.decisions[0].kind, 'call_tools');
  const pre = actual.events.filter(event => event.type === 'pre_tool_use_request');
  assert.deepEqual(pre.slice(0, 2).map(event => event.data.sdkToolCallId), ['call-1-0', 'call-1-1']);
  const firstEnd = actual.events.findIndex(event => event.type === 'execution_finished');
  const secondStart = actual.events.findIndex(event => event.type === 'pre_tool_use_request' && event.data.sdkToolCallId === 'call-1-1');
  assert.ok(secondStart > firstEnd);
  assert.equal(actual.state.observations.length, 5);
  assert.equal(actual.events.filter(event => event.type === 'model_usage').length, 5);
  const forged = structuredClone(actual.events);
  forged.find(event => event.type === 'observation_added')!.data.sdkToolCallId = 'call-1-1';
  assert.ok(validateTrace(forged).includes('batch observation identity mismatch'));
  const omitted = actual.events.filter(event => !(event.type === 'observation_added' && event.data.sdkToolCallId === 'call-1-1')).map((event, index) => ({ ...event, sequence: index + 1 }));
  assert.ok(validateTrace(omitted).includes('model request with unfinished tool batch'));
});

check('contract', 'Pi batch approvals are independent even for identical tool names and arguments', async () => {
  let approvals = 0;
  const actual = await sessionCase([plan(), { calls: [{ name: 'mcp__official__op', args: {} }, { name: 'mcp__official__op', args: {} }] }, ...full().slice(2)], {
    client: new CountingClient([op('publish')]), policy: new ActionPolicy('ask'),
    approvals: new ApprovalManager(async () => ++approvals === 1),
  });
  assert.equal(approvals, 2); assert.equal(actual.source.calls.length, 1);
  const executions = actual.data.executions().filter(record => record.sourceSlug === 'official');
  assert.deepEqual(executions.map(record => record.sdkToolCallId).sort(), ['call-2-0', 'call-2-1']);
  assert.equal(executions.reduce((count, record) => count + record.execute_count, 0), 1);
  assert.equal(actual.events.filter(event => event.type === 'approval_resolved').length, 2);
  const results = actual.requests[2].messages.filter((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id?.startsWith('call-2-'));
  assert.equal(results.length, 2); assert.match(results[1].content, /denied|permission|approval/i);
});

check('contract', 'Pi batch reserves all tool budgets before any side effect', async () => {
  const first = plan(); if (first.kind !== 'call_tool') throw Error('invalid fixture');
  const actual = await sessionCase([{ calls: [first, { name: 'mcp__official__op', args: {} }] }], { runtime: { maxToolCalls: 1 } });
  assert.match(actual.result.error!, /budget_tools/);
  assert.equal(actual.source.calls.length, 0); assert.equal(actual.data.executions().length, 0);
  assert.equal(actual.requests.length, 1);
});

check('contract', 'Pi batch counts repeated tool names against the same-tool budget', async () => {
  const actual = await sessionCase([plan(), { calls: [{ name: 'mcp__official__op', args: {} }, { name: 'mcp__official__op', args: {} }] }], { runtime: { maxSameToolCalls: 1 } });
  assert.match(actual.result.error!, /budget_same_tool/); assert.equal(actual.source.calls.length, 0);
  assert.equal(actual.data.executions().length, 1);
});

check('contract', 'Pi rejects truncated batches before their first execution', async () => {
  const first = plan(); if (first.kind !== 'call_tool') throw Error('invalid fixture');
  const actual = await sessionCase([{ calls: [first, { name: 'mcp__official__op', args: {} }], finish: 'length' }]);
  assert.equal(actual.result.status, 'failed'); assert.equal(actual.data.executions().length, 0);
  assert.equal(actual.source.calls.length, 0); assert.equal(actual.requests.length, 1);
});

check('contract', 'Pi batch retains an unknown tool error and executes the later valid call with its own ID', async () => {
  const first = plan(); if (first.kind !== 'call_tool') throw Error('invalid fixture');
  const actual = await sessionCase([{ calls: [first, { name: 'mcp__other__op', args: {} }, { name: 'mcp__official__op', args: {} }] }, ...full().slice(2)]);
  assert.equal(actual.source.calls.length, 1);
  const results = actual.requests[1].messages.filter((message: { role: string }) => message.role === 'tool');
  assert.deepEqual(results.map((message: { tool_call_id: string }) => message.tool_call_id), ['call-1-0', 'call-1-1', 'call-1-2']);
  assert.match(results[1].content, /not found|unknown tool/i);
  assert.ok(actual.events.some(event => event.type === 'pre_tool_use_request' && event.data.sdkToolCallId === 'call-1-2'));
  assert.ok(!actual.events.some(event => event.type === 'execution_started' && event.data.sdkToolCallId === 'call-1-1'));
});

check('contract', 'Pi batch rechecks source revocation between calls', async () => {
  let registry: ToolRegistry;
  const source = new CountingClient([op()], async () => { registry.setActive('official', false); return fixture(); });
  const actual = await sessionCase([plan(), { calls: [{ name: 'mcp__official__op', args: {} }, { name: 'mcp__official__op', args: {} }] }, done], {
    client: source, setup: async value => { registry = value; },
  });
  assert.equal(source.calls.length, 1);
  assert.match(JSON.stringify(actual.state.observations), /inactive_source|stale.*binding|source_inactive/);
});

check('contract', 'Pi cancellation inside a batch prevents later calls without replaying the completed one', async () => {
  const controller = new AbortController();
  const source = new CountingClient([op()], async () => { controller.abort(new Error('user_cancelled')); return fixture(); });
  const actual = await sessionCase([plan(), { calls: [{ name: 'mcp__official__op', args: {} }, { name: 'mcp__official__op', args: {} }] }], { client: source, signal: controller.signal });
  assert.equal(actual.result.status, 'cancelled'); assert.equal(source.calls.length, 1);
  assert.equal(actual.data.executions().filter(record => record.sourceSlug === 'official').length, 1);
});

check('contract', 'Fresh SDK call IDs cannot hide repeated no-progress batches', async () => {
  const batch = { calls: [{ name: 'session__read_plan', args: {} }, { name: 'session__read_plan', args: {} }] };
  const actual = await sessionCase([batch, batch, batch]);
  assert.match(actual.result.error!, /no_progress/); assert.equal(actual.requests.length, 3);
});
check('contract', 'Pi session rejects truncated tool arguments even when JSON is parseable', async () => {
  const actual = await sessionCase([{ calls: [plan() as any], finish: 'length' }]);
  assert.match(actual.result.error!, /truncated_response/); assert.equal(actual.data.executions().length, 0);
});
for (const [label, step] of [
  ['invalid schema', call('mcp__official__op', { unexpected: true })],
  ['unknown tool', call('mcp__other__op')],
] as const) check('contract', 'Pi SDK ' + label + ' rejection is retained as an Observation', async () => {
  const actual = await sessionCase([step, done]);
  assert.equal(actual.requests.length, 2); assert.equal(actual.source.calls.length, 0);
  assert.equal(actual.state.observations.length, 1);
  assert.equal((actual.state.observations[0].result as any).status, 'tool_failed');
  assert.match(actual.result.error!, /response_before_verified_draft/);
});
check('contract', 'Pi session cannot collect before submitting its plan', async () => {
  const actual = await sessionCase([call('mcp__official__op'), done]);
  assert.equal(actual.source.calls.length, 0);
  assert.match(JSON.stringify(actual.state.observations), /plan_required_before_collection/);
});
check('contract', 'Pi session cannot collect again after analysis', async () => {
  const actual = await sessionCase([plan(), call('mcp__official__op'), call('workflow__analyze'), call('mcp__official__op'), done]);
  assert.equal(actual.source.calls.length, 1);
  assert.match(JSON.stringify(actual.state.observations), /collection_after_analysis/);
});
check('contract', 'Pi explore hides write tools and rejects a model hallucinating their names', async () => {
  const actual = await sessionCase([plan(), call('mcp__official__op'), done], { client: new CountingClient([op('publish')]) });
  assert.equal(actual.source.calls.length, 0);
  assert.ok(actual.requests.every(request => !request.tools.some((tool: any) => tool.function.name === 'mcp__official__op')));
  assert.ok(!actual.data.executions().some(record => record.sourceSlug === 'official'));
  assert.match(JSON.stringify(actual.state.observations), /tool.*not found|unknown tool/i);
});
check('contract', 'Pi session ask mode waits for a one-shot host approval before publishing', async () => {
  let approvals = 0;
  const actual = await sessionCase([plan(), call('mcp__official__op'), done], {
    client: new CountingClient([op('publish')]), policy: new ActionPolicy('ask'),
    approvals: new ApprovalManager(async () => { approvals++; return true; }),
  });
  assert.equal(approvals, 1); assert.equal(actual.source.calls.length, 1);
  const approved = actual.events.findIndex(event => event.type === 'approval_resolved');
  const started = actual.events.findIndex((event, index) => index > approved && event.type === 'execution_started');
  assert.ok(approved >= 0 && started > approved);
});
check('contract', 'Pi session preserves the originally disclosed binding when a source changes during a model request', async () => {
  const replacement = new CountingClient([op()]);
  const actual = await sessionCase([plan(), call('mcp__official__op'), done], {
    onRequest: async (_request, index, registry) => {
      if (index === 2) await registry.register('official', 'mcp', replacement, new AbortController().signal);
    },
  });
  assert.equal(actual.source.calls.length, 0); assert.equal(replacement.calls.length, 0);
  assert.match(JSON.stringify(actual.state.observations), /stale_binding/);
  assert.ok(!actual.requests[2].tools.some((tool: any) => tool.function.name === 'mcp__official__op'));
});
check('contract', 'Pi session cancellation stops an in-flight provider and records no late events', async () => {
  const controller = new AbortController();
  const actual = await sessionCase([{ hold: true }], { signal: controller.signal, onRequest: () => { setTimeout(() => controller.abort(new Error('user_cancelled')), 10); } });
  assert.equal(actual.result.status, 'cancelled'); assert.equal(actual.requests.length, 1);
  assert.equal(actual.source.calls.length, 0);
  await waitTick(); assert.deepEqual(actual.data.lines('traces/' + actual.result.runId + '.jsonl'), actual.events);
});
check('contract', 'Pi session cancellation reaches a running host tool and rejects its late result', async () => {
  const controller = new AbortController(), late = deferred<unknown>();
  let observedAbort = false;
  const client = new CountingClient([op()], async signal => {
    signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
    setTimeout(() => controller.abort(new Error('user_cancelled')), 5);
    return late.promise;
  });
  const actual = await sessionCase([plan(), call('mcp__official__op')], { client, signal: controller.signal });
  assert.equal(actual.result.status, 'cancelled'); assert.equal(observedAbort, true);
  late.resolve(fixture()); await waitTick();
  assert.deepEqual(actual.data.lines('traces/' + actual.result.runId + '.jsonl'), actual.events);
  assert.equal(actual.state.observations.length, 1);
});
check('contract', 'Pi session run timeout terminates a pending provider request without retry', async () => {
  const actual = await sessionCase([{ hold: true }], { runtime: { timeoutMs: 6_000 } });
  assert.equal(actual.result.status, 'failed'); assert.match(actual.result.error!, /budget_timeout/);
  assert.equal(actual.requests.length, 1);
});
check('contract', 'Pi session stops when the retained complete tool turn alone exceeds the active character budget', async () => {
  const large = plan() as Extract<Decision, { kind: 'call_tool' }>;
  large.args.objective = 'x'.repeat(30_000);
  const actual = await sessionCase([large], { runtime: { contextChars: 20_000 } });
  assert.match(actual.result.error!, /context_budget_exceeded/); assert.equal(actual.requests.length, 1);
  assert.equal(actual.state.observations.length, 1);
});
check('integration', 'Pi sessions keep concurrent tasks, transcripts and reports isolated', async () => {
  const first = { ...task(), taskId: 'session-isolation-first', allowedSources: ['official'] };
  const second = { ...task(), taskId: 'session-isolation-second', allowedSources: ['official'] };
  const [a, b] = await Promise.all([sessionCase(full(first), { task: first }), sessionCase(full(second), { task: second })]);
  assert.equal(a.result.status, 'complete', a.result.error); assert.equal(b.result.status, 'complete', b.result.error);
  assert.notEqual(a.result.runId, b.result.runId);
  assert.equal(a.state.task.taskId, first.taskId); assert.equal(b.state.task.taskId, second.taskId);
  assert.ok(!JSON.stringify(a.requests).includes(second.taskId)); assert.ok(!JSON.stringify(b.requests).includes(first.taskId));
  const aLog = a.data.lines<any>('sessions/' + a.result.runId + '.jsonl');
  const bLog = b.data.lines<any>('sessions/' + b.result.runId + '.jsonl');
  assert.equal(aLog[0].id, a.result.runId); assert.equal(bLog[0].id, b.result.runId);
  assert.ok(!JSON.stringify(aLog).includes(second.taskId)); assert.ok(!JSON.stringify(bLog).includes(first.taskId));
});

check('integration', 'Real Pi subprocess compacts long history, keeps archived source originals and completes with metered summaries', async () => {
  let collected = 0, hooks = 0;
  const source = new CountingClient([{ ...op(), inputSchema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false } }], async () => {
    const payload = fixture(); payload.raw = 'archived-source-' + ++collected + ':' + 'x'.repeat(12_000); return payload;
  });
  const steps = full(); steps.splice(1, 1, ...[1, 2, 3].map(index => ({ calls: [{ name: 'mcp__official__op', args: { index } }], text: 'Assistant investigation reasoning ' + index + ': ' + 'a'.repeat(12_000) })));
  steps.unshift(call('session__read_source_guide', { source: 'official' }), call('session__read_skill_resource', { skill: 'fixture-skill', path: 'reference.md' }));
  steps.splice(3, 0, call('workflow__read_plan', { offset: 0, limit: 4096 }));
  steps.splice(7, 0, call('session__read_transcript', { throughEntryId: '$latest_compact', query: 'Assistant investigation reasoning 1', limit: 4096 }));
  const resourceText = 'post-compact-skill-resource-marker: verify source evidence'.padEnd(1188, 'r') + 'fixture-leak"marker';
  const actual = await sessionCase(steps, { client: source, setup: async (registry, data, client) => {
    data.text('sources/official/guide.md', 'post-compact-guide-marker: collect only scoped evidence');
    Object.assign(client, { guide: new PrerequisiteManager(data.root, 'official') });
    await registry.register('official', 'mcp', client, new AbortController().signal);
  }, runtime: { contextChars: 70_000, secrets: ['fixture-leak"marker'], userSkills: {
    documents: [{ name: 'fixture-skill', description: 'fixture skill', body: 'Read reference.md when needed.', hash: hash('fixture-skill'), resources: ['reference.md'] }],
    readResource: (_skill, _path, offset, limit) => ({ text: resourceText.slice(offset, offset + limit), hash: hash(resourceText), totalChars: resourceText.length, truncated: offset + limit < resourceText.length }),
  }, onPostCompact: async request => {
    hooks++; assert.ok(request.summary.nextSteps.length); assert.ok(request.keptEntryIds.length >= 2);
    return [{ name: 'Fixture host hook', content: 'post-compact-hook-marker: continue with current host permissions' }];
  } } });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  const summaries = actual.requests.filter(request => !request.tools?.length);
  assert.ok(summaries.length >= 1);
  assert.equal(hooks, summaries.length);
  assert.equal(actual.requests.length, steps.length + summaries.length);
  assert.equal(actual.source.calls.length, 3);
  assert.equal(actual.events.filter(event => event.type === 'model_usage').length, actual.requests.length);
  assert.equal(actual.events.filter(event => event.type === 'model_usage' && event.data.purpose === 'summary').length, summaries.length);
  assert.equal(actual.events.find(event => event.type === 'usage_reported')!.data.totalTokens, 120 * actual.requests.length);
  const transcript = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  assert.equal(transcript.filter(entry => entry.type === 'compaction').length, summaries.length);
  assert.equal(transcript.filter(entry => entry.type === 'message').length, 1 + 2 * (steps.length - 1) + 1);
  assert.match(JSON.stringify(transcript), /archived-source-1/);
  const last = actual.requests.at(-1);
  assert.ok(!JSON.stringify(last).includes('archived-source-1'));
  assert.match(JSON.stringify(last), /investigation plan is saved/);
  assert.match(JSON.stringify(last), /TASK CONSTRAINTS/);
  assert.match(JSON.stringify(last), /Current workflow state/);
  assert.match(JSON.stringify(last), /post-compact-hook-marker/);
  assert.match(JSON.stringify(last), /toolResultRefs/);
  assert.match(JSON.stringify(last), /post-compact-guide-marker/);
  assert.match(JSON.stringify(last), /post-compact-skill-resource-marker/);
  assert.match(JSON.stringify(last), /Current tool and MCP catalog/);
  assert.match(JSON.stringify(last), /Execution and agent status/);
  assert.ok(!JSON.stringify(last).includes('fixture-leak'));
  const attachments = transcript.filter(entry => entry.type === 'custom_message' && entry.customType === 'cwatch.post_compact_attachment');
  assert.ok(attachments.length >= 6);
  const firstState = attachments.find(entry => JSON.stringify(entry.content).includes('Current workflow state'));
  assert.match(JSON.stringify(firstState), /verified/);
  assert.match(JSON.stringify(firstState), /collected/);
  assert.equal(actual.state.decisions.filter(decision => decision.kind === 'call_tool' && decision.name === 'session__read_source_guide').length, 1);
  assert.equal(actual.state.decisions.filter(decision => decision.kind === 'call_tool' && decision.name === 'session__read_skill_resource').length, 1);
  assert.equal(actual.state.decisions.filter(decision => decision.kind === 'call_tool' && decision.name === 'workflow__read_plan').length, 1);
  const lookups = actual.state.observations.filter(observation => observation.name === 'session__read_transcript');
  assert.equal(lookups.length, 1); assert.match(JSON.stringify(lookups[0].result), /Assistant investigation reasoning 1/);
  const firstBoundary = transcript.find(entry => entry.type === 'compaction');
  const link = JSON.parse(firstBoundary.summary).transcript;
  assert.equal(link.path, actual.data.path('sessions/' + actual.result.runId + '.jsonl'));
  assert.equal(link.sessionId, actual.result.runId); assert.equal(link.tool, 'session__read_transcript');
  assert.ok(transcript.some(entry => entry.id === link.throughEntryId));
  assert.match(JSON.stringify(last), /transcriptLookup/);
  // The two recent results can still reach a formal summary when assistant text causes pressure.
  assert.ok(summaries.every(request => JSON.stringify(request).includes('Archived tool result (snip)')));
});

check('contract', 'A failed host post-compact hook prevents the next real provider request and commits no boundary', async () => {
  const steps = [plan(), ...[1, 2, 3].map(index => ({ calls: [{ name: 'mcp__official__op', args: {} }], text: 'Assistant context ' + index + ': ' + 'a'.repeat(12_000) })), done];
  const source = new CountingClient([op()], async () => { const payload = fixture(); payload.raw = 'x'.repeat(12_000); return payload; });
  let hookCalls = 0;
  const actual = await sessionCase(steps, { client: source, runtime: { contextChars: 70_000, onPostCompact: async () => { hookCalls++; throw new Error('fixture_post_compact_hook_failed'); } } });
  assert.match(actual.result.error!, /post_compact_hook_failed/); assert.equal(hookCalls, 1);
  assert.ok(!actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl').some(entry => entry.type === 'compaction'));
  const summaryIndex = actual.requests.findIndex(request => !request.tools?.length);
  assert.ok(summaryIndex >= 0); assert.equal(actual.requests.length, summaryIndex + 1);
});

check('integration', 'Real Pi microcompact and paged archive reads avoid summaries and do not repeat source actions', async () => {
  let collected = 0;
  const source = new CountingClient([{ ...op(), inputSchema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false } }], async () => {
    const payload = fixture(); payload.raw = 'reread-original-' + ++collected + ':' + 'x'.repeat(10_000); return payload;
  });
  const steps = full();
  steps.splice(1, 1, ...[1, 2, 3, 4, 5].map(index => call('mcp__official__op', { index })), call('session__read_tool_result', { entryId: '$first_source_result', toolCallId: '$from_transcript', offset: 0, limit: 4096 }));
  const actual = await sessionCase(steps, { client: source, runtime: { contextChars: 70_000 } });
  assert.equal(actual.result.status, 'complete', actual.result.error);
  assert.equal(actual.requests.filter(request => !request.tools?.length).length, 0);
  assert.equal(actual.source.calls.length, 5);
  const transcript = actual.data.lines<any>('sessions/' + actual.result.runId + '.jsonl');
  assert.ok(transcript.some(entry => entry.customType === 'cwatch.tool_result_view' && entry.data.mode === 'microcompact'));
  const reread = actual.state.observations.find(observation => observation.name === 'session__read_tool_result')!.result as { content: string };
  assert.match(reread.content, /reread-original-1/);
  assert.ok(actual.events.some(event => event.type === 'execution_started' && actual.data.executions().some(record => record.requestId === event.data.requestId && record.toolBinding.proxy_name === 'session__read_tool_result')));
});

check('contract', 'A large non-raw tool result reaches the next provider request only as a bounded recoverable view', async () => {
  const large = { kind: 'mcp_tool_result', isError: false, arbitraryData: 'HEAD-non-raw:' + 'x'.repeat(180_000) + ':TAIL-non-raw' };
  const actual = await sessionCase([plan(), call('mcp__official__op'), done], { client: new CountingClient([op()], async () => large) });
  assert.equal(actual.requests.length, 3); assert.match(actual.result.error!, /response_before_verified_draft/);
  const result = actual.requests[2].messages.find((message: any) => message.role === 'tool' && message.content.includes('HEAD-non-raw'));
  assert.ok(result); assert.ok(JSON.stringify(result).length < 16_000);
  assert.match(result.content, /TAIL-non-raw/); assert.match(result.content, /session__read_tool_result/);
  assert.match(JSON.stringify(actual.data.lines('sessions/' + actual.result.runId + '.jsonl')), new RegExp('x{180000}'));
  assert.equal(actual.source.calls.length, 1);
});

check('contract', 'Transcript write failure stops a real Pi subprocess before its tool can execute', async () => {
  const actual = await sessionCase([plan(), call('mcp__official__op'), done], {
    onRequest: (_request, index, _registry, data) => {
      if (index !== 1) return;
      const append = data.append.bind(data);
      data.append = (name, value) => {
        if (name.startsWith('sessions/') && (value as any).type === 'message' && (value as any).message.role === 'assistant') throw new Error('fixture_transcript_disk_failed');
        append(name, value);
      };
    },
  });
  assert.match(actual.result.error!, /fixture_transcript_disk_failed/);
  assert.equal(actual.requests.length, 1); assert.equal(actual.source.calls.length, 0);
  assert.equal(actual.data.executions().length, 0);
});
for (const status of [401, 429]) check('contract', 'Pi session preserves provider HTTP ' + status + ' failure and disables hidden retries', async () => {
  const actual = await sessionCase([{ http: status }]);
  assert.equal(actual.result.status, 'failed'); assert.match(actual.result.error!, /provider_unavailable/);
  assert.equal(actual.requests.length, 1); assert.equal(actual.source.calls.length, 0);
});
check('contract', 'Pi session returns redacted tool results to the SDK transcript and persistent Trace', async () => {
  const secret = 'fixture-source-secret-never-real';
  const payload = fixture(); payload.raw += secret;
  const actual = await sessionCase([plan(), call('mcp__official__op'), done], {
    client: new CountingClient([op()], async () => payload), runtime: { secrets: [secret, 'fixture-session-key'] },
  });
  assert.ok(!JSON.stringify(actual.requests).includes(secret));
  assert.deepEqual(validateTrace(actual.events, [secret]), []);
  assert.ok(JSON.stringify(actual.state.observations).includes('[REDACTED]'));
  assert.ok(!JSON.stringify(actual.data.lines('sessions/' + actual.result.runId + '.jsonl')).includes(secret));
});
check('contract', 'Pi session repeated decisions stop without further requests or tool execution', async () => {
  const actual = await sessionCase([call('mcp__missing__op'), call('mcp__missing__op'), call('mcp__missing__op')]);
  assert.match(actual.result.error!, /repeated identical decision/); assert.equal(actual.requests.length, 3);
  assert.equal(actual.state.observations.length, 2); assert.equal(actual.source.calls.length, 0);
});
check('contract', 'Pi session rejects a final answer before producing its verified draft', async () => {
  const actual = await sessionCase([done]);
  assert.match(actual.result.error!, /response_before_verified_draft/); assert.equal(actual.data.executions().length, 0);
});
check('contract', 'Pi session respects cancellation before startup without making a provider request', async () => {
  const controller = new AbortController(); controller.abort(new Error('user_cancelled'));
  const actual = await sessionCase([done], { signal: controller.signal });
  assert.equal(actual.result.status, 'cancelled'); assert.equal(actual.requests.length, 0);
});

for (const mode of ['ask', 'allow-all'] as const) check('integration', 'Pi AgentSession ' + mode + ' routes modifying, sending and publishing through the host policy', async () => {
  for (const action of ['modify', 'send', 'publish'] as const) {
    let prompts = 0;
    const actual = await sessionCase(full(), {
      client: new CountingClient([op(action)], async () => fixture()),
      policy: new ActionPolicy(mode),
      approvals: new ApprovalManager(async () => { prompts++; return true; }),
    });
    assert.equal(actual.result.status, 'complete', actual.result.error);
    assert.equal(actual.result.permissionMode, mode);
    assert.equal(actual.source.calls.length, 1);
    assert.equal(prompts, mode === 'ask' ? 1 : 0);
    assert.equal(actual.events[0].data.permissionMode, mode);
    assert.ok(actual.events.filter(event => event.type === 'policy_decision').every(event => event.data.effectiveMode === mode));
  }
});

function workerPid(data: FileStore): number {
  const file = readdirSync(data.path('traces')).find(name => name.endsWith('.jsonl'))!;
  const ready = data.lines<TraceEvent>('traces/' + file).find(event => event.type === 'agent_process' && event.data.state === 'ready')!;
  assert.notEqual(ready.data.pid, process.pid);
  return ready.data.pid as number;
}
check('integration', 'A killed real Pi worker leaves the host alive and a new SDK session can complete', async () => {
  const crashed = await sessionCase([{ hold: true }], { onRequest: (_request, _index, _registry, data) => { process.kill(workerPid(data), 'SIGKILL'); } });
  assert.equal(crashed.result.status, 'failed'); assert.match(crashed.result.error!, /agent_subprocess_(exit|disconnected)/);
  assert.equal(crashed.data.executions().length, 0);
  const next = await sessionCase(full());
  assert.equal(next.result.status, 'complete', next.result.error);
});
check('integration', 'A real Pi worker crash cancels its in-flight host read and preserves earlier completed work', async () => {
  const late = deferred<unknown>(); let pid = 0, aborted = false;
  const client = new CountingClient([op()], async signal => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    process.kill(pid, 'SIGKILL'); return late.promise;
  });
  const actual = await sessionCase([plan(), call('mcp__official__op')], { client, onRequest: (_request, _index, _registry, data) => { pid = workerPid(data); } });
  assert.equal(actual.result.status, 'failed'); assert.equal(aborted, true);
  const records = actual.data.executions();
  assert.equal(records.find(record => record.sourceSlug === 'official')!.state, 'cancelled');
  assert.equal(records.find(record => record.sourceSlug === 'workflow')!.state, 'completed');
  late.resolve(fixture()); await waitTick();
  assert.deepEqual(actual.data.lines('traces/' + actual.result.runId + '.jsonl'), actual.events);
});

check('contract', 'Pi output token limit reaches the actual provider request', async () => {
  const actual = await sessionCase([plan()], {runtime:{maxOutputTokens:47,maxSteps:1}});
  assert.match(actual.result.error!,/budget_iterations/);
  assert.equal(actual.requests[0].max_tokens ?? actual.requests[0].max_completion_tokens,47);
});
check('contract', 'Pi cumulative tokens reduce the next output allowance and block excess tools', async () => {
  const actual = await sessionCase([plan(),call('mcp__official__op')], {runtime:{maxTokens:200,maxOutputTokens:1000}});
  assert.match(actual.result.error!,/budget_tokens/);
  assert.equal(actual.requests.length,2);
  assert.equal(actual.requests[0].max_tokens ?? actual.requests[0].max_completion_tokens,200);
  assert.equal(actual.requests[1].max_tokens ?? actual.requests[1].max_completion_tokens,80);
  assert.equal(actual.source.calls.length,0);
  assert.equal(actual.data.executions().length,1);
  assert.equal(actual.events.find(e=>e.type==='usage_reported')!.data.totalTokens,240);
});
check('contract', 'Pi missing provider token usage stops instead of treating it as free usage', async () => {
  const actual = await sessionCase([plan()],{usage:null});
  assert.match(actual.result.error!,/budget_usage_unavailable/);
  assert.equal(actual.data.executions().length,0);
  assert.equal(actual.requests.length,1);
});
check('contract', 'Pi streamed response length stops before a tool can execute', async () => {
  const actual = await sessionCase([plan()],{runtime:{maxResponseChars:40}});
  assert.match(actual.result.error!,/budget_response_chars/);
  assert.equal(actual.data.executions().length,0);
  assert.equal(actual.requests.length,1);
  assert.ok(actual.events.some(e=>e.type==='budget_exceeded'));
});
check('contract', 'Pi model request deadline reaps the worker and records no late work', async () => {
  const actual = await sessionCase([plan(),{hold:true}],{runtime:{modelTimeoutMs:3000}});
  assert.match(actual.result.error!,/budget_model_timeout/);
  assert.equal(actual.requests.length,2);
  assert.equal(actual.source.calls.length,0);
  assert.ok(actual.events.some(e=>e.type==='agent_process' && e.data.state==='exited'));
  assert.ok(actual.events.some(e=>e.type==='budget_exceeded'));
});

check('contract','Pi refreshes permission branches and removes write tools before the next real model request',async()=>{
  const policy=new ActionPolicy('allow-all');
  const actual=await sessionCase([plan(),call('mcp__official__op'),done],{policy,client:new CountingClient([op('publish')]),onRequest:(_request,index)=>{if(index===1)policy.setMode('explore');}});
  assert.ok(actual.requests[0].tools.some((tool:any)=>tool.function.name==='mcp__official__op'));
  assert.ok(actual.requests.slice(1).every(request=>!request.tools.some((tool:any)=>tool.function.name==='mcp__official__op')));
  assert.ok(actual.requests[0].messages.some((message:any)=>typeof message.content==='string'&&message.content.includes('PERMISSION MODE: allow-all')));
  assert.ok(actual.requests[1].messages.some((message:any)=>typeof message.content==='string'&&message.content.includes('PERMISSION MODE: explore')));
  assert.equal(actual.source.calls.length,0);
  const contexts=actual.events.filter(e=>e.type==='context_prepared');
  assert.equal(contexts.length,actual.requests.length);assert.equal(contexts[1].data.permissionMode,'explore');
});
