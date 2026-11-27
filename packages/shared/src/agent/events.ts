import { z } from 'zod';
import { DecisionSchema, AgentTaskSchema } from "@cwatch/core/types";
import { PERMISSION_MODES } from "./core/permission-manager.ts";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const mode = z.enum(PERMISSION_MODES);
const identity = { requestId: text, taskId: text, toolName: text, bindingId: text, argsHash: text, sdkToolCallId: text.optional() };
export const ProviderRejectionSchema = z.object({
  entryId: text,
  reason: z.enum(['context_length_exceeded', 'output_token_limit']),
}).strict();
export type ProviderRejectionReason = z.infer<typeof ProviderRejectionSchema>['reason'];
const memoryReason = z.enum(['output_limit', 'invalid_working_state', 'unexpected_tool_call', 'unsuccessful_response', 'delta_too_large']);
export const MemoryAttemptSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('request'), attempt: count.min(1), maxAttempts: count.min(1), maxOutputTokens: count.min(1), checkpointRevision: count }).strict(),
  z.object({ phase: z.literal('wire'), attempt: count.min(1), wireMaxOutputTokens: count.min(1) }).strict(),
  z.object({ phase: z.literal('response'), stopReason: z.enum(['stop','length','toolUse','error','aborted','unknown']), textChars: count, thinkingChars: count }).strict(),
  z.object({ phase: z.literal('recovery'), attempt: count.min(1), reason: memoryReason, action: z.enum(['retry','stop','degrade']), validationErrors: z.array(text).optional(),
    checkpointRevision: count.optional(), pendingRounds: count.optional(), consecutiveFailures: count.min(1).optional(), circuitOpen: z.boolean().optional() }).strict(),
  z.object({ phase: z.literal('degraded'), reason: memoryReason, checkpointRevision: count, pendingRounds: count, consecutiveFailures: count.min(1), circuitOpen: z.boolean() }).strict(),
]);
const payloads = {
  run_started: z.object({ task: AgentTaskSchema.optional(), permissionMode: mode.optional(), mode: z.enum(['live','replay']).optional(), purpose: text.optional() }).passthrough(),
  agent_process: z.object({ state: z.enum(['started','ready','stopping','exited']), sessionId: text, pid: count.optional() }).passthrough(),
  skills_loaded: z.object({ skills: z.array(z.object({ name: text, hash: text, resources: z.array(z.string()) }).passthrough()) }).passthrough(),
  session_memory_updated: z.object({ revision: count.min(1), lastMessageId: text, path: text, windowTokens: count, windowGrowthTokens: count, toolCallCount: count }).strict(),
  session_memory_attempt: z.object({ iteration: count, attemptDetails: MemoryAttemptSchema }).strict(),
  conversation_turn_completed: z.object({ turn: count.min(1), response: text, status: z.enum(['complete','partial']) }).strict(),
  user_message_received: z.object({ turn: count.min(2), text: text.max(24000) }).strict(),
  // api is accepted here only to read historical Trace v2; current ToolBinding cannot emit it.
  context_prepared: z.object({ iteration: count, permissionMode: mode, contextHash: text, skillHash: text, tools: z.array(z.object({ proxyName: text, sourceSlug: text, originalName: text, channel: z.enum(['builtin','api','mcp','workflow']), action: z.enum(['collect','analyze','local_draft','modify','send','publish']), bindingId: text, dynamicAction: z.boolean().optional(), availableActions: z.array(z.enum(['collect','analyze','local_draft','modify','send','publish'])).optional() }).strict()) }).passthrough(),
  model_requested: z.object({ iteration: count, contextChars: count }).passthrough(),
  provider_rejected: ProviderRejectionSchema.extend({ iteration: count }),
  response_revision_requested: z.object({ iteration: count, length: count, limit: count.min(1) }).strict().refine(data => data.length > data.limit),
  model_usage: z.object({ iteration: count, usage: z.record(z.string(),z.unknown()) }).passthrough(),
  decision_made: z.object({ decision: DecisionSchema }).passthrough(),
  pre_tool_use_request: z.object({ ...identity, input: z.record(z.string(),z.unknown()) }).passthrough(),
  pre_tool_use_response: z.object({ ...identity, action: z.enum(['allow','block']), reason: text, effectiveMode: mode, approvedArgsHash: text.optional() }).passthrough(),
  policy_decision: z.object({ requestId: text, binding: z.object({ id: text }).passthrough(), argsHash: text, effectiveMode: mode, decision: z.enum(['ALLOW','BLOCK','APPROVAL']), reason: text }).passthrough(),
  approval_resolved: z.object({ requestId: text, decision: z.enum(['approved','denied_or_cancelled']), argsHash: text.optional(), error: z.string().optional() }).passthrough(),
  execution_started: z.object({ requestId: text, bindingId: text, sdkToolCallId: text.optional() }).passthrough(),
  execution_finished: z.object({ requestId: text, state: z.enum(['completed','failed','cancelled','unknown']) }).passthrough(),
  backend_policy: z.object({ requestId: text, stageId: text, backend: text, bindingId: text, argsHash: text, effectiveMode: mode, decision: z.enum(['ALLOW','BLOCK','APPROVAL']), reason: text }).passthrough(),
  backend_started: z.object({ requestId: text, stageId: text, backend: text }).passthrough(),
  backend_finished: z.object({ requestId: text, stageId: text, backend: text, state: z.enum(['completed','failed','cancelled']) }).passthrough(),
  web_route: z.object({ requestId: text, bindingId: text }).passthrough(),
  provider_tool_event: z.object({ requestId: text, bindingId: text }).passthrough(),
  observation_added: z.object({ name: text, observation: z.unknown().optional() }).passthrough(),
  plan_saved: z.object({ path: text }).passthrough(),
  plan_submitted: z.object({ path: text }).passthrough(),
  plan_file_failed: z.object({ error: text }).passthrough(),
  plan_submit_failed: z.object({ error: text }).passthrough(),
  evidence_saved: z.object({ evidenceIds: z.array(text), eventIds: z.array(text) }).passthrough(),
  usage_reported: z.object({ toolCalls: count, durationMs: count, modelUsage: z.array(z.unknown()), usageAvailable: z.boolean(), mode: z.enum(['live','replay']) }).passthrough(),
  budget_exceeded: z.object({ budget: text.optional(), limit: count.optional(), actual: count.optional(), error: z.string().optional() }).passthrough().refine(data => Boolean(data.budget || data.error), 'budget or error required'),
  run_completed: z.object({ status: z.enum(['complete','partial']).optional(), permissionMode: mode.optional() }).passthrough(),
  run_failed: z.object({ status: z.literal('failed').optional(), error: text.optional() }).passthrough(),
  run_cancelled: z.object({ status: z.literal('cancelled').optional(), error: text.optional() }).passthrough(),
};
export const AGENT_EVENT_TYPES = Object.keys(payloads) as Array<keyof typeof payloads>;
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), data: payloads.run_started }).strict(),
  z.object({ type: z.literal('agent_process'), data: payloads.agent_process }).strict(),
  z.object({ type: z.literal('skills_loaded'), data: payloads.skills_loaded }).strict(),
  z.object({ type: z.literal('session_memory_updated'), data: payloads.session_memory_updated }).strict(),
  z.object({ type: z.literal('session_memory_attempt'), data: payloads.session_memory_attempt }).strict(),
  z.object({ type: z.literal('conversation_turn_completed'), data: payloads.conversation_turn_completed }).strict(),
  z.object({ type: z.literal('user_message_received'), data: payloads.user_message_received }).strict(),
  z.object({ type: z.literal('context_prepared'), data: payloads.context_prepared }).strict(),
  z.object({ type: z.literal('model_requested'), data: payloads.model_requested }).strict(),
  z.object({ type: z.literal('provider_rejected'), data: payloads.provider_rejected }).strict(),
  z.object({ type: z.literal('response_revision_requested'), data: payloads.response_revision_requested }).strict(),
  z.object({ type: z.literal('model_usage'), data: payloads.model_usage }).strict(),
  z.object({ type: z.literal('decision_made'), data: payloads.decision_made }).strict(),
  z.object({ type: z.literal('pre_tool_use_request'), data: payloads.pre_tool_use_request }).strict(),
  z.object({ type: z.literal('pre_tool_use_response'), data: payloads.pre_tool_use_response }).strict(),
  z.object({ type: z.literal('policy_decision'), data: payloads.policy_decision }).strict(),
  z.object({ type: z.literal('approval_resolved'), data: payloads.approval_resolved }).strict(),
  z.object({ type: z.literal('execution_started'), data: payloads.execution_started }).strict(),
  z.object({ type: z.literal('execution_finished'), data: payloads.execution_finished }).strict(),
  z.object({ type: z.literal('backend_policy'), data: payloads.backend_policy }).strict(),
  z.object({ type: z.literal('backend_started'), data: payloads.backend_started }).strict(),
  z.object({ type: z.literal('backend_finished'), data: payloads.backend_finished }).strict(),
  z.object({ type: z.literal('web_route'), data: payloads.web_route }).strict(),
  z.object({ type: z.literal('provider_tool_event'), data: payloads.provider_tool_event }).strict(),
  z.object({ type: z.literal('observation_added'), data: payloads.observation_added }).strict(),
  z.object({ type: z.literal('plan_saved'), data: payloads.plan_saved }).strict(),
  z.object({ type: z.literal('plan_submitted'), data: payloads.plan_submitted }).strict(),
  z.object({ type: z.literal('plan_file_failed'), data: payloads.plan_file_failed }).strict(),
  z.object({ type: z.literal('plan_submit_failed'), data: payloads.plan_submit_failed }).strict(),
  z.object({ type: z.literal('evidence_saved'), data: payloads.evidence_saved }).strict(),
  z.object({ type: z.literal('usage_reported'), data: payloads.usage_reported }).strict(),
  z.object({ type: z.literal('budget_exceeded'), data: payloads.budget_exceeded }).strict(),
  z.object({ type: z.literal('run_completed'), data: payloads.run_completed }).strict(),
  z.object({ type: z.literal('run_failed'), data: payloads.run_failed }).strict(),
  z.object({ type: z.literal('run_cancelled'), data: payloads.run_cancelled }).strict(),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
