import type { AgentTask } from '@cwatch/core/types';
import type { RunSnapshot, RunStartInput } from '@cwatch/core/types/runs';
import { mergeActivities } from './client/activity-merger.ts';
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
  renderApprovalSpotlight,
  renderConversation,
  renderProcess,
  updateApprovalClocks,
} from './client/conversation.ts';
import { renderEvidenceRail } from './client/evidence-rail.ts';
import {
  handleTestMcp,
  handleToggleMcp,
  handleToggleSkill,
  inspectSkill,
  loadExtensions,
  renderExtensions,
} from './client/extensions.ts';
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
  formatElapsed,
  isActiveRun,
  isInvestigation,
  permissionNames,
  profileDisplayName,
  safeUrl,
  state,
  statusNames,
  statusTone,
  taskTitle,
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

function setSettingsOpen(open: boolean): void {
  state.settingsOpen = open;
  $('settings-popover').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-toggle').classList.toggle('is-active', open);
}

function setTraceDrawer(open: boolean): void {
  const allowed = open && Boolean(state.current) && state.view === 'workbench';
  state.traceDrawerOpen = allowed;
  $('trace-drawer').hidden = !allowed;
  $('trace-backdrop').hidden = !allowed;
  const trigger = $('toggle-trace-drawer');
  trigger.setAttribute('aria-expanded', String(allowed));
  trigger.classList.toggle('is-active', allowed);
  if (allowed && state.current) {
    void loadTrace(state.current.id);
    renderTrace();
  }
}

function syncHeaderControls(): void {
  const hasRun = Boolean(state.current);
  const inWorkbench = state.view === 'workbench';
  $('toggle-trace-drawer').hidden = !hasRun || !inWorkbench;
  $('new-run').hidden = !hasRun && inWorkbench;
  if (!hasRun || !inWorkbench) {
    if (state.traceDrawerOpen) setTraceDrawer(false);
  }
}

function setConnection(text: string, online = true): void {
  const el = $('connection');
  el.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
  el.classList.toggle('offline', !online);
}

function setProfileRadio(id: string): void {
  const target = id === 'web' || id === 'standard' || id === 'adapters' ? 'web' : 'agent';
  const radio = document.querySelector<HTMLInputElement>(`input[name="profile"][value="${target}"]`);
  if (radio) radio.checked = true;
}

function parseDomains(raw: string): string[] {
  return [...new Set(raw.split(/[,，\s]+/).map(part => {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '*') return '';
    try {
      if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).hostname.toLowerCase();
    } catch { /* fall through */ }
    return trimmed.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].toLowerCase();
  }).filter(Boolean))];
}

function syncWebToggleAndBadges(): void {
  const replay = currentMode() === 'replay';
  const domain = isInvestigation(currentProfile().task);
  const webCheckbox = $<HTMLInputElement>('toggle-web-search');
  const webLabel = $('web-toggle-label');
  const webSourceActive = Boolean(currentProfile().sources.find(s => s.slug === 'web')?.active);

  webCheckbox.disabled = replay || !webSourceActive;
  webLabel.classList.toggle('is-on', webCheckbox.checked && !webCheckbox.disabled);
  webLabel.classList.toggle('is-disabled', webCheckbox.disabled);

  const showDomainToggle = !domain && !replay && webCheckbox.checked;
  const domainToggle = $('toggle-domain-filter');
  domainToggle.hidden = !showDomainToggle;
  if (!showDomainToggle) state.domainFilterOpen = false;
  $('agent-web-domains-wrap').hidden = !showDomainToggle || !state.domainFilterOpen;
  domainToggle.setAttribute('aria-expanded', String(state.domainFilterOpen));
  domainToggle.classList.toggle('is-active', state.domainFilterOpen);

  const agentDomains = parseDomains($<HTMLInputElement>('agent-web-domains').value);
  const invDomains = parseDomains($<HTMLInputElement>('domains').value);
  const countEl = $('domain-filter-count');
  countEl.hidden = agentDomains.length === 0;
  countEl.textContent = String(agentDomains.length);

  // Composer top-right calm mode summary pill
  const modeBadge = $('composer-mode-badge');
  if (replay) {
    modeBadge.textContent = '离线演示';
    modeBadge.dataset.tone = 'muted';
  } else if (domain) {
    modeBadge.textContent = invDomains.length ? `真实调查 · 限定 ${invDomains.length} 域名` : '真实调查 · 全网公开';
    modeBadge.dataset.tone = 'live';
  } else if (webCheckbox.checked) {
    modeBadge.textContent = agentDomains.length ? `真实会话 · 限定 ${agentDomains.length} 域名` : '真实会话 · 全网公开';
    modeBadge.dataset.tone = 'live';
  } else {
    modeBadge.textContent = '真实会话 · 仅本地';
    modeBadge.dataset.tone = 'neutral';
  }

  // Settings badge highlights non-default permission or replay-when-configured
  const perm = $<HTMLSelectElement>('permission').value;
  const settingsBadge = $('settings-badge');
  const note = perm === 'ask' ? '审批' : perm === 'allow-all' ? '全权' : (replay && state.bootstrap?.model.configured ? '演示' : '');
  settingsBadge.hidden = !note;
  settingsBadge.textContent = note;
}

