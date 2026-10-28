import assert from 'node:assert/strict';
import { type ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent';
import { check, deferred, emptySchema, executionHarness, task, waitTick } from './harness.ts';
import { runPreToolUseChecks } from "@cwatch/shared/agent/core/pre-tool-use";
import { requestPreToolUseApproval, type PreToolUseRequest } from "@cwatch/shared/agent/pre-tool-use";
import { buildProxyTools, wrapSingleTool, wrapTool, wrapToolsWithHooks } from "@cwatch/shared/agent/backend/pi/tool-hooks";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { type AgentSessionHooks, type ToolExecutionContext } from "@cwatch/core/types";
import { validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";

const live = new AbortController().signal;
type Harness = Awaited<ReturnType<typeof executionHarness>>;
function checkInput(h: Harness) { return { toolName: 'mcp__official__op', input: {}, task: task(), binding: h.registry.binding('mcp__official__op'), registry: h.registry, policy: h.policy }; }
function start(h: Harness) { h.trace.emit('run_started', { task: task(), toolPipeline: 'pre-tool-use-v1' }); }
function finish(h: Harness) { h.trace.emit('run_completed'); const events = h.data.lines<TraceEvent>(h.trace.key); assert.deepEqual(validateTrace(events), []); return events; }
const reorder = (events: TraceEvent[]) => events.map((event, index) => ({ ...event, sequence: index + 1 }));

check('contract', 'runPreToolUseChecks returns allow/prompt/block from the current host mode without executing tools', async () => {
  const h = await executionHarness({ action: 'modify', mode: 'ask' }), input = checkInput(h);
  assert.equal(runPreToolUseChecks(input).type, 'prompt');
  h.policy.setMode('explore'); assert.equal(runPreToolUseChecks(input).type, 'block');
  h.policy.setMode('allow-all'); assert.equal(runPreToolUseChecks(input).type, 'allow');
  assert.equal(h.client.calls.length, 0); assert.equal(h.data.executions().length, 0);
});
check('contract', 'shared pre-tool checks reject mismatched names, schema and inactive sources before execution', async () => {
  const h = await executionHarness({ mode: 'allow-all' }), input = checkInput(h);
  assert.match(runPreToolUseChecks({ ...input, toolName: 'mcp__other__op' }).reason, /binding_name_mismatch/);
  assert.match(runPreToolUseChecks({ ...input, input: { extra: true } }).reason, /invalid_tool_arguments/);
  h.registry.setActive('official', false); assert.match(runPreToolUseChecks(input).reason, /inactive_source/);
  assert.equal(h.client.calls.length, 0);
});
check('contract', 'allow-all cannot bypass a business prerequisite in the shared pre-tool pipeline', async () => {
  const h = await executionHarness({ mode: 'allow-all' });
  const input = { ...checkInput(h), prerequisiteManager: { checkPrerequisites: () => ({ allowed: false, blockReason: 'fixture_plan_required' }) } };
  assert.deepEqual(runPreToolUseChecks(input), { type: 'block', source: 'prerequisite', reason: 'fixture_plan_required' });
  const executor = new ToolExecutor(h.registry, h.policy, h.approvals, h.data, h.trace, task(), 500, input.prerequisiteManager);
  start(h); await assert.rejects(executor.execute('mcp__official__op', {}, live), /fixture_plan_required/);
  assert.equal(h.client.calls.length, 0); assert.equal(h.data.executions()[0].execute_count, 0);
  const events = finish(h); assert.equal(events.find(event => event.type === 'pre_tool_use_response')!.data.action, 'block');
});
check('contract', 'pre-tool prerequisite errors become explicit block results', async () => {
  const h = await executionHarness();
  const result = runPreToolUseChecks({ ...checkInput(h), prerequisiteManager: { checkPrerequisites: () => { throw new Error('fixture_guard_failed'); } } });
  assert.equal(result.type, 'block'); assert.match(result.reason, /pre_tool_check_failed.*fixture_guard_failed/);
  assert.equal(h.client.calls.length, 0);
});
check('contract', 'pre_tool_use_response is correlated to SDK call, execution, task, binding and arguments', async () => {
  const h = await executionHarness(); start(h);
  await h.executor.execute('mcp__official__op', {}, live, undefined, 'sdk-fixture-call');
  const events = finish(h), request = events.find(event => event.type === 'pre_tool_use_request')!, response = events.find(event => event.type === 'pre_tool_use_response')!, execution = events.find(event => event.type === 'execution_started')!;
  assert.equal(response.data.action, 'allow'); assert.equal(response.data.requestId, execution.data.requestId);
  for (const key of ['requestId', 'taskId', 'toolName', 'bindingId', 'argsHash', 'sdkToolCallId']) assert.equal(response.data[key], request.data[key]);
  assert.equal(h.data.executions()[0].sdkToolCallId, 'sdk-fixture-call');
  assert.ok(events.indexOf(request) < events.indexOf(response) && events.indexOf(response) < events.indexOf(execution));
});
check('contract', 'host pre-tool bridge blocks a mismatched request instead of granting an approval', async () => {
  let prompts = 0;
  const h = await executionHarness({ action: 'modify', mode: 'ask', responder: async () => { prompts++; return true; } });
  const request: PreToolUseRequest = { type: 'pre_tool_use_request', requestId: 'fixture-request', taskId: task().taskId, toolName: 'mcp__official__op', bindingId: h.registry.binding('mcp__official__op').id, argsHash: 'forged-hash', input: {} };
  const response = await requestPreToolUseApproval(request, { ...checkInput(h), approvals: h.approvals, trace: h.trace }, live);
  assert.equal(response.type, 'pre_tool_use_response'); assert.equal(response.action, 'block');
  assert.match(response.reason, /pre_tool_request_mismatch/); assert.equal(prompts, 0); assert.equal(h.client.calls.length, 0);
});
check('contract', 'shared prerequisites are rechecked after approval before any tool executes', async () => {
  let ready = true;
  const h = await executionHarness({ action: 'modify', mode: 'ask', responder: async () => { ready = false; return true; } }); start(h);
  const executor = new ToolExecutor(h.registry, h.policy, h.approvals, h.data, h.trace, task(), 500, {
    checkPrerequisites: () => ({ allowed: ready, blockReason: 'fixture_prerequisite_changed' }),
  });
  await assert.rejects(executor.execute('mcp__official__op', {}, live), /policy_changed_or_unapproved/);
  assert.equal(h.client.calls.length, 0); assert.equal(h.approvals.pending.size, 0); finish(h);
});
check('contract', 'pre-tool approval occurs once even with multiple backend policy rechecks', async () => {
  let prompts = 0, backendCalls = 0;
  const h = await executionHarness({ action: 'modify', mode: 'ask', responder: async () => { prompts++; return true; } }); start(h);
  Object.assign(h.client, { callTool: async (_name: string, _args: unknown, _signal: AbortSignal, context?: ToolExecutionContext) => {
    await context!.stage('fixture.first', async () => { backendCalls++; });
    return context!.stage('fixture.second', async () => { backendCalls++; return { ok: true }; });
  } });
  await h.executor.execute('mcp__official__op', {}, live);
  assert.equal(prompts, 1); assert.equal(backendCalls, 2);
  const events = finish(h);
  assert.equal(events.filter(event => event.type === 'pre_tool_use_request').length, 1);
  assert.equal(events.filter(event => event.type === 'pre_tool_use_response').length, 1);
});
check('contract', 'shared prerequisites are checked again immediately before a backend request', async () => {
  let ready = true, backendCalls = 0;
  const h = await executionHarness({ mode: 'allow-all' }); start(h);
  const executor = new ToolExecutor(h.registry, h.policy, h.approvals, h.data, h.trace, task(), 500, { checkPrerequisites: () => ({ allowed: ready, blockReason: 'fixture_stage_prerequisite' }) });
  Object.assign(h.client, { callTool: async (_name: string, _args: unknown, _signal: AbortSignal, context?: ToolExecutionContext) => {
    ready = false; return context!.stage('fixture.http', async () => { backendCalls++; return {}; });
  } });
  await assert.rejects(executor.execute('mcp__official__op', {}, live), /backend_policy_block/); assert.equal(backendCalls, 0); finish(h);
});
check('contract', 'cancelled pre-tool approval produces one block response and no late execution', async () => {
  const answer = deferred<boolean>(), controller = new AbortController();
  const h = await executionHarness({ action: 'modify', mode: 'ask', responder: async () => answer.promise }); start(h);
  const pending = h.executor.execute('mcp__official__op', {}, controller.signal); await waitTick(); controller.abort(new Error('fixture_cancel'));
  await assert.rejects(pending); const events = finish(h);
  assert.equal(events.filter(event => event.type === 'pre_tool_use_response').length, 1);
  assert.equal(events.find(event => event.type === 'pre_tool_use_response')!.data.action, 'block');
  answer.resolve(true); await waitTick(); assert.equal(h.client.calls.length, 0); assert.deepEqual(h.data.lines(h.trace.key), events);
});
check('contract', 'Trace rejects missing, mismatched, replayed or blocking pre-tool responses before execution', async () => {
  const h = await executionHarness(); start(h); await h.executor.execute('mcp__official__op', {}, live);
  const events = finish(h), response = events.findIndex(event => event.type === 'pre_tool_use_response');
  const missing = reorder(events.filter((_, index) => index !== response));
  assert.ok(validateTrace(missing).includes('execution without pre-tool allow'));
  const forged = structuredClone(events); forged[response].data.argsHash = 'forged';
  assert.ok(validateTrace(forged).includes('invalid pre-tool response'));
  const replayed = reorder([...events.slice(0, response + 1), events[response], ...events.slice(response + 1)]);
  assert.ok(validateTrace(replayed).includes('invalid pre-tool response'));
  const blocked = structuredClone(events); blocked[response].data.action = 'block';
  assert.ok(validateTrace(blocked).includes('execution without pre-tool allow'));
});
check('contract', 'Trace still accepts historical executions without the new pre-tool protocol', async () => {
  const h = await executionHarness(); start(h); await h.executor.execute('mcp__official__op', {}, live);
  const events = structuredClone(finish(h)); delete events[0].data.toolPipeline;
  assert.deepEqual(validateTrace(reorder(events.filter(event => !event.type.startsWith('pre_tool_use_')))), []);
});

const extensionContext = {} as Parameters<PiToolDefinition['execute']>[4];
check('contract', 'wrapTool preserves schema, arguments, tool identity, context and progress forwarding', async () => {
  let progressCalls = 0;
  const params = { fixture: true }, progress: NonNullable<Parameters<PiToolDefinition['execute']>[3]> = () => { progressCalls++; };
  const original: PiToolDefinition = {
    name: 'fixture', label: 'fixture', description: 'test', parameters: emptySchema as PiToolDefinition['parameters'],
    execute: async function(callId, input, signal, onUpdate, context) {
      assert.equal(this, original); assert.equal(callId, 'fixture-call'); assert.equal(input, params); assert.equal(context, extensionContext);
      assert.equal(signal!.aborted, false); onUpdate!({ content: [], details: 'progress' });
      return { content: [{ type: 'text', text: 'ok' }], details: 'result' };
    },
  };
  assert.equal(wrapTool, wrapSingleTool);
  const wrapped = wrapToolsWithHooks([original], { signal: live, throwIfStopped: () => {} })[0];
  assert.equal(wrapped.parameters, original.parameters); assert.notEqual(wrapped.execute, original.execute);
  const result = await wrapped.execute('fixture-call', params, undefined, progress, extensionContext);
  assert.equal(result.details, 'result'); assert.equal(progressCalls, 1);
});
check('contract', 'wrapTool rejects cancellation and fatal session state before the original execute', async () => {
  let calls = 0;
  const original: PiToolDefinition = { name: 'fixture', label: 'fixture', description: '', parameters: emptySchema as PiToolDefinition['parameters'], execute: async () => { calls++; return { content: [], details: null }; } };
  const controller = new AbortController(); controller.abort(new Error('fixture_cancelled'));
  await assert.rejects(wrapTool(original, { signal: controller.signal, throwIfStopped: () => {} }).execute('id', {}, undefined, undefined, extensionContext), /fixture_cancelled/);
  await assert.rejects(wrapTool(original, { signal: live, throwIfStopped: () => { throw new Error('fixture_stopped'); } }).execute('id', {}, undefined, undefined, extensionContext), /fixture_stopped/);
  assert.equal(calls, 0);
});
check('contract', 'wrapTool propagates a tool error and rejects a late result after cancellation', async () => {
  const late = deferred<any>(), controller = new AbortController();
  const original: PiToolDefinition = { name: 'fixture', label: 'fixture', description: '', parameters: emptySchema as PiToolDefinition['parameters'], execute: async () => late.promise };
  const running = wrapTool(original, { signal: controller.signal, throwIfStopped: () => {} }).execute('id', {}, undefined, undefined, extensionContext);
  controller.abort(new Error('fixture_cancelled')); late.resolve({ content: [], details: 'late' });
  await assert.rejects(running, /fixture_cancelled/);
  original.execute = async () => { throw new Error('fixture_tool_failed'); };
  await assert.rejects(wrapTool(original, { signal: live, throwIfStopped: () => {} }).execute('id', {}, undefined, undefined, extensionContext), /fixture_tool_failed/);
});
check('contract', 'buildProxyTools snapshots bindings and forwards SDK toolCallId to the host', async () => {
  const h = await executionHarness(), bindings = h.registry.list(); let observed: unknown;
  const hooks: AgentSessionHooks = {
    beforeModel: () => { throw new Error('unused'); }, onDecision: () => {}, onObservation: () => {}, onUsage: () => {},
    executeTool: async (name, args, signal, binding, callId) => { observed = { name, args, original: binding!.original_name, callId, aborted: signal.aborted }; return { ok: true }; },
  };
  const proxy = buildProxyTools(bindings, hooks)[0]; bindings[0].original_name = 'tampered';
  const wrapped = wrapTool(proxy, { signal: live, throwIfStopped: () => {} });
  await wrapped.execute('sdk-id', {}, undefined, undefined, extensionContext);
  assert.deepEqual(observed, { name: 'mcp__official__op', args: {}, original: 'op', callId: 'sdk-id', aborted: false });
  assert.equal(h.client.calls.length, 0);
});
