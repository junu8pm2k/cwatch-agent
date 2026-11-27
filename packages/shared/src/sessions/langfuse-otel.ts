import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { context as otelContext, SpanStatusCode, trace as otelTrace, type Context, type Span } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  createObservationAttributes,
  LangfuseOtelSpanAttributes,
  type LangfuseGenerationAttributes,
  type LangfuseObservationType,
  type LangfuseSpanAttributes,
  type ObservationLevel,
} from '@langfuse/tracing';
import { z } from 'zod';
import { langfuseTraceUrl, readLangfuseConfig, type LangfuseConfig } from '../config/langfuse.ts';
import { reportedTokens } from '../agent/core/budgets.ts';
import { Redactor } from './trace.ts';

export const OTEL_TRACE_ARTIFACT_VERSION = 'cwatch.otel-trace.v1' as const;

export const LangfuseRunScoreSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  value: z.number(),
  dataType: z.enum(['NUMERIC', 'BOOLEAN']),
  comment: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type LangfuseRunScore = z.infer<typeof LangfuseRunScoreSchema>;

export const OtlpTraceArtifactSchema = z.object({
  schemaVersion: z.literal(OTEL_TRACE_ARTIFACT_VERSION),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  environment: z.string().min(1),
  resourceSpans: z.array(z.record(z.string(), z.unknown())),
  scores: z.array(LangfuseRunScoreSchema).default([]),
}).strict();
export type OtlpTraceArtifact = z.infer<typeof OtlpTraceArtifactSchema>;

export type LangfuseExportResult =
  | { status: 'disabled' }
  | { status: 'exported'; traceId: string; spanCount: number; traceUrl?: string }
  | { status: 'file_exported'; traceId: string; spanCount: number; filePath: string }
  | { status: 'failed'; error: string; traceId?: string; traceUrl?: string };

export interface LangfuseLiveInfo {
  status: 'disabled' | 'streaming' | 'exported' | 'failed';
  traceId?: string;
  traceUrl?: string;
  error?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export function langfuseTraceId(runId: string): string {
  return createHash('sha256').update('cwatch:' + runId).digest('hex').slice(0, 32);
}

function scoreId(traceId: string, name: string): string {
  return createHash('sha256').update(`cwatch:score:${traceId}:${name}`).digest('hex').slice(0, 32);
}

function serializeSpansToOtlp(spans: ReadableSpan[]): Record<string, unknown>[] {
  const bytes = JsonTraceSerializer.serializeRequest(spans);
  if (!bytes) return [];
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { resourceSpans?: Record<string, unknown>[] };
  return Array.isArray(parsed.resourceSpans) ? parsed.resourceSpans : [];
}

function countResourceSpans(resourceSpans: Record<string, unknown>[]): number {
  let count = 0;
  for (const rs of resourceSpans) {
    const scopeSpans = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
    for (const ss of scopeSpans) {
      const spans = Array.isArray((ss as { spans?: unknown[] }).spans) ? (ss as { spans: unknown[] }).spans : [];
      count += spans.length;
    }
  }
  return count;
}

function authHeader(config: Pick<LangfuseConfig, 'publicKey' | 'secretKey'>): string {
  return 'Basic ' + Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64');
}

function upsertOtlpStringAttr(attributes: Array<{ key: string; value: Record<string, unknown> }>, key: string, stringValue: string): void {
  const existing = attributes.find(attr => attr.key === key);
  if (existing) existing.value = { stringValue };
  else attributes.push({ key, value: { stringValue } });
}

/**
 * Enrich serialized OTLP resourceSpans (e.g. keyless CI trace.otel.json) before uploading to Langfuse.
 * Keeps the span tree and observation structure 100% isomorphic with live runs.
 */
export function enrichOtlpResourceSpans(
  resourceSpans: Record<string, unknown>[],
  options: {
    sessionId?: string;
    environment?: string;
    metadata?: Record<string, string>;
    rootInputOverride?: unknown;
    rootOutputOverride?: unknown;
  },
): Record<string, unknown>[] {
  const cloned = structuredClone(resourceSpans);
  for (const rs of cloned) {
    const scopeSpans = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
    for (const ss of scopeSpans) {
      const spans = Array.isArray((ss as { spans?: unknown[] }).spans) ? (ss as { spans: Record<string, unknown>[] }).spans : [];
      for (const span of spans) {
        const attrs = Array.isArray(span.attributes)
          ? span.attributes as Array<{ key: string; value: Record<string, unknown> }>
          : (span.attributes = [], span.attributes as Array<{ key: string; value: Record<string, unknown> }>);
        if (options.sessionId) upsertOtlpStringAttr(attrs, LangfuseOtelSpanAttributes.TRACE_SESSION_ID, options.sessionId);
        if (options.environment) upsertOtlpStringAttr(attrs, LangfuseOtelSpanAttributes.ENVIRONMENT, options.environment);
        const isRoot = !span.parentSpanId;
        if (isRoot) {
          for (const [k, v] of Object.entries(options.metadata ?? {})) {
            upsertOtlpStringAttr(attrs, `${LangfuseOtelSpanAttributes.TRACE_METADATA}.${k}`, v);
            upsertOtlpStringAttr(attrs, `${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.${k}`, v);
          }
          if (options.rootInputOverride !== undefined) {
            const serialized = JSON.stringify(options.rootInputOverride);
            upsertOtlpStringAttr(attrs, LangfuseOtelSpanAttributes.TRACE_INPUT, serialized);
            upsertOtlpStringAttr(attrs, LangfuseOtelSpanAttributes.OBSERVATION_INPUT, serialized);
          }
          if (options.rootOutputOverride !== undefined) {
            const serialized = JSON.stringify(options.rootOutputOverride);
            upsertOtlpStringAttr(attrs, LangfuseOtelSpanAttributes.TRACE_OUTPUT, serialized);
            upsertOtlpStringAttr(attrs, LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT, serialized);
          }
        }
      }
    }
  }
  return cloned;
}

export async function sendOtlpResourceSpans(
  config: LangfuseConfig,
  resourceSpans: Record<string, unknown>[],
  transport: typeof fetch = fetch,
  redactor = new Redactor([config.publicKey, config.secretKey]),
): Promise<void> {
  if (!resourceSpans.length) return;
  const body = JSON.stringify(redactor.clean({ resourceSpans }));
  const response = await transport(config.baseUrl + '/api/public/otel/v1/traces', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(config),
      'x-langfuse-ingestion-version': '4',
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw Error('langfuse_export: HTTP ' + response.status);
  const payload = text.trim() ? record(JSON.parse(text)) : {};
  const partial = record(payload.partialSuccess);
  if (Number(partial.rejectedSpans ?? 0) > 0 || partial.errorMessage) {
    throw Error('langfuse_export: OTLP partial rejection');
  }
}

export async function sendLangfuseScores(
  config: LangfuseConfig,
  traceId: string,
  scores: LangfuseRunScore[],
  transport: typeof fetch = fetch,
  redactor = new Redactor([config.publicKey, config.secretKey]),
): Promise<void> {
  if (!scores.length) return;
  const timestamp = new Date().toISOString();
  const items = scores.map(item => ({
    id: item.id,
    traceId,
    name: item.name,
    value: item.value,
    dataType: item.dataType,
    environment: config.environment,
    timestamp,
    ...(item.comment ? { comment: redactor.clean(item.comment).slice(0, 2000) } : {}),
    ...(item.metadata ? { metadata: redactor.clean(item.metadata) } : {}),
  }));
  for (let offset = 0; offset < items.length; offset += 100) {
    const response = await transport(config.baseUrl + '/api/public/scores', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(config),
      },
      body: JSON.stringify(items.slice(offset, offset + 100)),
    });
    if (!response.ok) throw Error('langfuse_scores: HTTP ' + response.status);
    const text = await response.text();
    const parsed = text.trim() ? record(JSON.parse(text)) : {};
    if (Array.isArray(parsed.errors) && parsed.errors.length) {
      throw Error('langfuse_scores: partial failure');
    }
  }
}

