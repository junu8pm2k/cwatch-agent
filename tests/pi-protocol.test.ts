import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { check, json, store, task } from './harness.ts';
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { SourceServerBuilder, SourceConfigsSchema } from "@cwatch/shared/sources/server-builder";
import { PiModel, ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation, replayState } from "@cwatch/server-core/runtime/investigation";
import { validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";

for (const legacyHost of [false, true]) check('integration', legacyHost
  ? 'A current Pi worker uses the original IPC messages when the host omits tool admission'
  : 'actual Pi SDK HTTP codec runs same scripted loop as replay (local provider fixture)', async () => {
  const steps = json('fixtures/model-script.json'); let cursor = 0; const requestedNames: string[][] = [], requestPaths: string[] = [], histories: any[][] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture-key-never-real'); requestPaths.push(req.url ?? '');
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')); requestedNames.push(request.tools?.map((t: any) => t.function.name) ?? []); histories.push(request.messages);
      const step = structuredClone(steps[cursor++]);
      if (step?.args?.claimIds === '$analyzed_claim_ids') {
        const analysisCall = request.messages.flatMap((message: any) => message.tool_calls ?? []).find((call: any) => call.function.name === 'workflow__analyze');
        const analysis = request.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === analysisCall.id);
        step.args.claimIds = JSON.parse(analysis.content).claims.map((claim: any) => claim.id);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const delta = step.kind === 'call_tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call-' + cursor, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { role: 'assistant', content: step.text };
      res.write('data: ' + JSON.stringify({ id: 'fixture-' + cursor, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'fixture-' + cursor, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: step.kind === 'call_tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const data = store(), registry = new ToolRegistry(); await new SourceServerBuilder(process.cwd()).register(SourceConfigsSchema.parse(json('examples/sources.json')), 'replay', registry, new AbortController().signal);
    const model = PiModel.fromEnvironment({ MODEL_PROVIDER: 'fixture-local', MODEL_ID: 'fixture-model', API_KEY: 'fixture-key-never-real', BASE_URL: `http://127.0.0.1:${address.port}/v1/` });
    if (legacyHost) {
      const runSession = model.runSession.bind(model);
      model.runSession = (input, hooks, signal) => runSession(input, { ...hooks, beforeTool: undefined }, signal);
    }
    const actual = await runInvestigation(task(), model, registry, data, 'replay', { timeoutMs: 60_000 });
    assert.equal(actual.status, 'complete', actual.error); assert.equal(cursor, steps.length); assert.ok(requestedNames.every(names => names.includes('web_fetch') && !names.includes('bash')));
    assert.ok(requestPaths.every(path => path === '/v1/chat/completions'));
    assert.equal(histories[1].filter(message => message.role === 'user').length, 1);
    assert.equal(histories[1].find(message => message.role === 'tool').tool_call_id, 'fixture-call-1');
    assert.ok(histories[steps.length - 1].filter(message => message.role === 'tool').length >= steps.length - 1);
    assert.equal((model.usage as Record<string, unknown>).costSource, 'unavailable_for_custom_endpoint');
    assert.equal('cost' in (model.usage as Record<string, unknown>), false);
    assert.ok(!JSON.stringify(replayState(data, actual.runId)).includes('fixture-key-never-real'));
    const state = replayState(data, actual.runId); const replay = new ReplayModel(steps);
    const expected = [];
    for (let i = 0; i < steps.length; i++) expected.push(await replay.decide({ state, stable: '', volatile: '', tools: registry.list() }, new AbortController().signal));
    assert.deepEqual(state.decisions, expected);
    const events = data.lines<TraceEvent>('traces/' + actual.runId + '.jsonl'); assert.equal(events[0].data.engine, 'pi-agent-session');
    const processes = events.filter(event => event.type === 'agent_process');
    assert.deepEqual(processes.map(event => event.data.state), ['started', 'ready', 'exited']);
    assert.notEqual(processes[0].data.pid, process.pid); assert.equal(processes[2].data.exitCode, 0);
    assert.deepEqual(validateTrace(events), []);
    const missingExit = events.filter(event => !(event.type === 'agent_process' && event.data.state === 'exited')).map((event, index) => ({ ...event, sequence: index + 1 }));
    assert.ok(validateTrace(missingExit).includes('run terminal with active agent process'));
    const preRequests = events.filter(event => event.type === 'pre_tool_use_request'), preResponses = events.filter(event => event.type === 'pre_tool_use_response');
    assert.equal(preRequests.length, steps.length - 1); assert.equal(preResponses.length, steps.length - 1);
    assert.deepEqual(preRequests.map(event => event.data.sdkToolCallId), Array.from({ length: steps.length - 1 }, (_, index) => 'fixture-call-' + (index + 1)));
    for (const request of preRequests) assert.ok(preResponses.some(response => response.data.requestId === request.data.requestId && response.data.sdkToolCallId === request.data.sdkToolCallId && response.data.action === 'allow')); assert.equal((events.find(e => e.type === 'usage_reported')!.data.modelUsage as unknown[]).length, steps.length);
    await registry.close();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
