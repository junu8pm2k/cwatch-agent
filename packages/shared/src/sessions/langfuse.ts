import { createHash } from 'node:crypto';
import { readLangfuseConfig, type LangfuseConfig } from '../config/langfuse.ts';
import { Redactor, type Trace } from './trace.ts';
import type { StructuredTrace, TraceStep } from './structured-trace.ts';

export type LangfuseExportResult =
  | { status: 'disabled' }
  | { status: 'exported'; traceId: string; spanCount: number }
  | { status: 'failed'; error: string; traceId?: string };
interface Attribute { key: string; value: { stringValue: string; intValue?: never } | { intValue: string; stringValue?: never } }
interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string; attributes: Attribute[];
  status: { code: number; message?: string };
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identity = (value: string, length: number): string => createHash('sha256').update('cwatch:' + value).digest('hex').slice(0, length);
const attribute = (key: string, value: unknown): Attribute => ({ key, value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } });
function nanos(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw Error('langfuse_export: invalid timestamp');
  return (BigInt(ms) * 1_000_000n).toString();
}

/** Pi reports input/output separately from cached tokens; retain that distinction. */
function usageDetails(step: TraceStep): Record<string, number> {
  const details: Record<string, number> = {};
  for (const entry of step.usage) {
    const usage = record(entry.reported);
    for (const [source, target] of [['input', 'input'], ['output', 'output'], ['cacheRead', 'cache_read_input_tokens'], ['cacheWrite', 'cache_creation_input_tokens'], ['totalTokens', 'total']] as const) {
      const value = usage[source];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) details[target] = (details[target] ?? 0) + value;
    }
  }
  return details;
}

/** Project the existing public audit view; do not read private SDK transcripts. */
export function langfusePayload(document: StructuredTrace, config: Pick<LangfuseConfig, 'environment'>): { traceId: string; spans: OtlpSpan[] } {
  if (!document.integrity.valid || !document.integrity.complete) throw Error('langfuse_export: complete valid trace required');
  const traceId = identity(document.runId, 32);
  const agentPrompts = record(document.steps.find(step => step.kind === 'run')?.attributes.agentPrompts);
  const spans = document.steps.map((step): OtlpSpan => {
    // Usage-only records have no measured start; export at the recorded end and mark it explicitly.
    const start = step.timing.requestedAt ?? step.timing.startedAt ?? step.timing.endedAt;
    const end = step.timing.endedAt;
    if (!start || !end) throw Error('langfuse_export: missing step timing');
    const failed = Boolean(step.error) || ['failed', 'blocked', 'cancelled'].includes(step.status);
    const attributes = [
      attribute('langfuse.observation.type', step.kind === 'model' ? 'generation' : step.kind === 'tool' ? 'tool' : step.kind === 'run' ? 'agent' : 'span'),
      attribute('langfuse.trace.name', 'cwatch.agent'), attribute('langfuse.session.id', document.taskId),
      attribute('langfuse.environment', config.environment), attribute('langfuse.trace.metadata.runId', document.runId),
      attribute('langfuse.trace.metadata.taskId', document.taskId), attribute('langfuse.trace.metadata.mode', document.input.mode),
      attribute('langfuse.observation.metadata.stepId', step.stepId), attribute('langfuse.observation.metadata.status', step.status),
      attribute('langfuse.observation.metadata.correlation', step.correlation),
      attribute('langfuse.observation.metadata.details', step.attributes),
      attribute('langfuse.observation.input', step.input), attribute('langfuse.observation.output', step.output),
      attribute('langfuse.observation.level', failed ? 'ERROR' : step.status === 'partial' ? 'WARNING' : 'DEFAULT'),
    ];
    if (step.error) attributes.push(attribute('langfuse.observation.status_message', step.error.message));
    if (Object.keys(agentPrompts).length) {
      attributes.push(attribute('langfuse.observation.metadata.agentPrompts', agentPrompts), attribute('langfuse.observation.metadata.agentPromptSnapshot', agentPrompts.snapshotSha256));
      for (const reference of Array.isArray(agentPrompts.references) ? agentPrompts.references : []) {
        const value = record(reference);
        if (typeof value.key === 'string') attributes.push(attribute('langfuse.observation.metadata.agentPromptVersion_' + value.key.replaceAll('-', '_'), value.version));
      }
    }
    if (step.kind === 'model') {
      const primary = record(agentPrompts.primary);
      if (step.attributes.purpose === 'turn' && typeof primary.name === 'string' && Number.isInteger(primary.version)) attributes.push(attribute('langfuse.observation.prompt.name', primary.name), { key: 'langfuse.observation.prompt.version', value: { intValue: String(primary.version) } });
      const model = record(step.attributes.model ?? document.input.model), usage = usageDetails(step);
      if (typeof model.id === 'string') attributes.push(attribute('langfuse.observation.model.name', model.id));
      if (typeof model.provider === 'string') attributes.push(attribute('gen_ai.system', model.provider));
      if (Object.keys(usage).length) attributes.push(attribute('langfuse.observation.usage_details', usage));
      if (step.usage.length) attributes.push(attribute('langfuse.observation.metadata.reportedUsage', step.usage));
    }
    return { traceId, spanId: identity(step.stepId, 16), ...(step.parentStepId ? { parentSpanId: identity(step.parentStepId, 16) } : {}),
      name: step.name, kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end), attributes,
      status: { code: failed ? 2 : 0, ...(step.error ? { message: step.error.message } : {}) } };
  });
  return { traceId, spans };
}