/** Realtime OTLP HTTP exporter wired into official LangfuseSpanProcessor. */
export class LangfuseOtlpHttpExporter implements SpanExporter {
  exportedSpans = 0;
  lastError?: string;
  constructor(
    private readonly config: LangfuseConfig,
    private readonly redactor: Redactor,
    private readonly transport: typeof fetch = fetch,
  ) {}
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const resourceSpans = serializeSpansToOtlp(spans);
    const batchCount = countResourceSpans(resourceSpans);
    if (!batchCount) { resultCallback({ code: ExportResultCode.SUCCESS }); return; }
    void sendOtlpResourceSpans(this.config, resourceSpans, this.transport, this.redactor)
      .then(() => {
        this.exportedSpans += batchCount;
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : '';
        this.lastError = this.redactor.clean(/^langfuse_(?:config|export|scores):/.test(message) ? message : 'langfuse_export: transport or response failure');
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(this.lastError) });
      });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

/** Local OTLP Span file exporter for keyless CI containers (100% isomorphic with live export). */
export class OtlpFileSpanExporter implements SpanExporter {
  readonly resourceSpans: Record<string, unknown>[] = [];
  exportedSpans = 0;
  constructor(private readonly redactor: Redactor) {}
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const serialized = this.redactor.clean(serializeSpansToOtlp(spans));
      const count = countResourceSpans(serialized);
      if (count) {
        this.resourceSpans.push(...serialized);
        this.exportedSpans += count;
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function extractUsageDetails(usage: unknown): Record<string, number> {
  const raw = record(usage);
  const details: Record<string, number> = {};
  for (const [source, target] of [
    ['input', 'input'],
    ['promptTokens', 'input'],
    ['prompt_tokens', 'input'],
    ['output', 'output'],
    ['completionTokens', 'output'],
    ['completion_tokens', 'output'],
    ['cacheRead', 'cache_read_input_tokens'],
    ['cacheWrite', 'cache_creation_input_tokens'],
    ['totalTokens', 'total'],
    ['total_tokens', 'total'],
  ] as const) {
    const value = num(raw[source]);
    if (value !== undefined && details[target] === undefined) details[target] = value;
  }
  return details;
}

function contentMetrics(content: unknown) {
  let thinkingChars = 0;
  let textChars = 0;
  let toolCallCount = 0;
  const textParts: string[] = [];
  const toolCalls: Array<{ id?: string; name?: string; arguments?: unknown }> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = record(block);
      if (b.type === 'thinking' && typeof b.thinking === 'string') thinkingChars += b.thinking.length;
      if (b.type === 'text' && typeof b.text === 'string') {
        textChars += b.text.length;
        textParts.push(b.text);
      }
      if (b.type === 'toolCall') {
        toolCallCount++;
        toolCalls.push({ id: str(b.id), name: str(b.name), arguments: b.arguments });
      }
    }
  }
  return {
    thinkingChars,
    textChars,
    toolCallCount,
    thinkingToTextRatio: textChars > 0 ? Number((thinkingChars / textChars).toFixed(2)) : thinkingChars > 0 ? thinkingChars : 0,
    text: textParts.join('\n'),
    toolCalls,
  };
}

