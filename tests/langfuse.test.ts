import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { exportToLangfuse, langfusePayload } from '@cwatch/shared/sessions/langfuse';
import { Trace } from '@cwatch/shared/sessions/trace';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import type { ModelPort } from '@cwatch/core/types';
import { check, store } from './harness.ts';

const configEnv = { LANGFUSE_PUBLIC_KEY: 'pk-lf-fixture', LANGFUSE_SECRET_KEY: 'sk-lf-fixture', LANGFUSE_TRACING_ENVIRONMENT: 'test' };
function traceFixture(terminal: 'run_completed' | 'run_failed' | 'run_cancelled' = 'run_completed'): Trace {
  const trace = new Trace(store(), 'langfuse-task', 'langfuse-run');
  trace.emit('run_started', { mode: 'live', task: { kind: 'agent', taskId: trace.taskId, instruction: 'Fixture ' + configEnv.LANGFUSE_SECRET_KEY, allowedSources: [] }, model: { provider: 'fixture', id: 'test-model' } });
  trace.emit('model_requested', { iteration: 1, contextChars: 10 });
  if (terminal === 'run_completed') {
    trace.emit('model_usage', { iteration: 1, purpose: 'turn', usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 2, totalTokens: 21 } });
    trace.emit('decision_made', { decision: { kind: 'respond', text: 'Fixture answer' } });
  }
  trace.emit(terminal, terminal === 'run_completed' ? { status: 'complete', response: 'Fixture answer' } : { status: terminal === 'run_failed' ? 'failed' : 'cancelled', error: 'fixture_interrupted' });
  return trace;
}
function attributes(span: ReturnType<typeof langfusePayload>['spans'][number]): Record<string, string> {
  return Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? a.value.intValue]));
}
async function withEnv<T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const names = [...new Set([...Object.keys(process.env).filter(name => name.startsWith('LANGFUSE_')), ...Object.keys(env)])];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, env);
    return await work();
  } finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

check('contract', 'Langfuse configuration is optional, explicitly disableable and validates destinations without exposing keys', () => {
  assert.equal(readLangfuseConfig({}), undefined);
  assert.equal(readLangfuseConfig({ ...configEnv, LANGFUSE_ENABLED: 'false' }), undefined);
  for (const env of [{ LANGFUSE_ENABLED: 'true' }, { LANGFUSE_PUBLIC_KEY: 'only-one' }, { ...configEnv, LANGFUSE_BASE_URL: 'https://user:secret@example.com' },
    { ...configEnv, LANGFUSE_BASE_URL: 'http://example.com' }, { ...configEnv, LANGFUSE_BASE_URL: 'https://example.com/api/public/otel' },
    { ...configEnv, LANGFUSE_TIMEOUT_MS: '0' }, { ...configEnv, LANGFUSE_TRACING_ENVIRONMENT: 'bad environment' }]) assert.throws(() => readLangfuseConfig(env), /langfuse_config/);
  assert.equal(readLangfuseConfig({ ...configEnv, LANGFUSE_BASE_URL: 'http://localhost:3000/' })?.baseUrl, 'http://localhost:3000');
});

check('contract', 'Langfuse OTLP mapping preserves identities, timings, model usage and cancelled/failed model spans', () => {
  const trace = traceFixture(), document = trace.exportStructured(), payload = langfusePayload(document, { environment: 'test' });
  assert.match(payload.traceId, /^[0-9a-f]{32}$/);
  const [root, generation] = payload.spans;
  assert.equal(generation.parentSpanId, root.spanId);
  assert.match(root.spanId, /^[0-9a-f]{16}$/);
  for (const span of payload.spans) {
    assert.equal(span.traceId, payload.traceId);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    assert.equal(attributes(span)['langfuse.trace.metadata.runId'], trace.runId);
    assert.equal(attributes(span)['langfuse.session.id'], trace.taskId);
  }
  const attrs = attributes(generation);
  assert.equal(attrs['langfuse.observation.type'], 'generation');
  assert.equal(attrs['langfuse.observation.model.name'], 'test-model');
  assert.deepEqual(JSON.parse(attrs['langfuse.observation.usage_details']), { input: 10, output: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, total: 21 });
  assert.deepEqual(langfusePayload(document, { environment: 'test' }), payload);
  for (const terminal of ['run_failed', 'run_cancelled'] as const) {
    const failed = langfusePayload(traceFixture(terminal).exportStructured(), { environment: 'test' });
    assert.ok(failed.spans.every(span => span.status.code === 2));
    assert.ok(!attributes(failed.spans[1])['langfuse.observation.usage_details']);
  }
});

