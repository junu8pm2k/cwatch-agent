import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { check, deferred, executionHarness, store, task, waitTick } from './harness.ts';
import { ActionPolicy, parsePermissionMode, PERMISSION_MODES, type Mode } from "@cwatch/shared/agent/core/permission-manager";
import { validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { type Action, type ToolExecutionContext } from "@cwatch/core/types";

const live = new AbortController().signal;
const actions: Action[] = ['collect', 'analyze', 'local_draft', 'modify', 'send', 'publish'];
const expected = {
  explore: ['ALLOW', 'ALLOW', 'ALLOW', 'BLOCK', 'BLOCK', 'BLOCK'],
  ask: ['ALLOW', 'ALLOW', 'ALLOW', 'APPROVAL', 'APPROVAL', 'APPROVAL'],
  'allow-all': ['ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'ALLOW', 'ALLOW'],
} as const;
function start(h: Awaited<ReturnType<typeof executionHarness>>) { h.trace.emit('run_started', { task: task(), permissionMode: h.policy.mode }); }
function finish(h: Awaited<ReturnType<typeof executionHarness>>) {
  h.trace.emit('run_completed', { permissionMode: h.policy.mode });
  const events = h.data.lines<TraceEvent>(h.trace.key);
  assert.deepEqual(validateTrace(events), []);
  return events;
}
check('contract', 'permission mode parser defaults to explore and normalizes the legacy safe alias', () => {
  assert.deepEqual(PERMISSION_MODES, ['explore', 'ask', 'allow-all']);
  assert.equal(parsePermissionMode(), 'explore'); assert.equal(parsePermissionMode('safe'), 'explore');
  assert.equal(new ActionPolicy().mode, 'explore'); assert.equal(new ActionPolicy('safe').mode, 'explore');
  const policy = new ActionPolicy('allow-all'); policy.setMode('safe'); assert.equal(policy.mode, 'explore');
});
check('contract', 'invalid runtime modes fail without changing the effective host mode', () => {
  const policy = new ActionPolicy('ask');
  for (const value of ['', 'all', 'ALLOW-ALL', 'prompt', null, 1, { mode: 'allow-all' }]) {
    assert.throws(() => parsePermissionMode(value), /permission must be/);
    assert.throws(() => policy.setMode(value as Mode), /permission must be/);
    assert.equal(policy.mode, 'ask');
    assert.throws(() => new ActionPolicy(value as Mode), /permission must be/);
  }
});
for (const mode of PERMISSION_MODES) check('contract', mode + ' enforces the independent six-action permission matrix through ToolExecutor', async () => {
  for (let index = 0; index < actions.length; index++) {
    let prompts = 0;
    const h = await executionHarness({ mode, action: actions[index], responder: async () => { prompts++; return true; } });
    start(h);
    const verdict = expected[mode][index];
    if (verdict === 'BLOCK') await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /write_action_forbidden_in_explore/);
    else await h.executor.execute('mcp__official__op', {}, live);
    assert.equal(h.client.calls.length, verdict === 'BLOCK' ? 0 : 1);
    assert.equal(prompts, verdict === 'APPROVAL' ? 1 : 0);
    const events = finish(h), policy = events.find(event => event.type === 'policy_decision')!;
    assert.equal(policy.data.decision, verdict); assert.equal(policy.data.effectiveMode, mode);
    await h.registry.close();
  }
});
for (const answer of ['denied', 'unavailable'] as const) check('contract', 'ask modification ' + answer + ' has zero executions', async () => {
  const h = await executionHarness({ mode: 'ask', action: 'modify', responder: answer === 'denied' ? async () => false : undefined });
  start(h); await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /approval_/);
  assert.equal(h.client.calls.length, 0); assert.equal(h.approvals.pending.size, 0); finish(h);
});
check('contract', 'allow-all still rejects unknown tools, schemas, task scope, source scope and stale/inactive bindings', async () => {
  const h = await executionHarness({ mode: 'allow-all', action: 'modify' }); start(h);
  await assert.rejects(h.executor.execute('mcp__missing__op', {}, live), /unknown_tool/);
  await assert.rejects(h.executor.execute('mcp__official__op', { injected: true }, live), /invalid_tool_arguments/);
  await h.registry.register('other', 'mcp', h.client, live);
  await assert.rejects(h.executor.execute('mcp__other__op', {}, live), /source_outside_task/);
  Object.assign(h.client, { validateScope: () => 'fixture_outside_scope' });
  await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /fixture_outside_scope/);
  Object.assign(h.client, { validateScope: () => undefined });
  const stale = h.registry.binding('mcp__official__op'); await h.registry.register('official', 'mcp', h.client, live);
  await assert.rejects(h.executor.execute('mcp__official__op', {}, live, stale), /stale_binding/);
  h.registry.setActive('official', false);
  await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /inactive_source/);
  assert.equal(h.client.calls.length, 0); assert.ok(h.data.executions().every(record => record.execute_count === 0)); finish(h);
});
check('contract', 'allow-all does not permit undeclared action semantics', async () => {
  const h = await executionHarness({ mode: 'allow-all', action: 'unknown' as Action }); start(h);
  await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /unknown_semantics/);
  assert.equal(h.client.calls.length, 0); finish(h);
});
for (const next of ['explore', 'ask'] as const) check('contract', 'allow-all downgrade to ' + next + ' is checked before the next backend action', async () => {
  const h = await executionHarness({ mode: 'allow-all', action: 'modify' }); start(h);
  let backendCalls = 0;
  Object.assign(h.client, { callTool: async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, context?: ToolExecutionContext) => {
    h.policy.setMode(next);
    return context!.stage('fixture.http', async () => { backendCalls++; return { ok: true }; });
  } });
  await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /backend_policy_block/);
  assert.equal(backendCalls, 0); assert.equal(h.policy.mode, next);
  const events = finish(h); assert.equal(events.find(event => event.type === 'backend_policy')!.data.effectiveMode, next);
});
check('contract', 'allow-all backend calls retain permission stages and Trace', async () => {
  const h = await executionHarness({ mode: 'allow-all', action: 'modify' }); start(h);
  let calls = 0;
  Object.assign(h.client, { callTool: async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, context?: ToolExecutionContext) =>
    context!.stage('fixture.http', async () => { calls++; return { ok: true }; }) });
  await h.executor.execute('mcp__official__op', {}, live); assert.equal(calls, 1);
  const events = finish(h);
  assert.equal(events.find(event => event.type === 'backend_policy')!.data.effectiveMode, 'allow-all');
  assert.equal(events.filter(event => event.type === 'backend_started').length, 1);
});
check('contract', 'allow-all cancellation keeps an in-flight modification unknown and rejects its late result', async () => {
  const late = deferred<unknown>(), controller = new AbortController();
  const h = await executionHarness({ mode: 'allow-all', action: 'modify', handler: async () => late.promise }); start(h);
  const running = h.executor.execute('mcp__official__op', {}, controller.signal); await waitTick();
  controller.abort(new Error('cancelled')); await assert.rejects(running);
  assert.equal(h.data.executions()[0].state, 'unknown');
  const events = finish(h); late.resolve({ ok: true }); await waitTick();
  assert.deepEqual(h.data.lines(h.trace.key), events);
});
check('contract', 'allow-all still enforces tool timeout for modifications', async () => {
  const h = await executionHarness({ mode: 'allow-all', action: 'modify', handler: async () => new Promise(() => {}) }); start(h);
  await assert.rejects(h.executor.execute('mcp__official__op', {}, live), /timeout/i);
  assert.equal(h.data.executions()[0].state, 'unknown'); finish(h);
});
check('contract', 'historical safe-mode Trace remains valid while unknown mode values are rejected', async () => {
  const h = await executionHarness(); start(h); await h.executor.execute('mcp__official__op', {}, live);
  const events = finish(h), historical = structuredClone(events);
  for (const event of historical) { delete event.schemaVersion; if ('effectiveMode' in event.data) event.data.effectiveMode = 'safe'; }
  assert.deepEqual(validateTrace(historical), []);
  historical.find(event => event.type === 'policy_decision')!.data.effectiveMode = 'bogus';
  assert.ok(validateTrace(historical).includes('policy fields missing or duplicate'));
});
for (const [label, value, canonical] of [
  ['default', undefined, 'explore'], ['explore', 'explore', 'explore'],
  ['ask', 'ask', 'ask'], ['allow-all', 'allow-all', 'allow-all'], ['legacy safe', 'safe', 'explore'],
] as const) check('integration', 'CLI ' + label + ' mode runs replay and records its canonical mode', () => {
  const data = store();
  const args = ['--experimental-transform-types', "apps/cli/src/index.ts", 'run', '--mode', 'replay', '--out', data.root, ...(value ? ['--permission', value] : [])];
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.status, 'complete'); assert.equal(result.permissionMode, canonical);
  const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
  assert.equal(events[0].data.permissionMode, canonical);
  assert.ok(events.filter(event => event.type === 'policy_decision').every(event => event.data.effectiveMode === canonical));
  assert.deepEqual(validateTrace(events), []);
});
check('contract', 'CLI rejects invalid permission flags before creating or recovering an output directory', () => {
  const output = store().path('invalid-permission-output');
  assert.equal(existsSync(output), false);
  assert.throws(() => execFileSync(process.execPath, ['--experimental-transform-types', "apps/cli/src/index.ts", 'run', '--permission', 'all', '--out', output], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
    assert.match(String((error as { stderr: string }).stderr), /permission must be explore, ask, or allow-all/);
    return true;
  });
  assert.equal(existsSync(output), false);
});