function populateProfileForm(task = currentProfile().task, preserveWebChoice = false): void {
  const domain = isInvestigation(task);
  const replay = currentMode() === 'replay';
  $('agent-fields').hidden = domain;
  $('investigation-fields').hidden = !domain;

  for (const id of ['competitor-name', 'product', 'start-date', 'end-date']) {
    $<HTMLInputElement>(id).required = domain;
  }
  $<HTMLInputElement>('domains').required = false;
  $<HTMLTextAreaElement>('instruction').required = !domain;

  if (state.view === 'workbench') {
    $('page-title').textContent = domain ? '产品调查' : '通用 Agent';
  }

  $('intro-title').textContent = domain ? '结构化调查产品动态' : '今天想调查或完成什么？';
  $('intro-description').textContent = domain
    ? '指定对象、产品与时间窗，联网采集公开信息并生成带可核验引用的调查草稿。'
    : '直接提问、联网检索公开资料或读取本地文件，每一步都在本机可审计执行。';

  $('start-run').innerHTML = `${domain ? '开始调查' : '开始任务'} <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg>`;
  $('cancel-run').textContent = domain ? '停止调查' : '停止任务';
  $('tab-report').textContent = domain ? '调查报告' : '任务结果';

  if (domain) {
    $<HTMLInputElement>('competitor-name').value = task.competitor.name;
    $<HTMLInputElement>('competitor-id').value = task.competitor.id;
    $<HTMLInputElement>('product').value = task.product;
    const displayDomains = task.competitor.domains.filter(d => d !== '*');
    $<HTMLInputElement>('domains').value = replay || state.current ? displayDomains.join(', ') : '';
    $<HTMLInputElement>('start-date').value = task.window.start.slice(0, 10);
    $<HTMLInputElement>('end-date').value = task.window.end.slice(0, 10);
  } else {
    $<HTMLTextAreaElement>('instruction').value = state.current || replay ? task.instruction : state.instructionDraft;
  }

  // Primary web search checkbox
  const webSource = currentProfile().sources.find(s => s.slug === 'web');
  const webBox = $<HTMLInputElement>('toggle-web-search');
  if (!preserveWebChoice) {
    if (replay) {
      webBox.checked = Boolean(webSource?.active && task.allowedSources.includes('web'));
    } else {
      // Live mode defaults web search ON for both Generic Agent & Competitor Investigation!
      webBox.checked = Boolean(webSource?.active && (state.current ? task.allowedSources.includes('web') : true));
    }
  }

  // Secondary custom MCP sources tucked inside Settings Popover
  const extraSources = currentProfile().sources.filter(s => s.slug !== 'web');
  $('custom-source-section').hidden = extraSources.length === 0;
  $('custom-source-options').innerHTML = extraSources.map(source => `
    <label class="option-chip">
      <input type="checkbox" name="source" value="${escapeHtml(source.slug)}" ${source.active && task.allowedSources.includes(source.slug) ? 'checked ' : ''}${!source.active ? 'disabled ' : ''}>
      <span>${escapeHtml(source.name)}</span>
    </label>`).join('');

  modeChanged(true);
}

