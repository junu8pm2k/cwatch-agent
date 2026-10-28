import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { id, type ModelPort, type AgentState } from '@cwatch/core/types';
import type { RunSnapshot, WorkbenchBootstrap } from '@cwatch/core/types/runs';
import { runAgent, replayState } from '@cwatch/server-core/runtime/agent';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { ActionPolicy } from '@cwatch/shared/agent/core/permission-manager';
import { validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { startWebServer } from '../apps/web/src/server.ts';
import { check, store, deferred, CountingClient, emptySchema } from './harness.ts';
import { waitForRun } from './run-service-fixture.ts';
import { conversationProvider, conversationTask } from './conversation-fixture.ts';

check('contract', 'conversation keeps user turns and prior decisions, scopes no-progress to each turn, and replays them', async () => {
  const data = store(), registry = new ToolRegistry(), seen: AgentState[] = []; let replies = 0;
  const model: ModelPort = { decide: async input => { seen.push(structuredClone(input.state)); return { kind: 'respond', text: 'The code is BLUE-17.' }; } };
  try {
    const result = await runAgent(conversationTask(), model, registry, data, 'replay', { builtinTools: false,
      nextUserMessage: async () => ++replies < 3 ? 'Repeat the code.' : null });
    assert.equal(result.status, 'complete', result.error); assert.equal(seen.length, 3);
    assert.equal(seen[2].userMessages?.length, 3); assert.equal(seen[2].decisions.length, 2);
    assert.deepEqual(replayState(data, result.runId).userMessages, [conversationTask().instruction, 'Repeat the code.', 'Repeat the code.']);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.deepEqual(validateTrace(events), []); assert.equal(events.filter(e => e.type === 'run_started').length, 1);
    assert.equal(events.filter(e => e.type === 'conversation_turn_completed').length, 3);
    assert.equal(events.filter(e => e.type === 'run_completed').length, 1);
  } finally { await registry.close(); }
});

check('contract', 'waiting for a user pauses execution and model timers but follow-up turns retain cumulative budgets', async () => {
  const data = store(), registry = new ToolRegistry(); let answers = 0;
  const model: ModelPort = { decide: async () => ({ kind: 'respond', text: 'Answer.' }) };
  try {
    const result = await runAgent(conversationTask(), model, registry, data, 'replay', { builtinTools: false, timeoutMs: 100, modelTimeoutMs: 30, maxSteps: 2,
      nextUserMessage: async () => { answers++; await delay(160); return 'Another question.'; } });
    assert.equal(answers, 2); assert.equal(result.status, 'failed'); assert.match(result.error!, /budget_iterations/);
    assert.equal(data.lines<TraceEvent>('traces/' + result.runId + '.jsonl').filter(e => e.type === 'decision_made').length, 2);
  } finally { await registry.close(); }
});

check('integration', 'real Pi conversation preserves previous user, assistant and tool messages without replaying the tool', async () => {
  const data = store(), registry = new ToolRegistry(); let answers = 0;
  const source = new CountingClient([{ name: 'lookup', description: 'Read the project code', action: 'collect', inputSchema: emptySchema }], async () => ({ code: 'TOOL-BLUE-17' }));
  await registry.register('facts', 'mcp', source, new AbortController().signal);
  const provider = await conversationProvider((request, turn) => {
    if (turn === 1) return { kind: 'call_tool', name: 'mcp__facts__lookup', args: {} };
    if (turn === 2) return { kind: 'respond', text: 'The tool reported TOOL-BLUE-17.' };
    assert.equal(turn, 3); assert.match(JSON.stringify(request.messages), /The tool reported TOOL-BLUE-17/);
    assert.match(JSON.stringify(request.messages), /What did that tool report/);
    assert.ok(request.messages.some(message => message.role === 'tool' && message.content?.includes('TOOL-BLUE-17')));
    return { kind: 'respond', text: 'It reported TOOL-BLUE-17, based on the earlier tool result.' };
  });
  try {
    const task = { ...conversationTask(), allowedSources: ['facts'] };
    const result = await runAgent(task, provider.model(), registry, data, 'live', { timeoutMs: 30000, builtinTools: false, sessionMemory: false,
      nextUserMessage: async () => ++answers === 1 ? 'What did that tool report?' : null });
    assert.equal(result.status, 'complete', result.error); assert.deepEqual(provider.errors, []);
    assert.equal(source.calls.length, 1); assert.equal(provider.business.length, 3);
    const entries = data.lines<{ type: string; message?: { role: string } }>('sessions/' + result.runId + '.jsonl');
    assert.equal(entries.filter(e => e.type === 'session').length, 1);
    assert.equal(entries.filter(e => e.message?.role === 'user').length, 2);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl'); assert.deepEqual(validateTrace(events), []);
    assert.equal(events.filter(e => e.type === 'agent_process' && e.data.state === 'started').length, 1);
    assert.equal(events.filter(e => e.type === 'agent_process' && e.data.state === 'exited').length, 1);
  } finally { await provider.close(); await registry.close(); }
});

check('integration', 'user follow-ups survive real Pi compaction with incremental memory under the same session identity', async () => {
  const data = store(), registry = new ToolRegistry(); let answers = 0;
  const provider = await conversationProvider((request, turn) => {
    if (turn === 3) return { kind: 'call_tool', name: 'session__read_session_memory', args: {} };
    if (turn === 4) assert.ok(!JSON.stringify(request.messages).includes('x'.repeat(5000)), 'tool continuation must not revive pre-compact history');
    return { kind: 'respond', text: turn === 1 ? 'FIRST-ANSWER-' + 'x'.repeat(16000) : 'Answer ' + turn + ' for BLUE-17.' };
  });
  try {
    const result = await runAgent(conversationTask(), provider.model(), registry, data, 'live', { timeoutMs: 30000, builtinTools: false, contextChars: 24000,
      sessionMemory: { initializeTokens: 1, growthTokens: 1, toolCalls: 1 }, nextUserMessage: async () => ++answers < 3 ? 'FOLLOW-UP-' + answers : null });
    assert.equal(result.status, 'complete', result.error); assert.deepEqual(provider.errors, []); assert.equal(provider.business.length, 4);
    const entries = data.lines<{ type: string; customType?: string; message?: { role: string } }>('sessions/' + result.runId + '.jsonl');
    assert.ok(entries.some(entry => entry.type === 'compaction'));
    assert.equal(entries.filter(entry => entry.message?.role === 'user').length, 3);
    const final = JSON.stringify(provider.business[2].messages);
    assert.match(final, /FOLLOW-UP-2/); assert.match(final, /BLUE-17/); assert.ok(!final.includes('x'.repeat(5000)));
    const memory = data.read<{ memory: { sessionId: string; revision: number; lastMessageId: string } }>('session-memory/' + result.runId + '.json', null!);
    assert.equal(memory.memory.sessionId, result.runId); assert.ok(memory.memory.revision >= 2);
    const maintenance = provider.requests.filter(request => JSON.stringify(request.messages[0]).includes('SESSION MEMORY UPDATE.'));
    assert.ok(maintenance.length >= 2); assert.ok(!JSON.stringify(maintenance[1]).includes('x'.repeat(5000)));
    assert.deepEqual(validateTrace(data.lines<TraceEvent>('traces/' + result.runId + '.jsonl')), []);
  } finally { await provider.close(); await registry.close(); }
});

check('integration', 'a user follow-up refreshes host permissions and removes revoked tool bindings before its first request', async () => {
  const data = store(), registry = new ToolRegistry(), policy = new ActionPolicy('allow-all'); let answers = 0;
  const source = new CountingClient([{ name: 'modify', description: 'Host write fixture', action: 'modify', inputSchema: emptySchema }]);
  await registry.register('facts', 'mcp', source, new AbortController().signal);
  const provider = await conversationProvider((request, turn) => {
    if (turn === 1) assert.ok(request.tools?.some(tool => tool.function.name === 'mcp__facts__modify'));
    else {
      assert.ok(!request.tools?.some(tool => tool.function.name === 'mcp__facts__modify'));
      assert.match(request.messages[0].content!, /PERMISSION MODE: explore/);
      assert.ok(!request.messages[0].content!.includes('PERMISSION MODE: allow-all'));
    }
    return { kind: 'respond', text: 'Answer under current host permissions.' };
  });
  try {
    const result = await runAgent({ ...conversationTask(), allowedSources: ['facts'] }, provider.model(), registry, data, 'live', { builtinTools: false, sessionMemory: false,
      nextUserMessage: async () => { if (++answers === 1) { policy.setMode('explore'); return 'Continue with reads only.'; } return null; } }, undefined, policy);
    assert.equal(result.status, 'complete', result.error); assert.deepEqual(provider.errors, []); assert.equal(provider.business.length, 2); assert.equal(source.calls.length, 0);
    assert.equal(provider.business[0].messages[0].content?.split('CONVERSATION:').length, 2);
  } finally { await provider.close(); await registry.close(); }
});

check('integration', 'cancelling an idle real Pi conversation exits its worker without another model request', async () => {
  const data = store(), registry = new ToolRegistry(), controller = new AbortController();
  const provider = await conversationProvider(() => ({ kind: 'respond', text: 'Ready for your next question.' }));
  try {
    const result = await runAgent(conversationTask(), provider.model(), registry, data, 'live', { timeoutMs: 30000, builtinTools: false, sessionMemory: false,
      nextUserMessage: async () => { controller.abort(new Error('user_cancelled')); return new Promise<never>(() => {}); } }, controller.signal);
    assert.equal(result.status, 'cancelled', result.error); assert.equal(provider.business.length, 1);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl'); assert.deepEqual(validateTrace(events), []);
    assert.ok(events.some(e => e.type === 'agent_process' && e.data.state === 'exited'));
  } finally { await provider.close(); await registry.close(); }
});

check('integration', 'HTTP conversation accepts follow-ups once, rejects busy/conflicting input, closes normally and preserves answers', async () => {
  const data = store(), gate = deferred<void>(), entered = deferred<void>(); let calls = 0;
  const service = new RunService({ root: process.cwd(), outputRoot: data.root, modelFactory: () => ({ decide: async input => {
    calls++; if (calls === 2) { entered.resolve(); await gate.promise; }
    return { kind: 'respond', text: 'Answer to ' + input.state.userMessages?.at(-1) };
  } }) });
  const app = await startWebServer({ root: process.cwd(), port: 0, service });
  const bootstrap = await (await fetch(app.origin + '/api/bootstrap')).json() as WorkbenchBootstrap;
  const post = (path: string, value: unknown, token = bootstrap.csrfToken) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Cwatch-Token': token }, body: JSON.stringify(value) });
  try {
    const started = await post('/api/runs', { profile: 'agent', mode: 'replay', permission: 'explore', conversation: true, task: conversationTask() });
    assert.equal(started.status, 202); const run = await started.json() as RunSnapshot;
    await waitForRun(service, run.id, r => r.status === 'awaiting_user');
    const path = '/api/runs/' + run.id, message = { messageId: id(), text: 'Use the earlier code.' };
    assert.equal((await post(path + '/messages', message, 'wrong')).status, 403);
    assert.equal((await post(path + '/messages', { ...message, text: ' ' })).status, 400);
    assert.equal((await post(path + '/messages', message)).status, 202); await entered.promise;
    assert.equal((await post(path + '/messages', { messageId: id(), text: 'Concurrent message.' })).status, 409);
    assert.equal((await post(path + '/messages', { ...message, text: 'Changed payload.' })).status, 409);
    assert.equal((await post(path + '/messages', message)).status, 202); assert.equal(calls, 2);
    assert.equal((await post(path + '/end', {})).status, 409);
    gate.resolve(); const waiting = await waitForRun(service, run.id, r => r.status === 'awaiting_user');
    assert.equal(waiting.messages?.length, 4); assert.equal(waiting.messages?.at(-1)?.content, 'Answer to Use the earlier code.');
    assert.equal((await post(path + '/end', {})).status, 202);
    const ended = await service.wait(run.id); assert.equal(ended.status, 'complete'); assert.equal(calls, 2);
    assert.equal((await post(path + '/messages', { messageId: id(), text: 'After close.' })).status, 409);
    assert.match(await (await fetch(app.origin + path + '/report')).text(), /earlier code/);
    const runData = new FileStore(data.path(run.id));
    assert.deepEqual(replayState(runData, ended.traceRunId!).userMessages, [conversationTask().instruction, message.text]);
    assert.deepEqual(validateTrace(runData.lines<TraceEvent>('traces/' + ended.traceRunId + '.jsonl')), []);
  } finally { gate.resolve(); await app.close(); }
});

check('contract', 'conversations isolate messages, cancel idle sessions and mark saved waiting sessions interrupted after restart', async () => {
  const data = store(), seen: string[][] = [];
  const service = new RunService({ root: process.cwd(), outputRoot: data.root, modelFactory: () => ({ decide: async input => {
    seen.push(input.state.userMessages ?? []); return { kind: 'respond', text: input.state.userMessages?.at(-1) ?? 'Answer.' };
  } }) });
  const input = { profile: 'agent', mode: 'replay' as const, permission: 'explore' as const, conversation: true };
  let first!: RunSnapshot;
  try {
    first = service.start({ ...input, task: conversationTask('FIRST-SESSION-SECRET') });
    const second = service.start({ ...input, task: conversationTask('SECOND-SESSION') });
    await Promise.all([waitForRun(service, first.id, r => r.status === 'awaiting_user'), waitForRun(service, second.id, r => r.status === 'awaiting_user')]);
    service.sendMessage(second.id, { messageId: id(), text: 'SECOND-FOLLOW-UP' });
    await waitForRun(service, second.id, r => r.status === 'awaiting_user');
    assert.deepEqual(seen.at(-1), ['SECOND-SESSION', 'SECOND-FOLLOW-UP']);
    assert.ok(!JSON.stringify(service.get(second.id).messages).includes('FIRST-SESSION-SECRET'));
    service.cancel(first.id); assert.equal((await service.wait(first.id)).status, 'cancelled');
    service.endConversation(second.id); await service.wait(second.id);
  } finally { await service.close(); }
  const path = data.path(first.id + '/summary.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.view.status = 'awaiting_user'; new FileStore(data.path(first.id)).write('summary.json', saved);
  const restarted = new RunService({ root: process.cwd(), outputRoot: data.root });
  try {
    assert.equal(restarted.get(first.id).status, 'unknown'); assert.ok(restarted.get(first.id).messages?.length);
    assert.throws(() => restarted.sendMessage(first.id, { messageId: id(), text: 'Cannot auto-resume.' }), /conversation_not_waiting/);
  } finally { await restarted.close(); }
});

check('integration', 'Workbench preparation timeout does not cancel a conversation while it waits for the next user', async () => {
  const data = store(), service = new RunService({ root: process.cwd(), outputRoot: data.root, modelFactory: () => ({ decide: async () => ({ kind: 'respond', text: 'Waiting for your next question.' }) }) });
  try {
    const run = service.start({ profile: 'agent', mode: 'replay', permission: 'explore', conversation: true, task: conversationTask(), limits: { timeoutMs: 1000 } });
    await waitForRun(service, run.id, current => current.status === 'awaiting_user');
    await delay(1100);
    assert.equal(service.get(run.id).status, 'awaiting_user');
    service.sendMessage(run.id, { messageId: id(), text: 'Continue after the wait.' });
    await waitForRun(service, run.id, current => current.status === 'awaiting_user');
    service.endConversation(run.id); assert.equal((await service.wait(run.id)).status, 'complete');
  } finally { await service.close(); }
});
