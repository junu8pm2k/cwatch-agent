import assert from 'node:assert/strict';
import { check, CountingClient, deferred, emptySchema, fixture, store, task, waitTick } from './harness.ts';
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
import { runPiSubprocess, workerEnvironment } from "@cwatch/shared/agent/backend/pi/subprocess";
import { validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { type ModelPort } from "@cwatch/core/types";

async function faultyCase(mode: string, options: { ask?: boolean; pendingTool?: boolean; shortStartup?: boolean } = {}) {
  const data = store(), registry = new ToolRegistry(), lateApproval = deferred<boolean>(), lateTool = deferred<unknown>();
  let toolAborted = false, prompted = false;
  const client = new CountingClient([{ name: 'op', description: 'host publish', action: 'publish', inputSchema: emptySchema }], async signal => {
    signal.addEventListener('abort', () => { toolAborted = true; }, { once: true });
    return options.pendingTool ? lateTool.promise : fixture();
  });
  await registry.register('official', 'mcp', client, new AbortController().signal);
  const approvals = new ApprovalManager(async () => { prompted = true; return lateApproval.promise; });
  const model: ModelPort = {
    decide: async () => { throw new Error('unused'); },
    runSession: (input, hooks, signal) => runPiSubprocess({ provider: 'fixture', modelId: 'fixture', apiKey: 'fixture-ipc-secret' }, { ...input, volatile: mode }, hooks, signal, {
      workerPath: new URL('./fixtures/pi-worker.ts', import.meta.url), shutdownMs: 100, startupMs: options.shortStartup ? 100 : 5_000,
    }),
  };
  const started = Date.now();
  const result = await runInvestigation({ ...task(), allowedSources: ['official'] }, model, registry, data, 'replay', { timeoutMs: 8_000, toolTimeoutMs: mode === 'omit-execute' ? 250 : 3_000 }, undefined, new ActionPolicy(options.ask ? 'ask' : 'allow-all'), approvals);
  const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
  assert.equal(result.status, 'failed', result.error);
  assert.deepEqual(validateTrace(events, ['fixture-ipc-secret']), []);
  assert.equal(approvals.pending.size, 0);
  assert.ok(events.some(event => event.type === 'agent_process' && event.data.state === 'exited'));
  const childPid = events.find(event => event.type === 'agent_process' && event.data.state === 'started')!.data.pid as number;
  assert.notEqual(childPid, process.pid);
  assert.throws(() => process.kill(childPid, 0), 'worker must be reaped before run terminal');
  lateApproval.resolve(true); lateTool.resolve(fixture()); await waitTick();
  assert.deepEqual(data.lines('traces/' + result.runId + '.jsonl'), events);
  await registry.close();
  return { result, events, data, client, toolAborted, prompted, durationMs: Date.now() - started };
}
check('contract', 'Agent worker environment excludes host source tokens, model keys and Node preload options', () => {
  assert.deepEqual(workerEnvironment({ PATH: '/node', SystemRoot: 'C:/Windows', HTTPS_PROXY: 'http://proxy', SEARCH_MCP_TOKEN: 'secret', API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', NODE_OPTIONS: '--require bad', HOME: '/private' }), { PATH: '/node', SystemRoot: 'C:/Windows', HTTPS_PROXY: 'http://proxy' });
});
for (const mode of ['exit-startup', 'disconnect', 'wrong-session', 'wrong-sequence', 'malformed', 'oversized', 'execute-first'] as const) check('contract', 'Agent subprocess rejects ' + mode + ' and preserves a terminal host Trace', async () => {
  const actual = await faultyCase(mode);
  assert.equal(actual.client.calls.length, 0); assert.equal(actual.data.executions().length, 0);
});
for (const mode of ['batch-wrong-id', 'batch-reordered', 'batch-duplicate-id', 'batch-complete-early', 'batch-next-model', 'batch-overwrite', 'batch-forged-observation', 'batch-forged-success']) check('contract', 'Agent subprocess rejects ' + mode + ' before a side effect', async () => {
  const actual = await faultyCase(mode);
  assert.equal(actual.client.calls.length, 0); assert.equal(actual.data.executions().length, 0);
});
check('contract', 'Unresponsive Agent startup is force-killed within a bounded grace period', async () => {
  const actual = await faultyCase('hang-startup', { shortStartup: true });
  assert.match(actual.result.error!, /startup_timeout/); assert.ok(actual.durationMs < 4_000);
});
for (const mode of ['changed-hash', 'exit-after-allow', 'omit-execute'] as const) check('contract', 'Agent ' + mode + ' cannot execute an approved tool', async () => {
  const actual = await faultyCase(mode);
  assert.equal(actual.client.calls.length, 0);
  assert.equal(actual.data.executions().length, 1);
  assert.equal(actual.data.executions()[0].execute_count, 0);
  assert.ok(!['awaiting_permission', 'executing'].includes(actual.data.executions()[0].state));
});
check('contract', 'Duplicate Agent pre-tool requests cancel the original pending approval', async () => {
  const actual = await faultyCase('duplicate-pre', { ask: true });
  assert.equal(actual.client.calls.length, 0); assert.equal(actual.prompted, true);
  assert.equal(actual.data.executions().length, 1); assert.equal(actual.data.executions()[0].state, 'cancelled');
});
check('contract', 'Agent crash during approval cancels the request and ignores a late approval', async () => {
  const actual = await faultyCase('exit-approval', { ask: true });
  assert.equal(actual.prompted, true); assert.equal(actual.client.calls.length, 0);
  assert.equal(actual.data.executions()[0].state, 'cancelled');
});
check('integration', 'Agent crash during a host write aborts it and persists unknown without replaying', async () => {
  const actual = await faultyCase('exit-executing', { pendingTool: true });
  assert.equal(actual.client.calls.length, 1); assert.equal(actual.toolAborted, true);
  assert.equal(actual.data.executions()[0].execute_count, 1); assert.equal(actual.data.executions()[0].state, 'unknown');
});
check('contract', 'Duplicate Agent execute requests never dispatch a tool twice', async () => {
  const actual = await faultyCase('duplicate-execute', { pendingTool: true });
  assert.ok(actual.client.calls.length <= 1); assert.equal(actual.data.executions().length, 1);
  assert.ok(actual.data.executions()[0].execute_count <= 1);
});
