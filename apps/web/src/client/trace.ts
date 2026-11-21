import type { StructuredTrace, TraceStep } from '@cwatch/shared/sessions/structured-trace';
import { fetchTraceApi } from './api.ts';
import { $, escapeHtml, formatDurationMs, formatTime, state, type TraceFilter } from './state.ts';

const kindLabels: Record<TraceStep['kind'], string> = {
  run: 'RUN',
  model: 'MODEL',
  tool: 'TOOL',
  backend: 'BACKEND',
  process: 'PROC',
};

const stepStatusLabels: Record<TraceStep['status'], string> = {
  pending: '等待中',
  running: '执行中',
  completed: '完成',
  partial: '部分完成',
  blocked: '已拦截',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
};

function stepTone(status: TraceStep['status']): string {
  if (status === 'completed') return 'ok';
  if (status === 'running' || status === 'pending') return 'busy';
  if (status === 'blocked' || status === 'partial') return 'warn';
  return 'error';
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface TreeRow {
  step: TraceStep;
  depth: number;
}

function buildStepTree(steps: TraceStep[]): TreeRow[] {
  const byParent = new Map<string | null, TraceStep[]>();
  const knownIds = new Set(steps.map(s => s.stepId));
  for (const step of steps) {
    const key = step.parentStepId && knownIds.has(step.parentStepId) ? step.parentStepId : null;
    const list = byParent.get(key) ?? [];
    list.push(step);
    byParent.set(key, list);
  }
  const rows: TreeRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const child of byParent.get(parentId) ?? []) {
      rows.push({ step: child, depth: Math.min(depth, 4) });
      visit(child.stepId, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

function matchesFilter(step: TraceStep, filter: TraceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errors') return Boolean(step.error) || ['failed', 'blocked', 'cancelled'].includes(step.status);
  return step.kind === filter;
}

export async function loadTrace(runId: string, force = false): Promise<void> {
  const run = state.runs.find(r => r.id === runId);
  const revision = run?.revision ?? 0;
  const cached = state.traceCache.get(runId);
  if (!force && cached && cached.revision === revision) return;
  if (state.loadingTraces.has(runId)) return;

  state.loadingTraces.add(runId);
  state.traceErrors.delete(runId);
  if (state.current?.id === runId && state.tab === 'trace') renderTrace();

  try {
    const trace = await fetchTraceApi(runId);
    state.traceCache.set(runId, { revision, trace });
    if (state.current?.id === runId && !state.selectedTraceStepId && trace.steps.length) {
      state.selectedTraceStepId = trace.steps[0].stepId;
    }
  } catch (error) {
    state.traceErrors.set(runId, error instanceof Error ? error.message : String(error));
  } finally {
    state.loadingTraces.delete(runId);
    if (state.current?.id === runId && state.tab === 'trace') renderTrace();
  }
}

export function renderTrace(): void {
  const panel = $('trace-content');
  const run = state.current;
  if (!run) {
    panel.innerHTML = '<div class="empty-state"><h3>暂无 Trace</h3><p>启动或选择一次任务后，可在此查看完整结构化调用链。</p></div>';
    return;
  }

  const cached = state.traceCache.get(run.id);
  const loading = state.loadingTraces.has(run.id);
  const error = state.traceErrors.get(run.id);

  if (!cached && !loading && !error) {
    void loadTrace(run.id);
    panel.innerHTML = '<div class="empty-state"><h3>正在加载结构化 Trace…</h3><p>读取本次运行的模型、工具与后端审计记录。</p></div>';
    return;
  }

  if (!cached && loading) {
    panel.innerHTML = '<div class="empty-state"><h3>正在加载结构化 Trace…</h3><p>读取本次运行的模型、工具与后端审计记录。</p></div>';
    return;
  }

  if (!cached && error) {
    const waiting = error.includes('trace_not_ready');
    panel.innerHTML = `<div class="empty-state"><h3>${waiting ? 'Trace 尚未就绪' : 'Trace 读取失败'}</h3><p>${escapeHtml(waiting ? '来源准备完成后将生成结构化审计 Trace，可稍后刷新。' : error)}</p><div class="empty-actions"><button type="button" class="button secondary" data-trace-refresh>重新读取</button></div></div>`;
    return;
  }

  const trace: StructuredTrace = cached!.trace;
  const rows = buildStepTree(trace.steps);
  const filtered = rows.filter(row => matchesFilter(row.step, state.traceFilter));
  const selected = filtered.find(r => r.step.stepId === state.selectedTraceStepId)?.step ?? filtered[0]?.step;
  if (selected) state.selectedTraceStepId = selected.stepId;

  const rootStart = trace.timing.startedAt ? Date.parse(trace.timing.startedAt) : NaN;
  const rootDuration = Math.max(1, trace.timing.durationMs ?? 1);
  const integrityClass = !trace.integrity.valid ? 'error' : trace.integrity.complete ? 'ok' : 'busy';
  const integrityLabel = !trace.integrity.valid ? '审计校验异常' : trace.integrity.complete ? '审计完整' : '进行中快照';

  const filters: Array<{ id: TraceFilter; label: string; count: number }> = [
    { id: 'all', label: '全部步骤', count: rows.length },
    { id: 'model', label: '模型', count: rows.filter(r => r.step.kind === 'model').length },
    { id: 'tool', label: '工具', count: rows.filter(r => r.step.kind === 'tool').length },
    { id: 'backend', label: '后端', count: rows.filter(r => r.step.kind === 'backend').length },
    { id: 'errors', label: '异常/拦截', count: rows.filter(r => matchesFilter(r.step, 'errors')).length },
  ];

  const rowsHtml = filtered.length
    ? filtered.map(({ step, depth }) => {
        const startMs = step.timing.startedAt ? Date.parse(step.timing.startedAt) : step.timing.requestedAt ? Date.parse(step.timing.requestedAt) : NaN;
        const leftPct = Number.isFinite(rootStart) && Number.isFinite(startMs)
          ? Math.max(0, Math.min(96, ((startMs - rootStart) / rootDuration) * 100))
          : 0;
        const duration = step.timing.durationMs ?? step.timing.executionDurationMs ?? 0;
        const widthPct = Math.max(2, Math.min(100 - leftPct, (duration / rootDuration) * 100));
        const activeClass = selected?.stepId === step.stepId ? 'selected' : '';
        const tone = stepTone(step.status);
        return `<button type="button" class="trace-row trace-depth-${depth} ${activeClass}" data-trace-step="${escapeHtml(step.stepId)}">
          <span class="trace-row-main">
            <span class="trace-kind kind-${escapeHtml(step.kind)}">${escapeHtml(kindLabels[step.kind])}</span>
            <span class="trace-name">${escapeHtml(step.name)}</span>
            ${step.resultStatus ? `<span class="trace-result-tag">${escapeHtml(step.resultStatus)}</span>` : ''}
          </span>
          <span class="trace-row-meta">
            <span class="trace-waterfall" aria-hidden="true"><span class="trace-bar-fill tone-${tone}" data-bar-left="${leftPct.toFixed(1)}" data-bar-width="${widthPct.toFixed(1)}"></span></span>
            <span class="trace-duration">${escapeHtml(formatDurationMs(step.timing.durationMs ?? step.timing.executionDurationMs))}</span>
            <span class="trace-status tone-${tone}">${escapeHtml(stepStatusLabels[step.status])}</span>
          </span>
        </button>`;
      }).join('')
    : '<p class="trace-empty-filter">当前筛选条件下没有匹配步骤。</p>';

  const detailHtml = selected ? renderStepDetail(selected) : '';

  panel.innerHTML = `
    <div class="trace-header">
      <div class="trace-badges">
        <span class="status-chip tone-${integrityClass}">${escapeHtml(integrityLabel)}</span>
        <span class="trace-meta-text">Schema ${escapeHtml(trace.schemaVersion)} · ${trace.events.length} 条审计事件</span>
      </div>
      <div class="trace-actions">
        <button type="button" class="button secondary sm" data-trace-refresh ${loading ? 'disabled' : ''}>${loading ? '刷新中…' : '刷新 Trace'}</button>
        <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/trace" download="trace-${escapeHtml(run.id.slice(0, 8))}.json">导出 JSON</a>
      </div>
    </div>
    <div class="trace-summary-grid">
      <div class="mini-stat"><span>模型轮次</span><strong>${trace.summary.modelRounds}</strong></div>
      <div class="mini-stat"><span>工具请求 / 执行</span><strong>${trace.summary.toolRequests} / ${trace.summary.toolExecutions}</strong></div>
      <div class="mini-stat"><span>后端执行</span><strong>${trace.summary.backendExecutions}</strong></div>
      <div class="mini-stat"><span>Token 用量</span><strong>${(trace.summary.totalTokens ?? trace.summary.knownTokens).toLocaleString()}</strong></div>
      <div class="mini-stat"><span>总耗时</span><strong>${escapeHtml(formatDurationMs(trace.timing.durationMs))}</strong></div>
    </div>
    ${trace.integrity.errors.length ? `<div class="run-notice"><strong>审计校验提示：</strong>${trace.integrity.errors.map(escapeHtml).join('；')}</div>` : ''}
    <div class="filter-pills" role="group" aria-label="Trace 步骤筛选">
      ${filters.map(f => `<button type="button" class="filter-pill ${state.traceFilter === f.id ? 'active' : ''}" data-trace-filter="${f.id}">${escapeHtml(f.label)} <span class="pill-count">${f.count}</span></button>`).join('')}
    </div>
    <div class="trace-split">
      <div class="trace-tree" aria-label="Trace 步骤树">${rowsHtml}</div>
      ${detailHtml}
    </div>
  `;

  // Apply waterfall positions through CSSOM so zero inline style="" attributes are emitted (strict CSP).
  for (const bar of panel.querySelectorAll<HTMLElement>('[data-bar-width]')) {
    bar.style.left = (bar.dataset.barLeft ?? '0') + '%';
    bar.style.width = (bar.dataset.barWidth ?? '2') + '%';
  }
}

function renderStepDetail(step: TraceStep): string {
  const corrEntries = Object.entries(step.correlation).filter(([, v]) => v !== null);
  const hasAttrs = Object.keys(step.attributes).length > 0;
  return `<section class="trace-detail" aria-label="步骤详情">
    <div class="trace-detail-head">
      <div>
        <span class="trace-kind kind-${escapeHtml(step.kind)}">${escapeHtml(kindLabels[step.kind])}</span>
        <h4>${escapeHtml(step.name)}</h4>
      </div>
      <span class="status-chip tone-${stepTone(step.status)}">${escapeHtml(stepStatusLabels[step.status])}</span>
    </div>
    <dl class="kv-grid">
      <dt>全程耗时</dt><dd>${escapeHtml(formatDurationMs(step.timing.durationMs))}</dd>
      <dt>实际执行</dt><dd>${escapeHtml(formatDurationMs(step.timing.executionDurationMs))}</dd>
      <dt>开始时间</dt><dd>${escapeHtml(step.timing.startedAt ? formatTime(step.timing.startedAt) : step.timing.requestedAt ? formatTime(step.timing.requestedAt) : '—')}</dd>
      <dt>关联事件</dt><dd>${step.eventIds.length} 条</dd>
      ${corrEntries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="mono">${escapeHtml(v)}</dd>`).join('')}
    </dl>
    ${step.error ? `<div class="trace-error-box"><strong>${escapeHtml(step.error.category)} · ${escapeHtml(step.error.code)}</strong><p>${escapeHtml(step.error.message)}</p></div>` : ''}
    ${step.input !== null ? `<details open><summary>输入 (input)</summary><pre class="json-pre">${escapeHtml(prettyJson(step.input))}</pre></details>` : ''}
    ${step.output !== null ? `<details open><summary>输出 (output)</summary><pre class="json-pre">${escapeHtml(prettyJson(step.output))}</pre></details>` : ''}
    ${step.usage.length ? `<details><summary>用量明细 (${step.usage.length})</summary><pre class="json-pre">${escapeHtml(prettyJson(step.usage))}</pre></details>` : ''}
    ${hasAttrs ? `<details><summary>属性与权限裁决 (attributes)</summary><pre class="json-pre">${escapeHtml(prettyJson(step.attributes))}</pre></details>` : ''}
  </section>`;
}