/** Awaited by the host at run termination. Remote failure must not change task success. */
export async function exportToLangfuse(trace: Trace, env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch): Promise<LangfuseExportResult> {
  const redactor = new Redactor(Object.entries(env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  let result: LangfuseExportResult;
  let destination: string | undefined;
  let exportedTraceId: string | undefined;
  const key = 'traces/' + trace.runId + '.langfuse.json';
  try {
    const config = readLangfuseConfig(env);
    if (!config) return { status: 'disabled' };
    // Project identity avoids suppressing an explicit export to a different instance/project.
    destination = identity(config.baseUrl + ':' + config.publicKey, 64);
    const previous = trace.store.read<{ destination?: string; result?: LangfuseExportResult }>(key, {});
    if (previous.destination === destination && previous.result?.status === 'exported') return previous.result;
    const document = redactor.clean(trace.redactor.clean(trace.exportStructured()));
    const { traceId, spans } = langfusePayload(document, config);
    exportedTraceId = traceId;
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [attribute('service.name', 'cwatch')] },
      scopeSpans: [{ scope: { name: 'cwatch.langfuse', version: '1' }, spans }] }] });
    const response = await transport(config.baseUrl + '/api/public/otel/v1/traces', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64'), 'x-langfuse-ingestion-version': '4' }, body,
    });
    // Read the body under the same timeout. Never expose remote response text or auth headers.
    const text = await response.text();
    if (!response.ok) throw Error('langfuse_export: HTTP ' + response.status);
    const payload = text.trim() ? record(JSON.parse(text)) : {};
    const partial = record(payload.partialSuccess);
    if (Number(partial.rejectedSpans ?? 0) > 0 || partial.errorMessage) throw Error('langfuse_export: OTLP partial rejection');
    result = { status: 'exported', traceId, spanCount: spans.length };
  } catch (error) {
    // Config/transport errors may contain user-controlled URLs; expose known safe messages only.
    const message = error instanceof Error ? error.message : '';
    result = { status: 'failed', ...(exportedTraceId ? { traceId: exportedTraceId } : {}), error: redactor.clean(/^langfuse_(?:config|export):/.test(message) ? message : 'langfuse_export: transport or response failure') };
  }
  try { trace.store.write(key, { destination, result, updatedAt: new Date().toISOString() }); }
  catch { /* The returned status remains available even when the sidecar cannot be saved. */ }
  return result;
}
