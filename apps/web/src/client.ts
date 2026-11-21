import type { AgentTask } from '@cwatch/core/types';
import type { RunSnapshot, RunStartInput } from '@cwatch/core/types/runs';
import {
  cancelRunApi,
  deleteRunApi,
  endConversationApi,
  fetchBootstrap,
  fetchReportApi,
  respondApprovalApi,
  sendMessageApi,
  startRunApi,
} from './client/api.ts';
import {
  renderApprovalBanner,
  renderApprovals,
  renderConversation,
  renderProcess,
  updateApprovalClocks,
} from './client/conversation.ts';
import {
  handleTestMcp,
  handleToggleMcp,
  handleToggleSkill,
  inspectSkill,
  loadExtensions,
  renderExtensions,
} from './client/extensions.ts';
import { renderInspector, updateElapsed } from './client/inspector.ts';
import { renderMarkdown } from './client/markdown.ts';
import { renderSidebar } from './client/sidebar.ts';
import {
  $,
  alertError,
  announce,
  clearError,
  currentMode,
  currentProfile,
  escapeHtml,
  isActiveRun,
  isInvestigation,
  permissionNames,
  safeUrl,
  state,
  statusNames,
  statusTone,
  taskTitle,
  type HistoryFilter,
  type MainTab,
  type TraceFilter,
} from './client/state.ts';
import { loadTrace, renderTrace } from './client/trace.ts';

function applyTheme(instant = false): void {
  if (instant) document.documentElement.classList.add('theme-switching');
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  if (instant) {
    void document.documentElement.offsetHeight;
    document.documentElement.classList.remove('theme-switching');
  }
  const toggle = $('theme-toggle');
  if (toggle) {
    const dark = state.theme === 'dark';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    const label = toggle.querySelector('.theme-label');
    if (label) label.textContent = dark ? '浅色模式' : '深色模式';
  }
}

function applyInspectorVisibility(): void {
  const wb = document.querySelector<HTMLElement>('.workbench');
  if (wb) wb.dataset.inspector = String(state.inspectorOpen);
  const toggle = $('toggle-inspector');
  if (toggle) {
    toggle.hidden = !state.current || state.view !== 'workbench';
    toggle.setAttribute('aria-expanded', String(state.inspectorOpen));
    toggle.classList.toggle('is-active', state.inspectorOpen);
  }
}

function setConnection(text: string, online = true): void {
  const el = $('connection');
  el.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
  el.classList.toggle('offline', !online);
}

function populateProfileForm(task = currentProfile().task): void {
  const domain = isInvestigation(task);
  $('agent-fields').hidden = domain;
  $('investigation-fields').hidden = !domain;
  for (const id of ['competitor-name', 'competitor-id', 'product', 'domains', 'start-date', 'end-date']) {
    $<HTMLInputElement>(id).required = domain;
  }
  $<HTMLTextAreaElement>('instruction').required = !domain;

  if (state.view === 'workbench') {
    $('page-title').textContent = domain ? '竞品调查' : '通用 Agent';
  }
  $('task-title').textContent = domain ? '调查设置' : '任务设置';
  $('intro-title').textContent = domain ? '调查竞品动态' : '交给 Agent 一项任务';
  $('intro-description').textContent = domain
    ? '选定产品、时间范围和来源，生成带可核验证据的调查报告。'
    : '描述你要完成的事，选择允许的来源与权限，在统一工作台追踪每一步。';

  const selectedProfile = $<HTMLSelectElement>('profile').value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#task-suggestions [data-template]')) {
    button.setAttribute('aria-pressed', String(button.dataset.template === selectedProfile));
  }

  $('start-run').innerHTML = `${domain ? '开始调查' : '开始任务'} <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg>`;
  $('cancel-run').textContent = domain ? '停止调查' : '停止任务';
  $('tab-report').textContent = domain ? '调查报告' : '任务结果';

  if (domain) {
    $<HTMLInputElement>('competitor-name').value = task.competitor.name;
    $<HTMLInputElement>('competitor-id').value = task.competitor.id;
    $<HTMLInputElement>('product').value = task.product;
    $<HTMLInputElement>('domains').value = task.competitor.domains.join(', ');
    $<HTMLInputElement>('start-date').value = task.window.start.slice(0, 10);
    $<HTMLInputElement>('end-date').value = task.window.end.slice(0, 10);
  } else {
    $<HTMLTextAreaElement>('instruction').value = state.current || currentMode() === 'replay' ? task.instruction : state.instructionDraft;
  }

  $('source-options').innerHTML = currentProfile().sources.map(source => `
    <label class="source-option">
      <input type="checkbox" name="source" value="${escapeHtml(source.slug)}" ${source.active && task.allowedSources.includes(source.slug) ? 'checked ' : ''}${!source.active ? 'disabled ' : ''}>
      <span>${escapeHtml(source.name)}</span>
      <small>${escapeHtml(source.channel === 'mcp' ? 'MCP' : '内建')}</small>
    </label>`).join('');
  modeChanged(true);
}

