import type { RunSnapshot } from '@cwatch/core/types/runs';
import { $, escapeHtml, formatShortDate, isActiveRun, isInvestigation, state, statusNames, statusTone, taskTitle, type HistoryFilter } from './state.ts';

function matchesHistory(run: RunSnapshot, query: string, filter: HistoryFilter): boolean {
  if (filter === 'active' && !isActiveRun(run)) return false;
  if (filter === 'done' && !['complete', 'partial'].includes(run.status)) return false;
  if (filter === 'error' && !['failed', 'cancelled', 'unknown'].includes(run.status)) return false;
  if (!query) return true;
  const needle = query.toLowerCase();
  const title = taskTitle(run.task).toLowerCase();
  const status = (statusNames[run.status] ?? '').toLowerCase();
  return title.includes(needle) || status.includes(needle) || run.profile.toLowerCase().includes(needle);
}

function modeBadge(run: RunSnapshot): string {
  if (run.mode === 'replay') return '演示';
  return run.conversation ? '会话' : isInvestigation(run.task) ? '调查' : '任务';
}

export function renderSidebar(): void {
  const maxSlots = state.bootstrap?.maxConcurrentRuns ?? 2;
  const activeCount = state.runs.filter(isActiveRun).length;
  const capacity = $('capacity-meter');
  const full = activeCount >= maxSlots;
  capacity.className = 'capacity-meter' + (full ? ' is-full' : '');
  capacity.innerHTML = `
    <div class="capacity-row">
      <span>活跃任务槽位</span>
      <strong>${activeCount} / ${maxSlots}</strong>
    </div>
    <div class="capacity-bars" aria-hidden="true">
      ${Array.from({ length: maxSlots }, (_, idx) => `<span class="capacity-seg ${idx < activeCount ? (full ? 'warn' : 'active') : ''}"></span>`).join('')}
    </div>
  `;

  $('history-count').textContent = String(state.runs.length);

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-history-filter]')) {
    const active = btn.dataset.historyFilter === state.historyFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  const filtered = state.runs.filter(run => matchesHistory(run, state.historyQuery.trim(), state.historyFilter));
  const list = $('history-list');
  if (!state.runs.length) {
    list.innerHTML = '<p class="sidebar-empty">还没有任务记录</p>';
  } else if (!filtered.length) {
    list.innerHTML = '<p class="sidebar-empty">没有匹配的任务记录</p>';
  } else {
    list.innerHTML = filtered.map(run => {
      const selected = state.current?.id === run.id;
      const tone = statusTone(run.status);
      const active = isActiveRun(run);
      const deleting = state.deletingRunIds.has(run.id);
      return `<div class="history-row ${selected ? 'active' : ''}">
        <button type="button" class="history-item ${selected ? 'active' : ''}" data-run="${escapeHtml(run.id)}" ${selected ? 'aria-current="true"' : ''}>
          <span class="history-title-line">
            <span class="status-dot tone-${tone} ${active && run.status !== 'awaiting_user' ? 'pulse' : ''}" aria-hidden="true"></span>
            <strong>${escapeHtml(taskTitle(run.task))}</strong>
          </span>
          <small>
            <span class="history-meta-left">${escapeHtml(statusNames[run.status])} · <span class="mode-tag">${escapeHtml(modeBadge(run))}</span></span>
            <span>${escapeHtml(formatShortDate(run.createdAt))}</span>
          </small>
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
