import { $, escapeHtml, isActiveRun, isInvestigation, state, statusNames, statusTone, taskTitle } from './state.ts';

const reportDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

export function renderResearch(): void {
  const query = $<HTMLInputElement>('research-search').value.trim().toLowerCase();
  const mode = $<HTMLSelectElement>('research-mode').value;
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = state.runs.filter(run => {
    const task = run.task;
    const domain = isInvestigation(task);
    const title = (domain ? `${task.competitor.name} ${task.product}` : task.instruction).toLowerCase();
    return (mode === 'all' || mode === run.mode)
      && terms.every(term => title.includes(term));
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const total = state.runs.length;
  const empty = matches.length === 0;
  $('research-filters').hidden = total === 0;
  const count = $('research-count');
  count.hidden = total === 0;
  const countText = matches.length === total
    ? `${total} 项调查`
    : `找到 ${matches.length} 项，共 ${total} 项调查`;
  if (count.textContent !== countText) count.textContent = countText;

  const list = $('research-list');
  list.hidden = empty;
  list.innerHTML = matches.map(run => {
    const task = run.task;
    const domain = isInvestigation(task);
    const title = domain ? task.product : taskTitle(task);
    const date = run.endedAt ?? run.createdAt;
    const active = isActiveRun(run);
    return `
    <li>
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
        <span class="research-open">${run.reportReady ? '打开报告' : active ? '打开调查' : '查看详情'}</span>
      </button>
      ${active ? '' : `<button type="button" class="button ghost sm research-delete" data-delete-run="${escapeHtml(run.id)}" aria-label="删除调查 ${escapeHtml(taskTitle(task))}" ${state.deletingRunIds.has(run.id) ? 'disabled' : ''}>删除</button>`}
    </li>`;
  }).join('');

  $('research-empty').hidden = !empty;
  if (empty) {
    $('research-empty-title').textContent = total === 0 ? '还没有调查' : '没有符合条件的调查';
    $('research-empty-note').textContent = total === 0
      ? '发起一次产品或竞品调查后，报告草稿与引用证据会自动汇总在这里。'
      : '试试其他关键词，或调整运行方式筛选。';
  }
}
