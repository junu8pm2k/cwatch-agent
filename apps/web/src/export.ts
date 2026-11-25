import { isInvestigationTask } from '@cwatch/core/types';
import type { RunClaimEvidence, RunSnapshot, RunStatus } from '@cwatch/core/types/runs';

export const draftExportFormats = ['md', 'html', 'doc', 'csv', 'json'] as const;
export type DraftExportFormat = typeof draftExportFormats[number];

export interface DraftExportResult {
  format: DraftExportFormat;
  contentType: string;
  filename: string;
  contentDisposition: string;
  body: string;
}

const statusLabels: Record<RunStatus, string> = {
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

const reviewLabels: Record<string, string> = {
  accept: '通过 (accept)',
  needs_evidence: '需补充证据 (needs_evidence)',
  reject: '驳回 / 冲突 (reject)',
};

const comparisonLabels: Record<string, string> = {
  new: '新增',
  updated: '已变更',
  unchanged: '保持一致',
};

export function isDraftExportFormat(value: string): value is DraftExportFormat {
  return (draftExportFormats as readonly string[]).includes(value);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function formatDate(iso?: string | null): string {
  if (!iso) return '未知';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 10);
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString('zh-CN', { hour12: false });
}

function extractDomain(ev: RunClaimEvidence): string {
  if (ev.domain?.trim()) return ev.domain.trim().toLowerCase();
  try {
    return new URL(ev.url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function runTitle(run: RunSnapshot): string {
  if (isInvestigationTask(run.task)) {
    return run.task.competitor.name === run.task.product
      ? `${run.task.competitor.name} 调查草稿`
      : `${run.task.competitor.name} · ${run.task.product}`;
  }
  const single = run.task.instruction.replace(/\s+/g, ' ').trim();
  return single.length > 60 ? single.slice(0, 60) + '…' : single || 'Cwatch 草稿';
}

function collectEvidence(run: RunSnapshot): {
  unique: RunClaimEvidence[];
  domains: string[];
  verifiedCount: number;
} {
  const map = new Map<string, RunClaimEvidence>();
  const domains = new Set<string>();
  for (const claim of run.claims) {
    for (const ev of claim.evidence) {
      const key = ev.snapshotHash ? `${ev.url}|${ev.snapshotHash}` : `${ev.source}|${ev.url}|${ev.title}`;
      if (!map.has(key)) map.set(key, ev);
      const host = extractDomain(ev);
      if (host) domains.add(host);
    }
  }
  const unique = [...map.values()];
  return {
    unique,
    domains: [...domains].sort(),
    verifiedCount: unique.filter(ev => ev.snapshotVerified).length,
  };
}

function reviewSummaryText(run: RunSnapshot): string {
  if (run.review) return reviewLabels[run.review.decision] ?? run.review.decision;
  if (run.status === 'complete' && run.gaps.length === 0) return '规则核验通过';
  if (run.status === 'partial' || run.gaps.length > 0) return '存在信息缺口';
  return statusLabels[run.status];
}

function formatInlineMarkdown(raw: string): string {
  const codeTokens: string[] = [];
  const withCode = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  const linkTokens: string[] = [];
  const withLinks = withCode.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = safeUrl(href);
    const token = `\u0000LINK${linkTokens.length}\u0000`;
    linkTokens.push(
      safe
        ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${formatEmphasis(escapeHtml(label))}</a>`
        : escapeHtml(label),
    );
    return token;
  });

  let html = formatEmphasis(escapeHtml(withLinks));
  html = html.replace(/\u0000LINK(\d+)\u0000/g, (_m, idx: string) => linkTokens[Number(idx)] ?? '');
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeTokens[Number(idx)] ?? '');
  return html;
}

function formatEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** XSS-safe Markdown-to-HTML renderer (zero raw HTML passthrough, strict URL protocol allowlist). */
function renderMarkdownSafe(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line.trim());
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(4, Math.max(1, heading[1].length));
      out.push(`<h${level}>${formatInlineMarkdown(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${quoteLines.map(q => q.trim() ? `<p>${formatInlineMarkdown(q)}</p>` : '').join('')}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map(h => `<th>${formatInlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows.map(row => `<tr>${headers.map((_h, idx) => `<td>${formatInlineMarkdown(row[idx] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map(item => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map(item => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) out.push(`<p>${paraLines.map(formatInlineMarkdown).join('<br>')}</p>`);
  }

  return out.join('\n');
}

function buildFilename(run: RunSnapshot, ext: DraftExportFormat): { ascii: string; utf8: string; header: string } {
  const date = (run.endedAt ?? run.createdAt).slice(0, 10);
  const rawBase = isInvestigationTask(run.task)
    ? `${run.task.competitor.name}-${run.task.product}`
    : 'cwatch-draft';
  const asciiSlug = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'report';
  const safeUtf8Base = rawBase
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'cwatch-draft';
  const ascii = `cwatch-${asciiSlug}-${date}.${ext}`;
  const utf8 = `${safeUtf8Base}-${date}.${ext}`;
  const header = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
  return { ascii, utf8, header };
}

function buildMarkdown(run: RunSnapshot, reportMarkdown: string): string {
  const title = runTitle(run);
  const stats = collectEvidence(run);
  const lines: string[] = [
    `# ${title}`,
    '',
    '## 调研概要',
    '',
    `- **状态**：${statusLabels[run.status]}（${run.mode === 'replay' ? '离线演示 · 合成快照' : '真实调查 · 本地草稿'}）`,
    `- **生成时间**：${formatDateTime(run.endedAt ?? run.updatedAt)}`,
    ...(isInvestigationTask(run.task)
      ? [
          `- **调查对象**：${run.task.competitor.name} / ${run.task.product}`,
          `- **时间范围**：${run.task.window.start.slice(0, 10)} 至 ${run.task.window.end.slice(0, 10)}（不含，${run.task.window.timezone}）`,
          `- **限定域名**：${run.task.competitor.domains.includes('*') ? '公开网页（不限域名）' : run.task.competitor.domains.join('、')}`,
        ]
      : []),
    ...(run.model?.id ? [`- **使用模型**：${run.model.provider ? `${run.model.provider} / ` : ''}${run.model.id}`] : []),
    `- **审阅结论**：${reviewSummaryText(run)}`,
    `- **核验指标**：核验主张 ${run.claims.length} 项 · 证据快照 ${stats.unique.length} 份（已验哈希 ${stats.verifiedCount} 份）· 独立域名 ${stats.domains.length} 个 · 信息缺口 ${run.gaps.length} 项`,
    '',
    '---',
    '',
    reportMarkdown.trim(),
  ];

  if (run.claims.length) {
    lines.push('', '---', '', '## 核验主张与引用来源', '');
    let citeSeq = 1;
    run.claims.forEach((claim, idx) => {
      lines.push(`${idx + 1}. ${claim.text}`);
      for (const ev of claim.evidence) {
        const safe = safeUrl(ev.url);
        const link = safe ? `[${ev.source} · ${ev.title}](${safe})` : `${ev.source} · ${ev.title}`;
        const dateNote = ev.publishedAt ? formatDate(ev.publishedAt) : '发布时间未知';
        const hashNote = ev.snapshotHash ? ` · SHA-256 ${ev.snapshotHash.slice(0, 12)}${ev.snapshotVerified ? ' (已核验)' : ''}` : '';
        lines.push(`   - [${citeSeq++}] ${link}（${dateNote}${ev.provenance === 'fixture' ? ' · 合成快照' : ''}${hashNote}）`);
      }
    });
  }

  if (run.gaps.length) {
    lines.push('', '## 信息缺口与待核验项', '');
    for (const gap of run.gaps) lines.push(`- ${gap}`);
  }

  lines.push('', '---', '', '> 本草稿由 Cwatch 本地调查工作台生成，引用链接与结论请人工核验。', '');
  return lines.join('\n');
}

function buildRichDocumentBody(run: RunSnapshot, reportMarkdown: string, forWord: boolean): string {
  const title = runTitle(run);
  const stats = collectEvidence(run);
  const reviewText = reviewSummaryText(run);
  const modeBadge = run.mode === 'replay' ? '离线演示 · 合成快照' : '真实调查 · 本地草稿';

  const metaRows: Array<[string, string]> = [
    ['任务状态', `${statusLabels[run.status]}（${modeBadge}）`],
    ['生成时间', formatDateTime(run.endedAt ?? run.updatedAt)],
    ...(isInvestigationTask(run.task)
      ? [
          ['调查对象', `${run.task.competitor.name} / ${run.task.product}`] as [string, string],
          ['时间范围', `${run.task.window.start.slice(0, 10)} 至 ${run.task.window.end.slice(0, 10)}（不含）`] as [string, string],
          ['搜索范围', run.task.competitor.domains.includes('*') ? '公开 HTTPS 网页' : run.task.competitor.domains.join('、')] as [string, string],
        ]
      : []),
    ...(run.model?.id ? [['使用模型', `${run.model.provider ? `${run.model.provider} / ` : ''}${run.model.id}`] as [string, string]] : []),
  ];

  const metricsHtml = forWord
    ? `<table class="metrics-table">
        <tr>
          <td><div class="m-label">核验主张</div><div class="m-val">${run.claims.length}</div></td>
          <td><div class="m-label">证据快照</div><div class="m-val">${stats.unique.length}</div><div class="m-sub">已验哈希 ${stats.verifiedCount}</div></td>
          <td><div class="m-label">独立域名</div><div class="m-val">${stats.domains.length}</div></td>
          <td><div class="m-label">审阅与缺口</div><div class="m-val m-sm">${escapeHtml(reviewText)}</div><div class="m-sub">缺口 ${run.gaps.length} 项</div></td>
        </tr>
      </table>`
    : `<div class="metrics-grid">
        <div class="metric-card"><span class="m-label">核验主张</span><strong class="m-val">${run.claims.length}</strong><span class="m-sub">结构化结论条目</span></div>
        <div class="metric-card"><span class="m-label">证据快照</span><strong class="m-val">${stats.unique.length}</strong><span class="m-sub">已验哈希 ${stats.verifiedCount} 份</span></div>
        <div class="metric-card"><span class="m-label">独立域名</span><strong class="m-val">${stats.domains.length}</strong><span class="m-sub">${escapeHtml(stats.domains.slice(0, 2).join(' · ') || '暂无外部域名')}</span></div>
        <div class="metric-card"><span class="m-label">审阅与缺口</span><strong class="m-val m-sm">${escapeHtml(reviewText)}</strong><span class="m-sub">信息缺口 ${run.gaps.length} 项</span></div>
      </div>`;

  const reviewHtml = run.review
    ? `<section class="box review-box">
        <h3>审阅质检门禁：${escapeHtml(reviewText)}</h3>
        ${run.review.issues.length
          ? `<ul>${run.review.issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
          : '<p>规则核验通过，未发现主张与证据冲突。</p>'}
      </section>`
    : '';

  const comparisonsHtml = run.comparisons?.length
    ? `<section class="section">
        <h2>历史事实版本演进</h2>
        <table>
          <thead><tr><th>变更状态</th><th>事件</th><th>类型</th><th>版本演进</th></tr></thead>
          <tbody>${run.comparisons.map(item => `<tr>
            <td>${escapeHtml(comparisonLabels[item.status] ?? item.status)}</td>
            <td>${escapeHtml(item.title?.trim() || item.eventId)}</td>
            <td>${escapeHtml(item.signalType ?? '—')}</td>
            <td>${item.previousVersions.length} → ${item.currentVersions.length}</td>
          </tr>`).join('')}</tbody>
        </table>
      </section>`
    : '';

  let citeSeq = 1;
  const claimsHtml = run.claims.length
    ? `<section class="section">
        <h2>调查结论与引用</h2>
        ${run.claims.map((claim, idx) => `<div class="claim-card">
          <p class="claim-text"><strong>${idx + 1}.</strong> ${escapeHtml(claim.text)}</p>
          <ul class="cite-list">${claim.evidence.map(ev => {
            const safe = safeUrl(ev.url);
            const label = `${ev.source} · ${ev.title}`;
            return `<li><span class="cite-num">[${citeSeq++}]</span> ${safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label)} <span class="muted">（${escapeHtml(formatDate(ev.publishedAt))}${ev.provenance === 'fixture' ? ' · 合成快照' : ''}）</span></li>`;
          }).join('')}</ul>
        </div>`).join('')}
      </section>`
    : '';

  const evidenceTableHtml = stats.unique.length
    ? `<section class="section">
        <h2>引用证据明细</h2>
        <table>
          <thead><tr><th>来源</th><th>标题与链接</th><th>发布日期</th><th>快照核验</th></tr></thead>
          <tbody>${stats.unique.map(ev => {
            const safe = safeUrl(ev.url);
            const host = extractDomain(ev);
            const verify = ev.snapshotVerified === true ? '已核验' : ev.snapshotVerified === false ? '快照异常' : '—';
            const hashPart = ev.snapshotHash ? ` (${ev.snapshotHash.slice(0, 8)})` : '';
            return `<tr>
              <td>${escapeHtml(ev.source)}${host ? `<br><span class="muted">${escapeHtml(host)}</span>` : ''}</td>
              <td>${safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ev.title)}</a>` : escapeHtml(ev.title)}${ev.excerpt ? `<div class="excerpt">${escapeHtml(ev.excerpt)}</div>` : ''}</td>
              <td>${escapeHtml(formatDate(ev.publishedAt))}</td>
              <td>${escapeHtml(verify + hashPart)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </section>`
    : '';

  const gapsHtml = run.gaps.length
    ? `<section class="section">
        <h2>信息缺口与待核验项</h2>
        <ul>${run.gaps.map(gap => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>
      </section>`
    : '';

  return `
    <header class="doc-header">
      <div class="doc-kicker">Cwatch 调查草稿 · ${escapeHtml(modeBadge)}</div>
      <h1>${escapeHtml(title)}</h1>
      <table class="meta-table">
        <tbody>${metaRows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody>
      </table>
    </header>
    ${metricsHtml}
    ${reviewHtml}
    ${comparisonsHtml}
    ${claimsHtml}
    <section class="section report-body">
      <h2>完整调查报告正文</h2>
      ${renderMarkdownSafe(reportMarkdown)}
    </section>
    ${evidenceTableHtml}
    ${gapsHtml}
    <footer class="doc-footer">本草稿由 Cwatch 本地调查工作台导出（${escapeHtml(formatDateTime(new Date().toISOString()))}），来源与结论请人工核验。</footer>
  `;
}

function buildHtmlDocument(run: RunSnapshot, reportMarkdown: string): string {
  const title = runTitle(run);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · Cwatch 调查草稿</title>
  <style>
    :root { --bg: #f6f8f9; --surface: #ffffff; --ink: #172f3c; --ink-2: #465d6b; --ink-3: #647986; --line: #d8e2e7; --accent: #166d62; --accent-soft: #e6f3ef; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 20px 56px; background: var(--bg); color: var(--ink); font-family: 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif; font-size: 14.5px; line-height: 1.7; }
    .container { max-width: 920px; margin: 0 auto; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 34px 38px; box-shadow: 0 8px 28px rgba(23,47,60,0.06); }
    a { color: var(--accent); text-decoration: none; word-break: break-all; }
    a:hover { text-decoration: underline; }
    .doc-kicker { display: inline-block; padding: 3px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; margin-bottom: 10px; }
    .doc-header h1 { margin: 0 0 16px; font-size: 26px; line-height: 1.3; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 22px; font-size: 13px; }
    .meta-table th, .meta-table td { padding: 7px 11px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
    .meta-table th { width: 120px; background: #f4f7f8; color: var(--ink-2); font-weight: 600; }
    .metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 18px 0 24px; }
    .metric-card { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fafcfc; display: flex; flex-direction: column; gap: 3px; }
    .m-label { font-size: 11.5px; color: var(--ink-3); font-weight: 600; }
    .m-val { font-size: 22px; font-weight: 700; color: var(--ink); line-height: 1.25; }
    .m-val.m-sm { font-size: 15px; line-height: 1.5; }
    .m-sub { font-size: 11.5px; color: var(--ink-3); }
    .box { padding: 14px 16px; border-radius: 10px; border: 1px solid var(--line); background: #f8fbfa; margin-bottom: 22px; }
    .box h3 { margin: 0 0 8px; font-size: 14.5px; color: var(--accent); }
    .box p, .box ul { margin: 0; }
    .section { margin-top: 26px; padding-top: 20px; border-top: 1px solid var(--line); }
    .section h2 { margin: 0 0 14px; font-size: 18px; color: var(--ink); }
    .claim-card { padding: 12px 15px; border-radius: 10px; border: 1px solid var(--line); background: #fafcfd; margin-bottom: 10px; }
    .claim-text { margin: 0 0 8px; }
    .cite-list { margin: 0; padding-left: 18px; font-size: 13px; }
    .cite-num { font-family: ui-monospace, Consolas, monospace; color: var(--accent); font-weight: 600; }
    .muted { color: var(--ink-3); font-size: 12.5px; }
    .excerpt { margin-top: 5px; padding: 6px 9px; border-left: 3px solid #a7cfc4; background: #f4f8f7; color: var(--ink-2); font-size: 12.5px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
    th, td { padding: 8px 11px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #f3f6f7; font-weight: 600; color: var(--ink-2); }
    pre { padding: 12px 14px; border-radius: 8px; background: #f4f6f5; border: 1px solid var(--line); overflow-x: auto; font-size: 12.5px; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; background: #f1f4f4; padding: 1px 4px; border-radius: 4px; }
    pre code { background: transparent; padding: 0; }
    blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid #a7cfc4; background: #f4f8f7; color: var(--ink-2); }
    .doc-footer { margin-top: 30px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-3); }
    @media (max-width: 680px) { .container { padding: 20px 18px; } .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media print { body { background: #fff; padding: 0; } .container { border: 0; box-shadow: none; padding: 0; } }
  </style>
</head>
<body>
  <main class="container">
    ${buildRichDocumentBody(run, reportMarkdown, false)}
  </main>
</body>
</html>
`;
}

function buildWordDocument(run: RunSnapshot, reportMarkdown: string): string {
  const title = runTitle(run);
  return `\uFEFF<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40" lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 2cm; }
    body { font-family: 'Microsoft YaHei', 'PingFang SC', 'Calibri', sans-serif; font-size: 10.5pt; line-height: 1.65; color: #172f3c; }
    h1 { font-size: 18pt; color: #123342; margin: 6pt 0 12pt; }
    h2 { font-size: 13.5pt; color: #166d62; margin: 16pt 0 8pt; border-bottom: 1pt solid #cfd9de; padding-bottom: 3pt; }
    h3 { font-size: 11.5pt; color: #172f3c; margin: 12pt 0 6pt; }
    p { margin: 5pt 0; }
    a { color: #166d62; text-decoration: underline; }
    .doc-kicker { font-size: 9pt; color: #166d62; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 9.5pt; }
    th, td { border: 1pt solid #cfd9de; padding: 5pt 7pt; text-align: left; vertical-align: top; }
    th { background: #f0f5f6; font-weight: bold; color: #364f5e; }
    .meta-table th { width: 22%; }
    .metrics-table td { width: 25%; background: #f8fbfb; }
    .m-label { font-size: 8.5pt; color: #5a707e; }
    .m-val { font-size: 14pt; font-weight: bold; color: #123342; margin: 2pt 0; }
    .m-val.m-sm { font-size: 10.5pt; }
    .m-sub { font-size: 8.5pt; color: #5a707e; }
    .box { border: 1pt solid #b8d3cb; background: #f4faf8; padding: 8pt 10pt; margin: 10pt 0; }
    .claim-card { border: 1pt solid #d8e2e7; background: #fafcfd; padding: 8pt 10pt; margin: 6pt 0; }
    .cite-num { color: #166d62; font-weight: bold; }
    .muted { color: #5a707e; font-size: 9pt; }
    .excerpt { margin-top: 4pt; padding: 4pt 7pt; border-left: 2pt solid #166d62; background: #f4f8f7; color: #405968; font-size: 9pt; }
    pre { background: #f4f6f5; border: 1pt solid #d8e2e7; padding: 7pt; font-family: Consolas, monospace; font-size: 9pt; white-space: pre-wrap; }
    code { font-family: Consolas, monospace; font-size: 9.5pt; }
    blockquote { margin: 8pt 0; padding: 6pt 10pt; border-left: 3pt solid #166d62; background: #f4f8f7; color: #405968; }
    .doc-footer { margin-top: 18pt; padding-top: 8pt; border-top: 1pt solid #d8e2e7; font-size: 8.5pt; color: #5a707e; }
  </style>
</head>
<body>
  ${buildRichDocumentBody(run, reportMarkdown, true)}
</body>
</html>
`;
}

function csvCell(raw: unknown): string {
  let value = String(raw ?? '').replace(/\r\n/g, '\n');
  // Neutralize spreadsheet formula injection (=, +, -, @, tab, CR)
  if (/^[=+\-@\t\r]/.test(value)) value = "'" + value;
  if (/[",\n\r]/.test(value)) value = '"' + value.replace(/"/g, '""') + '"';
  return value;
}

function buildCsv(run: RunSnapshot): string {
  const headers = [
    '主张编号', '主张内容', '来源', '域名', '标题', '链接', '发布时间', '采集时间',
    '来源性质', '归因判定', '时间窗判定', '快照核验', '快照哈希', '原文摘录',
  ];
  const rows: string[][] = [headers];
  for (const claim of run.claims) {
    if (!claim.evidence.length) {
      rows.push([claim.id, claim.text, '', '', '', '', '', '', '', '', '', '', '', '']);
      continue;
    }
    for (const ev of claim.evidence) {
      rows.push([
        claim.id,
        claim.text,
        ev.source,
        extractDomain(ev),
        ev.title,
        safeUrl(ev.url) ?? '',
        ev.publishedAt ?? '',
        ev.retrievedAt ?? '',
        ev.provenance === 'fixture' ? '合成快照' : '实采来源',
        ev.attribution ?? '',
        ev.timeStatus ?? '',
        ev.snapshotVerified === true ? '已核验' : ev.snapshotVerified === false ? '异常' : '',
        ev.snapshotHash ?? '',
        ev.excerpt ?? '',
      ]);
    }
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function buildJson(run: RunSnapshot, reportMarkdown: string): string {
  const stats = collectEvidence(run);
  return JSON.stringify({
    schemaVersion: 'cwatch.draft-export.v1',
    exportedAt: new Date().toISOString(),
    run: {
      id: run.id,
      profile: run.profile,
      mode: run.mode,
      permission: run.permission,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      endedAt: run.endedAt,
      model: run.model,
      toolCalls: run.toolCalls,
      modelTurns: run.modelTurns,
      totalTokens: run.totalTokens,
      reworkCount: run.reworkCount ?? 0,
    },
    task: run.task,
    metrics: {
      claimsCount: run.claims.length,
      evidenceCount: stats.unique.length,
      verifiedSnapshots: stats.verifiedCount,
      domains: stats.domains,
      gapsCount: run.gaps.length,
    },
    plan: run.plan,
    review: run.review,
    comparisons: run.comparisons,
    claims: run.claims,
    gaps: run.gaps,
    reportMarkdown,
  }, null, 2) + '\n';
}

export function buildDraftExport(run: RunSnapshot, reportMarkdown: string, format: DraftExportFormat): DraftExportResult {
  const name = buildFilename(run, format);
  if (format === 'md') {
    return { format, contentType: 'text/markdown; charset=utf-8', filename: name.utf8, contentDisposition: name.header, body: buildMarkdown(run, reportMarkdown) };
  }
  if (format === 'html') {
    return { format, contentType: 'text/html; charset=utf-8', filename: name.utf8, contentDisposition: name.header, body: buildHtmlDocument(run, reportMarkdown) };
  }
  if (format === 'doc') {
    return { format, contentType: 'application/msword; charset=utf-8', filename: name.utf8, contentDisposition: name.header, body: buildWordDocument(run, reportMarkdown) };
  }
  if (format === 'csv') {
    return { format, contentType: 'text/csv; charset=utf-8', filename: name.utf8, contentDisposition: name.header, body: buildCsv(run) };
  }
  return { format, contentType: 'application/json; charset=utf-8', filename: name.utf8, contentDisposition: name.header, body: buildJson(run, reportMarkdown) };
}
