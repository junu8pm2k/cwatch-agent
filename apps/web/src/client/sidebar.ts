import { $, isActiveRun, state } from './state.ts';

export function renderCapacity(): void {
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
