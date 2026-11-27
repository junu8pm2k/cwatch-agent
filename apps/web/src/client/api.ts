import type {
  McpTestResult,
  RunMessageInput,
  RunSnapshot,
  RunStartInput,
  ReportAnnotationInput,
  ReportReviewView,
  SkillDetail,
  TaskIntent,
  TaskIntentInput,
  WorkbenchBootstrap,
  WorkbenchExtensions,
  WorkbenchProject,
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
export const taskIntentApi = (input: TaskIntentInput): Promise<TaskIntent> => api<TaskIntent>('/api/task-intent', input);
export const createProjectApi = (name: string): Promise<WorkbenchProject> => api<WorkbenchProject>('/api/projects', { name });
export const moveRunApi = (id: string, projectId: string | null): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${id}/project`, { projectId });
export const renameRunApi = (id: string, title: string): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${id}/title`, { title });
export const fetchReviewApi = (id: string, saved = false): Promise<ReportReviewView> => api<ReportReviewView>(`/api/runs/${id}/report-review${saved ? '?version=saved' : ''}`);
export const annotateReportApi = (id: string, input: ReportAnnotationInput): Promise<ReportReviewView> => api<ReportReviewView>(`/api/runs/${id}/report-annotations`, input);
export const saveReportApi = (id: string, revision: number): Promise<ReportReviewView> => api<ReportReviewView>(`/api/runs/${id}/report-save`, { revision });
export const sendReportMessageApi = (id: string, input: RunMessageInput): Promise<ReportReviewView> => api<ReportReviewView>(`/api/runs/${id}/report-messages`, input);
export const startRunApi = (input: RunStartInput): Promise<RunSnapshot> => api<RunSnapshot>('/api/runs', input);
export const cancelRunApi = (runId: string): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${runId}/cancel`, {});
export const deleteRunApi = (runId: string): Promise<{ deleted: string }> => api<{ deleted: string }>(`/api/runs/${runId}/delete`, {});
export const sendMessageApi = (runId: string, input: RunMessageInput): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${runId}/messages`, input);
export const endConversationApi = (runId: string): Promise<RunSnapshot> => api<RunSnapshot>(`/api/runs/${runId}/end`, {});
export const respondApprovalApi = (runId: string, requestId: string, answer: boolean | { feedback: string }, argsHash: string): Promise<RunSnapshot> =>
  api<RunSnapshot>(`/api/runs/${runId}/approvals/${requestId}`, typeof answer === 'boolean' ? { allowed: answer, argsHash } : { ...answer, argsHash });
export const fetchTraceApi = (runId: string): Promise<StructuredTrace> => api<StructuredTrace>(`/api/runs/${runId}/trace`);

export async function fetchReportApi(runId: string, saved = false): Promise<string> {
  const response = await fetch(`/api/runs/${runId}/report${saved ? '?version=saved' : ''}`);
  if (!response.ok) throw Error('报告读取失败。');
  return response.text();
}

export const fetchExtensionsApi = (): Promise<WorkbenchExtensions> => api<WorkbenchExtensions>('/api/extensions');
export type ConnectionKind = 'providers' | 'search' | 'mcp' | 'skills';
export const saveConnectionApi = (kind: ConnectionKind, data: Record<string, unknown>): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>('/api/extensions/' + kind, data);
export const deleteProviderApi = (provider: string): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/providers/${encodeURIComponent(provider)}/delete`, {});
export const deleteSearchApi = (): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>('/api/extensions/search/delete', {});
export const fetchSkillDetailApi = (name: string): Promise<SkillDetail> => api<SkillDetail>(`/api/extensions/skills/${encodeURIComponent(name)}`);
export const toggleSkillApi = (name: string, enabled: boolean): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/skills/${encodeURIComponent(name)}/toggle`, { enabled });
export const deleteSkillApi = (name: string): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/skills/${encodeURIComponent(name)}/delete`, {});
export const toggleMcpApi = (slug: string, enabled: boolean): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/mcp/${encodeURIComponent(slug)}/toggle`, { enabled });
export const deleteMcpApi = (slug: string): Promise<WorkbenchExtensions> =>
  api<WorkbenchExtensions>(`/api/extensions/mcp/${encodeURIComponent(slug)}/delete`, {});
export const testMcpApi = (slug: string): Promise<McpTestResult> =>
  api<McpTestResult>(`/api/extensions/mcp/${encodeURIComponent(slug)}/test`, {});