function modelParams(raw: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export interface LangfuseRunTracerOptions {
  runId: string;
  taskId: string;
  sessionId?: string;
  mode: 'live' | 'replay';
  redactor: Redactor;
  env?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  otelFilePath?: string;
  environment?: string;
  release?: string;
  traceMetadata?: Record<string, string>;
}

interface ActiveGeneration {
  span: Span;
  purpose: 'turn' | 'memory' | 'summary' | 'intent' | 'rejected';
  plannedMaxTokens?: number;
  wireMaxTokens?: number;
  model?: string;
  provider?: string;
  attempt?: number;
  maxAttempts?: number;
  usageDetails?: Record<string, number>;
  stopReason?: string;
  thinkingChars?: number;
  textChars?: number;
  toolCallCount?: number;
  output?: unknown;
  degraded?: boolean;
  ended: boolean;
}

interface ActiveTool {
  span: Span;
  name: string;
  startedAt: number;
  ended: boolean;
  guardrail?: Span;
  guardrailStartedAt?: number;
  approvalRequestedAt?: number;
}

/**
 * Single unified OpenTelemetry + Langfuse v4 instrumentation layer.
 * Produces an isomorphic nested tree for both live HTTP streaming and keyless CI file export.
 */
export class LangfuseRunTracer {
  readonly traceId: string;
  readonly sessionId: string;
  readonly enabled: boolean;
  private readonly config?: LangfuseConfig;
  private readonly configError?: string;
  private readonly otelFilePath?: string;
  private readonly environment: string;
  private readonly redactor: Redactor;
  private readonly transport: typeof fetch;
  private readonly provider?: NodeTracerProvider;
  private readonly processor?: LangfuseSpanProcessor;
  private readonly httpExporter?: LangfuseOtlpHttpExporter;
  private readonly fileExporter?: OtlpFileSpanExporter;
  private readonly tracer?: ReturnType<NodeTracerProvider['getTracer']>;

  private rootSpan?: Span;
  private currentTurnSpan?: Span;
  private currentTurnIteration?: number;
  private currentContextSpan?: Span;
  private currentMemorySpan?: Span;
  private currentCompactSpan?: Span;
  private activeTurnGen?: ActiveGeneration;
  private activeMemoryGen?: ActiveGeneration;
  private activeSummaryGen?: ActiveGeneration;
  private pendingMemoryDegraded?: { reason: string; circuitOpen: boolean; pendingRounds?: unknown };
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly activeBackends = new Map<string, Span>();

  private modelId?: string;
  private modelProvider?: string;
  private primaryPrompt?: { name: string; version: number };
  private agentPromptsMeta?: Record<string, unknown>;
  private profileMode: 'live' | 'replay';

  // Run-level analytics counters for automatic Tags & Scores
  private memoryBatches = 0;
  private memoryFirstTrySuccesses = 0;
  private memoryAttemptInBatch = 0;
  private memoryDegradedCount = 0;
  private memoryCircuitOpened = false;
  private compactTriggered = 0;
  private compactSucceeded = 0;
  private reactiveCompactUsed = false;
  private reworkUsed = false;
  private truncationCount = 0;
  private schemaInvalidCount = 0;
  private budgetExceededCount = 0;
  private providerRejectedCount = 0;
  private totalReportedTokens = 0;
  private auxReportedTokens = 0;
  private cacheReadTokens = 0;
  private normalizedInputTokens = 0;
  private toolExecutions = 0;
  private toolErrors = 0;
  private finished = false;
  private finalResult?: LangfuseExportResult;

  constructor(options: LangfuseRunTracerOptions) {
    this.traceId = langfuseTraceId(options.runId);
    this.sessionId = options.sessionId ?? options.taskId;
    this.profileMode = options.mode;
    this.otelFilePath = options.otelFilePath;
    this.transport = options.transport ?? fetch;

    const env = options.env ?? process.env;
    const envSecrets = Object.entries(env)
      .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key))
      .map(([, value]) => value ?? '');
    const envRedactor = new Redactor(envSecrets);
    const combinedClean = <T>(value: T): T => envRedactor.clean(options.redactor.clean(value));
    this.redactor = { clean: combinedClean } as Redactor;

    let config: LangfuseConfig | undefined;
    if (!options.otelFilePath && options.mode === 'live') {
      try {
        config = readLangfuseConfig(env);
      } catch (error) {
        this.configError = combinedClean(error instanceof Error ? error.message : 'langfuse_config: invalid configuration');
      }
    }
    this.config = config;
    this.environment = options.environment ?? config?.environment ?? env.LANGFUSE_TRACING_ENVIRONMENT?.trim() ?? 'development';

    const mask = ({ data }: { data: unknown }) => combinedClean(data);

    if (options.otelFilePath) {
      this.fileExporter = new OtlpFileSpanExporter({ clean: combinedClean } as Redactor);
      this.processor = new LangfuseSpanProcessor({
        exporter: this.fileExporter,
        environment: this.environment,
        release: options.release,
        mediaUploadEnabled: false,
        exportMode: 'immediate',
        mask,
      });
    } else if (config) {
      this.httpExporter = new LangfuseOtlpHttpExporter(config, { clean: combinedClean } as Redactor, this.transport);
      this.processor = new LangfuseSpanProcessor({
        exporter: this.httpExporter,
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        environment: config.environment,
        release: options.release,
        timeout: Math.max(1, Math.ceil(config.timeoutMs / 1000)),
        mediaUploadEnabled: false,
        exportMode: 'batched',
        flushAt: 8,
        flushInterval: 2,
        mask,
      });
    }

    if (this.processor) {
      this.enabled = true;
      const fixedTraceId = this.traceId;
      this.provider = new NodeTracerProvider({
        resource: resourceFromAttributes({ 'service.name': 'cwatch' }),
        idGenerator: {
          generateTraceId: () => fixedTraceId,
          generateSpanId: () => randomBytes(8).toString('hex'),
        },
        spanProcessors: [this.processor],
      });
      this.tracer = this.provider.getTracer('langfuse-sdk');
    } else {
      this.enabled = false;
    }
  }

  get traceUrl(): string | undefined {
    return this.config ? langfuseTraceUrl(this.config.baseUrl, this.traceId, this.config.projectId) : undefined;
  }

  liveInfo(): LangfuseLiveInfo {
    if (this.finalResult) {
      if (this.finalResult.status === 'exported') return { status: 'exported', traceId: this.finalResult.traceId, traceUrl: this.finalResult.traceUrl };
      if (this.finalResult.status === 'failed') return { status: 'failed', traceId: this.finalResult.traceId, traceUrl: this.finalResult.traceUrl, error: this.finalResult.error };
      return { status: 'disabled' };
    }
    if (this.configError) return { status: 'failed', traceId: this.traceId, error: this.configError };
    if (this.config) return { status: 'streaming', traceId: this.traceId, traceUrl: this.traceUrl };
    return { status: 'disabled' };
  }

  private parentCtx(parent?: Span): Context {
    const target = parent ?? this.rootSpan;
    return target ? otelTrace.setSpan(otelContext.active(), target) : otelContext.active();
  }

  private startObs(
    name: string,
    asType: LangfuseObservationType,
    attrs: LangfuseSpanAttributes & LangfuseGenerationAttributes = {},
    parent?: Span,
    extraOtelAttrs?: Record<string, string | number | boolean | string[]>,
  ): Span | undefined {
    if (!this.tracer) return undefined;
    const cleaned = this.redactor.clean(attrs);
    const otelAttrs = createObservationAttributes(asType, cleaned);
    return this.tracer.startSpan(name, {
      attributes: { ...otelAttrs, ...(extraOtelAttrs ?? {}) },
    }, this.parentCtx(parent));
  }

  private updateObs(
    span: Span | undefined,
    asType: LangfuseObservationType,
    attrs: LangfuseSpanAttributes & LangfuseGenerationAttributes,
  ): void {
    if (!span) return;
    const cleaned = this.redactor.clean(attrs);
    span.setAttributes(createObservationAttributes(asType, cleaned));
  }

  private finishGen(gen: ActiveGeneration | undefined, opts: {
    outcome: 'succeeded' | 'retried' | 'degraded' | 'blocked' | 'failed';
    level?: ObservationLevel;
    statusMessage?: string;
    validationErrors?: string[];
    extraMeta?: Record<string, unknown>;
    output?: unknown;
  }): void {
    if (!gen || gen.ended) return;
    gen.ended = true;
    const wireMax = gen.wireMaxTokens ?? gen.plannedMaxTokens;
    const outTokens = gen.usageDetails?.output;
    const outputUtilization = wireMax && wireMax > 0 && outTokens !== undefined
      ? Number((outTokens / wireMax).toFixed(3))
      : undefined;
    const thinkingChars = gen.thinkingChars ?? 0;
    const textChars = gen.textChars ?? 0;
    const thinkingToTextRatio = textChars > 0 ? Number((thinkingChars / textChars).toFixed(2)) : thinkingChars > 0 ? thinkingChars : 0;
    const params = modelParams({
      ...(gen.plannedMaxTokens !== undefined ? { maxTokens: gen.plannedMaxTokens } : {}),
      ...(gen.wireMaxTokens !== undefined ? { wireMaxTokens: gen.wireMaxTokens } : {}),
    });
    const metadata: Record<string, unknown> = {
      purpose: gen.purpose,
      outcome: opts.outcome,
      ...(gen.attempt !== undefined ? { attempt: gen.attempt } : {}),
      ...(gen.maxAttempts !== undefined ? { maxAttempts: gen.maxAttempts } : {}),
      ...(gen.stopReason ? { stopReason: gen.stopReason } : {}),
      thinkingChars,
      textChars,
      thinkingToTextRatio,
      ...(gen.toolCallCount !== undefined ? { toolCallCount: gen.toolCallCount } : {}),
      ...(wireMax !== undefined ? { wireMaxTokens: wireMax } : {}),
      ...(outputUtilization !== undefined ? { outputUtilization } : {}),
      ...(opts.validationErrors?.length ? { validationErrors: opts.validationErrors } : {}),
      ...(opts.extraMeta ?? {}),
    };
    const isError = opts.level === 'ERROR' || opts.outcome === 'failed' || opts.outcome === 'retried' || opts.outcome === 'degraded';
    const level: ObservationLevel = opts.level ?? (isError ? 'ERROR' : gen.degraded ? 'WARNING' : 'DEFAULT');
    this.updateObs(gen.span, 'generation', {
      ...(gen.model ? { model: gen.model } : {}),
      ...(Object.keys(params).length ? { modelParameters: params } : {}),
      ...(gen.usageDetails && Object.keys(gen.usageDetails).length ? { usageDetails: gen.usageDetails } : {}),
      ...(opts.output !== undefined ? { output: opts.output } : gen.output !== undefined ? { output: gen.output } : {}),
      level,
      ...(opts.statusMessage ? { statusMessage: opts.statusMessage } : {}),
      metadata,
    });
    if (isError) gen.span.setStatus({ code: SpanStatusCode.ERROR, message: opts.statusMessage ?? opts.outcome });
    else gen.span.setStatus({ code: SpanStatusCode.OK });
    gen.span.end();
  }

  startRun(input: {
    runId: string;
    taskId: string;
    task: unknown;
    mode: 'live' | 'replay';
    permissionMode: string;
    engine: string;
    model?: { provider?: string; id?: string; reasoningEffort?: string } | null;
    agentPrompts?: Record<string, unknown>;
    extraMetadata?: Record<string, string>;
  }): void {
    this.modelId = str(input.model?.id);
    this.modelProvider = str(input.model?.provider);
    this.agentPromptsMeta = input.agentPrompts;
    const primary = record(input.agentPrompts?.primary);
    if (typeof primary.name === 'string' && Number.isInteger(primary.version)) {
      this.primaryPrompt = { name: primary.name, version: Number(primary.version) };
    }
    if (!this.tracer) return;
    const cleanedTask = this.redactor.clean(input.task);
    const traceAttrs: Record<string, string | number | boolean | string[]> = {
      [LangfuseOtelSpanAttributes.TRACE_NAME]: 'cwatch.agent',
      [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: this.sessionId,
      [LangfuseOtelSpanAttributes.TRACE_INPUT]: JSON.stringify(cleanedTask),
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.runId`]: input.runId,
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.taskId`]: input.taskId,
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.mode`]: input.mode,
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.permissionMode`]: input.permissionMode,
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.engine`]: input.engine,
    };
    if (this.modelId) traceAttrs[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.model`] = this.modelId;
    if (this.modelProvider) traceAttrs[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.provider`] = this.modelProvider;
    for (const [k, v] of Object.entries(input.extraMetadata ?? {})) {
      traceAttrs[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${k}`] = this.redactor.clean(v);
    }
    this.rootSpan = this.startObs('agent.run', 'agent', {
      input: cleanedTask,
      metadata: {
        runId: input.runId,
        taskId: input.taskId,
        mode: input.mode,
        permissionMode: input.permissionMode,
        engine: input.engine,
        model: input.model ?? null,
        ...(input.agentPrompts ? { agentPrompts: input.agentPrompts } : {}),
        ...(input.extraMetadata ?? {}),
      },
    }, undefined, traceAttrs);
  }

  startTurn(iteration: number, info: { contextChars?: number; toolCount?: number; promptInput?: unknown } = {}): void {
    this.closeTurn();
    this.currentTurnIteration = iteration;
    this.currentTurnSpan = this.startObs(`turn.${iteration}`, 'chain', {
      metadata: {
        iteration,
        ...(info.contextChars !== undefined ? { contextChars: info.contextChars } : {}),
        ...(info.toolCount !== undefined ? { toolSchemaCount: info.toolCount } : {}),
      },
    }, this.rootSpan);
    this.currentContextSpan = this.startObs('context.prepare', 'span', {
      metadata: { iteration },
    }, this.currentTurnSpan);
    if (info.promptInput !== undefined) {
      // Replay or single-step paths without cwatch.model_request still emit a generation span.
      this.openModelTurnGeneration({ input: info.promptInput, inputChars: info.contextChars });
    }
  }

  private closeContextPrepare(): void {
    if (this.activeMemoryGen && !this.activeMemoryGen.ended) {
      this.finishGen(this.activeMemoryGen, { outcome: 'failed', level: 'ERROR', statusMessage: 'Memory attempt interrupted before completion.' });
      this.activeMemoryGen = undefined;
    }
    if (this.currentMemorySpan) { this.currentMemorySpan.end(); this.currentMemorySpan = undefined; }
    if (this.activeSummaryGen && !this.activeSummaryGen.ended) {
      this.finishGen(this.activeSummaryGen, { outcome: 'failed', level: 'ERROR', statusMessage: 'Summary attempt interrupted before completion.' });
      this.activeSummaryGen = undefined;
    }
    if (this.currentCompactSpan) { this.currentCompactSpan.end(); this.currentCompactSpan = undefined; }
    if (this.currentContextSpan) { this.currentContextSpan.end(); this.currentContextSpan = undefined; }
  }

  private closeTurn(): void {
    this.closeContextPrepare();
    if (this.activeTurnGen && !this.activeTurnGen.ended) {
      this.finishGen(this.activeTurnGen, { outcome: 'failed', level: 'ERROR', statusMessage: 'Model turn ended without decision.' });
      this.activeTurnGen = undefined;
    }
    if (this.currentTurnSpan) {
      this.currentTurnSpan.end();
      this.currentTurnSpan = undefined;
    }
  }

  private openModelTurnGeneration(data: {
    model?: string;
    input?: unknown;
    inputChars?: number;
    maxTokens?: number;
    wireMaxTokens?: number;
    reasoningEffort?: string;
    cacheRetention?: string;
    toolCount?: number;
  }): void {
    this.closeContextPrepare();
    if (this.activeTurnGen && !this.activeTurnGen.ended) {
      this.finishGen(this.activeTurnGen, { outcome: 'retried', level: 'WARNING', statusMessage: 'Superseded by retry request.' });
    }
    const model = data.model ?? this.modelId;
    const params = modelParams({
      ...(data.maxTokens !== undefined ? { maxTokens: data.maxTokens } : {}),
      ...(data.wireMaxTokens !== undefined ? { wireMaxTokens: data.wireMaxTokens } : {}),
      ...(data.reasoningEffort ? { reasoningEffort: data.reasoningEffort } : {}),
      ...(data.cacheRetention ? { cacheRetention: data.cacheRetention } : {}),
    });
    const degraded = this.pendingMemoryDegraded;
    this.pendingMemoryDegraded = undefined;
    const span = this.startObs('model.turn', 'generation', {
      model,
      ...(Object.keys(params).length ? { modelParameters: params } : {}),
      ...(data.input !== undefined ? { input: data.input } : {}),
      ...(this.primaryPrompt ? { prompt: { name: this.primaryPrompt.name, version: this.primaryPrompt.version, isFallback: false } } : {}),
      ...(degraded ? {
        level: 'WARNING',
        statusMessage: `Session memory degraded (${degraded.reason}); continued with previous checkpoint${degraded.circuitOpen ? ' (memory circuit open)' : ''}.`,
      } : {}),
      metadata: {
        purpose: 'turn',
        iteration: this.currentTurnIteration,
        ...(data.inputChars !== undefined ? { inputChars: data.inputChars } : {}),
        ...(data.toolCount !== undefined ? { toolSchemaCount: data.toolCount } : {}),
        ...(this.modelProvider ? { provider: this.modelProvider } : {}),
        ...(degraded ? { memoryDegraded: degraded } : {}),
      },
    }, this.currentTurnSpan ?? this.rootSpan);
    if (span) {
      if (this.modelProvider) span.setAttribute('gen_ai.system', this.modelProvider);
      this.activeTurnGen = {
        span,
        purpose: 'turn',
        model,
        provider: this.modelProvider,
        plannedMaxTokens: data.maxTokens,
        wireMaxTokens: data.wireMaxTokens ?? data.maxTokens,
        degraded: Boolean(degraded),
        ended: false,
      };
    }
  }

  /** Consumes worker-archived session entries in real time from onTranscript. */
  onTranscriptEntry(entry: unknown): void {
    const e = record(entry);
    if (e.type === 'message') {
      const msg = record(e.message);
      if (msg.role === 'assistant' && this.activeTurnGen && !this.activeTurnGen.ended) {
        const metrics = contentMetrics(msg.content);
        const stopReason = str(msg.stopReason) ?? 'unknown';
        this.activeTurnGen.stopReason = stopReason;
        this.activeTurnGen.thinkingChars = metrics.thinkingChars;
        this.activeTurnGen.textChars = metrics.textChars;
        this.activeTurnGen.toolCallCount = metrics.toolCallCount;
        this.activeTurnGen.output = {
          text: metrics.text,
          ...(metrics.toolCalls.length ? { toolCalls: metrics.toolCalls } : {}),
          ...(str(msg.errorMessage) ? { errorMessage: str(msg.errorMessage) } : {}),
        };
        if (stopReason === 'length') this.truncationCount++;
        const usage = extractUsageDetails(msg.usage);
        if (Object.keys(usage).length) this.activeTurnGen.usageDetails = usage;
      }
      return;
    }
    if (e.type === 'compaction') {
      const details = record(e.details);
      if (this.currentCompactSpan) {
        const before = num(details.charsBefore);
        const after = num(details.charsAfter);
        this.updateObs(this.currentCompactSpan, 'span', {
          output: { summaryLength: typeof e.summary === 'string' ? e.summary.length : 0, charsBefore: before, charsAfter: after },
          metadata: {
            charsBefore: before,
            charsAfter: after,
            reductionRatio: before && after !== undefined ? Number(((before - after) / before).toFixed(3)) : undefined,
            retainedRounds: Array.isArray(details.retainedRoundIds) ? details.retainedRoundIds.length : undefined,
          },
        });
      }
      return;
    }
    if (e.type !== 'custom') return;
    const customType = str(e.customType);
    const data = record(e.data);
    if (!customType) return;

    if (customType === 'cwatch.context_prepare') {
      this.updateObs(this.currentContextSpan, 'span', {
        output: {
          charsBefore: data.charsBefore,
          charsAfter: data.charsAfter,
          windowTokens: data.windowTokens,
          inputLimit: data.inputLimit,
          compactNeeded: data.compactNeeded,
        },
        metadata: {
          triggerReason: data.triggerReason,
          charsBefore: data.charsBefore,
          charsAfter: data.charsAfter,
          windowTokens: data.windowTokens,
          inputLimit: data.inputLimit,
          windowUtilization: num(data.windowTokens) !== undefined && num(data.inputLimit)
            ? Number(((num(data.windowTokens)! / num(data.inputLimit)!)).toFixed(3))
            : undefined,
          snippedCount: data.snippedCount,
          microcompactedCount: data.microcompactedCount,
          reactive: Boolean(data.reactive),
        },
      });
      return;
    }

    if (customType === 'cwatch.reactive_compact') {
      this.reactiveCompactUsed = true;
      if (this.currentCompactSpan) {
        this.updateObs(this.currentCompactSpan, 'span', { metadata: { reactiveStage: data.stage, reactiveCircuitOpen: data.open } });
      }
      return;
    }

    if (customType === 'cwatch.model_request') {
      const payload = record(data.payload);
      const wireMax = num(payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens);
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      const promptCache = record(data.promptCache);
      const inputChars = JSON.stringify(payload).length;
      this.openModelTurnGeneration({
        model: str(data.model) ?? this.modelId,
        input: { messages: payload.messages, ...(payload.system ? { system: payload.system } : {}) },
        inputChars,
        wireMaxTokens: wireMax,
        reasoningEffort: str(payload.reasoning_effort),
        cacheRetention: str(promptCache.requestedRetention),
        toolCount: tools.length,
      });
      return;
    }

    if (customType.startsWith('cwatch.memory_')) {
      this.handleMemoryCustom(customType, data);
      return;
    }

    if (customType.startsWith('cwatch.summary_') || customType === 'cwatch.compact_commit') {
      this.handleSummaryCustom(customType, data);
    }
  }

  private handleMemoryCustom(customType: string, data: Record<string, unknown>): void {
    const parent = this.currentContextSpan ?? this.currentTurnSpan ?? this.rootSpan;
    if (customType === 'cwatch.memory_request') {
      const attempt = num(data.attempt) ?? 1;
      const maxAttempts = num(data.maxAttempts) ?? 3;
      if (attempt === 1) {
        this.memoryBatches++;
        this.memoryAttemptInBatch = 0;
        this.currentMemorySpan = this.startObs('memory.update', 'span', {
          metadata: { checkpointRevision: data.expectedRevision, maxAttempts },
        }, parent);
      }
      this.memoryAttemptInBatch = attempt;
      const ctx = record(data.context);
      const contract = record(data.contract);
      const sampling = record(contract.samplingParams);
      const plannedMax = num(data.maxTokens);
      const inputChars = JSON.stringify(ctx).length;
      const span = this.startObs(`memory.attempt.${attempt}`, 'generation', {
        model: this.modelId,
        input: ctx,
        modelParameters: modelParams({
          ...(plannedMax !== undefined ? { maxTokens: plannedMax } : {}),
          ...(str(sampling.reasoning_effort) ? { reasoningEffort: str(sampling.reasoning_effort)! } : {}),
          ...(str(record(sampling.response_format).type) ? { responseFormat: str(record(sampling.response_format).type)! } : {}),
        }),
        metadata: {
          purpose: 'memory',
          attempt,
          maxAttempts,
          checkpointRevision: data.expectedRevision,
          inputChars,
        },
      }, this.currentMemorySpan ?? parent);
      if (span) {
        if (this.modelProvider) span.setAttribute('gen_ai.system', this.modelProvider);
        this.activeMemoryGen = {
          span,
          purpose: 'memory',
          model: this.modelId,
          provider: this.modelProvider,
          plannedMaxTokens: plannedMax,
          attempt,
          maxAttempts,
          ended: false,
        };
      }
      return;
    }

    if (customType === 'cwatch.memory_wire_request' && this.activeMemoryGen) {
      const wireMax = num(data.maxTokens);
      this.activeMemoryGen.wireMaxTokens = wireMax;
      this.activeMemoryGen.model = str(data.model) ?? this.activeMemoryGen.model;
      this.updateObs(this.activeMemoryGen.span, 'generation', {
        model: this.activeMemoryGen.model,
        modelParameters: modelParams({
          ...(wireMax !== undefined ? { wireMaxTokens: wireMax } : {}),
          ...(str(data.reasoningEffort) ? { reasoningEffort: str(data.reasoningEffort)! } : {}),
          ...(str(record(data.responseFormat).type) ? { responseFormat: str(record(data.responseFormat).type)! } : {}),
        }),
      });
      return;
    }

    if (customType === 'cwatch.memory_response' && this.activeMemoryGen) {
      const metrics = contentMetrics(data.content);
      const stopReason = str(data.stopReason) ?? 'unknown';
      this.activeMemoryGen.stopReason = stopReason;
      this.activeMemoryGen.thinkingChars = metrics.thinkingChars;
      this.activeMemoryGen.textChars = metrics.textChars;
      this.activeMemoryGen.toolCallCount = metrics.toolCallCount;
      this.activeMemoryGen.output = metrics.text || (metrics.toolCalls.length ? { toolCalls: metrics.toolCalls } : '');
      const usage = extractUsageDetails(data.usage);
      if (Object.keys(usage).length) this.activeMemoryGen.usageDetails = usage;
      if (stopReason === 'length') this.truncationCount++;
      return;
    }

    if (customType === 'cwatch.memory_recovery') {
      const reason = str(data.reason) ?? 'unknown';
      const action = str(data.action) ?? 'stop';
      const validationErrors = Array.isArray(data.validationErrors) ? data.validationErrors.filter((v): v is string => typeof v === 'string') : undefined;
      if (reason === 'invalid_working_state') this.schemaInvalidCount++;
      const outcome = action === 'retry' ? 'retried' : action === 'degrade' ? 'degraded' : 'failed';
      this.finishGen(this.activeMemoryGen, {
        outcome,
        level: 'ERROR',
        statusMessage: `Memory ${reason} (${action})`,
        validationErrors,
        extraMeta: {
          reason,
          action,
          checkpointStatus: 'unchanged',
          ...(data.pendingRounds !== undefined ? { pendingRounds: data.pendingRounds } : {}),
          ...(data.consecutiveFailures !== undefined ? { consecutiveFailures: data.consecutiveFailures } : {}),
          ...(data.circuitOpen !== undefined ? { circuitOpen: data.circuitOpen } : {}),
        },
      });
      this.activeMemoryGen = undefined;
      if (action === 'degrade') {
        this.memoryDegradedCount++;
        if (data.circuitOpen === true) this.memoryCircuitOpened = true;
        this.pendingMemoryDegraded = { reason, circuitOpen: Boolean(data.circuitOpen), ...(data.pendingRounds !== undefined ? { pendingRounds: data.pendingRounds } : {}) };
        if (this.currentMemorySpan) {
          this.updateObs(this.currentMemorySpan, 'span', {
            level: 'WARNING',
            statusMessage: `Session memory degraded (${reason})${data.circuitOpen === true ? '; circuit open' : ''}`,
            output: { checkpointStatus: 'unchanged', reason, action, circuitOpen: Boolean(data.circuitOpen), pendingRounds: data.pendingRounds },
            metadata: { memoryCircuitOpen: Boolean(data.circuitOpen), pendingRounds: data.pendingRounds, consecutiveFailures: data.consecutiveFailures },
          });
          this.currentMemorySpan.end();
          this.currentMemorySpan = undefined;
        }
      } else if (action === 'stop' && this.currentMemorySpan) {
        this.updateObs(this.currentMemorySpan, 'span', { level: 'ERROR', statusMessage: `Session memory stopped (${reason})` });
        this.currentMemorySpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        this.currentMemorySpan.end();
        this.currentMemorySpan = undefined;
      }
      return;
    }

    if (customType === 'cwatch.memory_degraded') {
      const reason = str(data.reason) ?? 'delta_too_large';
      this.memoryBatches++;
      this.memoryDegradedCount++;
      if (data.circuitOpen === true) this.memoryCircuitOpened = true;
      this.pendingMemoryDegraded = { reason, circuitOpen: Boolean(data.circuitOpen), ...(data.pendingRounds !== undefined ? { pendingRounds: data.pendingRounds } : {}) };
      const span = this.currentMemorySpan ?? this.startObs('memory.update', 'span', {}, parent);
      if (span) {
        this.updateObs(span, 'span', {
          level: 'WARNING',
          statusMessage: `Session memory skipped (${reason})${data.circuitOpen === true ? '; circuit open' : ''}`,
          output: { checkpointStatus: 'unchanged', reason, action: 'degrade', circuitOpen: Boolean(data.circuitOpen), pendingRounds: data.pendingRounds },
          metadata: { checkpointRevision: data.checkpointRevision, pendingRounds: data.pendingRounds, consecutiveFailures: data.consecutiveFailures, memoryCircuitOpen: Boolean(data.circuitOpen) },
        });
        span.end();
      }
      this.currentMemorySpan = undefined;
      return;
    }

    if (customType === 'cwatch.memory_checkpoint') {
      if (this.memoryAttemptInBatch === 1) this.memoryFirstTrySuccesses++;
      this.finishGen(this.activeMemoryGen, {
        outcome: 'succeeded',
        level: 'DEFAULT',
        extraMeta: { checkpointStatus: 'saved', savedRevision: data.revision },
      });
      this.activeMemoryGen = undefined;
      if (this.currentMemorySpan) {
        this.updateObs(this.currentMemorySpan, 'span', {
          output: { checkpointStatus: 'saved', savedRevision: data.revision, lastMessageId: data.lastMessageId },
          metadata: { memoryRevision: data.revision },
        });
        this.currentMemorySpan.setStatus({ code: SpanStatusCode.OK });
        this.currentMemorySpan.end();
        this.currentMemorySpan = undefined;
      }
    }
  }

  private handleSummaryCustom(customType: string, data: Record<string, unknown>): void {
    const parent = this.currentContextSpan ?? this.currentTurnSpan ?? this.rootSpan;
    if (customType === 'cwatch.summary_request') {
      const attempt = num(data.attempt) ?? 1;
      const maxAttempts = num(data.maxAttempts) ?? 2;
      if (attempt === 1) {
        this.compactTriggered++;
        this.currentCompactSpan = this.startObs('compact.run', 'span', {
          metadata: { maxAttempts },
        }, parent);
      }
      const ctx = record(data.context);
      const contract = record(data.contract);
      const sampling = record(contract.samplingParams);
      const plannedMax = num(data.maxTokens);
      const inputChars = JSON.stringify(ctx).length;
      const span = this.startObs(`summary.attempt.${attempt}`, 'generation', {
        model: this.modelId,
        input: ctx,
        modelParameters: modelParams({
          ...(plannedMax !== undefined ? { maxTokens: plannedMax } : {}),
          ...(str(sampling.reasoning_effort) ? { reasoningEffort: str(sampling.reasoning_effort)! } : {}),
          ...(str(record(sampling.response_format).type) ? { responseFormat: str(record(sampling.response_format).type)! } : {}),
        }),
        metadata: {
          purpose: 'summary',
          attempt,
          maxAttempts,
          inputChars,
        },
      }, this.currentCompactSpan ?? parent);
      if (span) {
        if (this.modelProvider) span.setAttribute('gen_ai.system', this.modelProvider);
        this.activeSummaryGen = {
          span,
          purpose: 'summary',
          model: this.modelId,
          provider: this.modelProvider,
          plannedMaxTokens: plannedMax,
          attempt,
          maxAttempts,
          ended: false,
        };
      }
      return;
    }

    if (customType === 'cwatch.summary_wire_request' && this.activeSummaryGen) {
      const wireMax = num(data.maxTokens);
      this.activeSummaryGen.wireMaxTokens = wireMax;
      this.activeSummaryGen.model = str(data.model) ?? this.activeSummaryGen.model;
      this.updateObs(this.activeSummaryGen.span, 'generation', {
        model: this.activeSummaryGen.model,
        modelParameters: modelParams({
          ...(wireMax !== undefined ? { wireMaxTokens: wireMax } : {}),
          ...(str(data.reasoningEffort) ? { reasoningEffort: str(data.reasoningEffort)! } : {}),
          ...(str(record(data.responseFormat).type) ? { responseFormat: str(record(data.responseFormat).type)! } : {}),
        }),
      });
      return;
    }

    if (customType === 'cwatch.summary_response' && this.activeSummaryGen) {
      const metrics = contentMetrics(data.content);
      const stopReason = str(data.stopReason) ?? 'unknown';
      this.activeSummaryGen.stopReason = stopReason;
      this.activeSummaryGen.thinkingChars = metrics.thinkingChars;
      this.activeSummaryGen.textChars = metrics.textChars;
      this.activeSummaryGen.toolCallCount = metrics.toolCallCount;
      this.activeSummaryGen.output = metrics.text || (metrics.toolCalls.length ? { toolCalls: metrics.toolCalls } : '');
      const usage = extractUsageDetails(data.usage);
      if (Object.keys(usage).length) this.activeSummaryGen.usageDetails = usage;
      if (stopReason === 'length') this.truncationCount++;
      return;
    }

    if (customType === 'cwatch.summary_recovery') {
      const reason = str(data.reason) ?? 'unknown';
      const action = str(data.action) ?? 'stop';
      const validationErrors = Array.isArray(data.validationErrors) ? data.validationErrors.filter((v): v is string => typeof v === 'string') : undefined;
      if (reason === 'invalid_continuation' || reason === 'empty_summary') this.schemaInvalidCount++;
      this.finishGen(this.activeSummaryGen, {
        outcome: action === 'retry' ? 'retried' : 'failed',
        level: 'ERROR',
        statusMessage: `Summary ${reason} (${action})`,
        validationErrors,
        extraMeta: { reason, action },
      });
      this.activeSummaryGen = undefined;
      if (action === 'stop' && this.currentCompactSpan) {
        this.updateObs(this.currentCompactSpan, 'span', { level: 'ERROR', statusMessage: `Compaction failed (${reason})` });
        this.currentCompactSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        this.currentCompactSpan.end();
        this.currentCompactSpan = undefined;
      }
      return;
    }

    if (customType === 'cwatch.compact_commit') {
      this.compactSucceeded++;
      this.finishGen(this.activeSummaryGen, { outcome: 'succeeded', level: 'DEFAULT' });
      this.activeSummaryGen = undefined;
      if (this.currentCompactSpan) {
        this.updateObs(this.currentCompactSpan, 'span', {
          metadata: {
            attachmentCount: Array.isArray(data.attachmentEntryIds) ? data.attachmentEntryIds.length : 0,
            hookResultCount: Array.isArray(data.hookResultEntryIds) ? data.hookResultEntryIds.length : 0,
          },
        });
        this.currentCompactSpan.setStatus({ code: SpanStatusCode.OK });
        this.currentCompactSpan.end();
        this.currentCompactSpan = undefined;
      }
    }
  }

  onUsage(usage: unknown, purpose: 'turn' | 'summary' | 'memory' | 'rejected' = 'turn', cache?: Record<string, unknown>): void {
    const total = reportedTokens(usage);
    if (total !== undefined) {
      this.totalReportedTokens += total;
      if (purpose === 'memory' || purpose === 'summary') this.auxReportedTokens += total;
    }
    const read = num(cache?.readTokens);
    const input = num(cache?.normalizedInputTokens);
    if (read !== undefined) this.cacheReadTokens += read;
    if (input !== undefined) this.normalizedInputTokens += input;

    const details = extractUsageDetails(usage);
    if (purpose === 'turn' || purpose === 'rejected') {
      if (this.activeTurnGen && Object.keys(details).length) this.activeTurnGen.usageDetails = details;
    } else if (purpose === 'memory') {
      if (this.activeMemoryGen && Object.keys(details).length) this.activeMemoryGen.usageDetails = details;
    } else if (purpose === 'summary') {
      if (this.activeSummaryGen && Object.keys(details).length) this.activeSummaryGen.usageDetails = details;
    }
  }

  onDecision(decision: unknown): void {
    const d = record(decision);
    if (this.activeTurnGen && !this.activeTurnGen.ended) {
      if (this.activeTurnGen.output === undefined) this.activeTurnGen.output = d;
      this.finishGen(this.activeTurnGen, {
        outcome: 'succeeded',
        extraMeta: { decisionKind: str(d.kind) },
      });
      this.activeTurnGen = undefined;
    }
  }

  onProviderRejected(reason: string): void {
    this.providerRejectedCount++;
    if (reason === 'output_token_limit') this.truncationCount++;
    if (this.activeTurnGen && !this.activeTurnGen.ended) {
      this.finishGen(this.activeTurnGen, {
        outcome: 'retried',
        level: 'WARNING',
        statusMessage: `Provider rejected (${reason})`,
        extraMeta: { rejectionReason: reason },
      });
      this.activeTurnGen = undefined;
    }
  }

  onBudgetExceeded(data: Record<string, unknown>): void {
    this.budgetExceededCount++;
    const target = this.activeMemoryGen?.span ?? this.activeSummaryGen?.span ?? this.activeTurnGen?.span ?? this.rootSpan;
    if (target) {
      target.addEvent('budget_exceeded', {
        budget: String(data.budget ?? 'unknown'),
        outcome: String(data.outcome ?? 'failed'),
      });
    }
  }

  onToolTraceEvent(type: string, data: Record<string, unknown>): void {
    const requestId = str(data.requestId);
    if (type === 'evidence_saved' && typeof data.reworkRound === 'number' && data.reworkRound > 0) {
      this.reworkUsed = true;
      return;
    }
    if (!requestId) return;
    const parent = this.currentTurnSpan ?? this.rootSpan;

    if (type === 'pre_tool_use_request') {
      const toolName = str(data.toolName) ?? 'tool.call';
      const guardrail = this.startObs(`guardrail.${toolName}`, 'guardrail', {
        input: data.input,
        metadata: { requestId, toolName, bindingId: data.bindingId },
      }, parent);
      const asType: LangfuseObservationType = toolName === 'web_search' || toolName.endsWith('__web_search') ? 'retriever' : 'tool';
      const span = this.startObs(toolName, asType, {
        input: data.input,
        metadata: { requestId, sdkToolCallId: data.sdkToolCallId, bindingId: data.bindingId },
      }, parent);
      if (span) {
        this.activeTools.set(requestId, { span, name: toolName, startedAt: Date.now(), ended: false, guardrail, guardrailStartedAt: Date.now() });
      }
      return;
    }

    const tool = this.activeTools.get(requestId);
    if (type === 'policy_decision' && tool?.guardrail) {
      if (data.decision === 'APPROVAL') tool.approvalRequestedAt = Date.now();
      this.updateObs(tool.guardrail, 'guardrail', {
        metadata: { permissionMode: data.effectiveMode, decision: data.decision, reason: data.reason },
      });
      return;
    }
    if (type === 'approval_resolved' && tool?.guardrail) {
      const waitMs = tool.approvalRequestedAt ? Date.now() - tool.approvalRequestedAt : undefined;
      this.updateObs(tool.guardrail, 'guardrail', {
        metadata: { approvalDecision: data.decision, ...(waitMs !== undefined ? { approvalWaitMs: waitMs } : {}) },
      });
      return;
    }
    if (type === 'pre_tool_use_response' && tool?.guardrail) {
      const blocked = data.action === 'block';
      this.updateObs(tool.guardrail, 'guardrail', {
        output: { action: data.action, reason: data.reason, effectiveMode: data.effectiveMode },
        level: blocked ? 'WARNING' : 'DEFAULT',
        ...(blocked ? { statusMessage: String(data.reason ?? 'blocked') } : {}),
      });
      tool.guardrail.setStatus({ code: SpanStatusCode.OK });
      tool.guardrail.end();
      tool.guardrail = undefined;
      return;
    }
    if (type === 'execution_started' && tool) {
      this.toolExecutions++;
      return;
    }
    if (type === 'backend_started') {
      const stageId = str(data.stageId);
      if (!stageId) return;
      const backendSpan = this.startObs(`backend.${str(data.backend) ?? 'call'}`, 'span', {
        metadata: { stageId, requestId, backend: data.backend },
      }, tool?.span ?? parent);
      if (backendSpan) this.activeBackends.set(stageId, backendSpan);
      return;
    }
    if (type === 'backend_finished') {
      const stageId = str(data.stageId);
      const backendSpan = stageId ? this.activeBackends.get(stageId) : undefined;
      if (backendSpan) {
        const failed = data.state !== 'completed';
        this.updateObs(backendSpan, 'span', {
          output: { state: data.state, ...(data.error ? { error: data.error } : {}) },
          level: failed ? 'ERROR' : 'DEFAULT',
          ...(data.error ? { statusMessage: String(data.error) } : {}),
        });
        backendSpan.setStatus(failed ? { code: SpanStatusCode.ERROR, message: String(data.error ?? data.state) } : { code: SpanStatusCode.OK });
        backendSpan.end();
        this.activeBackends.delete(stageId!);
      }
      return;
    }
    if (type === 'execution_finished' && tool && !tool.ended) {
      const result = record(data.result);
      const resultStatus = str(result.status);
      const softFailed = Boolean(result.error) || ['auth_failed', 'rate_limited', 'timeout', 'parse_failed', 'cancelled', 'unknown', 'tool_failed'].includes(resultStatus ?? '');
      const failed = data.state !== 'completed' || softFailed;
      if (failed) this.toolErrors++;
      if (tool.guardrail) { tool.guardrail.end(); tool.guardrail = undefined; }
      const asType: LangfuseObservationType = tool.name === 'web_search' || tool.name.endsWith('__web_search') ? 'retriever' : 'tool';
      this.updateObs(tool.span, asType, {
        output: data.result ?? (data.error ? { error: data.error } : null),
        level: data.state !== 'completed' ? 'ERROR' : softFailed ? 'WARNING' : 'DEFAULT',
        ...(data.error ? { statusMessage: String(data.error) } : softFailed ? { statusMessage: String(result.error ?? resultStatus) } : {}),
        metadata: {
          state: data.state,
          ...(resultStatus ? { resultStatus } : {}),
          ...(result.snapshot ? { snapshotSaved: true } : {}),
        },
      });
      tool.span.setStatus(data.state !== 'completed' ? { code: SpanStatusCode.ERROR, message: String(data.error ?? data.state) } : { code: SpanStatusCode.OK });
      tool.span.end();
      tool.ended = true;
      this.activeTools.delete(requestId);
    }
  }

  private buildTags(status: 'complete' | 'partial' | 'failed' | 'cancelled', error?: string): string[] {
    const tags = new Set<string>([`status:${status}`, `mode:${this.profileMode}`]);
    if (this.modelId) tags.add(`model:${this.modelId}`);
    if (this.memoryDegradedCount > 0) tags.add('err:memory_degraded');
    if (this.memoryCircuitOpened) tags.add('err:memory_circuit_open');
    if (this.compactTriggered > this.compactSucceeded || error?.includes('context_compaction_failed')) tags.add('err:compact_failed');
    if (this.truncationCount > 0) tags.add('err:output_truncated');
    if (this.schemaInvalidCount > 0) tags.add('err:schema_invalid');
    if (this.budgetExceededCount > 0 || error?.includes('budget_')) tags.add('err:budget_exceeded');
    if (this.providerRejectedCount > 0) tags.add('err:provider_rejected');
    if (this.compactTriggered > 0) tags.add('used:compact');
    if (this.reactiveCompactUsed) tags.add('used:reactive_compact');
    if (this.reworkUsed) tags.add('used:rework');
    return [...tags];
  }

  buildScores(status: 'complete' | 'partial' | 'failed' | 'cancelled', gaps: string[]): LangfuseRunScore[] {
    const scores: LangfuseRunScore[] = [
      { id: scoreId(this.traceId, 'run_success'), name: 'run_success', value: status === 'complete' ? 1 : 0, dataType: 'BOOLEAN', comment: `status=${status}` },
      { id: scoreId(this.traceId, 'truncation_count'), name: 'truncation_count', value: this.truncationCount, dataType: 'NUMERIC' },
      { id: scoreId(this.traceId, 'evidence_gap_count'), name: 'evidence_gap_count', value: gaps.length, dataType: 'NUMERIC' },
    ];
    if (this.memoryBatches > 0) {
      scores.push(
        { id: scoreId(this.traceId, 'memory_first_try_rate'), name: 'memory_first_try_rate', value: Number((this.memoryFirstTrySuccesses / this.memoryBatches).toFixed(3)), dataType: 'NUMERIC', comment: `${this.memoryFirstTrySuccesses}/${this.memoryBatches}` },
        { id: scoreId(this.traceId, 'memory_degraded'), name: 'memory_degraded', value: this.memoryDegradedCount > 0 ? 1 : 0, dataType: 'BOOLEAN', comment: `degraded=${this.memoryDegradedCount}, circuitOpen=${this.memoryCircuitOpened}` },
      );
    }
    if (this.compactTriggered > 0) {
      scores.push({ id: scoreId(this.traceId, 'compact_success_rate'), name: 'compact_success_rate', value: Number((this.compactSucceeded / this.compactTriggered).toFixed(3)), dataType: 'NUMERIC', comment: `${this.compactSucceeded}/${this.compactTriggered}` });
    }
    if (this.totalReportedTokens > 0) {
      scores.push({ id: scoreId(this.traceId, 'aux_token_ratio'), name: 'aux_token_ratio', value: Number((this.auxReportedTokens / this.totalReportedTokens).toFixed(3)), dataType: 'NUMERIC', comment: `${this.auxReportedTokens}/${this.totalReportedTokens}` });
    }
    if (this.normalizedInputTokens > 0) {
      scores.push({ id: scoreId(this.traceId, 'cache_read_share'), name: 'cache_read_share', value: Number((this.cacheReadTokens / this.normalizedInputTokens).toFixed(3)), dataType: 'NUMERIC' });
    }
    if (this.toolExecutions > 0) {
      scores.push({ id: scoreId(this.traceId, 'tool_error_rate'), name: 'tool_error_rate', value: Number((this.toolErrors / this.toolExecutions).toFixed(3)), dataType: 'NUMERIC', comment: `${this.toolErrors}/${this.toolExecutions}` });
    }
    return scores;
  }

  async finishRun(summary: {
    runId: string;
    taskId: string;
    status: 'complete' | 'partial' | 'failed' | 'cancelled';
    response?: string;
    report?: string;
    gaps: string[];
    error?: string;
    stage?: string;
  }): Promise<LangfuseExportResult> {
    if (this.finished && this.finalResult) return this.finalResult;
    this.finished = true;

    if (this.configError) {
      this.finalResult = { status: 'failed', traceId: this.traceId, error: this.configError };
      return this.finalResult;
    }
    if (!this.enabled || !this.provider || !this.processor) {
      this.finalResult = { status: 'disabled' };
      return this.finalResult;
    }

    // Close any dangling spans cleanly before flushing.
    for (const backend of this.activeBackends.values()) { backend.setStatus({ code: SpanStatusCode.ERROR, message: summary.error ?? summary.status }); backend.end(); }
    this.activeBackends.clear();
    for (const tool of this.activeTools.values()) {
      if (tool.guardrail) tool.guardrail.end();
      if (!tool.ended) { tool.span.setStatus({ code: SpanStatusCode.ERROR, message: summary.error ?? summary.status }); tool.span.end(); }
    }
    this.activeTools.clear();
    this.closeTurn();

    const tags = this.buildTags(summary.status, summary.error);
    const scores = this.buildScores(summary.status, summary.gaps);
    const cleanedOutput = this.redactor.clean({ response: summary.response ?? null, report: summary.report ?? null, gaps: summary.gaps });
    const failed = summary.status === 'failed' || summary.status === 'cancelled';

    if (this.rootSpan) {
      this.rootSpan.setAttributes({
        [LangfuseOtelSpanAttributes.TRACE_OUTPUT]: JSON.stringify(cleanedOutput),
        [LangfuseOtelSpanAttributes.TRACE_TAGS]: tags,
      });
      this.updateObs(this.rootSpan, 'agent', {
        output: cleanedOutput,
        level: failed ? 'ERROR' : summary.status === 'partial' || this.memoryDegradedCount > 0 ? 'WARNING' : 'DEFAULT',
        ...(summary.error ? { statusMessage: summary.error } : {}),
        metadata: {
          status: summary.status,
          ...(summary.stage ? { stage: summary.stage } : {}),
          ...(summary.error ? { error: summary.error } : {}),
          tags,
        },
      });
      if (failed) this.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: summary.error ?? summary.status });
      else this.rootSpan.setStatus({ code: SpanStatusCode.OK });
      this.rootSpan.end();
      this.rootSpan = undefined;
    }

    try {
      const timeoutMs = this.config?.timeoutMs ?? 5000;
      await Promise.race([
        (async () => {
          await this.provider!.forceFlush();
          await this.provider!.shutdown();
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('langfuse_export: flush timeout')), timeoutMs).unref()),
      ]);

      if (this.fileExporter && this.otelFilePath) {
        const artifact: OtlpTraceArtifact = OtlpTraceArtifactSchema.parse({
          schemaVersion: OTEL_TRACE_ARTIFACT_VERSION,
          traceId: this.traceId,
          runId: summary.runId,
          taskId: summary.taskId,
          sessionId: this.sessionId,
          environment: this.environment,
          resourceSpans: this.fileExporter.resourceSpans,
          scores,
        });
        mkdirSync(dirname(this.otelFilePath), { recursive: true });
        writeFileSync(this.otelFilePath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
        this.finalResult = { status: 'file_exported', traceId: this.traceId, spanCount: this.fileExporter.exportedSpans, filePath: this.otelFilePath };
        return this.finalResult;
      }

      if (this.httpExporter?.lastError) {
        this.finalResult = { status: 'failed', traceId: this.traceId, traceUrl: this.traceUrl, error: this.httpExporter.lastError };
        return this.finalResult;
      }
      if (this.config) {
        // Best-effort scores upload; failure does not invalidate exported spans.
        try { await sendLangfuseScores(this.config, this.traceId, scores, this.transport, this.redactor); }
        catch { /* Scores failure stays non-fatal to the main run. */ }
      }
      this.finalResult = {
        status: 'exported',
        traceId: this.traceId,
        spanCount: this.httpExporter?.exportedSpans ?? 0,
        traceUrl: this.traceUrl,
      };
      return this.finalResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      this.finalResult = {
        status: 'failed',
        traceId: this.traceId,
        traceUrl: this.traceUrl,
        error: this.redactor.clean(/^langfuse_(?:config|export|scores):/.test(message) ? message : 'langfuse_export: transport or response failure'),
      };
      return this.finalResult;
    }
  }
}