check('contract', 'Langfuse export authenticates via OTLP, redacts env secrets and skips successfully exported traces', async () => {
  const trace = traceFixture(); let requests = 0;
  const transport: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://cloud.langfuse.com/api/public/otel/v1/traces');
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('x-langfuse-ingestion-version'), '4');
    assert.equal(headers.get('Authorization'), 'Basic ' + Buffer.from(configEnv.LANGFUSE_PUBLIC_KEY + ':' + configEnv.LANGFUSE_SECRET_KEY).toString('base64'));
    assert.ok(!String(options?.body).includes(configEnv.LANGFUSE_SECRET_KEY));
    assert.match(String(options?.body), /\[REDACTED\]/);
    return new Response('{}');
  };
  const first = await exportToLangfuse(trace, configEnv, transport);
  assert.equal(first.status, 'exported');
  assert.deepEqual(await exportToLangfuse(trace, configEnv, transport), first);
  assert.equal(requests, 1);
  await exportToLangfuse(trace, { ...configEnv, LANGFUSE_PUBLIC_KEY: 'another-project' }, async () => { requests++; return new Response('{}'); });
  assert.equal(requests, 2);
});

check('contract', 'Langfuse export detects HTTP and partial rejection, bounds timeouts and suppresses remote secrets', async () => {
  for (const response of [new Response('secret remote body', { status: 401 }), new Response('{"partialSuccess":{"rejectedSpans":"1"}}'), new Response('<html>unexpected login page</html>')]) {
    const result = await exportToLangfuse(traceFixture(), configEnv, async () => response);
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes('secret remote body'));
  }
  const timed = await exportToLangfuse(traceFixture(), { ...configEnv, LANGFUSE_TIMEOUT_MS: '10' }, async (_url, init) => {
    assert.ok(init?.signal);
    // Keep one event-loop handle until the unref'ed AbortSignal timer fires.
    return await new Promise<Response>((_resolve, reject) => {
      const hold = setTimeout(() => reject(Error('unexpected timeout')), 1000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(hold); reject(init!.signal!.reason); }, { once: true });
    });
  });
  assert.equal(timed.status, 'failed');
  const trace = traceFixture();
  assert.deepEqual(await exportToLangfuse(trace, {}, async () => { throw Error('must not request'); }), { status: 'disabled' });
});

check('contract', 'Langfuse refuses incomplete or tampered local audit before making a network request', async () => {
  const trace = new Trace(store(), 'incomplete-task', 'incomplete-run'); trace.emit('run_started');
  let requests = 0;
  assert.equal((await exportToLangfuse(trace, configEnv, async () => { requests++; return new Response('{}'); })).status, 'failed');
  const complete = traceFixture(), events = complete.store.lines<Record<string, unknown>>(complete.key); events[1].sequence = 100;
  complete.store.text(complete.key, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  assert.equal((await exportToLangfuse(complete, configEnv, async () => { requests++; return new Response('{}'); })).status, 'failed');
  assert.equal(requests, 0);
});

check('integration', 'Live runtime awaits real HTTP Langfuse export and retains task success when the server fails; replay stays offline', async () => {
  const bodies: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: ReturnType<typeof langfusePayload>['spans'] }> }> }> = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/public/otel/v1/traces');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await withEnv({ ...configEnv, LANGFUSE_BASE_URL: 'http://127.0.0.1:' + address.port }, async () => {
      for (const mode of ['live', 'live', 'replay'] as const) {
        const registry = new ToolRegistry();
        await registry.register('fixture', 'mcp', {
          async listTools() { return [{ name: 'lookup', description: 'fixture', action: 'collect', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]; },
          async callTool(_name, _args, _signal, context) { return context!.stage('fixture.backend', async () => ({ ok: true })); }, async close() {},
        }, new AbortController().signal);
        try {
          const data = store(); let round = 0;
          const model: ModelPort = { async decide() { return round++ === 0 ? { kind: 'call_tool', name: 'mcp__fixture__lookup', args: {} } : { kind: 'respond', text: 'Fixture completed' }; } };
          const result = await runAgent({ kind: 'agent', taskId: 'live-test', instruction: 'Fixture', allowedSources: ['fixture'] }, model, registry, data, mode, { builtinTools: false });
          assert.equal(result.status, 'complete', result.error);
          assert.equal(result.langfuse?.status, mode === 'replay' ? undefined : status === 200 ? 'exported' : 'failed');
          assert.equal(data.lines<{ type: string }>('traces/' + result.runId + '.jsonl').at(-1)?.type, 'run_completed');
          if (mode === 'live') assert.deepEqual(data.read<{ langfuse: unknown }>('runs/' + result.runId + '.json', { langfuse: null }).langfuse, result.langfuse);
          status = 503;
        } finally { await registry.close(); }
      }
    });
    assert.equal(bodies.length, 2);
    const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 5);
    const root = spans.find(span => attributes(span)['langfuse.observation.type'] === 'agent')!;
    const tool = spans.find(span => attributes(span)['langfuse.observation.type'] === 'tool')!;
    const backend = spans.find(span => attributes(span)['langfuse.observation.type'] === 'span')!;
    assert.ok(spans.some(span => span.spanId === tool.parentSpanId && span.parentSpanId === root.spanId));
    assert.equal(backend.parentSpanId, tool.spanId);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
