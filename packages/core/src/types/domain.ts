import type { ToolCallHandshake } from './pre-tool-use.ts';
import type { CompactRequest, PostCompactResult } from './compaction.ts';
import type { SessionMemoryPolicy, SessionMemoryRequest, SessionMemoryState } from './session-memory.ts';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';

export const timestamp = z.string().datetime({ offset: true });
export const TaskSchema = z.object({
  taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  competitor: z.object({ id: z.string().min(1), name: z.string().min(1), aliases: z.array(z.string()).default([]), domains: z.array(z.string()).min(1) }).strict(),
  product: z.string().min(1), signalTypes: z.array(z.enum(['release', 'price', 'content', 'campaign'])).min(1),
  window: z.object({ start: timestamp, end: timestamp, basis: z.enum(['published_at', 'occurred_at', 'effective_at']), timezone: z.string().min(1) }).strict(),
  allowedSources: z.array(z.string()).min(1), outputScope: z.literal('draft'),
}).strict().superRefine((t, ctx) => {
  if (Date.parse(t.window.start) >= Date.parse(t.window.end)) ctx.addIssue({ code: 'custom', message: 'window must be [start,end), start < end' });
  try { new Intl.DateTimeFormat('en', { timeZone: t.window.timezone }); } catch { ctx.addIssue({ code: 'custom', message: 'unknown IANA timezone' }); }
});
export type CompetitorTask = z.infer<typeof TaskSchema>;
export const GenericTaskSchema = z.object({
  kind: z.literal('agent'), taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  instruction: z.string().trim().min(1).max(24000),
  responseCharacterLimit: z.int().min(1).max(32_000).optional(),
  allowedSources: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(64).default([]),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type GenericTask = z.infer<typeof GenericTaskSchema>;
export type AgentTask = GenericTask | CompetitorTask;
export const AgentTaskSchema = z.union([GenericTaskSchema, TaskSchema]);
export function isInvestigationTask(task: AgentTask): task is CompetitorTask { return !('kind' in task); }
export function parseAgentTask(value: unknown): AgentTask {
  const parsed = AgentTaskSchema.safeParse(value);
  if (!parsed.success) throw new Error('needs_clarification: invalid task');
  return parsed.data;
}
export const statuses = ['success_with_data', 'success_empty', 'auth_failed', 'rate_limited', 'timeout', 'parse_failed', 'cancelled', 'unknown'] as const;
export const SignalSchema = z.object({
  entity: z.object({ id: z.string().nullable(), name: z.string(), domain: z.string().nullable() }).strict(),
  product: z.string(), signalType: z.enum(['release', 'price', 'content', 'campaign']),
  sourceSlug: z.string(), url: z.string().url(), eventKey: z.string().min(1),
  content: z.object({ title: z.string(), value: z.string(), polarity: z.enum(['supports', 'contradicts']).default('supports') }).strict(),
  published_at: timestamp.nullable(), retrieved_at: timestamp,
  occurred_at: timestamp.nullable().optional(), effective_at: timestamp.nullable().optional(),
  collectionStatus: z.literal('success_with_data'),
}).strict();
export type CompetitorSignal = z.infer<typeof SignalSchema>;
export const SearchHitSchema = z.object({ url: z.string().url(), title: z.string(), snippet: z.string(), published_at: timestamp.nullable(), retrieved_at: timestamp }).strict();
export const PageSchema = z.object({ url: z.string().url(), title: z.string(), text: z.string(), published_at: timestamp.nullable(), retrieved_at: timestamp, truncated: z.boolean() }).strict();
/** Host-selected HTTP diagnostics only; never an arbitrary response-header map. Retry times are hints, not guarantees. */
export const HttpResponseMetadataSchema = z.object({
  status: z.number().int().min(100).max(599),
  rateLimit: z.object({
    kind: z.enum(['primary', 'secondary', 'unspecified']),
    limit: z.number().int().nonnegative().safe().optional(), remaining: z.number().int().nonnegative().safe().optional(),
    resetAt: timestamp.optional(), retryAt: timestamp.optional(), retryAfterSeconds: z.number().int().nonnegative().safe().optional(),
    retrySource: z.enum(['retry-after', 'x-ratelimit-reset', 'secondary-minimum', 'combined']).optional(),
  }).strict().optional(),
}).strict();
export type HttpResponseMetadata = z.infer<typeof HttpResponseMetadataSchema>;
export const RetrievalSchema = z.object({ status: z.enum(statuses), signals: z.array(SignalSchema), raw: z.string(), error: z.string().optional(), provenance: z.enum(['fixture', 'live']), searchResults: z.array(SearchHitSchema).optional(), pages: z.array(PageSchema).optional(), backend: z.string().optional(), http: HttpResponseMetadataSchema.optional(), rawTruncated: z.boolean().optional(), snapshot: z.object({ path: z.string(), hash: z.string() }).strict().optional() }).strict().superRefine((r, ctx) => {
  if ((r.status === 'success_with_data') !== (r.signals.length + (r.searchResults?.length ?? 0) + (r.pages?.length ?? 0) > 0)) ctx.addIssue({ code: 'custom', message: 'retrieval status/data mismatch' });
});
export type RetrievalResult = z.infer<typeof RetrievalSchema>;
export type JsonSchema = Record<string, unknown>;
export type Action = 'collect' | 'analyze' | 'local_draft' | 'modify' | 'send' | 'publish';
export interface ToolDefinition { name: string; description: string; inputSchema: JsonSchema; action: Action; dynamicAction?: boolean; availableActions?: Action[]; /** Host-owned local tool namespace. External MCP definitions cannot select it. */ namespace?: 'native' | 'session' }
export interface ToolBinding extends ToolDefinition {
  id: string; source_slug: string; original_name: string; proxy_name: string;
  backendNames: { pi: string; replay: string }; channel: 'builtin' | 'mcp' | 'workflow'; revision: number;
}
export interface SourceGuide { sourceSlug: string; path: string; hash: string; text: string }
export interface SourceGuidePort { readonly path: string; read(signal: AbortSignal): Promise<SourceGuide>; check(): string | undefined; reset(): void }
export interface SourceClient {
  readonly guide?: SourceGuidePort;
  resolveAction?(name: string, args: Record<string, unknown>, task: AgentTask): Action;
  checkPrerequisites?(name: string, args: Record<string, unknown>): string | undefined;
  listTools(signal: AbortSignal): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<unknown>;
  validateScope?(name: string, args: Record<string, unknown>, task: AgentTask): string | undefined;
  close(): Promise<void>;
}
export interface ToolExecutionContext {
  /** Each backend request is reauthorized and recorded under the parent tool invocation. */
  stage<T>(backend: string, operation: () => Promise<T>): Promise<T>;
  event(type: 'web_route' | 'provider_tool_event', data: Record<string, unknown>): void;
}
export type ExecutionState = 'awaiting_permission' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface ExecutionRecord {
  requestId: string; taskId: string; runId: string; sourceSlug: string; toolBinding: ToolBinding;
  argsHash: string; sdkToolCallId?: string; state: ExecutionState; startedAt: string; endedAt?: string; error?: string; execute_count: number;
}
export const ToolCallIntentSchema = z.object({ sdkToolCallId: z.string().min(1).max(512), name: z.string().min(1), args: z.record(z.string(), z.unknown()) }).strict();
export type ToolCallIntent = z.infer<typeof ToolCallIntentSchema>;
const toolBatch = z.array(ToolCallIntentSchema).min(2).max(64).superRefine((calls, ctx) => {
  if (new Set(calls.map(call => call.sdkToolCallId)).size !== calls.length) ctx.addIssue({ code: 'custom', message: 'duplicate tool call identity in batch' });
});
export type Decision = { kind: 'call_tool'; name: string; args: Record<string, unknown> } | { kind: 'call_tools'; calls: ToolCallIntent[] } | { kind: 'respond'; text: string };
export interface Observation { name: string; result: unknown }
export interface AgentState { task: AgentTask; observations: Observation[]; decisions: Decision[]; iteration: number; userMessages?: string[] }
export interface ToolBudgetSnapshot {
  steps?: number;
  maxSteps?: number;
  maxToolCalls: number;
  maxSameToolCalls: number;
  toolCalls: number;
  callsByTool: Record<string, number>;
}
export interface ModelInput { state: AgentState; stable: string; volatile: string; tools: ToolBinding[]; sessionId?: string; conversation?: boolean; completionInstruction?: string; contextChars?: number; maxOutputTokens?: number; maxResponseChars?: number; sessionMemoryPolicy?: SessionMemoryPolicy; promptCache?: 'none' | 'short'; toolBudgets?: ToolBudgetSnapshot }
export interface AgentSessionHooks {
  beforeModel(): ModelInput | Promise<ModelInput>;
  onDecision(decision: Decision): void | Promise<void>;
  executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal, binding?: ToolBinding, sdkToolCallId?: string, handshake?: ToolCallHandshake): Promise<unknown>;
  onObservation(name: string, result: unknown, sdkToolCallId?: string): void | Promise<void>;
  onUsage(usage: unknown, purpose?: 'turn' | 'summary' | 'memory' | 'rejected'): void | Promise<void>;
  onTranscript?(entries: Record<string, unknown>[]): void | Promise<void>;
  beforeRequest?(purpose: 'turn' | 'summary' | 'memory'): { maxOutputTokens: number } | Promise<{ maxOutputTokens: number }>;
  sessionMemory?(request: SessionMemoryRequest): SessionMemoryState | null | Promise<SessionMemoryState | null>;
  afterCompact?(request: CompactRequest): PostCompactResult | Promise<PostCompactResult>;
  /** A final answer ends a user turn. null closes the conversation; absence keeps one-shot behavior. */
  nextUserMessage?(): Promise<string | null>;
  onProcessEvent?(event: Record<string, unknown>): void;
}
export interface ModelPort {
  readonly traceModel?:{provider:string;id:string};
  readonly tokenUsageRequired?: boolean;
  decide(input: ModelInput, signal: AbortSignal): Promise<Decision>;
  runSession?(input: ModelInput, hooks: AgentSessionHooks, signal: AbortSignal): Promise<void>;
  usage?: unknown; close?(): Promise<void>;
}
export const DecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('call_tool'), name: z.string(), args: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('call_tools'), calls: toolBatch }).strict(),
  z.object({ kind: z.literal('respond'), text: z.string().min(1) }).strict(),
]);
export const PlanSchema = z.object({ taskId: z.string(), objective: z.string().min(1), sources: z.array(z.string()).min(1), queries: z.array(z.string().min(1)).min(1), evidenceRequirements: z.array(z.string().min(1)).min(1), window: z.object({ start: timestamp, end: timestamp }).strict() }).strict();
export type Plan = z.infer<typeof PlanSchema>;
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function parseTask(value: unknown): CompetitorTask {
  const parsed = TaskSchema.safeParse(value);
  if (!parsed.success) throw new Error('needs_clarification: ' + parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; '));
  return parsed.data;
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The operation may have synchronously aborted the signal while constructing
  // its promise. Observe that promise even when cancellation wins immediately.
  if (signal.aborted) void promise.catch(() => {});
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(v => { if (!signal.aborted) resolve(v); }, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
