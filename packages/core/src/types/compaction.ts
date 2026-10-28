import { z } from 'zod';

const notes = z.array(z.string().min(1).max(2000)).max(64);
/** A continuation record, not a conversational synopsis. Unknowns must be stated explicitly. */
export const ContinuationSummarySchema = z.object({
  userGoal: z.string().min(1).max(4000), completedWork: notes, keyFiles: notes,
  errorsAndFixes: notes, unfinishedTasks: notes, nextSteps: notes.min(1), references: notes, sourceGaps: notes,
}).strict();
export type ContinuationSummary = z.infer<typeof ContinuationSummarySchema>;
export const CompactRequestSchema = z.object({ summary: ContinuationSummarySchema, keptEntryIds: z.array(z.string().min(1).max(512)).min(1).max(2048) }).strict();
export type CompactRequest = z.infer<typeof CompactRequestSchema>;
export const CompactAttachmentSchema = z.object({ name: z.string().min(1).max(120), content: z.string().min(1).max(24_000) }).strict();
export type CompactAttachment = z.infer<typeof CompactAttachmentSchema>;
/** Host-authored lookup metadata. The path is descriptive, never a file-read capability. */
export const TranscriptReferenceSchema = z.object({
  sessionId: z.string().min(1).max(512), path: z.string().min(1).max(1024),
  throughEntryId: z.string().min(1).max(512), entryCount: z.number().int().positive(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  tool: z.literal('session__read_transcript'),
}).strict();
export type TranscriptReference = z.infer<typeof TranscriptReferenceSchema>;
export const PostCompactResultSchema = z.object({ attachments: z.array(CompactAttachmentSchema).max(16), hookResults: z.array(CompactAttachmentSchema).max(16), transcript: TranscriptReferenceSchema.optional() }).strict();
export type PostCompactResult = z.infer<typeof PostCompactResultSchema>;
