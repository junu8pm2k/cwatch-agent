import type { RunClaimEvidence } from '@cwatch/core/types/runs';
import { $, escapeHtml, isActiveRun, isInvestigation, safeUrl, state } from './state.ts';

interface IndexedEvidence extends RunClaimEvidence {
  index: number;
  claimId: string;
}

const expandedEvidenceKeys = new Set<string>();
let lastRunId: string | undefined;
let railEventsBound = false;

function bindEvidenceRailEvents(rail: HTMLElement): void {
  if (railEventsBound) return;
  railEventsBound = true;

  // Prevent clicking/selecting metadata text inside an expanded panel from toggling claim highlight.
  rail.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.evidence-detail-panel') && !target.closest('a, button')) {
      event.stopPropagation();
    }
  }, true);

  // One-time delegated toggle for per-card snapshot metadata drawer.
  // Because the trigger is a <button>, client.ts ignores it and does not toggle claim highlight.
  rail.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const toggleBtn = target?.closest<HTMLButtonElement>('.evidence-detail-toggle[data-evidence-toggle]');
    if (!toggleBtn) return;
    const key = toggleBtn.dataset.evidenceToggle;
    if (!key) return;

    const nextExpanded = !expandedEvidenceKeys.has(key);
    if (nextExpanded) expandedEvidenceKeys.add(key);
    else expandedEvidenceKeys.delete(key);

    toggleBtn.setAttribute('aria-expanded', String(nextExpanded));
    const label = toggleBtn.querySelector('.evidence-detail-toggle-label');
    if (label) label.textContent = nextExpanded ? '收起快照元数据' : '原始快照元数据与完整摘录';
    const chevron = toggleBtn.querySelector('.evidence-detail-chevron');
    if (chevron) chevron.textContent = nextExpanded ? '▴' : '▾';

    const panelId = toggleBtn.getAttribute('aria-controls');
    if (panelId) {
      const panel = document.getElementById(panelId);
      if (panel) panel.hidden = !nextExpanded;
    }
  });
}

function resolveDomain(ev: RunClaimEvidence, verifiedUrl?: string): string | undefined {
  const explicit = typeof ev.domain === 'string' ? ev.domain.trim() : '';
  if (explicit) return explicit;
  if (!verifiedUrl) return undefined;
  try {
    return new URL(verifiedUrl).hostname;
  } catch {
    return undefined;
  }
}

function formatPublishedLabel(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.trim()) return '未知';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '未知';
  return new Date(ms).toLocaleDateString('zh-CN');
}