function modeChanged(resetInstruction = false): void {
  const replay = currentMode() === 'replay';
  const configured = state.bootstrap?.model.configured;
  const profile = currentProfile();
  const task = profile.task;
  const domain = isInvestigation(task);

  for (const id of ['competitor-name', 'product', 'domains', 'start-date', 'end-date']) {
    $<HTMLInputElement>(id).readOnly = replay;
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('#custom-source-options input[name=source]')) {
    input.disabled = replay || !profile.sources.find(source => source.slug === input.value)?.active;
  }
  $<HTMLTextAreaElement>('instruction').readOnly = replay;

  if (resetInstruction && !state.current) {
    if (!domain) {
      $<HTMLTextAreaElement>('instruction').value = replay ? task.instruction : state.instructionDraft;
    } else {
      const displayDomains = task.competitor.domains.filter(d => d !== '*');
      $<HTMLInputElement>('domains').value = replay ? displayDomains.join(', ') : '';
    }
    const webSource = profile.sources.find(s => s.slug === 'web');
    const webBox = $<HTMLInputElement>('toggle-web-search');
    if (replay) {
      webBox.checked = Boolean(webSource?.active && task.allowedSources.includes('web'));
    } else if (webSource?.active && !webBox.checked && domain) {
      webBox.checked = true;
    } else if (!replay && !domain && webSource?.active && webBox.disabled) {
      webBox.checked = true;
    }
  }

  syncWebToggleAndBadges();

  if (!replay && !configured) {
    $('mode-note').textContent = '请先在本机 .env 配置模型凭据并重启服务。';
  } else if (domain) {
    $('mode-note').textContent = replay
      ? '使用本地合成快照演示完整 5 阶段调查与引用核验。'
      : '默认可搜索全网公开 HTTPS 网页；填写限定域名后自动包含子域名。';
  } else {
    $('mode-note').textContent = replay
      ? '离线脚本样例；切换「真实运行」即可自由提问并多轮追问。'
      : '真实多轮会话：支持自由联网检索与本地文件读取。';
  }

  $('start-note').textContent = replay
    ? '当前为离线演示模式 · 点击卡片左下角「设置」可切换真实运行与权限。'
    : '已连接本地模型 · 默认支持全网公开 HTTPS 搜索，每次工具调用均经主进程门禁审计。';

  $<HTMLButtonElement>('start-run').disabled = state.submitting || (!replay && !configured);
}

function permissionChanged(): void {
  const value = $<HTMLSelectElement>('permission').value;
  $('permission-note').textContent = value === 'explore'
    ? '只读探索：可读取与联网搜索，禁止修改、发送或发布。'
    : value === 'ask'
      ? '写入前审批：每次写入、发送或发布前都会在顶部卡片由你确认。'
      : '允许已配置操作：无需逐次弹窗，仍严格受来源与权限边界约束。';
  syncWebToggleAndBadges();
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
    setSettingsOpen(false);
    $('page-title').textContent = '工作区扩展';
    void loadExtensions();
    renderExtensions();
  } else {
    const activeTask = state.current?.task ?? currentProfile().task;
    $('page-title').textContent = isInvestigation(activeTask) ? '产品调查' : '通用 Agent';
  }
  syncHeaderControls();
}