/** Record a single standalone LLM generation (e.g. Web task intent classification) directly to Langfuse. */
export async function recordStandaloneGeneration(params: {
  name: string;
  purpose: string;
  model?: string;
  provider?: string;
  input: unknown;
  output?: unknown;
  usage?: unknown;
  error?: string;
  env?: NodeJS.ProcessEnv;
  redactor?: Redactor;
  transport?: typeof fetch;
}): Promise<void> {
  let config: LangfuseConfig | undefined;
  try { config = readLangfuseConfig(params.env ?? process.env); } catch { return; }
  if (!config) return;
  const redactor = params.redactor ?? new Redactor([config.publicKey, config.secretKey]);
  const exporter = new LangfuseOtlpHttpExporter(config, redactor, params.transport ?? fetch);
  const processor = new LangfuseSpanProcessor({
    exporter,
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    mediaUploadEnabled: false,
    exportMode: 'immediate',
    mask: ({ data }) => redactor.clean(data),
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'cwatch' }),
    spanProcessors: [processor],
  });
  try {
    const tracer = provider.getTracer('langfuse-sdk');
    const usageDetails = extractUsageDetails(params.usage);
    const cleanedInput = redactor.clean(params.input);
    const cleanedOutput = redactor.clean(params.output ?? null);
    const span = tracer.startSpan(params.name, {
      attributes: {
        ...createObservationAttributes('generation', redactor.clean({
          model: params.model,
          input: cleanedInput,
          output: cleanedOutput,
          ...(Object.keys(usageDetails).length ? { usageDetails } : {}),
          level: params.error ? 'ERROR' : 'DEFAULT',
          ...(params.error ? { statusMessage: params.error } : {}),
          metadata: { purpose: params.purpose, ...(params.provider ? { provider: params.provider } : {}) },
        })),
        [LangfuseOtelSpanAttributes.TRACE_NAME]: `cwatch.${params.name}`,
        [LangfuseOtelSpanAttributes.TRACE_INPUT]: JSON.stringify(cleanedInput),
        [LangfuseOtelSpanAttributes.TRACE_OUTPUT]: JSON.stringify(cleanedOutput),
      },
    });
    if (params.error) span.setStatus({ code: SpanStatusCode.ERROR, message: params.error });
    else span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    await provider.forceFlush();
    await provider.shutdown();
  } catch { /* Non-fatal telemetry. */ }
}
