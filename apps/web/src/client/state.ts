import type { AgentTask, CompetitorTask } from '@cwatch/core/types';
import type {
  McpTestResult,
  RunProfile,
  RunSnapshot,
  RunStatus,
  SkillDetail,
  WorkbenchBootstrap,
  WorkbenchExtensions,
} from '@cwatch/core/types/runs';
import type { StructuredTrace } from '@cwatch/shared/sessions/structured-trace';

export type MainTab = 'report' | 'process';
export type TraceFilter = 'all' | 'model' | 'tool' | 'backend' | 'errors';

export const $ = <E extends HTMLElement = HTMLElement>(id: string): E => document.getElementById(id) as E;

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

export function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export const statusNames: Record<RunStatus, string> = {
  preparing: '准备中',
  running: '执行中',
  awaiting_approval: '等待审批',
  awaiting_user: '等待追问',
  cancelling: '正在取消',
  complete: '已完成',
  partial: '部分完成',
  failed: '运行失败',
  cancelled: '已取消',
  unknown: '运行中断',
};

export const permissionNames: Record<string, string> = {
  explore: '只读探索',
  ask: '写入前审批',
  'allow-all': '允许已配置操作',
};

export function isActiveStatus(status: RunStatus): boolean {
  return ['preparing', 'running', 'awaiting_approval', 'awaiting_user', 'cancelling'].includes(status);
}

export function isActiveRun(run?: RunSnapshot): boolean {
  return Boolean(run && isActiveStatus(run.status));
}

export function statusTone(status: RunStatus): 'busy' | 'warn' | 'ok' | 'error' | 'idle' {
  if (status === 'awaiting_approval') return 'warn';
  if (status === 'awaiting_user') return 'busy';
  if (status === 'preparing' || status === 'running' || status === 'cancelling') return 'busy';
  if (status === 'complete') return 'ok';
  if (status === 'partial' || status === 'failed' || status === 'cancelled' || status === 'unknown') return 'error';
  return 'idle';
}

export function isInvestigation(task: AgentTask): task is CompetitorTask {
  return !('kind' in task);
}

export function taskTitle(task: AgentTask): string {
  if (isInvestigation(task)) {
    return task.competitor.name + (task.competitor.name === task.product ? ' 动态调查' : ' · ' + task.product);
  }
  const singleLine = task.instruction.replace(/\s+/g, ' ').trim();
  return singleLine.length > 72 ? singleLine.slice(0, 72) + '…' : singleLine || '未命名任务';
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

export function formatElapsed(createdAt: string, endedAt?: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(endedAt ?? new Date().toISOString()) - Date.parse(createdAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface ClientState {
  bootstrap?: WorkbenchBootstrap;
  extensions?: WorkbenchExtensions;
  loadingExtensions: boolean;
  runs: RunSnapshot[];
  current?: RunSnapshot;
  view: 'workbench' | 'connections' | 'research';
  tab: MainTab;
  traceDrawerOpen: boolean;
  settingsOpen: boolean;
  domainFilterOpen: boolean;
  highlightedClaimId?: string;
  selectedPipelineStage?: number;
  theme: 'light' | 'dark';
  stream?: EventSource;
  submitting: boolean;
  sending: boolean;
  deletingRunIds: Set<string>;
  instructionDraft: string;
  drafts: Map<string, string>;
  pendingMessage?: { runId: string; text: string; messageId: string };
  reportCache: Map<string, string>;
  loadingReports: Set<string>;
  traceCache: Map<string, { revision: number; trace: StructuredTrace }>;
  loadingTraces: Set<string>;
  traceErrors: Map<string, string>;
  traceFilter: TraceFilter;
  selectedTraceStepId?: string;
  skillDetailCache: Map<string, SkillDetail>;
  activeSkillName?: string;
  loadingSkillName?: string;
  skillError?: string;
  mcpTestResults: Map<string, McpTestResult>;
  testingMcpSlugs: Set<string>;
  togglingKeys: Set<string>;
}

function readInitialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('cwatch-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* ignore */ }
  return 'light';
}

export const state: ClientState = {
  loadingExtensions: false,
  runs: [],
  view: 'workbench',
  tab: 'report',
  traceDrawerOpen: false,
  settingsOpen: false,
  domainFilterOpen: false,
  theme: readInitialTheme(),
  submitting: false,
  sending: false,
  deletingRunIds: new Set(),
  instructionDraft: '',
  drafts: new Map(),
  reportCache: new Map(),
  loadingReports: new Set(),
  traceCache: new Map(),
  loadingTraces: new Set(),
  traceErrors: new Map(),
  traceFilter: 'all',
  skillDetailCache: new Map(),
  mcpTestResults: new Map(),
  testingMcpSlugs: new Set(),
  togglingKeys: new Set(),
};

export function currentProfile(): RunProfile {
  return state.bootstrap!.profiles.find(p => p.id === 'web') ?? state.bootstrap!.profiles[0];
}

export function currentMode(): 'live' | 'replay' {
  return $<HTMLSelectElement>('task-runtime').value === 'live' ? 'live' : 'replay';
}

export function announce(text: string): void {
  $('announcer').textContent = text;
}

export function alertError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  const el = state.view === 'workbench' && !$('task-editor').hidden ? $('task-editor-error') : $('alert');
  el.textContent = text;
  el.hidden = false;
  announce(text);
}

export function clearError(): void {
  $('alert').hidden = true;
  $('task-editor-error').hidden = true;
}
