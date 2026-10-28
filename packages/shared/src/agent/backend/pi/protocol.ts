import { z } from 'zod';
import { DecisionSchema, type ModelInput } from "@cwatch/core/types";
import { CompactRequestSchema } from '@cwatch/core/types/compaction';
import { SessionMemoryRequestSchema } from '@cwatch/core/types/session-memory';
import { type PreToolUseRequest, type PreToolUseResponse } from '../../pre-tool-use.ts';
import { type ModelConfig } from "../../../config/models.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_CHARS = 2_000_000;
const text = z.string().min(1).max(512);
const identity = { requestId: text, taskId: text, toolName: text, bindingId: text, argsHash: text, sdkToolCallId: text.optional() };
export const PreRequestSchema = z.object({ type: z.literal('pre_tool_use_request'), ...identity, requestId: z.string().uuid(), input: z.record(z.string(), z.unknown()) }).strict();
export const ToolIdentitySchema = z.object(identity).strict();
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('before_model'), requestId: text }).strict(),
  z.object({ type: z.literal('next_user_message'), requestId: text }).strict(),
  z.object({ type: z.literal('decision'), requestId: text, decision: DecisionSchema }).strict(),
  z.object({ type: z.literal('observation'), requestId: text, name: text, sdkToolCallId: text.optional(), result: z.unknown().optional() }).strict(),
  z.object({ type: z.literal('usage'), requestId: text, usage: z.unknown().optional(), purpose: z.enum(['turn', 'summary', 'memory', 'rejected']).optional() }).strict(),
  z.object({ type: z.literal('transcript'), requestId: text, entries: z.array(z.record(z.string(), z.unknown())).min(1) }).strict(),
  z.object({ type: z.literal('before_request'), requestId: text, purpose: z.enum(['turn', 'summary', 'memory']) }).strict(),
  z.object({ type: z.literal('session_memory'), requestId: text, request: SessionMemoryRequestSchema }).strict(),
  z.object({ type: z.literal('post_compact'), requestId: text, request: CompactRequestSchema }).strict(),
  z.object({ type: z.literal('pre_tool_use_request'), request: PreRequestSchema }).strict(),
  z.object({ type: z.literal('tool_execute_request'), request: ToolIdentitySchema }).strict(),
  z.object({ type: z.literal('completed') }).strict(),
  z.object({ type: z.literal('failed'), error: z.string().max(16_000) }).strict(),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export type HostMessage =
  | { type: 'init'; config: ModelConfig; input: ModelInput }
  | { type: 'hook_response'; requestId: string; ok: boolean; value?: unknown; error?: string }
  | { type: 'pre_tool_use_response'; response: PreToolUseResponse }
  | { type: 'tool_execute_response'; requestId: string; ok: boolean; value?: unknown; error?: string }
  | { type: 'abort'; reason: string };
export interface Frame { version: 1; sessionId: string; taskId: string; sequence: number; body: unknown }
const FrameSchema = z.object({ version: z.literal(1), sessionId: text, taskId: text, sequence: z.number().int().positive(), body: z.unknown() }).strict();
export function parseFrame(raw: unknown, sessionId: string, taskId: string, sequence: number): Frame {
  if (JSON.stringify(raw)?.length > MAX_FRAME_CHARS) throw new Error('agent_protocol: frame_too_large');
  const frame = FrameSchema.parse(raw);
  if (frame.sessionId !== sessionId || frame.taskId !== taskId || frame.sequence !== sequence) throw new Error('agent_protocol: stale_or_mismatched_frame');
  return frame;
}
export function toolIdentity(request: PreToolUseRequest | PreToolUseResponse): ToolIdentity {
  const { requestId, taskId, toolName, bindingId, argsHash, sdkToolCallId } = request;
  return { requestId, taskId, toolName, bindingId, argsHash, ...(sdkToolCallId ? { sdkToolCallId } : {}) };
}
