import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { id } from '@cwatch/core/types';
import { PiBuiltinSource, PI_BUILTIN_NAMES } from '@cwatch/shared/tools/pi-builtins';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ToolExecutor } from '@cwatch/shared/tools/executor';
import { ActionPolicy, ApprovalManager, type Mode } from '@cwatch/shared/agent/core/permission-manager';
import { Trace, validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { buildProxyTools } from '@cwatch/shared/agent/backend/pi/tool-hooks';
import type { AgentSessionHooks } from '@cwatch/core/types';
import { check, store, task } from './harness.ts';

const live = new AbortController().signal;
async function localTools(mode: Mode = 'allow-all', approve = true) {
  const workspace = store(), audit = store(), registry = new ToolRegistry(), value = task();
  const trace = new Trace(audit, value.taskId, id()); trace.emit('run_started', { task: value });
  const source = new PiBuiltinSource(workspace.root, [audit.root]);
  await registry.register('pi', 'builtin', source, live);
  let approvals = 0;
  const policy = new ActionPolicy(mode), manager = new ApprovalManager(async () => { approvals++; return approve; });
  const executor = new ToolExecutor(registry, policy, manager, audit, trace, value, 10_000);
  return { workspace, audit, registry, source, policy, executor, approvals: () => approvals, finish: () => { trace.emit('run_completed'); return audit.lines<TraceEvent>(trace.key); } };
}
const textResult = (result: any): string => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');

check('integration', 'Pi SDK read write edit grep find and ls execute through the shared host executor', async () => {
  const h = await localTools('ask');
  try {
    assert.deepEqual(h.registry.list().map(tool => tool.proxy_name).sort(), [...PI_BUILTIN_NAMES].sort());
    await h.executor.execute('write', { path: 'notes/result.txt', content: 'release-marker\nfirst\n' }, live);
    await h.executor.execute('edit', { path: 'notes/result.txt', edits: [{ oldText: 'first', newText: 'updated' }] }, live);
    assert.match(textResult(await h.executor.execute('read', { path: 'notes/result.txt' }, live)), /updated/);
    assert.match(textResult(await h.executor.execute('grep', { path: 'notes', pattern: 'release-marker' }, live)), /result.txt:1/);
    assert.match(textResult(await h.executor.execute('find', { path: 'notes', pattern: '*.txt' }, live)), /result.txt/);
    assert.match(textResult(await h.executor.execute('ls', { path: 'notes' }, live)), /result.txt/);
    assert.equal(h.approvals(), 2);
    assert.equal(readFileSync(resolve(h.workspace.root, 'notes/result.txt'), 'utf8'), 'release-marker\nupdated\n');
    assert.equal(h.audit.executions().length, 6);
    const events = h.finish(); assert.deepEqual(validateTrace(events), []);
    for (const name of ['write', 'edit', 'read', 'grep', 'find', 'ls']) assert.ok(events.some(event => event.type === 'backend_started' && event.data.backend === 'pi.builtin.' + name));
  } finally { await h.registry.close(); }
});

check('contract', 'Pi builtins respect explore mode and denied writes have no filesystem side effect', async () => {
  const h = await localTools('explore');
  try {
    assert.deepEqual(h.policy.visibleTools(h.executor.task, h.registry).map(tool => tool.proxy_name).sort(), ['read', 'grep', 'find', 'ls'].sort());
    for (const [name, args] of [['write', { path: 'denied.txt', content: 'no' }], ['edit', { path: 'denied.txt', edits: [{ oldText: 'x', newText: 'y' }] }], ['bash', { command: 'printf no' }]] as const) await assert.rejects(h.executor.execute(name, args, live), /forbidden/);
    assert.equal(h.approvals(), 0); assert.ok(h.audit.executions().every(record => record.execute_count === 0));
    assert.deepEqual(validateTrace(h.finish()), []);
  } finally { await h.registry.close(); }
  const denied = await localTools('ask', false);
  try {
    await assert.rejects(denied.executor.execute('write', { path: 'denied.txt', content: 'no' }, live), /approval_denied/);
    assert.equal(denied.approvals(), 1); assert.equal(denied.audit.executions()[0].execute_count, 0);
  } finally { await denied.registry.close(); }
});

check('contract', 'Pi file tools reject traversal, private files, protected config and junction escapes', async () => {
  const h = await localTools(), outside = store();
  try {
    writeFileSync(resolve(h.workspace.root, '.env'), 'PRIVATE_FIXTURE_KEY=not-for-model');
    mkdirSync(resolve(h.workspace.root, 'sources'));
    writeFileSync(resolve(h.workspace.root, 'sources/config.json'), '{}');
    symlinkSync(outside.root, resolve(h.workspace.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['../outside.txt', '.env', 'escape/outside.txt']) await assert.rejects(h.executor.execute('read', { path }, live), /builtin_/);
    await assert.rejects(h.executor.execute('write', { path: 'sources/config.json', content: 'changed' }, live), /protected_path/);
    assert.equal(readFileSync(resolve(h.workspace.root, 'sources/config.json'), 'utf8'), '{}');
    // A workspace opened through a junction must still protect its real audit directory.
    mkdirSync(resolve(h.workspace.root, 'audit'));
    const alias = resolve(outside.root, 'workspace-alias');
    symlinkSync(h.workspace.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliased = new PiBuiltinSource(alias, [resolve(alias, 'audit')]);
    assert.equal(aliased.validateScope('write', { path: 'audit/forged.json' }), 'builtin_protected_path');
    await aliased.close();
    assert.ok(h.audit.executions().every(record => record.execute_count === 0));
    assert.deepEqual(validateTrace(h.finish()), []);
  } finally { await h.registry.close(); }
});

check('integration', 'Pi bash is approved once, runs in the selected workspace and omits host credentials', async () => {
  const h = await localTools('ask'), previous = process.env.CWATCH_PRIVATE_BUILTIN_TEST;
  process.env.CWATCH_PRIVATE_BUILTIN_TEST = 'private-fixture-value';
  try {
    const result = await h.executor.execute('bash', { command: "printf '%s' \"${CWATCH_PRIVATE_BUILTIN_TEST-unset}\"; printf 'shell-marker' > shell-result.txt" }, live);
    assert.equal(textResult(result), 'unset');
    assert.equal(readFileSync(resolve(h.workspace.root, 'shell-result.txt'), 'utf8'), 'shell-marker');
    assert.equal(h.approvals(), 1); assert.deepEqual(validateTrace(h.finish(), ['private-fixture-value']), []);
  } finally {
    if (previous === undefined) delete process.env.CWATCH_PRIVATE_BUILTIN_TEST; else process.env.CWATCH_PRIVATE_BUILTIN_TEST = previous;
    await h.registry.close();
  }
});

check('contract', 'Pi bash cancellation settles execution and suppresses late results', async () => {
  const h = await localTools(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('builtin_cancelled')), 300);
  try {
    await assert.rejects(h.executor.execute('bash', { command: 'sleep 30' }, controller.signal), /builtin_cancelled/);
    assert.equal(h.audit.executions()[0].state, 'unknown');
    const events = h.finish(); await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(h.audit.lines(h.executor.trace.key), events); assert.deepEqual(validateTrace(events), []);
  } finally { clearTimeout(timer); await h.registry.close(); }
});

check('contract', 'Pi builtin execution requires host context and the proxy returns native content blocks', async () => {
  const h = await localTools();
  try {
    await assert.rejects(h.source.callTool('ls', {}, live), /execution_context_required/);
    const binding = h.registry.binding('read');
    const content = [{ type: 'text' as const, text: 'native-result' }];
    const hooks = { executeTool: async () => ({ kind: 'pi_builtin_result', content, raw: '{}' }) } as unknown as AgentSessionHooks;
    const proxy = buildProxyTools([binding], hooks)[0];
    const result = await proxy.execute('sdk-call', {}, live, undefined, undefined as never);
    assert.deepEqual(result.content, content);
  } finally { await h.registry.close(); }
});
