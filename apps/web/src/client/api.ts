import type {
  McpTestResult,
  RunMessageInput,
  RunSnapshot,
  RunStartInput,
  SkillDetail,
  WorkbenchBootstrap,
  WorkbenchExtensions,
} from '@cwatch/core/types/runs';
import type { StructuredTrace } from '@cwatch/shared/sessions/structured-trace';
import { state } from './state.ts';

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined
      ? {}
      : { 'Content-Type': 'application/json', 'X-Cwatch-Token': state.bootstrap?.csrfToken ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? '请求失败，请检查本地服务。');
  return value as T;
}

export const fetchBootstrap = (): Promise<WorkbenchBootstrap> => api<WorkbenchBootstrap>('/api/bootstrap');
export const startRunApi = (input: RunStartInput): Promise<RunSnapshot> => api<RunSnapshot>('/api/runs', input);
export const cancelRunApi = (runId: string): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${runId}/cancel`, {});
export const deleteRunApi = (runId: string): Promise<{ deleted: string }> => api<{ deleted: string }>(`/api/runs/${runId}/delete`, {});
export const sendMessageApi = (runId: string, input: RunMessageInput): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${runId}/messages`, input);
export const endConversationApi = (runId: string): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${runId}/end`, {});
export const respondApprovalApi = (runId: string, requestId: string, allowed: boolean, argsHash: string): Promise<RunSnapshot> =>
  api<RunSnapshot>(`/api/runs/${runId}/approvals/${requestId}`, { allowed, argsHash });
export const fetchTraceApi = (runId: string): Promise<StructuredTrace> => api<StructuredTrace>(`/api/runs/${runId}/trace`);

export async function fetchReportApi(runId: string): Promise<string> {
  const response = await fetch(`/api/runs/${runId}/report`);
  if (!response.ok) throw Error('报告读取失败。');
  return response.text();
}

export const fetchExtensionsApi = (): Promise<WorkbenchExtensions> => api<WorkbenchExtensions>('/api/extensions');
export const fetchSkillDetailApi = (name: string): Promise<SkillDetail> => api<SkillDetail>(`/api/extensions/skills/${encodeURIComponent(name)}`);
export const toggleSkillApi = (name: string, enabled: boolean): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/skills/${encodeURIComponent(name)}/toggle`, { enabled });
export const toggleMcpApi = (slug: string, enabled: boolean): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/mcp/${encodeURIComponent(slug)}/toggle`, { enabled });
export const testMcpApi = (slug: string): Promise<McpTestResult> =>
  api<McpTestResult>(`/api/extensions/mcp/${encodeURIComponent(slug)}/test`, {});
