import { z } from 'zod';
import { ContinuationSummarySchema, TranscriptReferenceSchema } from './compaction.ts';

const count = z.number().int().safe().nonnegative();
export const SessionMemoryPolicySchema = z.object({
  initializeTokens: count.min(1).default(12_000), growthTokens: count.min(1).default(4000),
  toolCalls: count.min(1).default(6), maxInputChars: count.min(1024).max(150_000).default(48_000),
}).strict();
export type SessionMemoryPolicy = z.infer<typeof SessionMemoryPolicySchema>;
export const SessionMemoryUpdateSchema = z.object({
  expectedRevision: count, lastMessageId: z.string().min(1).max(512), windowTokens: count,
  windowGrowthTokens: count, pendingMessages: z.boolean(), content: ContinuationSummarySchema.refine(value => JSON.stringify(value).length <= 12_000, 'memory content exceeds 12000 characters'),
}).strict();
export const SessionMemoryStateSchema = SessionMemoryUpdateSchema.omit({ expectedRevision: true }).extend({
  version: z.literal(1), sessionId: z.string().min(1), taskId: z.string().min(1), revision: count.min(1),
  policy: SessionMemoryPolicySchema, messageCount: count.min(1), toolCallCount: count, toolCallsSinceUpdate: count,
  transcript: TranscriptReferenceSchema, updatedAt: z.string().datetime(),
}).strict();
export type SessionMemoryState = z.infer<typeof SessionMemoryStateSchema>;
export const SessionMemoryRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('load') }).strict(),
  z.object({ operation: z.literal('commit'), update: SessionMemoryUpdateSchema }).strict(),
]);
export type SessionMemoryRequest = z.infer<typeof SessionMemoryRequestSchema>;