function parseDomains(raw: string): string[] {
  return [...new Set(raw.split(/[,，\s]+/).map(part => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    try {
      if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).hostname.toLowerCase();
    } catch { /* fall through */ }
    return trimmed.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].toLowerCase();
  }).filter(Boolean))];
}

function syncAgentWebDomains(): void {
  const wrap = $('agent-web-domains-wrap');
  const domain = isInvestigation(currentProfile().task);
  const webChecked = Boolean(document.querySelector<HTMLInputElement>('input[name=source][value=web]:checked'));
  wrap.hidden = domain || currentMode() === 'replay' || !webChecked;
}

function modeChanged(resetInstruction = false): void {
  const replay = currentMode() === 'replay';
  const configured = state.bootstrap?.model.configured;
  for (const id of ['competitor-name', 'competitor-id', 'product', 'domains', 'start-date', 'end-date']) {
    $<HTMLInputElement>(id).readOnly = replay;
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name=source]')) {
    input.disabled = replay || !currentProfile().sources.find(source => source.slug === input.value)?.active;
  }
  $<HTMLTextAreaElement>('instruction').readOnly = replay;
  syncAgentWebDomains();

  const task = currentProfile().task;
  if (resetInstruction && !state.current && !isInvestigation(task)) {
    const input = $<HTMLTextAreaElement>('instruction');
    input.value = replay ? task.instruction : state.instructionDraft;
  }

  $('mode-note').textContent = replay
    ? '当前为固定样例，切换真实运行可编辑任务。'
    : configured
      ? '使用已配置的模型，任务描述与来源均可调整 · Ctrl+Enter 启动。'
      : '请先在本机 .env 配置模型并重启服务。';
  $('start-note').textContent = replay
    ? '演示使用合成数据，全程在本机运行。'
    : '真实运行会调用已配置的模型和所选来源，每步执行均经主进程门禁。';
  $<HTMLButtonElement>('start-run').disabled = state.submitting || (!replay && !configured);
}

function permissionChanged(): void {
  const value = $<HTMLSelectElement>('permission').value;
  $('permission-note').textContent = value === 'explore'
    ? '可读取与分析，禁止修改、发送和发布。'
    : value === 'ask'
      ? '每次写入、发送或发布前由你确认。'
      : '已配置操作无需逐次审批，仍受来源范围限制。';
}

function showView(view: 'workbench' | 'connections'): void {
  state.view = view;
  const showingConnections = view === 'connections';
  $('connections-panel').hidden = !showingConnections;
  document.querySelector<HTMLElement>('.workbench')!.hidden = showingConnections;
  $('nav-sources').classList.toggle('selected', showingConnections);
  $('nav-workbench').classList.toggle('selected', !showingConnections);
  $('nav-sources').setAttribute('aria-expanded', String(showingConnections));
  $('mobile-sources').setAttribute('aria-expanded', String(showingConnections));
  if (showingConnections) {
    $('page-title').textContent = '工作区扩展';
    void loadExtensions();
    renderExtensions();
  } else {
    const activeTask = state.current?.task ?? currentProfile().task;
    $('page-title').textContent = isInvestigation(activeTask) ? '竞品调查' : '通用 Agent';
  }
  applyInspectorVisibility();
}

function showTab(tab: MainTab): void {
  state.tab = tab;
  const names: MainTab[] = ['process', 'report', 'approvals', 'trace'];
  for (const name of names) {
    const selected = name === tab;
    const btn = $('tab-' + name);
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    $('panel-' + name).hidden = !selected;
  }
  renderApprovalBanner();
  if (tab === 'report') renderReport();
  if (tab === 'trace') {
    if (state.current) void loadTrace(state.current.id);
    renderTrace();
  }
}

