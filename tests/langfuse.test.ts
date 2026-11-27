import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { langfuseTraceUrl, readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import {
  LangfuseRunTracer,
  OtlpTraceArtifactSchema,
  enrichOtlpResourceSpans,
  exportToLangfuse,
  langfusePayload,
} from '@cwatch/shared/sessions/langfuse';
import { Redactor, Trace } from '@cwatch/shared/sessions/trace';
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

function otlpAttrMap(span: { attributes?: Array<{ key: string; value?: Record<string, unknown> }> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attr of span.attributes ?? []) {
    const v = attr.value ?? {};
    if ('stringValue' in v) out[attr.key] = v.stringValue;
    else if ('intValue' in v) out[attr.key] = Number(v.intValue);
    else if ('doubleValue' in v) out[attr.key] = Number(v.doubleValue);
    else if ('boolValue' in v) out[attr.key] = Boolean(v.boolValue);
    else if ('arrayValue' in v) {
      const vals = (v.arrayValue as { values?: Array<Record<string, unknown>> })?.values ?? [];
      out[attr.key] = vals.map(item => item.stringValue ?? item.intValue ?? item.boolValue);
    }
  }
  return out;
}

function collectOtlpSpans(resourceSpans: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }>) {
  const spans: Array<Record<string, unknown>> = [];
  for (const rs of resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) spans.push(span);
    }
  }
  return spans;
}

check('contract', 'Langfuse traceUrl supports project-scoped and generic trace URLs', () => {
  const tid = '0123456789abcdef0123456789abcdef';
  assert.equal(langfuseTraceUrl('https://cloud.langfuse.com', tid), 'https://cloud.langfuse.com/trace/' + tid);
  assert.equal(langfuseTraceUrl('https://cloud.langfuse.com', tid, 'proj-abc'), 'https://cloud.langfuse.com/project/proj-abc/traces/' + tid);
  assert.equal(readLangfuseConfig({ ...configEnv, LANGFUSE_PROJECT_ID: 'proj-abc' })?.projectId, 'proj-abc');
});

check('integration', 'Live runtime streams official Langfuse v4 OTel tree and scores over HTTP and retains task success when server fails; replay stays offline', async () => {
  const traceBodies: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> }> = [];
  const scoreBatches: Array<Array<Record<string, unknown>>> = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/public/otel/v1/traces') traceBodies.push(parsed);
    else if (req.url === '/api/public/scores') scoreBatches.push(parsed);
    else assert.fail('unexpected path: ' + req.url);
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let firstTraceId = '';
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
          if (mode === 'live' && status === 200 && result.langfuse?.status === 'exported') {
            firstTraceId = result.langfuse.traceId;
            assert.equal(result.langfuse.traceUrl, `http://127.0.0.1:${address.port}/trace/${result.langfuse.traceId}`);
          }
          assert.equal(data.lines<{ type: string }>('traces/' + result.runId + '.jsonl').at(-1)?.type, 'run_completed');
          if (mode === 'live') assert.deepEqual(data.read<{ langfuse: unknown }>('runs/' + result.runId + '.json', { langfuse: null }).langfuse, result.langfuse);
          status = 503;
        } finally { await registry.close(); }
      }
    });
    assert.ok(traceBodies.length >= 2);
    const firstTraceSpans = traceBodies
      .flatMap(body => collectOtlpSpans(body.resourceSpans))
      .filter(s => s.traceId === firstTraceId);
    const root = firstTraceSpans.find(s => s.name === 'agent.run')!;
    const turn1 = firstTraceSpans.find(s => s.name === 'turn.1')!;
    const tool = firstTraceSpans.find(s => s.name === 'mcp__fixture__lookup')!;
    const guardrail = firstTraceSpans.find(s => s.name === 'guardrail.mcp__fixture__lookup')!;
    const backend = firstTraceSpans.find(s => s.name === 'backend.fixture.backend')!;
    assert.ok(root && turn1 && tool && guardrail && backend);
    assert.equal(turn1.parentSpanId, root.spanId);
    assert.equal(tool.parentSpanId, turn1.spanId);
    assert.equal(guardrail.parentSpanId, turn1.spanId);
    assert.equal(backend.parentSpanId, tool.spanId);
    const rootAttrs = otlpAttrMap(root as any);
    assert.equal(rootAttrs['langfuse.observation.type'], 'agent');
    assert.ok(Array.isArray(rootAttrs['langfuse.trace.tags']) && (rootAttrs['langfuse.trace.tags'] as string[]).includes('status:complete'));
    assert.equal(scoreBatches.length, 1);
    const scoreNames = scoreBatches[0].map(s => s.name);
    assert.ok(scoreNames.includes('run_success'));
    assert.ok(scoreNames.includes('tool_error_rate'));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

