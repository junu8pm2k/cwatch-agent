import { $, escapeHtml, formatElapsed, formatTime, isActiveRun, isInvestigation, permissionNames, state } from './state.ts';

export function updateElapsed(): void {
  const run = state.current;
  const text = run ? formatElapsed(run.createdAt, run.endedAt) : '—';
  const statTime = $('stat-time');
  if (statTime) statTime.textContent = text;
}

export function renderInspector(): void {
  const run = state.current;
  const stats = $('run-stats');
  stats.hidden = !run;
  $('stat-tools').textContent = run ? String(run.toolCalls) : '—';
  $('stat-turns').textContent = run && run.mode === 'live' ? String(run.modelTurns) : '—';
  $('stat-tokens').textContent = run && run.totalTokens ? run.totalTokens.toLocaleString() : '—';
  updateElapsed();

  const meta = $('inspector-meta');
  const feed = $('inspector-feed');
  if (!run) {
    meta.innerHTML = '';
    feed.innerHTML = '';
    return;
  }

  const profile = state.bootstrap?.profiles.find(p => p.id === run.profile);
  const sources = run.task.allowedSources;
  meta.innerHTML = `
    <div class="inspector-section-head">
      <h3>本次任务概览</h3>
      <button type="button" class="link-btn" data-clone-run>以此配置新建</button>
    </div>
    <dl class="kv-grid compact">
      <dt>模板</dt><dd>${escapeHtml(profile?.name ?? run.profile)}</dd>
      <dt>模式</dt><dd>${run.mode === 'replay' ? '离线演示' : run.conversation ? '真实多轮会话' : '真实执行'}</dd>
      <dt>权限</dt><dd>${escapeHtml(permissionNames[run.permission] ?? run.permission)}</dd>
      <dt>来源</dt><dd>${sources.length ? sources.map(s => `<span class="inline-chip">${escapeHtml(s)}</span>`).join(' ') : '仅内建工作区工具'}</dd>
      ${isInvestigation(run.task) ? `<dt>主张 / 缺口</dt><dd>${run.claims.length} 项主张 · ${run.gaps.length} 项缺口</dd>` : ''}
    </dl>
  `;

  const recent = run.activities.slice(-6).reverse();
  feed.innerHTML = `
    <div class="inspector-section-head">
      <h3>实时轨迹 ${isActiveRun(run) ? '<span class="pulse-dot tone-busy" aria-hidden="true"></span>' : ''}</h3>
      <div class="inspector-jumps">
        <button type="button" class="link-btn" data-jump-tab="process">过程</button>
        <button type="button" class="link-btn" data-jump-tab="trace">Trace</button>
      </div>
    </div>
    ${recent.length
      ? `<ul class="inspector-activity-list">${recent.map(ev => `
          <li class="inspector-activity kind-${escapeHtml(ev.kind)}">
            <span class="inspector-activity-msg">${escapeHtml(ev.message)}</span>
            <time datetime="${escapeHtml(ev.timestamp)}">${formatTime(ev.timestamp)}</time>
          </li>`).join('')}</ul>`
      : '<p class="field-note">等待执行事件…</p>'}
  `;
}