async function loadReport(run: RunSnapshot): Promise<void> {
  if (state.loadingReports.has(run.id) || state.reportCache.has(run.id)) return;
  state.loadingReports.add(run.id);
  try {
    state.reportCache.set(run.id, await fetchReportApi(run.id));
    if (state.current?.id === run.id && state.tab === 'report') renderReport();
  } catch (error) {
    alertError(error);
  } finally {
    state.loadingReports.delete(run.id);
  }
}

function renderReport(): void {
  const run = state.current;
  if (run?.conversation) {
    const latest = run.messages?.filter(message => message.role === 'assistant').at(-1)?.content;
    if (latest !== undefined) state.reportCache.set(run.id, latest);
    $('report-content').innerHTML = latest === undefined
      ? ''
      : `<div class="report-actions">
          <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report" download="agent-result.md">下载最新回答</a>
          <button type="button" class="button secondary sm" id="copy-report">复制最新回答</button>
        </div>`;
    return;
  }

  if (!run?.reportReady) {
    const domain = isInvestigation(run?.task ?? currentProfile().task);
    $('report-content').innerHTML = `
      <div class="empty-state">
        <h3>${escapeHtml(run && ['failed', 'cancelled', 'unknown'].includes(run.status) ? '本次运行未生成结果' : '结果将在这里呈现')}</h3>
        <p>${escapeHtml(run?.error ?? (domain ? '调查完成后，在这里查看结论、来源与完整报告。' : '任务完成后，在这里阅读、复制或下载回答。'))}</p>
      </div>`;
    return;
  }

  const doc = state.reportCache.get(run.id);
  if (doc === undefined) void loadReport(run);

  if (!isInvestigation(run.task)) {
    $('report-content').innerHTML = `
      <div class="report-heading">
        <h3>任务结果</h3>
        <span class="report-mode">${run.mode === 'replay' ? '固定脚本演示' : 'Agent 回答'}</span>
      </div>
      ${run.gaps.length ? `<div class="run-notice">${run.gaps.map(escapeHtml).join('<br>')}</div>` : ''}
      <div class="report-document md-body">${doc === undefined ? '<p class="field-note">正在读取…</p>' : renderMarkdown(doc)}</div>
      <div class="report-actions">
        <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report" download="agent-result.md">下载 Markdown 结果</a>
        <button type="button" class="button secondary sm" id="copy-report">复制完整报告</button>
      </div>`;
    return;
  }

  $('report-content').innerHTML = `
    <div class="report-heading">
      <h3>调查结论与引用</h3>
      <span class="report-mode">${run.mode === 'replay' ? '合成快照 · 演示' : '本地草稿 · 待核对'}</span>
    </div>
    ${run.gaps.length ? `<div class="run-notice"><strong>本次有 ${run.gaps.length} 项缺口</strong><br>${run.gaps.map(escapeHtml).join('<br>')}</div>` : ''}
    ${run.claims.length
      ? run.claims.map(claim => `
          <article class="claim">
            <p>${escapeHtml(claim.text)}</p>
            <div class="evidence-links">
              ${claim.evidence.map(evidence => {
                const url = safeUrl(evidence.url);
                return `<div class="evidence-item">
                  ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(evidence.source)} · ${escapeHtml(evidence.title)}</a>` : `<span>${escapeHtml(evidence.title)}</span>`}
                  <small>${escapeHtml(evidence.publishedAt ? new Date(evidence.publishedAt).toLocaleDateString('zh-CN') : '发布时间未知')}${evidence.provenance === 'fixture' ? ' · 合成快照' : ''}</small>
                </div>`;
              }).join('')}
            </div>
          </article>`).join('')
      : '<p class="field-note">本次没有可进入结构化主张的证据，请查看缺口与完整报告。</p>'}
    <div class="report-actions">
      <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report" download="competitor-report.md">下载 Markdown 报告</a>
      <button type="button" class="button secondary sm" id="copy-report">复制完整报告</button>
    </div>
    <details class="report-full">
      <summary>查看完整报告</summary>
      <div class="report-document md-body">${doc === undefined ? '<p class="field-note">正在读取报告…</p>' : renderMarkdown(doc)}</div>
    </details>`;
}

function renderRun(): void {
  const run = state.current;
  const wb = document.querySelector<HTMLElement>('.workbench')!;
  wb.dataset.hasRun = String(Boolean(run));
  wb.dataset.conversation = String(Boolean(run?.conversation));
  applyInspectorVisibility();

  $('run-title').textContent = run ? taskTitle(run.task) : '任务空间';
  const labelText = run
    ? `${statusNames[run.status]} / ${run.mode === 'replay' ? '离线演示' : run.conversation ? '真实会话' : '真实调查'}`
    : '准备就绪';
  const label = $('run-label');
  label.textContent = labelText;
  label.className = 'run-label tone-' + (run ? statusTone(run.status) : 'idle');

  const showPipeline = run ? isInvestigation(run.task) : isInvestigation(currentProfile().task);
  $('pipeline').hidden = !showPipeline;
  $('pipeline').innerHTML = ['计划', '采集', '分析', '审阅', '草稿'].map((name, index) => {
    const done = Boolean(run && run.stage > index);
    const current = Boolean(run && run.stage === index && isActiveRun(run));
    return `<div class="pipeline-step ${done ? 'done' : current ? 'current' : ''}"><span class="step-dot">${done ? '✓' : index + 1}</span><span>${name}</span></div>`;
  }).join('');

  $('cancel-run').hidden = !isActiveRun(run);
  $<HTMLButtonElement>('cancel-run').disabled = run?.status === 'cancelling';

  $('approval-count').textContent = String(run?.approvals.length ?? 0);
  $('approval-count').className = 'count-badge ' + (run?.approvals.length ? 'pending' : '');

  $('run-footer-text').textContent = run
    ? `${permissionNames[run.permission] ?? run.permission} · 工具调用已记录`
    : '任务与对话保存在本机';
  $('provenance-label').textContent = run?.mode === 'replay'
    ? '合成数据演示'
    : run
      ? '来源与引用请核验'
      : '按需选择来源与技能';

  renderApprovalBanner();
  renderProcess();
  renderApprovals();
  renderConversation();
  renderInspector();
  if (state.tab === 'report') renderReport();
  if (state.tab === 'trace') renderTrace();
  updateApprovalClocks();
}

function updateRun(run: RunSnapshot): void {
  const previousStatus = state.current?.status;
  const index = state.runs.findIndex(item => item.id === run.id);
  if (index >= 0 && (state.runs[index].revision ?? 0) > (run.revision ?? 0)) return;
  if (index < 0) state.runs.unshift(run);
  else state.runs[index] = run;

  if (state.current?.id === run.id) {
    state.current = run;
    if (previousStatus !== run.status) {
      if ((run.conversation && run.status === 'awaiting_user') || (!isInvestigation(run.task) && run.status === 'complete' && run.reportReady)) {
        showTab('report');
      }
      announce(statusNames[run.status]);
    }
    if (state.tab === 'trace') {
      void loadTrace(run.id);
    }
    renderRun();
  }
  renderSidebar();
  if (state.view === 'connections') renderExtensions();
}

function selectRun(run: RunSnapshot): void {
  state.stream?.close();
  state.current = run;
  state.selectedTraceStepId = undefined;
  state.traceFilter = 'all';
  localStorage.setItem('cwatch-selected-run', run.id);
  showView('workbench');

  $<HTMLSelectElement>('profile').value = run.profile;
  const radio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${run.mode}]`);
  if (radio) radio.checked = true;
  $<HTMLSelectElement>('permission').value = run.permission;

  populateProfileForm(run.task);
  permissionChanged();
  showTab(run.status === 'awaiting_approval' ? 'approvals' : run.conversation ? 'report' : 'process');
  renderSidebar();
  renderRun();

  const stream = new EventSource(`/api/runs/${run.id}/events`);
  state.stream = stream;
  stream.addEventListener('snapshot', event => {
    if (state.current?.id !== run.id) return;
    setConnection('本地服务已连接');
    updateRun(JSON.parse((event as MessageEvent<string>).data));
  });
  stream.onerror = () => {
    if (state.current?.id === run.id) setConnection('连接中断，正在重连', false);
  };
}

