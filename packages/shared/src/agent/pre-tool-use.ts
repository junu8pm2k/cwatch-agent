import type { PreToolUseRequest, PreToolUseResponse, ToolCallHandshake } from '@cwatch/core/types/pre-tool-use';
export type { PreToolUseRequest, PreToolUseResponse, ToolCallHandshake } from '@cwatch/core/types/pre-tool-use';
import { hash } from "@cwatch/core/types";
import { type Mode, type ApprovalManager } from "./core/permission-manager.ts";
import { type Trace } from "../sessions/trace.ts";
import { runPreToolUseChecks, toPolicyVerdict, type PreToolUseInput } from './core/pre-tool-use.ts';

export interface PreToolUseHost extends Omit<PreToolUseInput, 'toolName' | 'input'> {
  approvals: ApprovalManager; trace: Trace;
  onApprovalWait?: { pause(): void; resume(): void };
}


/** Host-owned permission handler shared by subprocess calls and replay/probes. */
export async function requestPreToolUseApproval(request: PreToolUseRequest, host: PreToolUseHost, signal: AbortSignal): Promise<PreToolUseResponse> {
  const { type: requestType, ...requestData } = request;
  host.trace.emit(requestType, requestData);
  const check = () => runPreToolUseChecks({ ...host, toolName: request.toolName, input: request.input });
  const initial = check();
  host.trace.emit('policy_decision', { requestId: request.requestId, binding: host.binding, effectiveMode: host.policy.mode, ...toPolicyVerdict(initial), argsHash: request.argsHash });
  const respond = (action: 'allow' | 'block', reason: string, approvedArgsHash?: string): PreToolUseResponse => {
    const response: PreToolUseResponse = {
      type: 'pre_tool_use_response', requestId: request.requestId, taskId: host.task.taskId,
      toolName: request.toolName, bindingId: host.binding.id, argsHash: request.argsHash,
      action, reason, effectiveMode: host.policy.mode,
      ...(approvedArgsHash ? { approvedArgsHash } : {}),
      ...(request.sdkToolCallId ? { sdkToolCallId: request.sdkToolCallId } : {}),
    };
    const { type, ...data } = response; host.trace.emit(type, data); return response;
  };
  if (request.taskId !== host.task.taskId || request.bindingId !== host.binding.id || request.argsHash !== hash(request.input)) return respond('block', 'pre_tool_request_mismatch');
  if (initial.type === 'block') return respond('block', 'policy_block: ' + initial.reason);
  let approvedArgsHash: string | undefined;
  if (initial.type === 'prompt') {
    host.onApprovalWait?.pause();
    try {
      approvedArgsHash = await host.approvals.wait(request.requestId, host.task.taskId, request.toolName, request.input, signal, value => JSON.stringify(host.trace.redactor.clean(value)));
      host.trace.emit('approval_resolved', { requestId: request.requestId, decision: 'approved', argsHash: approvedArgsHash });
    } catch (error) {
      host.trace.emit('approval_resolved', { requestId: request.requestId, decision: 'denied_or_cancelled', error: String(error) });
      return respond('block', error instanceof Error ? error.message : String(error));
    } finally {
      host.onApprovalWait?.resume();
    }
  }
  if (signal.aborted) return respond('block', 'pre_tool_use_cancelled');
  const current = check();
  if (current.type === 'block' || (current.type === 'prompt' && approvedArgsHash !== hash(request.input))) return respond('block', 'policy_changed_or_unapproved: ' + current.reason);
  return respond('allow', current.reason, approvedArgsHash);
}
