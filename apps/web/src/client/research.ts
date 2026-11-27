import { fetchReviewApi } from './api.ts';
import { renderMarkdown } from './markdown.ts';
import { $, alertError, escapeHtml, isInvestigation, state, statusNames, statusTone, taskTitle } from './state.ts';

const reportDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const savedTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const selected = new Set<string>();
const comparisonLimit = 4;
let comparisonRequest = 0;
const savedRuns = () => state.runs.filter(run => run.reportReady && run.reportReview?.savedAt && isInvestigation(run.task));

function savedClaims(markdown: string): string[] {
  const section = markdown.split(/^##\s+/m).find(part => part.startsWith('结构化主张')) ?? '';
  const claims = [...section.matchAll(/^- \*\*claim-[^*\n]+\*\* ([^\n]+)$/gm)]
    .map(match => match[1].replace(/\s+（事件 .*）$/, '').replace(/\s+/g, ' ').trim());
  return [...new Set(claims)];
}

export function closeComparison(): void {
  comparisonRequest++;
  $('research-comparison').hidden = true;
}

function renderSelection(): void {
  const valid = new Set(savedRuns().map(run => run.id));
  for (const id of selected) if (!valid.has(id)) selected.delete(id);
  $('research-compare-tools').hidden = valid.size < 2;
  $('compare-count').textContent = `已选 ${selected.size} 份（可选 2–${comparisonLimit} 份）`;
  $<HTMLButtonElement>('compare-reports').disabled = selected.size < 2;
  for (const checkbox of $('research-list').querySelectorAll<HTMLInputElement>('[data-compare-report]')) {
    checkbox.checked = selected.has(checkbox.dataset.compareReport!);
    checkbox.disabled = selected.size >= comparisonLimit && !checkbox.checked;
  }
}

export function bindResearchComparison(): void {
  $('research-list').addEventListener('change', event => {
    const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>('[data-compare-report]');
    const runId = checkbox?.dataset.compareReport;
    if (!checkbox || !runId) return;
    if (checkbox.checked && selected.size < comparisonLimit) selected.add(runId);
    if (!checkbox.checked) selected.delete(runId);
    renderSelection();
  });
  $('compare-reports').addEventListener('click', () => {
    const reports = savedRuns().filter(run => selected.has(run.id));
    if (reports.length < 2) return;
    const request = ++comparisonRequest;
    const host = $('comparison-content');
    $('research-comparison').hidden = false;
    host.textContent = '正在读取已保存的报告…';
    $('comparison-title').focus();
    void Promise.all(reports.map(async run => ({ run, report: await fetchReviewApi(run.id, true) }))).then(items => {
      if (request !== comparisonRequest) return;
      const claims = items.map(item => savedClaims(item.report.markdown));
      const shared = claims[0].filter(claim => claims.every(list => list.includes(claim)));
      const paragraph = shared.length ? `<details class="shared-findings" open><summary>各报告共同列出的主张（${shared.length}）</summary><ul>${shared.map(claim => `<li>${escapeHtml(claim)}</li>`).join('')}</ul></details>` : '';
      host.innerHTML = `${paragraph}<div class="comparison-grid" tabindex="0" aria-label="并排报告">${items.map(({ run, report }, index) => {
        const task = run.task;
        const window = isInvestigation(task) ? `${task.window.start.slice(0, 10)} 至 ${task.window.end.slice(0, 10)}（不含）` : '';
        const unique = claims[index].filter(claim => !claims.some((other, comparisonIndex) => comparisonIndex !== index && other.includes(claim)));
        return `<article class="comparison-report"><header><h4>${escapeHtml(taskTitle(task))}</h4><p>${escapeHtml(window)}</p><p>保存于 ${escapeHtml(savedTime.format(new Date(report.savedAt!)))}${report.annotations.length ? ` · ${report.annotations.length} 条标注` : ''}</p></header>
          ${unique.length ? `<details class="shared-findings"><summary>仅本报告列出的主张（${unique.length}）</summary><ul>${unique.map(claim => `<li>${escapeHtml(claim)}</li>`).join('')}</ul></details>` : ''}
          <div class="md-body">${renderMarkdown(report.markdown)}</div>
          ${report.annotations.length ? `<details><summary>标注与校订（${report.annotations.length}）</summary><ul>${report.annotations.map(note => `<li>${escapeHtml(note.note)}</li>`).join('')}</ul></details>` : ''}</article>`;
      }).join('')}</div>`;
    }).catch(error => { if (request === comparisonRequest) { closeComparison(); alertError(error); } });
  });
  $('close-comparison').addEventListener('click', () => { closeComparison(); $('compare-reports').focus(); });
}

export function renderResearch(): void {
  const query = $<HTMLInputElement>('research-search').value.trim().toLowerCase();
  const mode = $<HTMLSelectElement>('research-mode').value;
  const terms = query.split(/\s+/).filter(Boolean);
  const archive = savedRuns();
  const matches = archive.filter(run => {
    const task = run.task;
    const domain = isInvestigation(task);
    const title = (domain ? `${task.competitor.name} ${task.product}` : task.instruction).toLowerCase();
    return (mode === 'all' || mode === run.mode)
      && terms.every(term => title.includes(term));
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const total = archive.length;
  const empty = matches.length === 0;
  $('research-filters').hidden = total === 0;
  const count = $('research-count');
  count.hidden = total === 0;
  const countText = matches.length === total
    ? `${total} 份报告`
    : `找到 ${matches.length} 份，共 ${total} 份报告`;
  if (count.textContent !== countText) count.textContent = countText;

  const list = $('research-list');
  list.hidden = empty;
  list.innerHTML = matches.map(run => {
    const task = run.task;
    const domain = isInvestigation(task);
    const title = domain ? task.product : taskTitle(task);
    const date = run.reportReview!.savedAt!;
    return `
    <li>
      <input class="compare-checkbox" type="checkbox" data-compare-report="${escapeHtml(run.id)}" aria-label="选择报告 ${escapeHtml(taskTitle(task))} 进行对比">
      <button type="button" class="research-entry" data-research-run="${escapeHtml(run.id)}">
        <span class="research-entry-main">
          <strong>${escapeHtml(title)}</strong>
          ${domain ? `<span class="research-entry-detail">
            ${task.competitor.name === task.product ? '' : `<span>${escapeHtml(task.competitor.name)}</span>`}
            <span>调查范围 ${escapeHtml(task.window.start.slice(0, 10))} 至 ${escapeHtml(task.window.end.slice(0, 10))}（不含）</span>
          </span>` : ''}
        </span>
        <span class="research-entry-meta">
          <span class="research-mode">${run.mode === 'replay' ? '离线演示' : '真实调查'}</span>
          <span class="status-chip tone-${statusTone(run.status)}">${escapeHtml(statusNames[run.status])}</span>
          <time datetime="${escapeHtml(date)}">${escapeHtml(reportDate.format(new Date(date)))}</time>
        </span>
        <span class="research-open">打开报告</span>
      </button>
      <button type="button" class="button ghost sm research-delete" data-delete-run="${escapeHtml(run.id)}" aria-label="删除调查 ${escapeHtml(taskTitle(task))}" ${state.deletingRunIds.has(run.id) ? 'disabled' : ''}>删除</button>
    </li>`;
  }).join('');
  renderSelection();

  $('research-empty').hidden = !empty;
  if (empty) {
    $('research-empty-title').textContent = total === 0 ? '还没有调查' : '没有符合条件的调查';
    $('research-empty-note').textContent = total === 0
      ? '在左侧打开一个调研会话，检查草稿后点击「保存到我的调研」。'
      : '试试其他关键词，或调整运行方式筛选。';
  }
}
