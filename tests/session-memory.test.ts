import assert from 'node:assert/strict';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { id, type AgentSessionHooks } from '@cwatch/core/types';
import { SessionMemoryPolicySchema } from '@cwatch/core/types/session-memory';
import { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { PiSessionMemory, memoryRequestContract } from '@cwatch/shared/agent/backend/pi/session-memory';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { assertCompleteApiRounds } from '@cwatch/shared/agent/backend/pi/api-rounds';
import { check, store } from './harness.ts';

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const content = (goal = 'Keep current investigation state') => ({ userGoal: goal, completedWork: ['plan saved'], keyFiles: [], errorsAndFixes: [], unfinishedTasks: ['investigate'], nextSteps: ['collect evidence'], references: [], sourceGaps: [] });
async function harness(options: Partial<ReturnType<typeof SessionMemoryPolicySchema.parse>> = {}) {
  const data = store(), sessionId = id(), manager = SessionManager.inMemory(process.cwd(), { id: sessionId }), redactor = new Redactor(['memory-secret']);
  const transcript = new SessionTranscript(data, sessionId, redactor), policy = SessionMemoryPolicySchema.parse({ initializeTokens: 100, growthTokens: 50, toolCalls: 2, ...options });
  const memory = new SessionMemoryStore(data, transcript, 'task-1', policy, redactor);
  let sent = 0, headerSent = false, metered = 0;
  const requests: any[] = [];
  const flush = () => { transcript.append([...(!headerSent ? [manager.getHeader()!] : []), ...manager.getEntries().slice(sent)].map(entry => ({ ...entry }))); headerSent = true; sent = manager.getEntries().length; };
  const hooks: Pick<AgentSessionHooks, 'sessionMemory' | 'beforeRequest' | 'onUsage'> = { sessionMemory: request => memory.handle(request), beforeRequest: () => ({ maxOutputTokens: 4096 }), onUsage: (_usage, purpose) => { assert.equal(purpose, 'memory'); metered++; } };
  const archive = async (type: string, value: unknown) => { manager.appendCustomEntry(type, value); flush(); };
  const updater = new PiSessionMemory(manager, hooks, policy, 80_000, 32_000, archive);
  const { model } = await createPiRuntime('memory-fixture', 'fixture', { apiKey: 'key', baseUrl: 'http://127.0.0.1/unused' }, new AbortController().signal);
  let response: any;
  const runtime = { completeSimple: async (_model: unknown, context: any, options: { cacheRetention?: string; maxRetries?: number; maxTokens?: number; reasoning?: string }) => {
    assert.equal(options.cacheRetention, 'none');
    assert.equal(options.maxRetries, 0);
    const input = JSON.parse(context.messages[0].content); requests.push({ context, input, options });
    return (typeof response === 'function' ? response(requests.length) : response) ?? { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(content('memory revision ' + requests.length + ' memory-secret')) }], usage, stopReason: 'stop' };
  } } as unknown as ModelRuntime;
  manager.appendMessage({ role: 'user', content: 'original-task-marker', timestamp: Date.now() });
  const turn = (index: number, chars = 20) => {
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'assistant-' + index + ':' + 'x'.repeat(chars) }, { type: 'toolCall', id: 'call-' + index, name: 'mcp__source__read', arguments: { index } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
    return manager.appendMessage({ role: 'toolResult', toolCallId: 'call-' + index, toolName: 'mcp__source__read', content: [{ type: 'text', text: 'result-' + index }], isError: false, timestamp: Date.now() });
  };
  const advance = async (windowTokens: number, signal = new AbortController().signal) => { flush(); await updater.prepare(windowTokens, runtime, model, 4096, signal); };
  return { data, manager, transcript, policy, memory, updater, hooks, requests, turn, advance, setResponse: (value: unknown) => { response = value; }, metered: () => metered };
}

check('contract', 'Session memory initializes by context threshold and incrementally updates by window growth or tool count across shrinkage', async () => {
  const h = await harness(); const first = h.turn(1);
  await h.advance(99); assert.equal(h.memory.load(), null);
  await h.advance(100); const one = h.memory.load()!;
  assert.equal(one.lastMessageId, first); assert.equal(one.revision, 1); assert.equal(one.toolCallCount, 1);
  assert.equal(one.policy.initializeTokens, 100); assert.ok(!JSON.stringify(one).includes('memory-secret'));
  h.turn(2); await h.advance(120); assert.equal(h.requests.length, 1);
  const third = h.turn(3); await h.advance(90); // Window shrinks, but two tools still trigger an update.
  assert.equal(h.requests.length, 2); assert.equal(h.memory.load()!.lastMessageId, third);
  assert.equal(h.memory.load()!.toolCallsSinceUpdate, 2);
  assert.equal(h.requests[1].input.currentMemory.userGoal, one.content.userGoal);
  assert.ok(!JSON.stringify(h.requests[1].input.newMessages).includes('original-task-marker'));
  assert.ok(!JSON.stringify(h.requests[1].input.newMessages).includes('assistant-1:'));
  assert.match(JSON.stringify(h.requests[1].input.newMessages), /assistant-2:/);
  h.turn(4); await h.advance(150); assert.equal(h.requests.length, 3);
  assert.equal(h.memory.load()!.windowGrowthTokens, 60); assert.equal(h.memory.load()!.toolCallCount, 4);
  await h.advance(1000); assert.equal(h.requests.length, 3); assert.equal(h.metered(), 3);
  assert.ok(h.requests.every(request => !request.context.tools && !JSON.stringify(request.input).includes('cwatch.memory_request')));
});

