import type { Plan } from '@cwatch/core/types';
import type {
  RunClaimEvidence,
  RunComparisonSummary,
  RunSnapshot,
} from '@cwatch/core/types/runs';
import { mergeActivities, type MergedActivity } from './activity-merger.ts';
import { extractHeadings } from './markdown.ts';
import {
  escapeHtml,
  formatDurationMs,
  formatTime,
  isActiveRun,
  isInvestigation,
  safeUrl,
  statusNames,
} from './state.ts';

export const PIPELINE_STAGES = ['计划', '采集', '分析', '审阅', '草稿'] as const;

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  release: '发布 release',
  price: '定价 price',
  content: '内容 content',
  campaign: '活动 campaign',
};

function parseJsonObject(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractEvidenceDomain(ev: RunClaimEvidence): string | undefined {
  if (ev.domain?.trim()) return ev.domain.trim().toLowerCase();
  try {
    return new URL(ev.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function collectEvidenceStats(run: RunSnapshot): {
  evidenceCount: number;
  domainCount: number;
  verifiedCount: number;
  domains: string[];
} {
  const uniqueEvidence = new Map<string, RunClaimEvidence>();
  const domains = new Set<string>();

  for (const claim of run.claims) {
    for (const ev of claim.evidence) {
      const key = ev.snapshotHash
        ? `${ev.url}|${ev.snapshotHash}`
        : `${ev.source}|${ev.url}|${ev.title}`;
      if (!uniqueEvidence.has(key)) uniqueEvidence.set(key, ev);
      const host = extractEvidenceDomain(ev);
      if (host) domains.add(host);
    }
  }

  let verifiedCount = 0;
  for (const ev of uniqueEvidence.values()) {
    if (ev.snapshotVerified) verifiedCount++;
  }

  return {
    evidenceCount: uniqueEvidence.size,
    domainCount: domains.size,
    verifiedCount,
    domains: [...domains],
  };
}

interface ReviewSummaryState {
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  shortLabel: string;
  fullLabel: string;
  explicit: boolean;
}

function resolveReviewState(run: RunSnapshot): ReviewSummaryState {
  if (run.review) {
    if (run.review.decision === 'accept') {
      return { tone: 'ok', shortLabel: '通过', fullLabel: '通过 (accept)', explicit: true };
    }
    if (run.review.decision === 'needs_evidence') {
      return { tone: 'warn', shortLabel: '需补证据', fullLabel: '需补充证据 (needs_evidence)', explicit: true };
    }
    return { tone: 'error', shortLabel: '驳回 / 冲突', fullLabel: '驳回/冲突 (reject)', explicit: true };
  }
  if (run.status === 'complete' && run.gaps.length === 0) {
    return { tone: 'ok', shortLabel: '核验通过', fullLabel: '规则核验通过', explicit: false };
  }
  if (run.status === 'partial' || run.gaps.length > 0) {
    return { tone: 'warn', shortLabel: '存在缺口', fullLabel: '存在信息缺口', explicit: false };
  }
  if (['failed', 'cancelled', 'unknown'].includes(run.status)) {
    return { tone: 'error', shortLabel: statusNames[run.status], fullLabel: statusNames[run.status], explicit: false };
  }
  return { tone: 'neutral', shortLabel: '待审阅', fullLabel: '等待审阅', explicit: false };
}

export function resolveRunPlan(run: RunSnapshot): Plan | undefined {
  if (run.plan) return run.plan;

  for (let i = run.activities.length - 1; i >= 0; i--) {
    const act = run.activities[i];
    if (act.tool !== 'workflow__save_plan' || !act.detail) continue;
    const parsed = parseJsonObject(act.detail);
    if (!parsed) continue;

    const objective = typeof parsed.objective === 'string' ? parsed.objective.trim() : '';
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const evidenceRequirements = Array.isArray(parsed.evidenceRequirements)
      ? parsed.evidenceRequirements.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    const rawWindow = parsed.window && typeof parsed.window === 'object' && !Array.isArray(parsed.window)
      ? (parsed.window as Record<string, unknown>)
      : undefined;
    const fallbackWindow = isInvestigation(run.task)
      ? { start: run.task.window.start, end: run.task.window.end }
      : { start: '', end: '' };
    const start = typeof rawWindow?.start === 'string' ? rawWindow.start : fallbackWindow.start;
    const end = typeof rawWindow?.end === 'string' ? rawWindow.end : fallbackWindow.end;

    if (objective || queries.length || sources.length) {
      return {
        taskId: typeof parsed.taskId === 'string' ? parsed.taskId : run.task.taskId,
        objective: objective || '未提供调查目标说明',
        sources,
        queries,
        evidenceRequirements,
        window: { start, end },
      };
    }
  }

  return undefined;
}

function formatDateRange(start?: string, end?: string): string {
  if (!start && !end) return '未指定时间窗';
  const s = start ? start.slice(0, 10) : '—';
  const e = end ? end.slice(0, 10) : '—';
  return `${s} ~ ${e}`;
}

export function renderMetricsRibbon(run: RunSnapshot): string {
  const stats = collectEvidenceStats(run);
  const reviewState = resolveReviewState(run);
  const domainSub = stats.domains.length
    ? stats.domains.slice(0, 2).join(' · ') + (stats.domains.length > 2 ? ` +${stats.domains.length - 2}` : '')
    : '暂无外部域名';
  const evidenceSub = stats.verifiedCount > 0
    ? `${stats.verifiedCount} 份已验快照哈希`
    : '主张去重证据数';
  const gapSub = run.gaps.length > 0 ? `缺口 ${run.gaps.length} 项` : '0 项信息缺口';

  return `
    <div class="report-metrics-ribbon" role="region" aria-label="核心指标速览">
      <div class="metric-tile">
        <span class="metric-label">核验主张</span>
        <strong class="metric-value">${run.claims.length}</strong>
        <span class="metric-sub">结构化结论条目</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">证据快照</span>
        <strong class="metric-value">${stats.evidenceCount}</strong>
        <span class="metric-sub">${escapeHtml(evidenceSub)}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">独立域名</span>
        <strong class="metric-value">${stats.domainCount}</strong>
        <span class="metric-sub" title="${escapeHtml(stats.domains.join(', '))}">${escapeHtml(domainSub)}</span>
      </div>
      <div class="metric-tile tone-${reviewState.tone}">
        <span class="metric-label">审阅与缺口</span>
        <strong class="metric-value metric-status">${escapeHtml(reviewState.shortLabel)}</strong>
        <span class="metric-sub">${escapeHtml(gapSub)}</span>
      </div>
    </div>`;
}

export function renderReviewGateCard(run: RunSnapshot): string {
  const reviewState = resolveReviewState(run);

  if (run.review) {
    const { review } = run;
    const reworkPill = run.reworkCount && run.reworkCount > 0
      ? `<span class="gate-meta-pill tone-warn">已执行 ${run.reworkCount} 轮补采返工</span>`
      : '';
    const gapPill = run.gaps.length > 0
      ? `<span class="gate-meta-pill tone-warn">采集缺口 ${run.gaps.length} 项</span>`
      : '';
    const bodyHtml = review.issues.length > 0
      ? `<ul class="report-gate-issues">${review.issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
      : '<p class="report-gate-ok">规则核验通过，未发现主张与证据冲突</p>';

    return `
      <section class="report-gate-card tone-${reviewState.tone}" aria-label="审阅质检门禁">
        <div class="report-gate-head">
          <div class="report-gate-title-group">
            <span class="gate-badge tone-${reviewState.tone}">${escapeHtml(reviewState.fullLabel)}</span>
            <span class="report-gate-label">审阅质检门禁</span>
          </div>
          <div class="report-gate-meta">
            <span class="gate-meta-pill">已引用证据 ${review.evidenceRefs.length} 项</span>
            ${reworkPill}
            ${gapPill}
          </div>
        </div>
        ${bodyHtml}
      </section>`;
  }

  if (run.gaps.length > 0 || run.status === 'complete' || run.status === 'partial') {
    const summaryText = run.status === 'complete' && run.gaps.length === 0
      ? '规则核验通过，未发现主张与证据冲突。'
      : run.gaps.length > 0
        ? `本次调查保留 ${run.gaps.length} 项来源或核验缺口，建议结合右侧缺口清单复核。`
        : '调查部分完成，请结合正文草稿与执行轨迹人工复核。';
    const reworkPill = run.reworkCount && run.reworkCount > 0
      ? `<span class="gate-meta-pill tone-warn">已执行 ${run.reworkCount} 轮补采返工</span>`
      : '';

    return `
      <section class="report-gate-card tone-${reviewState.tone}" aria-label="审阅质检摘要">
        <div class="report-gate-head">
          <div class="report-gate-title-group">
            <span class="gate-badge tone-${reviewState.tone}">${escapeHtml(reviewState.fullLabel)}</span>
            <span class="report-gate-label">质检摘要</span>
          </div>
          <div class="report-gate-meta">
            <span class="gate-meta-pill">主张 ${run.claims.length} 项</span>
            <span class="gate-meta-pill${run.gaps.length > 0 ? ' tone-warn' : ''}">缺口 ${run.gaps.length} 项</span>
            ${reworkPill}
          </div>
        </div>
        <p class="report-gate-ok">${escapeHtml(summaryText)}</p>
      </section>`;
  }

  return '';
}

function diffStatusMeta(status: RunComparisonSummary['status']): { label: string; cls: string } {
  if (status === 'new') return { label: '新增', cls: 'diff-new' };
  if (status === 'updated') return { label: '已变更', cls: 'diff-updated' };
  return { label: '保持一致', cls: 'diff-unchanged' };
}

export function renderVersionDiffCard(run: RunSnapshot): string {
  const comparisons = run.comparisons;
  if (!comparisons?.length) return '';

  const counts = { new: 0, updated: 0, unchanged: 0 };
  for (const item of comparisons) {
    counts[item.status]++;
  }

  const summaryPills = [
    counts.new > 0 ? `<span class="diff-count-pill diff-new">新增 ${counts.new}</span>` : '',
    counts.updated > 0 ? `<span class="diff-count-pill diff-updated">已变更 ${counts.updated}</span>` : '',
    counts.unchanged > 0 ? `<span class="diff-count-pill diff-unchanged">保持一致 ${counts.unchanged}</span>` : '',
  ].filter(Boolean).join('');

  const rowsHtml = comparisons.map(item => {
    const meta = diffStatusMeta(item.status);
    const titleText = item.title?.trim() || item.eventId;
    const signalLabel = item.signalType
      ? (SIGNAL_TYPE_LABELS[item.signalType] ?? item.signalType)
      : '';
    return `
      <li class="version-diff-item ${meta.cls}">
        <span class="diff-status-badge ${meta.cls}">${meta.label}</span>
        <div class="diff-item-main">
          <span class="diff-item-title">${escapeHtml(titleText)}</span>
          ${item.title?.trim() ? `<span class="diff-item-id mono">${escapeHtml(item.eventId)}</span>` : ''}
        </div>
        <div class="diff-item-meta">
          ${signalLabel ? `<span class="diff-signal-tag">${escapeHtml(signalLabel)}</span>` : ''}
          <span class="diff-version-delta mono" title="历史版本数 → 当前版本数">${item.previousVersions.length} → ${item.currentVersions.length} 版本</span>
        </div>
      </li>`;
  }).join('');

  return `
    <section class="report-diff-card" aria-label="历史事实版本演进">
      <div class="report-diff-head">
        <h4>历史事实版本演进</h4>
        <div class="report-diff-summary">${summaryPills}</div>
      </div>
      <ul class="version-diff-list">${rowsHtml}</ul>
    </section>`;
}

export function renderReportToc(doc: string): string {
  const headings = extractHeadings(doc).filter(item => item.level === 2 || item.level === 3);
  if (headings.length < 2) return '';

  return `
    <nav class="report-toc" aria-label="报告章节目录">
      <span class="report-toc-title">章节目录</span>
      <ol class="report-toc-list">
        ${headings.map(h => `
          <li class="toc-item toc-level-${h.level}">
            <a class="toc-link" href="#${escapeHtml(h.id)}" data-toc-target="${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>
          </li>`).join('')}
      </ol>
    </nav>`;
}

function renderCompactStepRow(item: MergedActivity): string {
  const icon = item.state === 'completed' ? '✓' : item.state === 'failed' ? '!' : item.state === 'running' ? '…' : '·';
  return `
    <li class="step-card state-${item.state}">
      <div class="step-card-row">
        <span class="step-state state-${item.state}" aria-hidden="true">${icon}</span>
        <span class="step-pill cat-${escapeHtml(item.category)}">${escapeHtml(item.badge)}</span>
        <span class="step-title">${escapeHtml(item.title)}</span>
        <span class="step-right">
          ${item.durationMs !== undefined ? `<span class="step-dur">${escapeHtml(formatDurationMs(item.durationMs))}</span>` : ''}
          <time datetime="${escapeHtml(item.startedAt)}">${formatTime(item.startedAt)}</time>
        </span>
      </div>
    </li>`;
}

export function renderLiveProgressCard(run: RunSnapshot): string {
  const investigation = isInvestigation(run.task);
  const clampedStage = Math.min(Math.max(run.stage, 0), PIPELINE_STAGES.length - 1);
  const stageName = PIPELINE_STAGES[clampedStage];
  const stageText = investigation
    ? `当前阶段 ${clampedStage + 1}/${PIPELINE_STAGES.length} · ${stageName}`
    : `当前状态 · ${statusNames[run.status]}`;

  const merged = mergeActivities(run.activities);
  const recent = merged.slice(-4);
  const stepsHtml = recent.length
    ? `<ul class="step-card-list compact live-step-list">${recent.map(renderCompactStepRow).join('')}</ul>`
    : '<p class="live-progress-empty">正在初始化运行环境与来源连接，首个执行步骤马上出现…</p>';

  return `
    <section class="live-progress-card" aria-label="实时执行进展">
      <div class="live-progress-head">
        <div class="live-progress-title-group">
          <span class="pulse-dot tone-busy" aria-hidden="true"></span>
          <h3>${escapeHtml(investigation ? '正在执行调查…' : '正在生成结果…')}</h3>
        </div>
        <span class="live-stage-pill">${escapeHtml(stageText)}</span>
      </div>
      <p class="live-progress-desc">${escapeHtml(
        investigation
          ? '采集、归因分析与规则审阅完成后，结构化指标与带引用的调查报告将自动呈现在这里。'
          : '任务完成后，回答内容将在这里展示，并支持复制与导出。',
      )}</p>
      ${stepsHtml}
      <div class="live-progress-actions">
        <button type="button" class="button secondary sm" data-jump-tab="process">查看实时执行轨迹</button>
        <button type="button" class="button ghost sm" data-open-trace>打开 Trace 抽屉</button>
      </div>
    </section>`;
}

export function renderPipeline(run: RunSnapshot, selectedStage?: number): string {
  return PIPELINE_STAGES.map((name, index) => {
    const done = run.stage > index;
    const current = run.stage === index && isActiveRun(run);
    const selected = selectedStage === index;
    const cls = [
      'pipeline-step',
      done ? 'done' : current ? 'current' : '',
      selected ? 'selected' : '',
    ].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-pipeline-stage="${index}" aria-pressed="${selected ? 'true' : 'false'}"><span class="step-dot">${done ? '✓' : index + 1}</span><span>${name}</span></button>`;
  }).join('');
}

function renderPlanStageBody(run: RunSnapshot): string {
  const plan = resolveRunPlan(run);
  if (!plan) {
    return `<p class="pipeline-empty">${isActiveRun(run) ? '调查计划尚未锁定，正在等待 Agent 生成并提交计划…' : '本次运行未记录结构化计划详情。'}</p>`;
  }

  const sourcesHtml = plan.sources.length
    ? plan.sources.map(src => `<span class="pipeline-chip">${escapeHtml(src)}</span>`).join('')
    : '<span class="pipeline-muted">未指定</span>';
  const queriesHtml = plan.queries.length
    ? `<ul class="pipeline-list">${plan.queries.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
    : '<p class="pipeline-muted">未提供查询列表</p>';
  const reqsHtml = plan.evidenceRequirements.length
    ? `<div class="pipeline-chip-row">${plan.evidenceRequirements.map(req => `<span class="pipeline-chip subtle">${escapeHtml(req)}</span>`).join('')}</div>`
    : '<p class="pipeline-muted">未指定额外证据要求</p>';

  return `
    <div class="pipeline-plan-grid">
      <div class="pipeline-field">
        <span class="pipeline-field-label">调查目标</span>
        <p class="pipeline-objective">${escapeHtml(plan.objective)}</p>
      </div>
      <div class="pipeline-field-split">
        <div class="pipeline-field">
          <span class="pipeline-field-label">目标来源</span>
          <div class="pipeline-chip-row">${sourcesHtml}</div>
        </div>
        <div class="pipeline-field">
          <span class="pipeline-field-label">调查时间窗</span>
          <p class="pipeline-mono-val mono">${escapeHtml(formatDateRange(plan.window.start, plan.window.end))}</p>
        </div>
      </div>
      <div class="pipeline-field">
        <span class="pipeline-field-label">计划查询 (${plan.queries.length})</span>
        ${queriesHtml}
      </div>
      <div class="pipeline-field">
        <span class="pipeline-field-label">证据要求</span>
        ${reqsHtml}
      </div>
    </div>`;
}

function renderCollectStageBody(run: RunSnapshot): string {
  const merged = mergeActivities(run.activities);
  const collectSteps = merged.filter(item =>
    Boolean(item.tool)
    && !item.tool!.startsWith('workflow__')
    && !item.tool!.startsWith('session__'),
  );

  const completed = collectSteps.filter(s => s.state === 'completed').length;
  const failed = collectSteps.filter(s => s.state === 'failed').length;
  const running = collectSteps.filter(s => s.state === 'running').length;

  const visitedUrls = new Map<string, string>();
  const searchQueries = new Set<string>();
  const usedTools = new Set<string>();

  for (const step of collectSteps) {
    if (step.tool) usedTools.add(step.tool);
    const args = parseJsonObject(step.detail);
    if (typeof args?.url === 'string') {
      const safe = safeUrl(args.url);
      if (safe && !visitedUrls.has(safe)) visitedUrls.set(safe, safe);
    }
    if (typeof args?.query === 'string' && args.query.trim()) {
      searchQueries.add(args.query.trim());
    }
  }
  for (const claim of run.claims) {
    for (const ev of claim.evidence) {
      const safe = safeUrl(ev.url);
      if (safe && !visitedUrls.has(safe)) visitedUrls.set(safe, ev.title || safe);
    }
  }

  const latest = collectSteps.at(-1);
  const latestLabel = latest
    ? `${latest.title}（${latest.state === 'completed' ? '已完成' : latest.state === 'running' ? '执行中' : latest.state === 'failed' ? '未完成' : '已记录'}）`
    : '尚未触发采集工具调用';

  const urlListHtml = visitedUrls.size
    ? `<ul class="pipeline-list">${[...visitedUrls.entries()].slice(0, 8).map(([href, label]) => `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>`).join('')}</ul>`
    : '';
  const queryHtml = searchQueries.size
    ? `<div class="pipeline-chip-row">${[...searchQueries].slice(0, 8).map(q => `<span class="pipeline-chip subtle">${escapeHtml(q)}</span>`).join('')}</div>`
    : '';
  const sourceChips = isInvestigation(run.task)
    ? run.task.allowedSources.map(s => `<span class="pipeline-chip">${escapeHtml(s)}</span>`).join('')
    : '';

  return `
    <div class="pipeline-kv-strip">
      <div class="pipeline-stat"><span class="pipeline-field-label">采集工具调用</span><strong>${collectSteps.length} 次</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">成功 / 异常</span><strong>${completed} / ${failed}${running ? `（${running} 进行中）` : ''}</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">已记录 URL</span><strong>${visitedUrls.size} 个</strong></div>
    </div>
    <div class="pipeline-field">
      <span class="pipeline-field-label">最新采集状态</span>
      <p class="pipeline-objective">${escapeHtml(latestLabel)}</p>
    </div>
    ${sourceChips ? `<div class="pipeline-field"><span class="pipeline-field-label">配置来源 / 工具</span><div class="pipeline-chip-row">${sourceChips}${[...usedTools].map(t => `<span class="pipeline-chip subtle mono">${escapeHtml(t)}</span>`).join('')}</div></div>` : ''}
    ${queryHtml ? `<div class="pipeline-field"><span class="pipeline-field-label">执行检索词</span>${queryHtml}</div>` : ''}
    ${urlListHtml ? `<div class="pipeline-field"><span class="pipeline-field-label">已访问来源 URL</span>${urlListHtml}</div>` : ''}`;
}

function renderAnalyzeStageBody(run: RunSnapshot): string {
  const comparisons = run.comparisons ?? [];
  const newCount = comparisons.filter(c => c.status === 'new').length;
  const updatedCount = comparisons.filter(c => c.status === 'updated').length;
  const unchangedCount = comparisons.filter(c => c.status === 'unchanged').length;

  const gapsHtml = run.gaps.length
    ? `<ul class="pipeline-list">${run.gaps.map(g => `<li>${escapeHtml(g)}</li>`).join('')}</ul>`
    : '<p class="pipeline-muted">当前无归因或采集信息缺口。</p>';

  return `
    <div class="pipeline-kv-strip">
      <div class="pipeline-stat"><span class="pipeline-field-label">已生成主张</span><strong>${run.claims.length} 项</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">历史版本比对</span><strong>${comparisons.length} 项</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">信息缺口</span><strong>${run.gaps.length} 项</strong></div>
    </div>
    ${comparisons.length ? `<div class="pipeline-chip-row"><span class="diff-count-pill diff-new">新增 ${newCount}</span><span class="diff-count-pill diff-updated">已变更 ${updatedCount}</span><span class="diff-count-pill diff-unchanged">一致 ${unchangedCount}</span></div>` : ''}
    <div class="pipeline-field">
      <span class="pipeline-field-label">缺口汇总</span>
      ${gapsHtml}
    </div>`;
}

function renderReviewStageBody(run: RunSnapshot): string {
  const reviewState = resolveReviewState(run);
  const reworkText = run.reworkCount && run.reworkCount > 0
    ? `已执行 ${run.reworkCount} 轮补采返工`
    : '0 轮（首轮直通）';

  if (run.review) {
    const issuesHtml = run.review.issues.length
      ? `<ul class="pipeline-list">${run.review.issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
      : '<p class="pipeline-muted">规则核验通过，未发现主张与证据冲突。</p>';
    return `
      <div class="pipeline-kv-strip">
        <div class="pipeline-stat"><span class="pipeline-field-label">审阅结论</span><strong><span class="gate-badge tone-${reviewState.tone}">${escapeHtml(reviewState.fullLabel)}</span></strong></div>
        <div class="pipeline-stat"><span class="pipeline-field-label">返工轮次</span><strong>${escapeHtml(reworkText)}</strong></div>
        <div class="pipeline-stat"><span class="pipeline-field-label">核验引用数</span><strong>${run.review.evidenceRefs.length} 项</strong></div>
      </div>
      <div class="pipeline-field">
        <span class="pipeline-field-label">发现问题 (${run.review.issues.length})</span>
        ${issuesHtml}
      </div>`;
  }

  const reviewAct = mergeActivities(run.activities).filter(a => a.tool === 'workflow__review').at(-1);
  const actStatus = reviewAct
    ? (reviewAct.state === 'completed' ? '规则审阅已执行完成' : reviewAct.state === 'running' ? '规则审阅执行中…' : '规则审阅执行异常')
    : '等待进入审阅阶段';

  return `
    <div class="pipeline-kv-strip">
      <div class="pipeline-stat"><span class="pipeline-field-label">审阅状态</span><strong><span class="gate-badge tone-${reviewState.tone}">${escapeHtml(reviewState.fullLabel)}</span></strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">返工轮次</span><strong>${escapeHtml(reworkText)}</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">留痕缺口</span><strong>${run.gaps.length} 项</strong></div>
    </div>
    <p class="pipeline-muted">${escapeHtml(actStatus)}</p>`;
}

function renderDraftStageBody(run: RunSnapshot): string {
  const readyText = run.reportReady ? '报告草稿已就绪' : isActiveRun(run) ? '等待生成报告草稿…' : '未生成报告草稿';
  const modeText = run.mode === 'replay' ? '合成快照 · 演示' : '本地草稿 · 待人工核对';

  return `
    <div class="pipeline-kv-strip">
      <div class="pipeline-stat"><span class="pipeline-field-label">草稿状态</span><strong>${escapeHtml(readyText)}</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">纳入主张</span><strong>${run.claims.length} 项</strong></div>
      <div class="pipeline-stat"><span class="pipeline-field-label">报告性质</span><strong>${escapeHtml(modeText)}</strong></div>
    </div>
    <div class="pipeline-actions">
      ${run.reportReady ? '<button type="button" class="button primary sm" data-jump-report>定位调查报告</button>' : ''}
      <button type="button" class="button secondary sm" data-jump-tab="process">查看执行轨迹</button>
      <button type="button" class="button ghost sm" data-open-trace>打开 Trace 抽屉</button>
    </div>`;
}

export function renderPipelineDetail(run: RunSnapshot, stageIndex: number): string {
  const index = Math.min(Math.max(stageIndex, 0), PIPELINE_STAGES.length - 1);
  const stageName = PIPELINE_STAGES[index];
  const done = run.stage > index;
  const current = run.stage === index && isActiveRun(run);
  const statusLabel = done ? '已完成' : current ? '进行中' : '待执行';
  const statusToneClass = done ? 'tone-ok' : current ? 'tone-busy' : 'tone-idle';

  const body = index === 0
    ? renderPlanStageBody(run)
    : index === 1
      ? renderCollectStageBody(run)
      : index === 2
        ? renderAnalyzeStageBody(run)
        : index === 3
          ? renderReviewStageBody(run)
          : renderDraftStageBody(run);

  return `
    <div class="pipeline-detail-head">
      <div class="pipeline-detail-title">
        <span class="status-chip ${statusToneClass}">${statusLabel}</span>
        <h4>阶段 ${index + 1} · ${escapeHtml(stageName)}</h4>
      </div>
      <button type="button" class="ghost-btn pipeline-close-btn" data-close-pipeline-detail aria-label="收起阶段详情">收起</button>
    </div>
    <div class="pipeline-detail-body">${body}</div>`;
}
