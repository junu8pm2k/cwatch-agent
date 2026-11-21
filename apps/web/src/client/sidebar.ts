import type { RunSnapshot } from '@cwatch/core/types/runs';
import { $, escapeHtml, formatShortDate, isActiveRun, state, statusNames, statusTone, taskTitle } from './state.ts';

function matchesHistory(run: RunSnapshot, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return taskTitle(run.task).toLowerCase().includes(needle) || (statusNames[run.status] ?? '').toLowerCase().includes(needle);
}

export function renderSidebar(): void {
  const maxSlots = state.bootstrap?.maxConcurrentRuns ?? 2;
  const activeCount = state.runs.filter(isActiveRun).length;
  const capacity = $('capacity-meter');
  // Quiet by default — only surface capacity pill when slots are full so the sidebar stays serene.
  if (activeCount >= maxSlots) {
    capacity.hidden = false;
    capacity.textContent = `并发已满 (${activeCount}/${maxSlots}) · 请先结束或取消进行中的任务`;
  } else {
    capacity.hidden = true;
    capacity.textContent = '';
  }

  $('history-count').textContent = String(state.runs.length);

  // Keep sidebar serene when empty; reveal quiet search input as soon as history exists
  const searchWrap = $('history-search-wrap');
  searchWrap.hidden = state.runs.length === 0 && !state.historyQuery;

  const filtered = state.runs.filter(run => matchesHistory(run, state.historyQuery.trim()));
  const list = $('history-list');
  if (!state.runs.length) {
    list.innerHTML = '<p class="sidebar-empty">暂无任务记录</p>';
  } else if (!filtered.length) {
    list.innerHTML = '<p class="sidebar-empty">没有匹配的记录</p>';
  } else {
    list.innerHTML = filtered.map(run => {
      const selected = state.current?.id === run.id;
      const tone = statusTone(run.status);
      const active = isActiveRun(run);
      const deleting = state.deletingRunIds.has(run.id);
      return `<div class="history-row ${selected ? 'active' : ''}">
        <button type="button" class="history-item ${selected ? 'active' : ''}" data-run="${escapeHtml(run.id)}" ${selected ? 'aria-current="true"' : ''}>
          <span class="status-dot tone-${tone} ${active && run.status !== 'awaiting_user' ? 'pulse' : ''}" aria-hidden="true"></span>
          <span class="history-title">${escapeHtml(taskTitle(run.task))}</span>
          <span class="history-date">${escapeHtml(formatShortDate(run.createdAt))}</span>
        </button>
        ${!active ? `<button type="button" class="history-delete" data-delete-run="${escapeHtml(run.id)}" aria-label="删除任务 ${escapeHtml(taskTitle(run.task))}" title="删除任务记录" ${deleting ? 'disabled' : ''}>×</button>` : ''}
      </div>`;
    }).join('');
  }

  const select = $<HTMLSelectElement>('history-select');
  select.innerHTML = '<option value="">新建任务</option>'
    + state.runs.map(run => `<option value="${escapeHtml(run.id)}">${escapeHtml(taskTitle(run.task))} · ${escapeHtml(statusNames[run.status])}</option>`).join('');
  select.value = state.current?.id ?? '';
}