check('contract', 'Thinking-only memory exhaustion recovers once using fresh allowance and complete rounds without skipping backlog', async () => {
  const h = await harness(); const first = h.turn(1); h.turn(2); h.turn(3);
  let allowances = 0;
  h.hooks.beforeRequest = () => { allowances++; return { maxOutputTokens: 2048 }; };
  h.setResponse((index: number) => index === 1 ? { content: [{ type: 'thinking', thinking: 'unfinished reasoning' }], usage, stopReason: 'length' } : undefined);
  await h.advance(100);
  assert.equal(allowances, 2); assert.equal(h.metered(), 2);
  assert.deepEqual(h.requests.map(request => request.options.maxTokens), [1024, 2048]);
  assert.equal(h.memory.load()!.revision, 1); assert.equal(h.memory.load()!.lastMessageId, first);
  assert.equal(h.memory.load()!.pendingMessages, true);
  assert.ok(h.requests[1].input.newMessages.length < h.requests[0].input.newMessages.length);
  assertCompleteApiRounds(h.requests[1].input.newMessages.map((entry: any) => entry.message));
  assert.ok(!JSON.stringify(h.requests[1].input).includes('unfinished reasoning'));
  await h.advance(100); assert.equal(h.memory.load()!.pendingMessages, false);
  assert.equal(h.memory.load()!.toolCallCount, 3);
});

check('contract', 'Repeated truncated memory stops at two metered attempts and retains the previous checkpoint', async () => {
  const h = await harness(); h.turn(1); await h.advance(100); const before = h.memory.load();
  h.turn(2); h.setResponse({ content: [{ type: 'thinking', thinking: 'still thinking' }], usage, stopReason: 'length' });
  await assert.rejects(h.advance(200), /output limit exhausted after 2 attempts/);
  assert.equal(h.requests.length, 3); assert.equal(h.metered(), 3); assert.deepEqual(h.memory.load(), before);
  const recovery = h.manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'cwatch.memory_recovery');
  assert.deepEqual(recovery.map(entry => (entry as any).data.action), ['retry', 'stop']);
});

check('contract', 'Memory recovery honors cancellation, fresh budget and usage failures before another physical request', async () => {
  for (const stage of ['cancel', 'budget', 'usage', 'missing_usage'] as const) {
    const h = await harness(); h.turn(1); await h.advance(100); const before = h.memory.load();
    h.turn(2); const controller = new AbortController(); let allowance = 0;
    h.hooks.beforeRequest = () => { if (++allowance === 2 && stage === 'budget') throw new Error('retry-budget'); return { maxOutputTokens: 2048 }; };
    h.hooks.onUsage = () => { if (stage === 'cancel') controller.abort(new Error('retry-cancel')); if (stage === 'usage') throw new Error('retry-usage'); };
    h.setResponse({ content: [{ type: 'thinking', thinking: 'partial' }], usage: stage === 'missing_usage' ? undefined : usage, stopReason: 'length' });
    await assert.rejects(h.advance(200, controller.signal), /retry-budget|retry-cancel|retry-usage|usage_unavailable/);
    assert.equal(h.requests.length, 2); assert.deepEqual(h.memory.load(), before);
  }
});

check('contract', 'Memory low reasoning and JSON wire parameters are scoped to verified Step 5 endpoints', async () => {
  const signal = new AbortController().signal;
  const { model, runtime } = await createPiRuntime('memory-step5', 'step-5-preview', { apiKey: 'fixture-key', baseUrl: 'https://api.stepfun.com/v1' }, signal);
  for (const baseUrl of ['https://api.stepfun.ai/v1', 'https://api.stepfun.com/v1']) {
    assert.equal(memoryRequestContract({ ...model, baseUrl }).reasoning, 'low');
  }
  for (const override of [{ baseUrl: 'https://other.example/v1' }, { baseUrl: 'http://api.stepfun.com/v1' }, { id: 'other-model' }]) {
    assert.deepEqual(memoryRequestContract({ ...model, ...override }), {});
  }
  let sent: any;
  const response = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Return JSON', timestamp: 1 }] }, {
    ...memoryRequestContract(model), signal, maxTokens: 1024, maxRetries: 0, cacheRetention: 'none',
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(response.stopReason, 'stop'); assert.equal(sent.reasoning_effort, 'low');
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 1024); assert.equal(sent.tools, undefined);
});