function newRun(seed?: { profile: string; mode: 'live' | 'replay'; permission: string; task: AgentTask }): void {
  state.stream?.close();
  state.current = undefined;
  state.instructionDraft = seed && !isInvestigation(seed.task) ? seed.task.instruction : '';
  localStorage.removeItem('cwatch-selected-run');
  clearError();
  showView('workbench');

  $<HTMLSelectElement>('profile').value = seed?.profile ?? 'agent';
  const defaultMode = seed?.mode ?? (state.bootstrap?.model.configured ? 'live' : 'replay');
  const radio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${defaultMode}]`);
  if (radio) radio.checked = true;
  $<HTMLSelectElement>('permission').value = seed?.permission ?? 'explore';

  populateProfileForm(seed?.task);
  permissionChanged();
  showTab('process');
  renderSidebar();
  renderRun();
  announce('可以新建任务。');
}

async function handleDeleteRun(runId: string): Promise<void> {
  if (state.deletingRunIds.has(runId)) return;
  state.deletingRunIds.add(runId);
  clearError();
  renderSidebar();
  try {
    await deleteRunApi(runId);
    state.runs = state.runs.filter(r => r.id !== runId);
    state.reportCache.delete(runId);
    state.traceCache.delete(runId);
    state.drafts.delete(runId);
    if (state.current?.id === runId) {
      const next = state.runs[0];
      if (next) selectRun(next);
      else newRun();
    } else {
      renderSidebar();
    }
    announce('任务记录已删除。');
  } catch (error) {
    alertError(error);
  } finally {
    state.deletingRunIds.delete(runId);
    renderSidebar();
  }
}

async function refreshBootstrapQuietly(): Promise<void> {
  const bootstrap = await fetchBootstrap();
  state.bootstrap = bootstrap;
  renderSkillCheckboxes();
  populateProfileForm(state.current?.task);
}

function renderSkillCheckboxes(): void {
  const bootstrap = state.bootstrap;
  if (!bootstrap) return;
  $('skill-options').innerHTML = bootstrap.skills.filter(skill => skill.enabled).map(skill => `
    <label class="source-option" title="${escapeHtml(skill.description)}">
      <input type="checkbox" name="skill" value="${escapeHtml(skill.name)}">
      <span>${escapeHtml(skill.name)}</span>
    </label>`).join('')
    || '<p class="field-note">使用所选模板的基础指导；可通过 CLI 安装或在「来源与连接」查看 Skill。</p>';
}

// Form submission
$('run-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state.submitting) return;
  clearError();
  void (async () => {
    state.submitting = true;
    modeChanged();
    try {
      const profile = currentProfile();
      const replay = currentMode() === 'replay';
      const task = structuredClone(profile.task);
      let webDomains: string[] | undefined;
      if (!replay && isInvestigation(task)) {
        const defaultTask = isInvestigation(profile.task) ? profile.task : undefined;
        task.taskId = 'web-' + Date.now();
        task.competitor.name = $<HTMLInputElement>('competitor-name').value.trim();
        const rawId = $<HTMLInputElement>('competitor-id').value.trim();
        if (defaultTask && task.competitor.name !== defaultTask.competitor.name) {
          task.competitor.aliases = [];
          task.competitor.id = rawId === defaultTask.competitor.id
            ? (task.competitor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target-' + Date.now().toString(36))
            : rawId;
        } else {
          task.competitor.id = rawId;
        }
        task.competitor.domains = parseDomains($<HTMLInputElement>('domains').value);
        if (!task.competitor.domains.length) throw Error('请填写至少一个允许访问的公开域名（如 bigmodel.cn）。');
        task.product = $<HTMLInputElement>('product').value.trim();
        task.window = {
          start: $<HTMLInputElement>('start-date').value + 'T00:00:00+08:00',
          end: $<HTMLInputElement>('end-date').value + 'T00:00:00+08:00',
          basis: 'published_at',
          timezone: 'Asia/Shanghai',
        };
        task.allowedSources = [...document.querySelectorAll<HTMLInputElement>('input[name=source]:checked')].map(input => input.value);
      }
      if (!isInvestigation(task)) {
        task.instruction = $<HTMLTextAreaElement>('instruction').value.trim();
        if (!replay) {
          task.taskId = 'task-' + Date.now();
          task.allowedSources = [...document.querySelectorAll<HTMLInputElement>('input[name=source]:checked')].map(input => input.value);
          if (task.allowedSources.includes('web')) {
            webDomains = parseDomains($<HTMLInputElement>('agent-web-domains').value);
            if (!webDomains.length) throw Error('已勾选联网搜索与读取，请填写至少一个允许访问的公开域名（如 bigmodel.cn, open.bigmodel.cn）。');
          }
        }
      }
      if (isInvestigation(task) && Date.parse(task.window.start) >= Date.parse(task.window.end)) {
        throw Error('结束日期须晚于开始日期。');
      }
      if (isInvestigation(task) && !task.allowedSources.length) {
        throw Error('请至少选择一个采集来源。');
      }
      const input: RunStartInput = {
        profile: profile.id,
        mode: currentMode(),
        permission: $<HTMLSelectElement>('permission').value as RunStartInput['permission'],
        ...(!isInvestigation(task) && !replay ? { conversation: true } : {}),
        ...(webDomains?.length ? { webDomains } : {}),
        task,
        skills: [...document.querySelectorAll<HTMLInputElement>('input[name=skill]:checked')].map(input => input.value),
        limits: {
          timeoutMs: Number($<HTMLInputElement>('timeout').value) * 1000,
          maxTokens: Number($<HTMLInputElement>('tokens').value),
        },
      };
      const run = await startRunApi(input);
      state.runs.unshift(run);
      selectRun(run);
      $('run-title').focus();
      announce(isInvestigation(task) ? '调查已启动。' : '任务已启动。');
    } catch (error) {
      alertError(error);
    } finally {
      state.submitting = false;
      modeChanged();
    }
  })();
});

// Follow-up conversation
$('follow-up').addEventListener('input', () => {
  if (state.current) state.drafts.set(state.current.id, $<HTMLTextAreaElement>('follow-up').value);
});
$('follow-up').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$<HTMLButtonElement>('send-message').disabled) {
    event.preventDefault();
    $<HTMLFormElement>('message-form').requestSubmit();
  }
});
$('message-form').addEventListener('submit', event => {
  event.preventDefault();
  const run = state.current;
  const text = $<HTMLTextAreaElement>('follow-up').value.trim();
  if (!run || run.status !== 'awaiting_user' || state.sending || !text) return;
  const pending = state.pendingMessage;
  const message = pending?.runId === run.id && pending.text === text ? pending : { runId: run.id, text, messageId: crypto.randomUUID() };
  state.pendingMessage = message;
  state.sending = true;
  clearError();
  renderConversation();
  void sendMessageApi(run.id, { text, messageId: message.messageId }).then(value => {
    state.drafts.delete(run.id);
    state.pendingMessage = undefined;
    if (state.current?.id === run.id) $<HTMLTextAreaElement>('follow-up').value = '';
    updateRun(value);
    announce('追问已发送。');
  }).catch(alertError).finally(() => {
    state.sending = false;
    renderConversation();
  });
});

$('end-conversation').addEventListener('click', () => {
  const run = state.current;
  if (!run || run.status !== 'awaiting_user' || state.sending) return;
  state.sending = true;
  clearError();
  renderConversation();
  void endConversationApi(run.id).then(updateRun).catch(alertError).finally(() => {
    state.sending = false;
    renderConversation();
  });
});

// Navigation, compose & controls
$('new-run').addEventListener('click', () => newRun());
$('sidebar-new-run').addEventListener('click', () => newRun());
$('profile').addEventListener('change', () => { populateProfileForm(); if (!state.current) renderRun(); });
$('task-suggestions').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-template]');
  if (!button || state.current || !state.bootstrap?.profiles.some(profile => profile.id === button.dataset.template)) return;
  $<HTMLSelectElement>('profile').value = button.dataset.template!;
  populateProfileForm();
  renderRun();
  announce('已选择' + currentProfile().name + '模板。');
});
$('run-form').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$<HTMLButtonElement>('start-run').disabled) {
    event.preventDefault();
    $<HTMLFormElement>('run-form').requestSubmit();
  }
});
$('instruction').addEventListener('input', () => {
  if (!state.current) state.instructionDraft = $<HTMLTextAreaElement>('instruction').value;
});
$('source-options').addEventListener('change', syncAgentWebDomains);
for (const input of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) {
  input.addEventListener('change', () => modeChanged(true));
}
$('permission').addEventListener('change', permissionChanged);
$('cancel-run').addEventListener('click', () => {
  const run = state.current;
  if (!run) return;
  clearError();
  void cancelRunApi(run.id).then(updateRun).catch(alertError);
});

// Theme & Inspector toggles
$('theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('cwatch-theme', state.theme); } catch { /* ignore */ }
  applyTheme(true);
  announce(state.theme === 'dark' ? '已切换到深色模式。' : '已切换到浅色模式。');
});
$('toggle-inspector').addEventListener('click', () => {
  state.inspectorOpen = !state.inspectorOpen;
  try { localStorage.setItem('cwatch-inspector-open', String(state.inspectorOpen)); } catch { /* ignore */ }
  applyInspectorVisibility();
});

// Sidebar history search, filter, select & delete
$('history-search').addEventListener('input', () => {
  state.historyQuery = $<HTMLInputElement>('history-search').value;
  renderSidebar();
});
document.querySelector('.history-filters')!.addEventListener('click', event => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history-filter]');
  if (!btn) return;
  state.historyFilter = btn.dataset.historyFilter as HistoryFilter;
  renderSidebar();
});
$('history-list').addEventListener('click', event => {
  const del = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-run]');
  if (del) {
    void handleDeleteRun(del.dataset.deleteRun!);
    return;
  }
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-run]');
  const run = state.runs.find(r => r.id === target?.dataset.run);
  if (run) { clearError(); selectRun(run); }
});
$('history-select').addEventListener('change', () => {
  const run = state.runs.find(r => r.id === $<HTMLSelectElement>('history-select').value);
  if (run) selectRun(run);
  else newRun();
});

// Tabs & keyboard navigation (process -> report -> approvals -> trace)
for (const button of document.querySelectorAll<HTMLElement>('[data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab as MainTab));
}
document.querySelector('[role=tablist]')!.addEventListener('keydown', event => {
  const key = (event as KeyboardEvent).key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  event.preventDefault();
  const names: MainTab[] = ['process', 'report', 'approvals', 'trace'];
  const index = names.indexOf(state.tab);
  const next = key === 'Home' ? 0 : key === 'End' ? names.length - 1 : (index + (key === 'ArrowRight' ? 1 : names.length - 1)) % names.length;
  showTab(names[next]);
  $('tab-' + names[next]).focus();
});

// Approvals actions
$('approval-content').addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-approve],[data-deny]');
  const run = state.current;
  if (!target || !run) return;
  const requestId = target.dataset.approve ?? target.dataset.deny!;
  target.disabled = true;
  void respondApprovalApi(run.id, requestId, Boolean(target.dataset.approve), target.dataset.hash!)
    .then(updateRun)
    .catch(error => { alertError(error); target.disabled = false; });
});

// Trace interactions
$('trace-content').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-trace-refresh]') && state.current) {
    void loadTrace(state.current.id, true);
    return;
  }
  const filterBtn = target.closest<HTMLButtonElement>('[data-trace-filter]');
  if (filterBtn) {
    state.traceFilter = filterBtn.dataset.traceFilter as TraceFilter;
    renderTrace();
    return;
  }
  const stepBtn = target.closest<HTMLButtonElement>('[data-trace-step]');
  if (stepBtn) {
    state.selectedTraceStepId = stepBtn.dataset.traceStep;
    renderTrace();
  }
});

// Connections / Extensions interactions
$('connections-panel').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-ext-refresh]')) {
    void loadExtensions(true);
    return;
  }
  if (target.closest('[data-close-skill]')) {
    state.activeSkillName = undefined;
    renderExtensions();
    return;
  }
  const inspectBtn = target.closest<HTMLButtonElement>('[data-inspect-skill]');
  if (inspectBtn) {
    void inspectSkill(inspectBtn.dataset.inspectSkill!);
    return;
  }
  const toggleSkillBtn = target.closest<HTMLButtonElement>('[data-toggle-skill]');
  if (toggleSkillBtn) {
    void handleToggleSkill(toggleSkillBtn.dataset.toggleSkill!, toggleSkillBtn.dataset.nextEnabled === 'true', refreshBootstrapQuietly);
    return;
  }
  const toggleMcpBtn = target.closest<HTMLButtonElement>('[data-toggle-mcp]');
  if (toggleMcpBtn) {
    void handleToggleMcp(toggleMcpBtn.dataset.toggleMcp!, toggleMcpBtn.dataset.nextEnabled === 'true', refreshBootstrapQuietly);
    return;
  }
  const testMcpBtn = target.closest<HTMLButtonElement>('[data-test-mcp]');
  if (testMcpBtn) {
    void handleTestMcp(testMcpBtn.dataset.testMcp!);
  }
});

$('nav-sources').addEventListener('click', () => showView(state.view === 'connections' ? 'workbench' : 'connections'));
$('mobile-sources').addEventListener('click', () => showView(state.view === 'connections' ? 'workbench' : 'connections'));
$('nav-workbench').addEventListener('click', () => showView('workbench'));

// Delegated global actions (copy report, copy code block, copy message, jump tab, clone run)
document.body.addEventListener('click', event => {
  const target = event.target as HTMLElement;

  const copyReportBtn = target.closest<HTMLButtonElement>('#copy-report');
  if (copyReportBtn) {
    const report = state.current && state.reportCache.get(state.current.id);
    if (report) {
      void navigator.clipboard.writeText(report).then(() => {
        copyReportBtn.textContent = '已复制';
        announce('报告已复制。');
      }).catch(() => alertError('浏览器未允许复制，请下载报告。'));
    }
    return;
  }

  const copyCodeBtn = target.closest<HTMLButtonElement>('[data-copy-code]');
  if (copyCodeBtn) {
    const code = copyCodeBtn.closest('.md-code-block')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard.writeText(code).then(() => {
      copyCodeBtn.textContent = '已复制';
      setTimeout(() => { copyCodeBtn.textContent = '复制代码'; }, 1600);
    }).catch(() => alertError('浏览器未允许复制。'));
    return;
  }

  const copyMsgBtn = target.closest<HTMLButtonElement>('[data-copy-msg]');
  if (copyMsgBtn) {
    const idx = Number(copyMsgBtn.dataset.copyMsg);
    const content = state.current?.messages?.[idx]?.content;
    if (content !== undefined) {
      void navigator.clipboard.writeText(content).then(() => {
        copyMsgBtn.textContent = '已复制';
        setTimeout(() => { copyMsgBtn.textContent = '复制'; }, 1600);
      }).catch(() => alertError('浏览器未允许复制。'));
    }
    return;
  }

  const jumpBtn = target.closest<HTMLButtonElement>('[data-jump-tab]');
  if (jumpBtn) {
    showTab(jumpBtn.dataset.jumpTab as MainTab);
    return;
  }

  if (target.closest('[data-clone-run]') && state.current) {
    const run = state.current;
    newRun({ profile: run.profile, mode: run.mode, permission: run.permission, task: structuredClone(run.task) });
  }
});

setInterval(() => {
  updateElapsed();
  updateApprovalClocks();
}, 1000);

async function init(): Promise<void> {
  applyTheme();
  try {
    const bootstrap = await fetchBootstrap();
    state.bootstrap = bootstrap;
    state.runs = bootstrap.runs;
    $('profile').innerHTML = bootstrap.profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join('');
    $<HTMLSelectElement>('profile').value = 'agent';
    const defaultRadio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${bootstrap.model.configured ? 'live' : 'replay'}]`);
    if (defaultRadio) defaultRadio.checked = true;
    renderSkillCheckboxes();
    $('model-status').textContent = bootstrap.model.configured
      ? `模型：${bootstrap.model.provider} / ${bootstrap.model.id}`
      : '模型未配置 · 离线演示可用';
    setConnection('本地服务已连接');
    populateProfileForm();
    permissionChanged();
    renderSidebar();
    const selected = state.runs.find(run => run.id === localStorage.getItem('cwatch-selected-run'))
      ?? state.runs.find(isActiveRun)
      ?? state.runs[0];
    if (selected) selectRun(selected);
    else { showTab('process'); renderRun(); }
  } catch (error) {
    setConnection('本地服务未连接', false);
    alertError(error);
    $<HTMLButtonElement>('start-run').disabled = true;
  }
}

void init();