check('contract', 'LangfuseRunTracer emits nested memory/compact/turn OTel tree with unified generation fields, redacted content, automatic tags/scores and keyless CI enrichment', async () => {
  const data = store();
  const otelFilePath = join(data.root, 'trace.otel.json');
  const redactor = new Redactor(['top-secret-token']);
  const tracer = new LangfuseRunTracer({
    runId: 'run-otel-nested',
    taskId: 'task-otel-nested',
    mode: 'live',
    redactor,
    env: { LANGFUSE_ENABLED: 'false' },
    otelFilePath,
  });
  tracer.startRun({
    runId: 'run-otel-nested',
    taskId: 'task-otel-nested',
    task: { kind: 'agent', taskId: 'task-otel-nested', instruction: 'Inspect top-secret-token' },
    mode: 'live',
    permissionMode: 'explore',
    engine: 'pi-agent-session',
    model: { provider: 'stepfun', id: 'step-5-preview' },
  });
  tracer.startTurn(1, { contextChars: 4200, toolCount: 3 });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.context_prepare', data: { charsBefore: 5000, charsAfter: 4200, windowTokens: 4000, inputLimit: 10000, triggerReason: 'threshold', snippedCount: 1, microcompactedCount: 0, reactive: false } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.memory_request', data: { attempt: 1, maxAttempts: 2, maxTokens: 3072, expectedRevision: 0, context: { systemPrompt: 'Memory with top-secret-token' }, contract: { samplingParams: { reasoning_effort: 'low', response_format: { type: 'json_object' } } } } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.memory_wire_request', data: { attempt: 1, model: 'step-5-preview', maxTokens: 3072, reasoningEffort: 'low', responseFormat: { type: 'json_object' } } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.memory_response', data: { attempt: 1, stopReason: 'length', content: [{ type: 'thinking', thinking: 'a'.repeat(500) }], usage: { input: 200, output: 3072, totalTokens: 3272 } } });
  tracer.onUsage({ input: 200, output: 3072, totalTokens: 3272 }, 'memory');
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.memory_recovery', data: { attempt: 1, reason: 'output_limit_exhausted', action: 'degrade', pendingRounds: 2, consecutiveFailures: 2, circuitOpen: true } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.summary_request', data: { attempt: 1, maxAttempts: 2, maxTokens: 6144, context: { systemPrompt: 'Summary prompt' }, contract: {} } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.summary_wire_request', data: { attempt: 1, model: 'step-5-preview', maxTokens: 6144 } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.summary_response', data: { attempt: 1, stopReason: 'stop', content: [{ type: 'text', text: '{"userGoal":"done"}' }], usage: { input: 300, output: 50, totalTokens: 350 } } });
  tracer.onUsage({ input: 300, output: 50, totalTokens: 350 }, 'summary');
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.compact_commit', data: { attachmentEntryIds: ['a1'], hookResultEntryIds: [] } });
  tracer.onTranscriptEntry({ type: 'custom', customType: 'cwatch.model_request', data: { model: 'step-5-preview', payload: { max_tokens: 4096, messages: [{ role: 'user', content: 'hello top-secret-token' }] } } });
  tracer.onTranscriptEntry({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'short' }, { type: 'text', text: 'Final answer without top-secret-token' }], usage: { input: 400, output: 100, cacheRead: 200, totalTokens: 700 } } });
  tracer.onUsage({ input: 400, output: 100, cacheRead: 200, totalTokens: 700 }, 'turn', { readTokens: 200, normalizedInputTokens: 600 });
  tracer.onDecision({ kind: 'respond', text: 'Final answer' });

  const exported = await tracer.finishRun({ runId: 'run-otel-nested', taskId: 'task-otel-nested', status: 'complete', response: 'Final answer', gaps: [] });
  assert.equal(exported.status, 'file_exported');

  const rawText = readFileSync(otelFilePath, 'utf8');
  assert.ok(!rawText.includes('top-secret-token'), 'OTLP artifact must redact secrets');
  const artifact = OtlpTraceArtifactSchema.parse(JSON.parse(rawText));
  const spans = collectOtlpSpans(artifact.resourceSpans as any);
  const byName = (name: string) => spans.find(s => s.name === name)!;
  const root = byName('agent.run');
  const turn1 = byName('turn.1');
  const ctxSpan = byName('context.prepare');
  const memSpan = byName('memory.update');
  const memAttempt = byName('memory.attempt.1');
  const compactSpan = byName('compact.run');
  const sumAttempt = byName('summary.attempt.1');
  const modelTurn = byName('model.turn');
  assert.equal(turn1.parentSpanId, root.spanId);
  assert.equal(ctxSpan.parentSpanId, turn1.spanId);
  assert.equal(memSpan.parentSpanId, ctxSpan.spanId);
  assert.equal(memAttempt.parentSpanId, memSpan.spanId);
  assert.equal(compactSpan.parentSpanId, ctxSpan.spanId);
  assert.equal(sumAttempt.parentSpanId, compactSpan.spanId);
  assert.equal(modelTurn.parentSpanId, turn1.spanId);

  const memAttrs = otlpAttrMap(memAttempt as any);
  const metaVal = (attrs: Record<string, unknown>, key: string) => JSON.parse(String(attrs['langfuse.observation.metadata.' + key]));
  assert.equal(metaVal(memAttrs, 'stopReason'), 'length');
  assert.equal(metaVal(memAttrs, 'thinkingChars'), 500);
  assert.equal(metaVal(memAttrs, 'textChars'), 0);
  assert.equal(metaVal(memAttrs, 'wireMaxTokens'), 3072);
  assert.equal(metaVal(memAttrs, 'outputUtilization'), 1);
  assert.equal(metaVal(memAttrs, 'outcome'), 'degraded');

  const turnAttrs = otlpAttrMap(modelTurn as any);
  assert.equal(turnAttrs['langfuse.observation.level'], 'WARNING');
  assert.match(String(turnAttrs['langfuse.observation.input']), /\[REDACTED\]/);
  assert.match(String(turnAttrs['langfuse.observation.output']), /Final answer without \[REDACTED\]/);

  const rootAttrs = otlpAttrMap(root as any);
  const tags = rootAttrs['langfuse.trace.tags'] as string[];
  for (const expectedTag of ['status:complete', 'model:step-5-preview', 'err:memory_degraded', 'err:memory_circuit_open', 'err:output_truncated', 'used:compact']) {
    assert.ok(tags.includes(expectedTag), 'missing tag ' + expectedTag);
  }
  const scoreMap = Object.fromEntries(artifact.scores.map(s => [s.name, s.value]));
  assert.equal(scoreMap.run_success, 1);
  assert.equal(scoreMap.memory_first_try_rate, 0);
  assert.equal(scoreMap.memory_degraded, 1);
  assert.equal(scoreMap.compact_success_rate, 1);
  assert.equal(scoreMap.truncation_count, 1);

  // Verify enrichOtlpResourceSpans injects benchmark metadata & overrides without mutating source
  const enriched = enrichOtlpResourceSpans(artifact.resourceSpans, {
    sessionId: 'bench-session-1',
    environment: 'benchmark',
    metadata: { case_id: 'case-1' },
    rootOutputOverride: [{ role: 'assistant', content: 'override' }],
  });
  const enrichedRoot = collectOtlpSpans(enriched as any).find(s => s.name === 'agent.run')!;
  const enrichedAttrs = otlpAttrMap(enrichedRoot as any);
  assert.equal(enrichedAttrs['session.id'], 'bench-session-1');
  assert.equal(enrichedAttrs['langfuse.environment'], 'benchmark');
  assert.equal(enrichedAttrs['langfuse.trace.metadata.case_id'], 'case-1');
  assert.match(String(enrichedAttrs['langfuse.trace.output']), /override/);
  assert.equal(otlpAttrMap(root as any)['session.id'], 'task-otel-nested');
});