function showTab(tab: MainTab): void {
  state.tab = tab;
  const names: MainTab[] = ['report', 'process'];
  for (const name of names) {
    const selected = name === tab;
    const btn = $('tab-' + name);
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    $('panel-' + name).hidden = !selected;
  }
  if (tab === 'report') renderReport();
  if (tab === 'process') renderProcess();
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

function updateRunMetrics(): void {
  const run = state.current;
  const el = $('run-metrics');
  if (!run) {
    el.textContent = '';
    return;
  }
  const parts = [
    `${run.toolCalls} 次工具`,
    `${run.modelTurns} 轮模型`,
    run.totalTokens ? `${run.totalTokens.toLocaleString()} tokens` : null,
    formatElapsed(run.createdAt, run.endedAt),
  ].filter(Boolean);
  el.textContent = parts.join(' · ');
}

function renderReport(): void {
  const run = state.current;
  if (run?.conversation) {
    const latest = run.messages?.filter(message => message.role === 'assistant').at(-1)?.content;
    if (latest !== undefined) state.reportCache.set(run.id, latest);
    $('report-content').innerHTML = latest === undefined
      ? ''
      : `<div class="report-actions conversation-export">
          <a class="button ghost sm" href="/api/runs/${escapeHtml(run.id)}/report" download="agent-result.md">下载最新回答</a>
          <button type="button" class="button ghost sm" id="copy-report">复制最新回答</button>
        </div>`;
    return;
  }

  if (!run?.reportReady) {
    const domain = isInvestigation(run?.task ?? currentProfile().task);
    const failedOrStopped = Boolean(run && ['failed', 'cancelled', 'unknown'].includes(run.status));
    $('report-content').innerHTML = `
      <div class="empty-state">
        <h3>${escapeHtml(failedOrStopped ? '本次运行未生成结果' : '正在生成结果…')}</h3>
        <p>${escapeHtml(run?.error ?? (domain ? '采集、分析与审阅完成后，带引用的调查报告将自动呈现在这里。' : '任务完成后，回答内容将在这里展示，并支持复制与导出。'))}</p>
        ${run && isActiveRun(run) ? '<div class="empty-actions"><button type="button" class="button secondary sm" data-jump-tab="process">查看实时执行轨迹</button></div>' : ''}
        ${failedOrStopped ? `<div class="empty-actions"><button type="button" class="button primary sm" data-retry-run ${state.submitting ? 'disabled' : ''}>尝试重试</button><button type="button" class="button secondary sm" data-clone-run>修改配置</button></div>` : ''}
      </div>`;
    return;
  }

  const doc = state.reportCache.get(run.id);
  if (doc === undefined) void loadReport(run);

  if (!isInvestigation(run.task)) {
    $('report-content').innerHTML = `
      <div class="report-card">
        <div class="report-heading">
          <h3>任务结果</h3>
          <span class="report-mode">${run.mode === 'replay' ? '固定脚本演示' : 'Agent 回答'}</span>
        </div>
        ${run.gaps.length ? `<div class="run-notice">${run.gaps.map(escapeHtml).join('<br>')}</div>` : ''}
        <div class="report-document md-body">${doc === undefined ? '<p class="field-note">正在读取…</p>' : renderMarkdown(doc)}</div>
        <div class="report-actions">
          <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report" download="agent-result.md">下载 Markdown 结果</a>
          <button type="button" class="button secondary sm" id="copy-report">复制完整报告</button>
        </div>
      </div>`;
    return;
  }

  // Competitor Investigation editorial view with claim <-> evidence rail linkage
  let citationSeq = 1;
  const claimsHtml = run.claims.length
    ? run.claims.map(claim => {
        const isHighlighted = state.highlightedClaimId === claim.id;
        const evHtml = claim.evidence.map(evidence => {
          const num = citationSeq++;
          const url = safeUrl(evidence.url);
          return `<div class="evidence-item">
            <span class="cite-index">[${num}]</span>
            ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(evidence.source)} · ${escapeHtml(evidence.title)}</a>` : `<span>${escapeHtml(evidence.title)}</span>`}
            <small>${escapeHtml(evidence.publishedAt ? new Date(evidence.publishedAt).toLocaleDateString('zh-CN') : '发布时间未知')}${evidence.provenance === 'fixture' ? ' · 合成快照' : ''}</small>
          </div>`;
        }).join('');
        return `<article class="claim${isHighlighted ? ' highlighted' : ''}" data-claim-id="${escapeHtml(claim.id)}">
          <p class="claim-text">${escapeHtml(claim.text)}</p>
          <div class="evidence-links">${evHtml}</div>
        </article>`;
      }).join('')
    : '<p class="field-note">本次没有可进入结构化主张的证据，请查看右侧信息缺口与下方完整报告。</p>';

  $('report-content').innerHTML = `
    <div class="report-card">
      <div class="report-heading">
        <div>
          <h3 class="serif-sub">调查结论与引用</h3>
          <p class="report-sub-hint">点击任意主张卡片，可联动高亮右侧对应证据来源。</p>
        </div>
        <span class="report-mode">${run.mode === 'replay' ? '合成快照 · 演示' : '本地草稿 · 待核对'}</span>
      </div>
      ${claimsHtml}
      <div class="report-actions">
        <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report" download="competitor-report.md">下载 Markdown 报告</a>
        <button type="button" class="button secondary sm" id="copy-report">复制完整报告</button>
      </div>
      <details class="report-full" open>
        <summary>完整调查报告正文</summary>
        <div class="report-document md-body">${doc === undefined ? '<p class="field-note">正在读取报告…</p>' : renderMarkdown(doc)}</div>
      </details>
    </div>`;
}

function renderRun(): void {
  const run = state.current;
  const wb = document.querySelector<HTMLElement>('.workbench')!;
  const hasRun = Boolean(run);
  const investigation = Boolean(run && isInvestigation(run.task));

  wb.dataset.hasRun = String(hasRun);
  wb.dataset.conversation = String(Boolean(run?.conversation));
  wb.dataset.hasRail = String(investigation);
  syncHeaderControls();

  if (!run) {
    renderEvidenceRail();
    renderApprovalSpotlight();
    return;
  }

  $('run-title').textContent = taskTitle(run.task);
  const labelText = `${statusNames[run.status]} / ${run.mode === 'replay' ? '离线演示' : run.conversation ? '真实会话' : '真实调查'}`;
  const label = $('run-label');
  label.textContent = labelText;
  label.className = 'run-label tone-' + statusTone(run.status);

  $('tab-report').textContent = investigation ? '调查报告' : '任务结果';
  $('cancel-run').textContent = investigation ? '停止调查' : '停止任务';
  $('cancel-run').hidden = !isActiveRun(run);
  $<HTMLButtonElement>('cancel-run').disabled = run.status === 'cancelling';

  const canRetry = ['failed', 'cancelled', 'unknown', 'partial'].includes(run.status);
  $('retry-run').hidden = !canRetry;
  $<HTMLButtonElement>('retry-run').disabled = state.submitting;

  $('pipeline').hidden = !investigation;
  if (investigation) {
    $('pipeline').innerHTML = ['计划', '采集', '分析', '审阅', '草稿'].map((name, index) => {
      const done = run.stage > index;
      const current = run.stage === index && isActiveRun(run);
      return `<div class="pipeline-step ${done ? 'done' : current ? 'current' : ''}"><span class="step-dot">${done ? '✓' : index + 1}</span><span>${name}</span></div>`;
    }).join('');
  }

  const mergedCount = mergeActivities(run.activities).length;
  $('process-count').textContent = String(mergedCount);

  $('run-footer-text').textContent = `${permissionNames[run.permission] ?? run.permission} · 工具调用均经主进程门禁留痕`;
  $('provenance-label').textContent = run.mode === 'replay' ? '合成数据演示' : '来源与引用请人工核验';

  updateRunMetrics();
  renderApprovalSpotlight();
  renderConversation();
  renderProcess();
  renderEvidenceRail();
  if (state.tab === 'report') renderReport();
  if (state.traceDrawerOpen) renderTrace();
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
      if (
        (run.conversation && run.status === 'awaiting_user')
        || ((run.status === 'complete' || run.status === 'partial') && run.reportReady)
      ) {
        showTab('report');
      }
      announce(statusNames[run.status]);
    }
    if (state.traceDrawerOpen) {
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
  state.highlightedClaimId = undefined;
  state.selectedTraceStepId = undefined;
  state.traceFilter = 'all';
  setSettingsOpen(false);
  localStorage.setItem('cwatch-selected-run', run.id);
  showView('workbench');

  setProfileRadio(run.profile);
  const radio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${run.mode}]`);
  if (radio) radio.checked = true;
  $<HTMLSelectElement>('permission').value = run.permission;

  populateProfileForm(run.task);
  permissionChanged();

  // Default to Editorial Report/Conversation unless an investigation is actively running without a report yet
  const defaultTab: MainTab = isInvestigation(run.task) && isActiveRun(run) && !run.reportReady ? 'process' : 'report';
  showTab(defaultTab);
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
  state.highlightedClaimId = undefined;
  state.domainFilterOpen = false;
  setTraceDrawer(false);
  setSettingsOpen(false);
  state.instructionDraft = seed && !isInvestigation(seed.task) ? seed.task.instruction : '';
  localStorage.removeItem('cwatch-selected-run');
  clearError();
  showView('workbench');

  setProfileRadio(seed ? (isInvestigation(seed.task) ? 'web' : 'agent') : 'agent');
  const defaultMode = seed?.mode ?? (state.bootstrap?.model.configured ? 'live' : 'replay');
  const radio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${defaultMode}]`);
  if (radio) radio.checked = true;
  $<HTMLSelectElement>('permission').value = seed?.permission ?? 'explore';

  populateProfileForm(seed?.task);
  permissionChanged();
  showTab('report');
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
  populateProfileForm(state.current?.task, true);
}

function renderSkillCheckboxes(): void {
  const bootstrap = state.bootstrap;
  if (!bootstrap) return;
  $('skill-options').innerHTML = bootstrap.skills.filter(skill => skill.enabled).map(skill => `
    <label class="option-chip" title="${escapeHtml(skill.description)}">
      <input type="checkbox" name="skill" value="${escapeHtml(skill.name)}">
      <span>${escapeHtml(skill.name)}</span>
    </label>`).join('')
    || '<p class="field-note">默认使用内置任务指导；可在「来源与连接」查看 Skill。</p>';
}

async function retryCurrentRun(): Promise<void> {
  const sourceRun = state.current;
  if (!sourceRun || state.submitting || isActiveRun(sourceRun)) return;
  clearError();
  state.submitting = true;
  renderRun();
  try {
    const task = structuredClone(sourceRun.task);
    let webDomains: string[] | undefined;
    if (sourceRun.mode === 'live') {
      task.taskId = (isInvestigation(task) ? 'web-' : 'task-') + Date.now();
      if (!isInvestigation(task) && task.allowedSources.includes('web')) {
        const parsed = parseDomains($<HTMLInputElement>('agent-web-domains').value);
        if (parsed.length) webDomains = parsed;
      }
    }
    const input: RunStartInput = {
      profile: sourceRun.profile,
      mode: sourceRun.mode,
      permission: sourceRun.permission,
      ...(!isInvestigation(task) && sourceRun.mode !== 'replay' ? { conversation: true } : {}),
      ...(webDomains?.length ? { webDomains } : {}),
      task,
      skills: [...document.querySelectorAll<HTMLInputElement>('input[name=skill]:checked')].map(inputEl => inputEl.value),
      limits: {
        timeoutMs: Math.max(Number($<HTMLInputElement>('timeout').value) || 300, 300) * 1000,
        maxTokens: Math.max(Number($<HTMLInputElement>('tokens').value) || 400000, 400000),
      },
    };
    const nextRun = await startRunApi(input);
    state.runs.unshift(nextRun);
    selectRun(nextRun);
    $('run-title').focus();
    announce('已重新启动任务。');
  } catch (error) {
    alertError(error);
  } finally {
    state.submitting = false;
    renderRun();
  }
}

// Form submission
$('run-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state.submitting) return;
  clearError();
  setSettingsOpen(false);
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
          task.competitor.id = rawId === defaultTask.competitor.id || !rawId
            ? (task.competitor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target-' + Date.now().toString(36))
            : rawId;
        } else {
          task.competitor.id = rawId || 'target-' + Date.now().toString(36);
        }
        const parsed = parseDomains($<HTMLInputElement>('domains').value);
        // Empty domain input defaults to open public HTTPS web search (`['*']`)!
        task.competitor.domains = parsed.length ? parsed : ['*'];
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
            const parsed = parseDomains($<HTMLInputElement>('agent-web-domains').value);
            // Blank means open public HTTPS (backend defaults to ['*'])
            if (parsed.length) webDomains = parsed;
          }
        }
      }

      if (isInvestigation(task) && Date.parse(task.window.start) >= Date.parse(task.window.end)) {
        throw Error('结束日期须晚于开始日期。');
      }
      if (isInvestigation(task) && !task.allowedSources.length) {
        throw Error('请至少开启联网搜索或选择一个扩展来源。');
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

// Compose mode, toggles & settings popover
$('new-run').addEventListener('click', () => newRun());
$('sidebar-new-run').addEventListener('click', () => newRun());

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="profile"]')) {
  radio.addEventListener('change', () => {
    populateProfileForm();
    if (!state.current) renderRun();
  });
}

$('toggle-web-search').addEventListener('change', syncWebToggleAndBadges);
$('agent-web-domains').addEventListener('input', syncWebToggleAndBadges);
$('domains').addEventListener('input', syncWebToggleAndBadges);

$('toggle-domain-filter').addEventListener('click', () => {
  state.domainFilterOpen = !state.domainFilterOpen;
  syncWebToggleAndBadges();
  if (state.domainFilterOpen) $<HTMLInputElement>('agent-web-domains').focus();
});

$('settings-toggle').addEventListener('click', () => setSettingsOpen(!state.settingsOpen));
$('composer-mode-badge').addEventListener('click', () => setSettingsOpen(!state.settingsOpen));

$('task-suggestions').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-template]');
  if (!button || state.current || !state.bootstrap?.profiles.some(profile => profile.id === button.dataset.template)) return;
  setProfileRadio(button.dataset.template!);
  const liveReady = Boolean(state.bootstrap.model.configured);
  if (button.dataset.enableWeb === 'true' && liveReady) {
    const liveRadio = document.querySelector<HTMLInputElement>('input[name=mode][value=live]');
    if (liveRadio) liveRadio.checked = true;
  }
  const prompt = button.dataset.prompt;
  if (prompt && liveReady && currentMode() === 'live') {
    state.instructionDraft = prompt;
  }
  populateProfileForm();
  if (button.dataset.template === 'agent' && currentMode() === 'live') {
    const webBox = $<HTMLInputElement>('toggle-web-search');
    if (!webBox.disabled && button.dataset.enableWeb !== undefined) {
      webBox.checked = button.dataset.enableWeb === 'true';
    }
    syncWebToggleAndBadges();
    $<HTMLTextAreaElement>('instruction').focus();
  } else if (button.dataset.template === 'web') {
    $<HTMLInputElement>('competitor-name').focus();
  }
  renderRun();
  announce('已选择' + profileDisplayName(currentProfile().id, currentProfile().name) + '。');
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

// Theme & Trace Slide-Over Drawer
$('theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('cwatch-theme', state.theme); } catch { /* ignore */ }
  applyTheme(true);
  announce(state.theme === 'dark' ? '已切换到深色模式。' : '已切换到浅色模式。');
});

$('toggle-trace-drawer').addEventListener('click', () => setTraceDrawer(!state.traceDrawerOpen));
$('close-trace-drawer').addEventListener('click', () => setTraceDrawer(false));
$('trace-backdrop').addEventListener('click', () => setTraceDrawer(false));

// Close popover or Trace drawer on Escape / outside click
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (state.traceDrawerOpen) {
      setTraceDrawer(false);
      $('toggle-trace-drawer').focus();
    } else if (state.settingsOpen) {
      setSettingsOpen(false);
      $('settings-toggle').focus();
    }
  }
});
document.addEventListener('click', event => {
  if (!state.settingsOpen) return;
  const target = event.target as HTMLElement;
  if (!target.closest('.settings-anchor') && !target.closest('#composer-mode-badge')) {
    setSettingsOpen(false);
  }
});

// Sidebar history search, select & delete
$('history-search').addEventListener('input', () => {
  state.historyQuery = $<HTMLInputElement>('history-search').value;
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

// 2-Tab Bar & Keyboard Navigation (report <-> process)
for (const button of document.querySelectorAll<HTMLElement>('[data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab as MainTab));
}
document.querySelector('[role=tablist]')!.addEventListener('keydown', event => {
  const key = (event as KeyboardEvent).key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  event.preventDefault();
  const names: MainTab[] = ['report', 'process'];
  const index = names.indexOf(state.tab);
  const next = key === 'Home' ? 0 : key === 'End' ? names.length - 1 : (index + (key === 'ArrowRight' ? 1 : names.length - 1)) % names.length;
  showTab(names[next]);
  $('tab-' + names[next]).focus();
});

// Inline Approval Spotlight Actions
$('approval-spotlight').addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-approve],[data-deny]');
  const run = state.current;
  if (!target || !run) return;
  const requestId = target.dataset.approve ?? target.dataset.deny!;
  target.disabled = true;
  void respondApprovalApi(run.id, requestId, Boolean(target.dataset.approve), target.dataset.hash!)
    .then(updateRun)
    .catch(error => { alertError(error); target.disabled = false; });
});

// Bidirectional Claim <-> Evidence Rail linkage
function highlightClaim(claimId: string, scrollTarget: 'evidence' | 'claim'): void {
  state.highlightedClaimId = state.highlightedClaimId === claimId ? undefined : claimId;
  renderReport();
  renderEvidenceRail();
  if (!state.highlightedClaimId) return;
  if (scrollTarget === 'evidence') {
    document.querySelector<HTMLElement>(`[data-evidence-claim="${CSS.escape(claimId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    document.querySelector<HTMLElement>(`[data-claim-id="${CSS.escape(claimId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

$('report-content').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('a, button, summary')) return;
  const claim = target.closest<HTMLElement>('[data-claim-id]');
  if (claim?.dataset.claimId) {
    highlightClaim(claim.dataset.claimId, 'evidence');
  }
});

$('evidence-rail').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('a, button')) return;
  const card = target.closest<HTMLElement>('[data-evidence-claim]');
  if (card?.dataset.evidenceClaim) {
    if (state.tab !== 'report') showTab('report');
    highlightClaim(card.dataset.evidenceClaim, 'claim');
  }
});

