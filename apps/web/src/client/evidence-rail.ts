import { $, escapeHtml, isActiveRun, isInvestigation, safeUrl, state } from './state.ts';

/**
 * VerdaAI-inspired companion Evidence & Gaps rail shown exclusively for Competitor Investigations.
 * Kept hidden for Generic Agent conversations so chat remains a calm single-column stream.
 */
export function renderEvidenceRail(): void {
  const rail = $('evidence-rail');
  const run = state.current;
  if (!run || !isInvestigation(run.task)) {
    rail.hidden = true;
    rail.innerHTML = '';
    return;
  }

  rail.hidden = false;
  const evidenceItems: Array<{ index: number; claimId: string; source: string; url: string; title: string; publishedAt: string | null; provenance: string }> = [];
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
          ${evidenceItems.map(item => {
            const url = safeUrl(item.url);
            const glow = state.highlightedClaimId === item.claimId ? ' highlighted' : '';
            return `<div class="evidence-card${glow}" data-evidence-claim="${escapeHtml(item.claimId)}">
              <div class="evidence-card-top">
                <span class="cite-index">[${item.index}]</span>
                <span class="evidence-source">${escapeHtml(item.source)}</span>
                <span class="evidence-date">${escapeHtml(item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('zh-CN') : '时间未知')}</span>
              </div>
              <div class="evidence-card-title">
                ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>` : `<span>${escapeHtml(item.title)}</span>`}
              </div>
              ${item.provenance === 'fixture' ? '<span class="evidence-tag">合成快照</span>' : ''}
            </div>`;
          }).join('')}
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