function formatRetrievedLabel(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value.trim();
  return new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function provenanceMeta(provenance: string): { label: string; tone: string } | undefined {
  if (provenance === 'fixture') return { label: '合成快照', tone: 'fixture' };
  if (provenance === 'live') return { label: '实采来源', tone: 'live' };
  return undefined;
}

function attributionMeta(value: RunClaimEvidence['attribution']): { label: string; tone: string } | undefined {
  if (!value) return undefined;
  if (value === 'matched') return { label: '实体已匹配', tone: 'ok' };
  if (value === 'ambiguous') return { label: '归属待确认', tone: 'warn' };
  if (value === 'wrong_entity') return { label: '实体不匹配', tone: 'error' };
  return { label: String(value), tone: 'neutral' };
}

function timeStatusMeta(value: RunClaimEvidence['timeStatus']): { label: string; tone: string } | undefined {
  if (!value) return undefined;
  if (value === 'in_window') return { label: '时间窗内', tone: 'ok' };
  if (value === 'out_of_window') return { label: '超出时间窗', tone: 'warn' };
  if (value === 'unknown_time') return { label: '发布时间未知', tone: 'neutral' };
  return { label: String(value), tone: 'neutral' };
}

function renderEvidenceCard(item: IndexedEvidence, runId: string): string {
  const url = safeUrl(item.url);
  const domain = resolveDomain(item, url);
  const glow = state.highlightedClaimId === item.claimId ? ' highlighted' : '';
  const excerpt = typeof item.excerpt === 'string' ? item.excerpt.trim() : '';
  const snapshotHash = typeof item.snapshotHash === 'string' ? item.snapshotHash.trim() : '';
  const snapshotFailed = item.snapshotVerified === false;
  const shortHash = snapshotHash ? snapshotHash.slice(0, 8) : '';
  const publishedLabel = formatPublishedLabel(item.publishedAt);
  const retrievedLabel = formatRetrievedLabel(item.retrievedAt);
  const prov = provenanceMeta(item.provenance);
  const attr = attributionMeta(item.attribution);
  const tStatus = timeStatusMeta(item.timeStatus);

  const badges: string[] = [];
  if (prov) {
    badges.push(`<span class="evidence-tag tone-${prov.tone}">${escapeHtml(prov.label)}</span>`);
  }
  if (snapshotHash) {
    badges.push(snapshotFailed
      ? `<span class="evidence-tag evidence-snapshot-badge tone-error" title="快照哈希核验失败">快照异常 · <code class="evidence-short-hash">${escapeHtml(shortHash)}</code></span>`
      : `<span class="evidence-tag evidence-snapshot-badge tone-ok" title="SHA-256 快照完整性已核验">SHA-256 已核验 · <code class="evidence-short-hash">${escapeHtml(shortHash)}</code></span>`);
  }

  const itemKey = `${runId}:${item.index}`;
  const panelId = `evidence-detail-${item.index}`;
  const expanded = expandedEvidenceKeys.has(itemKey);

  return `<div class="evidence-card${glow}" data-evidence-claim="${escapeHtml(item.claimId)}">
    <div class="evidence-card-top">
      <span class="cite-index">[${item.index}]</span>
      <span class="evidence-source">${escapeHtml(item.source)}</span>
      ${domain ? `<span class="evidence-domain" title="${escapeHtml(domain)}">${escapeHtml(domain)}</span>` : ''}
    </div>
    <div class="evidence-card-title">
      ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>` : `<span>${escapeHtml(item.title)}</span>`}
    </div>
    ${excerpt ? `<blockquote class="evidence-excerpt">${escapeHtml(excerpt)}</blockquote>` : ''}
    <div class="evidence-timestamps">
      <span class="evidence-time-item">发布: ${escapeHtml(publishedLabel)}</span>
      ${retrievedLabel ? `<span class="evidence-time-item">采集: ${escapeHtml(retrievedLabel)}</span>` : ''}
    </div>
    ${badges.length ? `<div class="evidence-badges">${badges.join('')}</div>` : ''}
    <div class="evidence-card-footer">
      <button type="button" class="evidence-detail-toggle" data-evidence-toggle="${escapeHtml(itemKey)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${escapeHtml(panelId)}">
        <span class="evidence-detail-toggle-label">${expanded ? '收起快照元数据' : '原始快照元数据与完整摘录'}</span>
        <span class="evidence-detail-chevron" aria-hidden="true">${expanded ? '▴' : '▾'}</span>
      </button>
    </div>
    <div id="${escapeHtml(panelId)}" class="evidence-detail-panel"${expanded ? '' : ' hidden'}>
      ${excerpt ? `<div class="evidence-detail-block"><span class="evidence-detail-label">完整摘录</span><p class="evidence-full-excerpt">${escapeHtml(excerpt)}</p></div>` : ''}
      <dl class="evidence-meta-list">
        ${snapshotHash ? `<div class="evidence-meta-row"><dt>快照哈希 (SHA-256)</dt><dd><code class="evidence-hash-full">${escapeHtml(snapshotHash)}</code><span class="evidence-status-pill tone-${snapshotFailed ? 'error' : 'ok'}">${snapshotFailed ? '快照异常' : 'SHA-256 已核验'}</span></dd></div>` : ''}
        ${attr ? `<div class="evidence-meta-row"><dt>归属状态</dt><dd><span class="evidence-status-pill tone-${attr.tone}">${escapeHtml(attr.label)}</span> <code class="evidence-meta-code">${escapeHtml(item.attribution)}</code></dd></div>` : ''}
        ${tStatus ? `<div class="evidence-meta-row"><dt>时间窗状态</dt><dd><span class="evidence-status-pill tone-${tStatus.tone}">${escapeHtml(tStatus.label)}</span> <code class="evidence-meta-code">${escapeHtml(item.timeStatus)}</code></dd></div>` : ''}
        ${domain ? `<div class="evidence-meta-row"><dt>来源域名</dt><dd class="mono">${escapeHtml(domain)}</dd></div>` : ''}
        <div class="evidence-meta-row"><dt>原始来源链接</dt><dd>${url ? `<a class="evidence-origin-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>` : '<span class="evidence-invalid-url">链接无效或受限</span>'}</dd></div>
      </dl>
    </div>
  </div>`;
}

/**
 * VerdaAI-inspired companion Evidence & Gaps rail shown exclusively for Competitor Investigations.
 * Kept hidden for Generic Agent conversations so chat remains a calm single-column stream.
 */
export function renderEvidenceRail(): void {
  const rail = $('evidence-rail');
  bindEvidenceRailEvents(rail);

  const run = state.current;
  if (!run || !isInvestigation(run.task)) {
    rail.hidden = true;
    rail.innerHTML = '';
    return;
  }

  if (lastRunId !== run.id) {
    expandedEvidenceKeys.clear();
    lastRunId = run.id;
  }

  rail.hidden = false;
  const evidenceItems: IndexedEvidence[] = [];
  let seq = 1;
  for (const claim of run.claims) {
    for (const ev of claim.evidence) {
      evidenceItems.push({ index: seq++, claimId: claim.id, ...ev });
    }
  }

  const evidenceHtml = evidenceItems.length
    ? `<section class="rail-section">
        <div class="rail-section-head">
          <h3>引用证据</h3>
          <span class="rail-badge">${evidenceItems.length}</span>
        </div>
        <div class="evidence-card-list">
          ${evidenceItems.map(item => renderEvidenceCard(item, run.id)).join('')}
        </div>
      </section>`
    : `<section class="rail-section">
        <h3>引用证据</h3>
        <p class="rail-empty">${isActiveRun(run) ? '采集与审阅完成后，已核验的来源证据会汇总在这里。' : '本次运行暂未产出结构化证据卡片，请查看正文报告与缺口说明。'}</p>
      </section>`;

  const gapsHtml = run.gaps.length
    ? `<section class="rail-section">
        <div class="rail-section-head">
          <h3>信息缺口</h3>
          <span class="rail-badge warn">${run.gaps.length}</span>
        </div>
        <ul class="gap-list">${run.gaps.map(g => `<li>${escapeHtml(g)}</li>`).join('')}</ul>
      </section>`
    : '';

  rail.innerHTML = evidenceHtml + gapsHtml;
}
