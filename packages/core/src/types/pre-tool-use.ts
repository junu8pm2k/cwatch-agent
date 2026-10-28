import type { Mode } from './permissions.ts';
export interface PreToolUseRequest {
  type: 'pre_tool_use_request';
  requestId: string; taskId: string; toolName: string; bindingId: string; argsHash: string;
  input: Record<string, unknown>; sdkToolCallId?: string;
}
export interface PreToolUseResponse {
  type: 'pre_tool_use_response';
  requestId: string; taskId: string; toolName: string; bindingId: string; argsHash: string;
  action: 'allow' | 'block'; reason: string; effectiveMode: Mode;
  approvedArgsHash?: string; sdkToolCallId?: string;
}
export interface ToolCallHandshake {
  request: PreToolUseRequest;
  onResponse(response: PreToolUseResponse): Promise<void>;
}