check('contract', 'Session memory batches complete rounds without dropping backlog or advancing through half a tool pair', async () => {
  const h = await harness({ maxInputChars: 3000 });
  for (let i = 1; i <= 4; i++) h.turn(i, 700);
  await h.advance(100); assert.equal(h.memory.load()!.pendingMessages, true);
  while (h.memory.load()!.pendingMessages) await h.advance(100);
  assert.equal(h.requests.length, 4);
  const ids = h.requests.flatMap(request => request.input.newMessages.map((entry: any) => entry.entryId));
  assert.equal(new Set(ids).size, 9); assert.equal(ids.length, 9);
  for (const request of h.requests) assertCompleteApiRounds(request.input.newMessages.map((entry: any) => entry.message));
  const other = await harness({ maxInputChars: 1024 }); other.turn(1, 10_000);
  await assert.rejects(other.advance(100), /session_memory_delta_too_large/); assert.equal(other.memory.load(), null);
});

check('contract', 'Failed, unmetered, malformed or cancelled memory responses preserve the previous durable cursor', async () => {
  for (const response of [
    { content: [{ type: 'text', text: 'vague summary' }], usage, stopReason: 'stop' },
    { content: [{ type: 'text', text: JSON.stringify(content()) }], usage, stopReason: 'length' },
    { content: [{ type: 'text', text: JSON.stringify(content()) }], usage: undefined, stopReason: 'stop' },
    { content: [{ type: 'toolCall', id: 'forged', name: 'mcp__source__write', arguments: {} }], usage, stopReason: 'toolUse' },
  ]) {
    const h = await harness(); h.turn(1); await h.advance(100); const before = h.memory.load();
    h.turn(2); h.setResponse(response);
    await assert.rejects(h.advance(200), /session_memory_update_failed|usage_unavailable/);
    assert.deepEqual(h.memory.load(), before);
  }
  const h = await harness(); h.turn(1); await h.advance(100); const before = h.memory.load();
  h.turn(2); const controller = new AbortController(); controller.abort(new Error('cancel-memory'));
  await assert.rejects(h.advance(200, controller.signal), /cancel-memory/); assert.deepEqual(h.memory.load(), before);
});

check('contract', 'Host memory persistence rejects stale revisions, foreign or regressing cursors, corruption and write failures', async () => {
  const h = await harness(); h.turn(1); await h.advance(100); const saved = h.memory.load()!;
  const update = { expectedRevision: saved.revision, lastMessageId: saved.lastMessageId, windowTokens: 100, windowGrowthTokens: 0, pendingMessages: false, content: content() };
  assert.throws(() => h.memory.handle({ operation: 'commit', update: { ...update, expectedRevision: 0 } }), /revision_conflict/);
  assert.throws(() => h.memory.handle({ operation: 'commit', update }), /cursor_not_advanced/);
  assert.throws(() => h.memory.handle({ operation: 'commit', update: { ...update, lastMessageId: 'foreign-id' } }), /current_session/);
  h.turn(2); const write = h.data.write.bind(h.data);
  const assistant = h.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1)!;
  await h.advance(110);
  assert.throws(() => h.memory.handle({ operation: 'commit', update: { ...update, lastMessageId: assistant.id } }), /incomplete_round/);
  h.data.write = (path, value) => { if (path === h.memory.key) throw new Error('memory-disk-failure'); write(path, value); };
  await assert.rejects(h.advance(200), /memory-disk-failure/); assert.deepEqual(h.memory.load(), saved);
  h.data.write = write;
  const disk = h.data.read<any>(h.memory.key, null); disk.memory.content.userGoal = 'tampered'; h.data.write(h.memory.key, disk);
  assert.throws(() => h.memory.load(), /snapshot_mismatch/);
});

check('contract', 'Memory request and usage budgets or mid-update cancellation cannot advance a durable checkpoint', async () => {
  for (const stage of ['before_request', 'usage_budget', 'cancel'] as const) {
    const h = await harness(); h.turn(1); await h.advance(100); const before = h.memory.load();
    h.turn(2); const controller = new AbortController();
    if (stage === 'before_request') h.hooks.beforeRequest = () => { throw new Error('memory-request-budget'); };
    else h.hooks.onUsage = () => { if (stage === 'cancel') controller.abort(new Error('cancel-during-memory')); else throw new Error('memory-token-budget'); };
    await assert.rejects(h.advance(200, controller.signal), /memory-request-budget|memory-token-budget|cancel-during-memory/);
    assert.deepEqual(h.memory.load(), before);
    if (stage === 'before_request') assert.equal(h.requests.length, 1);
  }
});
