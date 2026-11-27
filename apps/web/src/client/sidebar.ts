import type { RunSnapshot } from '@cwatch/core/types/runs';
import { createProjectApi, moveRunApi, renameRunApi } from './api.ts';
import { $, alertError, announce, escapeHtml, isActiveRun, sessionTitle, state, statusNames } from './state.ts';

const dragType = 'application/x-cwatch-session';
let dragging = false;
let renderedHistory = '';
let openActionsFor: string | undefined;

function sessionRows(runs: RunSnapshot[]): string {
  return runs.map(run => {
    const title = escapeHtml(sessionTitle(run));
    const id = escapeHtml(run.id);
    const active = isActiveRun(run);
    const expanded = openActionsFor === run.id;
    return `<div class="history-session-row">
      <button type="button" class="history-session" draggable="true" data-session-id="${id}" ${state.current?.id === run.id ? 'aria-current="true"' : ''} title="${title} · ${escapeHtml(statusNames[run.status])}"><span>${title}</span>${active ? '<span class="dot" aria-label="正在运行"></span>' : ''}</button>
      <button type="button" class="history-action-trigger" data-session-actions="${id}" aria-label="会话操作 ${title}" aria-expanded="${expanded}" aria-controls="session-actions-${id}">⋯</button>
      <div class="history-session-actions" id="session-actions-${id}" ${expanded ? '' : 'hidden'}>
        <button type="button" data-rename-session="${id}" aria-label="重命名会话 ${title}">重命名</button>
        <button type="button" data-delete-session="${id}" aria-label="删除会话 ${title}" ${active ? 'title="停止任务后可删除"' : ''} ${active || state.deletingRunIds.has(run.id) ? 'disabled' : ''}>删除</button>
      </div>
    </div>`;
  }).join('');
}

export function renderHistory(): void {
  const unassigned = state.runs.filter(run => !run.projectId);
  const recent = unassigned.length ? `<section data-drop-project="" class="history-standalone" aria-label="历史会话">${sessionRows(unassigned)}</section>` : '';
  const html = recent + state.projects.map(project => {
    const name = escapeHtml(project.name), id = escapeHtml(project.id);
    const rows = sessionRows(state.runs.filter(run => run.projectId === project.id));
    return `<section class="history-group" data-drop-project="${id}" aria-label="项目 ${name}">
      <div class="history-group-head"><h3>${name}</h3><button type="button" class="button ghost sm" data-new-in-project="${id}" aria-label="在 ${name} 中新建会话" title="在此项目中新建会话">+</button></div>${rows || '<p class="history-empty">拖入会话或新建</p>'}</section>`;
  }).join('');
  if (!dragging && html !== renderedHistory) {
    $('history-list').innerHTML = html;
    renderedHistory = html;
  }
}

export function bindHistory(open: (run: RunSnapshot) => void, create: (projectId: string) => void, update: (run: RunSnapshot) => void, requestDelete: (runId: string) => void): void {
  const media = matchMedia('(max-width: 960px)');
  const mount = () => $(media.matches ? 'mobile-history-slot' : 'desktop-history').append($('session-history'));
  media.addEventListener('change', mount);
  mount();

  const form = $<HTMLFormElement>('project-form');
  const name = $<HTMLInputElement>('project-name');
  const add = $('new-project');
  add.addEventListener('click', () => {
    form.hidden = !form.hidden;
    add.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) name.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const button = form.querySelector('button')!;
    if (button.disabled || !name.value.trim()) return;
    button.disabled = true;
    void createProjectApi(name.value.trim()).then(project => {
      state.projects.push(project);
      form.reset(); form.hidden = true; add.setAttribute('aria-expanded', 'false');
      renderHistory(); add.focus(); announce(`已创建项目 ${project.name}`);
    }).catch(alertError).finally(() => { button.disabled = false; });
  });

  async function move(runId: string, projectId: string | null): Promise<void> {
    try {
      update(await moveRunApi(runId, projectId));
      announce(projectId ? '会话已移到项目。' : '会话已移到未归档。');
    } catch (error) { alertError(error); }
    finally { renderHistory(); }
  }

  const list = $('history-list');
  const actionsTrigger = (runId: string) => list.querySelector<HTMLButtonElement>(`[data-session-actions="${CSS.escape(runId)}"]`);
  function toggleActions(runId: string): void {
    openActionsFor = openActionsFor === runId ? undefined : runId;
    renderHistory();
    actionsTrigger(runId)?.focus();
  }

  async function rename(run: RunSnapshot): Promise<void> {
    const previous = sessionTitle(run);
    const title = window.prompt('重命名会话（最多 80 个字符）', previous)?.trim();
    if (title === undefined || title === previous) return;
    if (!title || title.length > 80) { alertError('请输入 1 到 80 个字符的会话名称。'); return; }
    try {
      const renamed = await renameRunApi(run.id, title);
      if (state.runs.some(item => item.id === run.id)) {
        const restoreFocus = document.activeElement === actionsTrigger(run.id);
        update(renamed);
        if (restoreFocus) actionsTrigger(run.id)?.focus();
        announce('会话已重命名。');
      }
    } catch (error) { alertError(error); }
  }

  list.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-session-id], [data-new-in-project], [data-session-actions], [data-rename-session], [data-delete-session]');
    if (!target) return;
    const { sessionId, newInProject, sessionActions, renameSession, deleteSession } = target.dataset;
    if (sessionActions) { toggleActions(sessionActions); return; }
    if (openActionsFor) toggleActions(openActionsFor);
    if (deleteSession) { requestDelete(deleteSession); return; }
    const run = state.runs.find(item => item.id === (renameSession ?? sessionId));
    if (renameSession && run) { void rename(run); return; }
    if (newInProject) create(newInProject);
    else if (run) open(run);
    $('mobile-history').removeAttribute('open');
  });
  list.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openActionsFor) toggleActions(openActionsFor);
  });
  const dropTarget = (event: DragEvent) => (event.target as HTMLElement).closest<HTMLElement>('[data-drop-project]');
  list.addEventListener('dragstart', event => {
    const runId = (event.target as HTMLElement).closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (!runId || !event.dataTransfer) return;
    dragging = true;
    openActionsFor = undefined;
    event.dataTransfer.setData(dragType, runId);
    event.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', event => {
    const target = dropTarget(event);
    if (!target || !event.dataTransfer?.types.includes(dragType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    list.querySelector('.drop-target')?.classList.remove('drop-target');
    target.classList.add('drop-target');
  });
  list.addEventListener('dragleave', event => {
    const target = dropTarget(event);
    if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) target.classList.remove('drop-target');
  });
  const endDrag = () => { dragging = false; list.querySelector('.drop-target')?.classList.remove('drop-target'); renderHistory(); };
  list.addEventListener('dragend', endDrag);
  list.addEventListener('drop', event => {
    const target = dropTarget(event), runId = event.dataTransfer?.getData(dragType);
    if (!target || !runId) return;
    event.preventDefault();
    const projectId = target.dataset.dropProject || null;
    endDrag();
    void move(runId, projectId);
  });
}

export function renderCapacity(): void {
  renderHistory();
  const maxSlots = state.bootstrap?.maxConcurrentRuns ?? 2;
  const activeCount = state.runs.filter(isActiveRun).length;
  const capacity = $('capacity-meter');
  if (activeCount >= maxSlots) {
    capacity.hidden = false;
    capacity.textContent = `并发已满 (${activeCount}/${maxSlots}) · 请先结束或取消进行中的任务`;
  } else {
    capacity.hidden = true;
    capacity.textContent = '';
  }
}