// Trace drawer interactions
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

// Global delegated actions (copy, jump tab, open trace drawer, clone run)
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

  if (target.closest('[data-open-trace]')) {
    setTraceDrawer(true);
    return;
  }

  if (target.closest('[data-retry-run]')) {
    void retryCurrentRun();
    return;
  }

  if (target.closest('[data-clone-run]') && state.current) {
    const run = state.current;
    newRun({ profile: run.profile, mode: run.mode, permission: run.permission, task: structuredClone(run.task) });
  }
});

setInterval(() => {
  updateRunMetrics();
  updateApprovalClocks();
}, 1000);

async function init(): Promise<void> {
  applyTheme();
  try {
    const bootstrap = await fetchBootstrap();
    state.bootstrap = bootstrap;
    state.runs = bootstrap.runs;
    setProfileRadio('agent');
    const defaultRadio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${bootstrap.model.configured ? 'live' : 'replay'}]`);
    if (defaultRadio) defaultRadio.checked = true;
    renderSkillCheckboxes();
    $('model-status').textContent = bootstrap.model.configured
      ? `${bootstrap.model.provider} · ${bootstrap.model.id}`
      : '离线演示模式 · 未配置 .env';
    setConnection('本地服务已连接');
    populateProfileForm();
    permissionChanged();
    renderSidebar();
    const selected = state.runs.find(run => run.id === localStorage.getItem('cwatch-selected-run'))
      ?? state.runs.find(isActiveRun)
      ?? state.runs[0];
    if (selected) selectRun(selected);
    else { showTab('report'); renderRun(); }
  } catch (error) {
    setConnection('本地服务未连接', false);
    alertError(error);
    $<HTMLButtonElement>('start-run').disabled = true;
  }
}

void init();
