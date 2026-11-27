import type { AgentTask } from '@cwatch/core/types';
import type { RunModelChoice, RunSnapshot, RunStartInput } from '@cwatch/core/types/runs';
import {
  cancelRunApi,
  deleteRunApi,
  endConversationApi,
  fetchBootstrap,
  fetchReportApi,
  respondApprovalApi,
  sendMessageApi,
  startRunApi,
  taskIntentApi,
} from './client/api.ts';
import {
  renderApprovalSpotlight,
  renderConversation,
  renderProcess,
  updateApprovalClocks,
} from './client/conversation.ts';
import { renderEvidenceRail } from './client/evidence-rail.ts';
import {
  closeConnectionEditor,
  closeSkillModal,
  handleDeleteMcp,
  handleDeleteProvider,
  handleDeleteSearch,
  handleDeleteSkill,
  handleTestMcp,
  handleToggleMcp,
  handleToggleSkill,
  inspectSkill,
  isConnectionEditorOpen,
  isSkillModalOpen,
  loadExtensions,
  openConnectionEditor,
  renderExtensions,
  saveConnection,
} from './client/extensions.ts';
import { renderMarkdown } from './client/markdown.ts';
import { bindResearchComparison, closeComparison, renderResearch } from './client/research.ts';
import { bindSpecifiedSources, fillSpecifiedSources, investigationStages, readSpecifiedSources, renderInvestigationAssessment } from './client/investigation-assessment.ts';
import { bindReportReview, currentReview, invalidateReview, markAnnotatedPassages, renderReportReview } from './client/report-workspace.ts';
import {
  renderLiveProgressCard,
  renderMetricsRibbon,
  renderPipeline,
  renderPipelineDetail,
  displayedPipelineStage,
  PIPELINE_STAGES,
  renderReportToc,
  renderReviewGateCard,
  renderVersionDiffCard,
} from './client/report-view.ts';
import { bindHistory, renderCapacity } from './client/sidebar.ts';
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
  langfuseTraceHref,
  permissionNames,
  safeUrl,
  sessionTitle,
  state,
  statusNames,
  statusTone,
  taskTitle,
  type MainTab,
} from './client/state.ts';

function applyTheme(instant = false): void {
  if (instant) document.documentElement.classList.add('theme-switching');
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  if (instant) {
    void document.documentElement.offsetHeight;
    document.documentElement.classList.remove('theme-switching');
  }
  $('theme-toggle').setAttribute('aria-pressed', String(state.theme === 'dark'));
}

function setSettingsOpen(open: boolean): void {
  state.settingsOpen = open;
  $('settings-popover').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-toggle').classList.toggle('is-active', open);
  if (open) $('settings-popover').focus();
}

function selectedTaskModel(): RunModelChoice | undefined {
  const option = $<HTMLSelectElement>('task-model').selectedOptions[0];
  const id = option?.dataset.modelId;
  if (!id || currentMode() === 'replay') return undefined;
  const reasoningEffort = option.dataset.reasoning === 'true'
    ? $<HTMLSelectElement>('task-reasoning').value as RunModelChoice['reasoningEffort']
    : undefined;
  const provider = option.dataset.provider;
  return { id, ...(provider ? { provider } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function renderTaskModels(choice?: RunModelChoice): void {
  const model = state.bootstrap!.model;
  const select = $<HTMLSelectElement>('task-model');
  const groups = [...(model.id ? [{ provider: model.provider, modelIds: model.availableIds, supportsReasoningEffort: model.supportsReasoningEffort, legacy: true }] : []),
    ...model.providers.map(provider => ({ ...provider, legacy: false }))];
  select.replaceChildren(...groups.map(group => {
    const options = document.createElement('optgroup');
    options.label = group.provider;
    for (const id of group.modelIds) {
      const option = new Option(id, group.legacy ? id : JSON.stringify([group.provider, id]));
      option.dataset.modelId = id;
      option.dataset.reasoning = String(group.supportsReasoningEffort);
      if (!group.legacy) option.dataset.provider = group.provider;
      options.append(option);
    }
    return options;
  }));
  if (!select.options.length) select.add(new Option('未配置模型', ''));
  const chosen = choice && [...select.options].find(option => option.dataset.modelId === choice.id && option.dataset.provider === choice.provider);
  if (chosen) chosen.selected = true;
  $<HTMLSelectElement>('task-reasoning').value = chosen?.dataset.reasoning === 'true' ? choice?.reasoningEffort ?? '' : '';
  const defaultProvider = model.providers[0];
  $('model-status').textContent = model.id ? `${model.provider} · ${model.id}` : defaultProvider
    ? `${defaultProvider.provider} · ${defaultProvider.modelIds[0]}` : '离线演示模式 · 未配置模型';
}

function setTaskEditorOpen(open: boolean): void {
  $('task-editor').hidden = !open;
  $('compose-view').dataset.editing = String(open);
  if (!open) setSettingsOpen(false);
}

function openTaskEditor(): void {
  if (!state.bootstrap) return;
  const replay = currentMode() === 'replay';
  const model = selectedTaskModel();
  const reasoning = $<HTMLSelectElement>('task-reasoning').selectedOptions[0]?.textContent;
  $('task-selected-profile').textContent = '调查模式';
  $('task-selection-summary').textContent = replay ? '离线演示' : model
    ? ['真实运行', model.id, `思考强度 ${reasoning}`].join(' · ')
    : '真实运行 · 未配置模型';
  $('task-details-title').textContent = replay ? '示例调查设置' : '调研范围';
  $('task-details-question').textContent = replay ? '确认预设调查内容后开始演示。' : '确认调研对象、时间范围与交付要求后即可开始调查。';
  setTaskEditorOpen(true);
  window.scrollTo(0, 0);
  $('task-details-title').focus();
}

function closeTaskEditor(): void {
  if (currentMode() === 'live') {
    const focus = $<HTMLTextAreaElement>('research-focus').value;
    $<HTMLTextAreaElement>('task-prompt').value = focus;
    state.investigationFormPrompt = focus.trim();
  }
  setTaskEditorOpen(false);
  clearError();
  $('task-prompt').focus();
}

let lastExportTrigger: HTMLElement | null = null;

function isExportModalOpen(): boolean {
  return !$('export-modal').hidden;
}

function closeExportModal(restoreFocus = false): void {
  const modal = $('export-modal');
  if (modal.hidden) return;
  modal.hidden = true;
  $('export-modal-backdrop').hidden = true;
  $('export-modal-body').replaceChildren();
  if (restoreFocus) {
    (lastExportTrigger?.isConnected ? lastExportTrigger : $('export-run')).focus();
  }
  lastExportTrigger = null;
}

function openExportModal(trigger?: HTMLElement | null): void {
  const run = state.current;
  if (!run?.reportReady) return;
  closeConnectionEditor(false);
  closeSkillModal(false);
  lastExportTrigger = trigger ?? null;

  const uniqueEvidence = new Set<string>();
  for (const claim of run.claims) {
    for (const ev of claim.evidence) {
      uniqueEvidence.add(ev.snapshotHash ? `${ev.url}|${ev.snapshotHash}` : `${ev.source}|${ev.url}|${ev.title}`);
    }
  }
  $('export-modal-sub').textContent = `${taskTitle(run.task)} · ${run.claims.length} 项主张 · ${uniqueEvidence.size} 份证据 · ${run.gaps.length} 项缺口`;

  const id = encodeURIComponent(run.id);
  const formats: Array<{ format: string; badge: string; title: string; desc: string }> = [
    { format: 'md', badge: 'MD', title: '完整 Markdown 草稿', desc: '含调研概要、完整报告正文、核验主张引用与信息缺口，适合 Notion / Obsidian / Git' },
    { format: 'html', badge: 'HTML', title: '独立排版网页', desc: '单文件自包含样式、4 维指标卡与可点击证据链接，发给同事双击即可打开' },
    { format: 'doc', badge: 'DOC', title: 'Word 文档', desc: '兼容 Word / WPS / 飞书文档导入，带表格与完整引用清单，方便汇报与二次编辑' },
    { format: 'csv', badge: 'CSV', title: '证据与主张明细表', desc: 'UTF-8 编码兼容 Excel，列出全部主张、来源域名、URL、发布时间与 SHA-256 核验状态' },
    { format: 'json', badge: 'JSON', title: '结构化数据包', desc: '完整机器可读 JSON（含任务、指标、审阅门禁、版本演进、主张与正文），便于归档' },
  ];

  $('export-modal-body').innerHTML = `
    <ul class="export-option-list" aria-label="草稿导出格式">
      ${formats.map(item => `
        <li class="export-option-item">
          <span class="export-ext-badge mono">${item.badge}</span>
          <div class="export-option-main">
            <strong>${item.title}</strong>
            <p>${item.desc}</p>
          </div>
          <a class="button secondary sm" data-export-format="${item.format}" href="/api/runs/${id}/export?format=${item.format}${state.savedReportMode ? '&amp;version=saved' : ''}" download>下载 .${item.format}</a>
        </li>`).join('')}
    </ul>
    <div class="export-quick-actions">
      <button type="button" class="button ghost sm" id="export-copy-report" data-copy-report>复制完整 Markdown</button>
      <button type="button" class="button ghost sm" data-print-report>打印 / 导出 PDF</button>
    </div>`;

  $('export-modal-backdrop').hidden = false;
  $('export-modal').hidden = false;
  $('export-modal').focus();
}

function syncHeaderControls(): void {
  const run = state.current;
  const hasRun = Boolean(run);
  const inWorkbench = state.view === 'workbench';
  const lfLink = $<HTMLAnchorElement>('langfuse-trace-link');
  const lfHref = hasRun && inWorkbench ? langfuseTraceHref(run) : undefined;
  lfLink.hidden = !lfHref;
  if (lfHref) {
    lfLink.href = lfHref;
    const lfStatus = run?.langfuse?.status;
    $('langfuse-trace-label').textContent = lfStatus === 'streaming'
      ? 'Langfuse Trace（实时）'
      : lfStatus === 'failed'
        ? 'Langfuse（上报异常）'
        : 'Langfuse Trace';
    lfLink.title = lfStatus === 'failed' && run?.langfuse?.error
      ? `Langfuse 上报异常：${run.langfuse.error}`
      : '在 Langfuse 中查看完整 Trace';
  } else {
    lfLink.removeAttribute('href');
  }
  $('new-run').hidden = state.view === 'research' || (!hasRun && inWorkbench);
  if (!hasRun || !inWorkbench) {
    if (isExportModalOpen()) closeExportModal();
  }
}

function setConnection(text: string, online = true): void {
  const el = $('connection');
  el.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
  el.classList.toggle('offline', !online);
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

const DEPTH_PRESETS = {
  fast: { label: '快速速览', tokens: 250000, summary: '25 万 tokens' },
  standard: { label: '标准核验', tokens: 750000, summary: '75 万 tokens' },
  deep: { label: '深度穷举', tokens: 1500000, summary: '150 万 tokens' },
} as const;
type DepthPresetKey = keyof typeof DEPTH_PRESETS;

function buildRunLimits(toolTimeoutSec: number, maxTokens: number): NonNullable<RunStartInput['limits']> {
  return { toolTimeoutMs: toolTimeoutSec * 1000, maxTokens };
}
const quickLookupLimits = { maxTokens: 250_000, maxToolCalls: 5, maxSameToolCalls: 3 };

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function windowPresetDates(days: number): { start: string; end: string } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 - days);
  return { start: formatLocalDate(start), end: formatLocalDate(end) };
}

function syncWindowPresetState(): void {
  const replay = currentMode() === 'replay';
  const startVal = $<HTMLInputElement>('start-date').value;
  const endVal = $<HTMLInputElement>('end-date').value;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-window-days]')) {
    btn.disabled = replay;
    const days = Number(btn.dataset.windowDays);
    const matched = !replay && Number.isFinite(days) && days > 0 && (() => {
      const range = windowPresetDates(days);
      return range.start === startVal && range.end === endVal;
    })();
    btn.classList.toggle('is-active', matched);
    btn.setAttribute('aria-pressed', String(matched));
  }
}

function applyWindowPreset(days: number): void {
  if (currentMode() === 'replay' || !Number.isFinite(days) || days <= 0) return;
  const { start, end } = windowPresetDates(days);
  $<HTMLInputElement>('start-date').value = start;
  $<HTMLInputElement>('end-date').value = end;
  syncWindowPresetState();
}

function syncDepthPresetState(): void {
  const tokens = Number($<HTMLInputElement>('tokens').value);
  let matchedKey: DepthPresetKey | undefined;
  for (const key of Object.keys(DEPTH_PRESETS) as DepthPresetKey[]) {
    const preset = DEPTH_PRESETS[key];
    if (preset.tokens === tokens) {
      matchedKey = key;
      break;
    }
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-depth-preset]')) {
    const active = btn.dataset.depthPreset === matchedKey;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  const summaryEl = $('depth-preset-summary');
  if (summaryEl) {
    summaryEl.textContent = matchedKey
      ? DEPTH_PRESETS[matchedKey].summary
      : `自定义（${Number.isFinite(tokens) && tokens > 0 ? tokens.toLocaleString() : '—'} tokens）`;
  }
}

function applyDepthPreset(key: DepthPresetKey): void {
  const preset = DEPTH_PRESETS[key];
  $<HTMLInputElement>('tokens').value = String(preset.tokens);
  syncDepthPresetState();
}

function syncWebToggleAndBadges(): void {
  const replay = currentMode() === 'replay';
  const webCheckbox = $<HTMLInputElement>('toggle-web-search');
  const webLabel = $('web-toggle-label');
  const webSourceActive = Boolean(currentProfile().sources.find(s => s.slug === 'web')?.active);

  webCheckbox.disabled = replay || !webSourceActive;
  const webEnabled = webCheckbox.checked && !webCheckbox.disabled;
  webLabel.classList.toggle('is-on', webEnabled);
  webLabel.classList.toggle('is-disabled', webCheckbox.disabled);

  const invDomains = parseDomains($<HTMLInputElement>('domains').value);
  const configured = Boolean(state.bootstrap?.model.configured);
  const domainCount = invDomains.length;
  const startNote = $('start-note');
  const summary = replay
    ? '演示使用预设调查任务，可直接运行。'
    : !configured
      ? '在「来源与连接」添加模型供应商，或配置本机 .env 后即可真实运行。'
      : webEnabled
        ? domainCount ? `联网搜索已开启，范围限定为 ${domainCount} 个域名。` : '联网搜索已开启，范围为公开网页。'
        : '联网搜索已关闭（请启用联网搜索或扩展 MCP 来源）。';

  if (startNote.textContent !== summary) startNote.textContent = summary;

  const perm = $<HTMLSelectElement>('permission').value;
  const settingsBadge = $('settings-badge');
  const note = perm === 'ask' ? '需审批' : perm === 'allow-all' ? '免审批' : '';
  settingsBadge.hidden = !note;
  settingsBadge.textContent = note;
}

function populateProfileForm(task = currentProfile().task, preserveWebChoice = false): void {
  const replay = currentMode() === 'replay';
  const invTask = isInvestigation(task) ? task : currentProfile().task;
  if (isInvestigation(invTask)) {
    $<HTMLInputElement>('competitor-name').value = invTask.competitor.name;
    $<HTMLInputElement>('competitor-id').value = invTask.competitor.id;
    $<HTMLInputElement>('product').value = invTask.product;
    const displayDomains = invTask.competitor.domains.filter(d => d !== '*');
    $<HTMLInputElement>('domains').value = replay || invTask !== currentProfile().task ? displayDomains.join(', ') : '';
    $<HTMLInputElement>('start-date').value = invTask.window.start.slice(0, 10);
    $<HTMLInputElement>('end-date').value = invTask.window.end.slice(0, 10);
    $<HTMLTextAreaElement>('research-focus').value = invTask.researchBrief?.focus ?? '';
    $<HTMLTextAreaElement>('task-deliverable').value = invTask.researchBrief?.deliverable ?? '';
    fillSpecifiedSources(invTask.evidencePolicy);
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name=signal-type]')) {
      input.checked = invTask === currentProfile().task || invTask.signalTypes.some(type => type === input.value);
    }
  }

  // Primary web search checkbox
  const webSource = currentProfile().sources.find(s => s.slug === 'web');
  const webBox = $<HTMLInputElement>('toggle-web-search');
  if (!preserveWebChoice) {
    if (replay) {
      webBox.checked = Boolean(webSource?.active && invTask.allowedSources.includes('web'));
    } else {
      webBox.checked = Boolean(webSource?.active && (invTask.allowedSources.includes('web') || !state.current));
    }
  }

  // Secondary custom MCP sources tucked inside Settings Popover
  const extraSources = currentProfile().sources.filter(s => s.slug !== 'web');
  $('custom-source-section').hidden = extraSources.length === 0;
  $('custom-source-options').innerHTML = extraSources.map(source => `
    <label class="option-chip">
      <input type="checkbox" name="source" value="${escapeHtml(source.slug)}" ${source.active && invTask.allowedSources.includes(source.slug) ? 'checked ' : ''}${!source.active ? 'disabled ' : ''}>
      <span>${escapeHtml(source.name)}</span>
    </label>`).join('');

  modeChanged(true);
}

function modeChanged(resetInstruction = false): void {
  const mode = currentMode();
  const replay = mode === 'replay';
  const configured = state.bootstrap?.model.configured;
  const profile = currentProfile();
  const task = profile.task;

  for (const id of ['competitor-name', 'product', 'domains', 'start-date', 'end-date']) {
    $<HTMLInputElement>(id).readOnly = replay;
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('#custom-source-options input[name=source]')) {
    input.disabled = replay || !profile.sources.find(source => source.slug === input.value)?.active;
  }

  if (resetInstruction && !state.current) {
    const webSource = profile.sources.find(s => s.slug === 'web');
    const webBox = $<HTMLInputElement>('toggle-web-search');
    if (replay) {
      webBox.checked = Boolean(webSource?.active && task.allowedSources.includes('web'));
    } else if (webSource?.active && !webBox.checked) {
      webBox.checked = true;
    }
  }

  syncWebToggleAndBadges();
  syncWindowPresetState();
  syncDepthPresetState();

  const examples = $('task-suggestions');
  examples.hidden = !state.bootstrap;
  for (const example of examples.querySelectorAll<HTMLButtonElement>('[data-template]')) {
    const exampleMode = example.dataset.exampleMode;
    example.hidden = Boolean(exampleMode && exampleMode !== (configured ? 'live' : 'replay'));
  }

  const supportsReasoning = $<HTMLSelectElement>('task-model').selectedOptions[0]?.dataset.reasoning === 'true';
  const blocked = !replay && !configured;
  const homePrompt = $<HTMLTextAreaElement>('task-prompt');
  homePrompt.readOnly = replay || state.submitting;
  homePrompt.placeholder = replay
    ? '离线演示使用预设调查任务，点击右侧按钮继续。'
    : '例如，帮我看看工作区里的 README.md…';
  $<HTMLSelectElement>('task-runtime').disabled = state.submitting;
  $<HTMLSelectElement>('task-model').disabled = replay || blocked || state.submitting;
  $<HTMLSelectElement>('task-reasoning').disabled = replay || blocked || state.submitting || !supportsReasoning;
  if (!supportsReasoning) $<HTMLSelectElement>('task-reasoning').value = '';
  const deciding = $('task-setup').getAttribute('aria-busy') === 'true';
  $('mode-note').hidden = !deciding && !blocked && !replay && supportsReasoning;
  $('mode-note').textContent = deciding ? '正在判断任务类型…' : replay
    ? '离线演示使用预设调查任务和合成快照。'
    : blocked
      ? '请先在「来源与连接」添加模型供应商，或在 .env 配置模型凭据。'
      : supportsReasoning
        ? '可用模型来自本机与工作台配置，思考强度由所选模型服务支持。'
        : '当前模型连接使用模型默认思考强度。';
  for (const question of document.querySelectorAll<HTMLElement>('[data-live-question]')) question.hidden = replay;
  $<HTMLButtonElement>('task-next').disabled = state.submitting;
  $<HTMLButtonElement>('start-run').disabled = state.submitting || blocked;
  $<HTMLButtonElement>('task-back').disabled = state.submitting;
}

function permissionChanged(): void {
  const value = $<HTMLSelectElement>('permission').value;
  $('permission-note').textContent = value === 'explore'
    ? '真实调查需要确认计划。可读取与联网搜索，禁止修改、发送或发布。'
    : value === 'ask'
      ? '调查计划、写入、发送和发布均需要你的确认。'
      : '调查计划需要你的确认。已配置的操作由 Agent 自动执行。';
  syncWebToggleAndBadges();
  syncWindowPresetState();
  syncDepthPresetState();
}

function showView(view: typeof state.view): void {
  state.view = view;
  const showingConnections = view === 'connections';
  const showingResearch = view === 'research';
  if (!showingResearch) closeComparison();
  $('connections-panel').hidden = !showingConnections;
  if (!showingConnections) {
    closeConnectionEditor();
    closeSkillModal();
  }
  $('research-view').hidden = !showingResearch;
  document.querySelector<HTMLElement>('.workbench')!.hidden = view !== 'workbench';
  $('nav-sources').classList.toggle('selected', showingConnections);
  $('nav-workbench').classList.toggle('selected', view === 'workbench');
  $('nav-research').classList.toggle('selected', showingResearch);
  $('nav-sources').setAttribute('aria-expanded', String(showingConnections));
  $('mobile-sources').setAttribute('aria-expanded', String(showingConnections));
  $('mobile-research').setAttribute('aria-expanded', String(showingResearch));
  if (view === 'workbench') $('mobile-workbench').setAttribute('aria-current', 'page');
  else $('mobile-workbench').removeAttribute('aria-current');
  if (showingResearch) $('nav-research').setAttribute('aria-current', 'page');
  else $('nav-research').removeAttribute('aria-current');
  if (view !== 'workbench') {
    setSettingsOpen(false);
    closeExportModal();
  }
  if (showingConnections) {
    $('page-title').textContent = '工作区扩展';
    void loadExtensions();
    renderExtensions();
  } else if (showingResearch) {
    $('page-title').textContent = '我的调研';
    renderResearch();
  } else {
    const run = state.current;
    $('page-title').textContent = !run ? '新建任务' : isInvestigation(run.task) ? '产品调查' : '通用任务';
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
  renderPipelineSection();
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
    run.model?.id,
    `${run.toolCalls} 次工具`,
    `${run.modelTurns} 轮模型`,
    run.totalTokens ? `${run.totalTokens.toLocaleString()} tokens` : null,
    formatElapsed(run.createdAt, run.endedAt),
  ].filter(Boolean);
  el.textContent = parts.join(' · ');
}

function renderReport(): void {
  const run = state.current;
  const review = run && currentReview(run, renderReport);
  renderReportReview(run, review);
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
    if (run && isActiveRun(run)) {
      $('report-content').innerHTML = renderLiveProgressCard(run, displayedPipelineStage(run, state.selectedPipelineStage) === undefined);
      return;
    }
    const domain = isInvestigation(run?.task ?? currentProfile().task);
    const failedOrStopped = Boolean(run && ['failed', 'cancelled', 'unknown'].includes(run.status));
    $('report-content').innerHTML = `
      <div class="empty-state">
        <h3>${escapeHtml(failedOrStopped ? '本次运行未生成结果' : '正在生成结果…')}</h3>
        <p>${run?.stoppedAtStage ? `${escapeHtml(investigationStages[run.stoppedAtStage] ?? run.stoppedAtStage)}阶段结束。` : ''}${escapeHtml(run?.error ?? (domain ? '采集、分析与审阅完成后，带引用的调查报告将自动呈现在这里。' : '任务完成后，回答内容将在这里展示，并支持复制与导出。'))}</p>
        ${failedOrStopped ? `<div class="empty-actions"><button type="button" class="button primary sm" data-retry-run ${state.submitting ? 'disabled' : ''}>尝试重试</button><button type="button" class="button secondary sm" data-clone-run>修改配置</button></div>` : ''}
      </div>`;
    return;
  }

  const doc = run.reportReview ? review?.markdown : state.reportCache.get(run.id);
  if (doc === undefined && !run.reportReview) void loadReport(run);

  if (!isInvestigation(run.task)) {
    const tocHtml = doc !== undefined ? renderReportToc(doc) : '';
    $('report-content').innerHTML = `
      <div class="report-card">
        <div class="report-heading">
          <h3>任务结果</h3>
          <span class="report-mode">${run.mode === 'replay' ? '固定脚本演示' : 'Agent 回答'}</span>
        </div>
        ${run.gaps.length ? `<div class="run-notice">${run.gaps.map(escapeHtml).join('<br>')}</div>` : ''}
        ${tocHtml}
        <div class="report-document md-body">${doc === undefined ? '<p class="field-note">正在读取…</p>' : renderMarkdown(doc)}</div>
        <div class="report-actions">
          <button type="button" class="button primary sm" data-open-export>导出草稿</button>
          <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report" download="agent-result.md">下载 Markdown 结果</a>
          <button type="button" class="button secondary sm" id="copy-report" data-copy-report>复制完整报告</button>
          <button type="button" class="button secondary sm" id="print-report" data-print-report>打印 / 导出 PDF</button>
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

  const metricsHtml = renderMetricsRibbon(run);
  const reviewGateHtml = renderReviewGateCard(run);
  const versionDiffHtml = renderVersionDiffCard(run);
  const tocHtml = doc !== undefined ? renderReportToc(doc) : '';

  $('report-content').innerHTML = `
    <div class="report-card">
      ${metricsHtml}
      ${reviewGateHtml}
      ${renderInvestigationAssessment(run)}
      ${versionDiffHtml}
      <div class="report-heading">
        <div>
          <h3 class="serif-sub">${(state.savedReportMode ? review?.savedRevision : review?.revision) ? '原始核验主张与引用' : '调查结论与引用'}</h3>
          <p class="report-sub-hint">点击任意主张卡片，可联动高亮右侧对应证据来源。</p>
        </div>
        <span class="report-mode">${run.mode === 'replay' ? '合成快照 · 演示' : '本地草稿 · 待核对'}</span>
      </div>
      ${claimsHtml}
      <div class="report-actions">
        <button type="button" class="button primary sm" data-open-export>导出草稿</button>
        <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/report${state.savedReportMode ? '?version=saved' : ''}" download="competitor-report.md">下载 Markdown 报告</a>
        <button type="button" class="button secondary sm" id="copy-report" data-copy-report>复制完整报告</button>
        <button type="button" class="button secondary sm" id="print-report" data-print-report>打印 / 导出 PDF</button>
      </div>
      <details class="report-full" open>
        <summary>完整调查报告正文</summary>
        ${tocHtml}
        <div class="report-document md-body">${doc === undefined ? '<p class="field-note">正在读取报告…</p>' : renderMarkdown(doc)}</div>
      </details>
    </div>`;
  if (review) markAnnotatedPassages(review);
}

function renderPipelineSection(): void {
  const run = state.current;
  const investigation = Boolean(run && isInvestigation(run.task));
  const bar = $('pipeline');
  const detail = $('pipeline-detail');
  const content = $('pipeline-detail-content');
  const approval = $('approval-spotlight');
  const stage = run && displayedPipelineStage(run, state.selectedPipelineStage);
  const planPending = Boolean(run?.approvals.some(request => request.tool === 'workflow__save_plan'));
  const approvalVisible = !investigation || stage === undefined || stage === (planPending ? 0 : run?.stage);
  if (investigation && approvalVisible && stage !== undefined) {
    if (approval.parentElement !== detail) detail.append(approval);
  } else if (approval.parentElement === detail) {
    detail.after(approval);
  }
  renderApprovalSpotlight(approvalVisible);
  bar.hidden = !investigation;
  if (!investigation || !run) {
    bar.innerHTML = '';
    delete bar.dataset.rendered;
    detail.hidden = true;
    content.innerHTML = '';
    return;
  }
  const buttons = renderPipeline(run, stage);
  if (bar.dataset.rendered !== buttons) {
    const focusedStage = (document.activeElement as HTMLElement | null)?.dataset.pipelineStage;
    bar.innerHTML = buttons;
    bar.dataset.rendered = buttons;
    if (focusedStage !== undefined) bar.querySelector<HTMLButtonElement>(`[data-pipeline-stage="${focusedStage}"]`)?.focus({ preventScroll: true });
  }
  detail.hidden = stage === undefined;
  const collapsible = state.selectedPipelineStage !== undefined && !(stage === 0 && (planPending || run.planApproval?.status === 'revising'));
  content.innerHTML = stage === undefined ? '' : renderPipelineDetail(run, stage, state.tab === 'report', collapsible);
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
    renderReportReview();
    renderPipelineSection();
    renderEvidenceRail();
    return;
  }

  $('run-title').textContent = sessionTitle(run);
  const labelText = `${statusNames[run.status]} / ${run.mode === 'replay' ? '离线演示' : run.conversation ? '真实会话' : investigation ? '真实调查' : '真实任务'}`;
  const label = $('run-label');
  label.textContent = labelText;
  label.className = 'run-label tone-' + statusTone(run.status);

  $('tab-report').textContent = investigation ? '调查报告' : '任务结果';
  $('export-run').hidden = !run.reportReady;
  $('cancel-run').textContent = investigation ? '停止调查' : '停止任务';
  $('cancel-run').hidden = !isActiveRun(run);
  $<HTMLButtonElement>('cancel-run').disabled = run.status === 'cancelling';

  const canRetry = ['failed', 'cancelled', 'unknown', 'partial'].includes(run.status);
  $('retry-run').hidden = !canRetry;
  $<HTMLButtonElement>('retry-run').disabled = state.submitting;

  renderPipelineSection();

  const lfNote = run.langfuse?.status === 'failed' ? ' · Langfuse 上报失败' : '';
  $('run-footer-text').textContent = `${permissionNames[run.permission] ?? run.permission} · 工具调用均经主进程门禁留痕${lfNote}`;
  $('provenance-label').textContent = run.mode === 'replay' ? '合成数据演示' : '来源与引用请人工核验';

  updateRunMetrics();
  renderConversation();
  renderProcess();
  renderEvidenceRail();
  if (state.tab === 'report') renderReport();
  else renderReportReview(run);
  updateApprovalClocks();
}

function updateRun(run: RunSnapshot): void {
  const previousStatus = state.current?.status;
  const index = state.runs.findIndex(item => item.id === run.id);
  const previous = state.runs[index];
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
    renderRun();
  }
  renderCapacity();
  if (state.view === 'connections') renderExtensions();
  if (state.view === 'research' && (run.reportReview?.savedAt !== previous?.reportReview?.savedAt || run.status !== previous?.status)) renderResearch();
}

function selectRun(run: RunSnapshot, fromResearch = false): void {
  state.stream?.close();
  state.current = run;
  state.savedReportMode = fromResearch;
  invalidateReview(run.id);
  $('back-to-research').hidden = !fromResearch;
  state.highlightedClaimId = undefined;
  state.selectedPipelineStage = undefined;
  closeExportModal();
  setTaskEditorOpen(false);
  localStorage.setItem('cwatch-selected-run', run.id);
  showView('workbench');

  $<HTMLSelectElement>('task-runtime').value = run.mode;
  $<HTMLSelectElement>('permission').value = run.permission;
  renderTaskModels(run.model);

  populateProfileForm(run.task);
  permissionChanged();

  // Default to Editorial Report/Conversation unless an investigation is actively running without a report yet
  const defaultTab: MainTab = isInvestigation(run.task) && isActiveRun(run) && !run.reportReady ? 'process' : 'report';
  showTab(defaultTab);
  renderCapacity();
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

function newRun(seed?: { profile: string; mode: 'live' | 'replay'; permission: string; task: AgentTask; model?: RunModelChoice; projectId?: string }, projectId = seed?.projectId): void {
  if (!state.bootstrap || state.submitting) return;
  state.stream?.close();
  state.current = undefined;
  state.savedReportMode = false;
  state.composeProjectId = projectId;
  const project = state.projects.find(item => item.id === projectId);
  $('compose-project').hidden = !project;
  $('compose-project').textContent = project ? `新会话将加入 ${project.name}` : '';
  state.highlightedClaimId = undefined;
  state.selectedPipelineStage = undefined;
  state.domainFilterOpen = false;
  closeExportModal();
  setTaskEditorOpen(false);
  const investigation = seed && isInvestigation(seed.task) ? seed.task : undefined;
  state.investigationFormPrompt = investigation?.researchBrief?.focus?.trim();
  localStorage.removeItem('cwatch-selected-run');
  clearError();
  showView('workbench');

  const defaultMode = seed?.mode ?? (state.bootstrap?.model.configured ? 'live' : 'replay');
  $<HTMLSelectElement>('task-runtime').value = defaultMode;
  const prompt = seed && !isInvestigation(seed.task) ? seed.task.instruction.slice(0, 2000) : investigation?.researchBrief?.focus ?? '';
  $<HTMLTextAreaElement>('task-prompt').value = prompt;
  $<HTMLSelectElement>('permission').value = seed?.permission ?? 'explore';
  renderTaskModels(seed?.model);

  populateProfileForm(investigation);
  permissionChanged();
  showTab('report');
  renderCapacity();
  renderRun();
  window.scrollTo(0, 0);
  announce('可以新建任务。');
}

async function handleDeleteRun(runId: string): Promise<void> {
  const run = state.runs.find(item => item.id === runId);
  if (!run || isActiveRun(run) || state.deletingRunIds.has(runId)) return;
  const consequences = run.reportReview?.savedAt ? '此会话和「我的调研」中的已保存报告将一并删除。' : '此会话的消息、草稿与标注将一并删除。';
  if (!window.confirm(`删除会话「${sessionTitle(run)}」？\n${consequences} 此操作无法撤销。`)) return;
  state.deletingRunIds.add(runId);
  clearError();
  renderResearch();
  renderCapacity();
  try {
    await deleteRunApi(runId);
    state.runs = state.runs.filter(r => r.id !== runId);
    state.reportCache.delete(runId);
    invalidateReview(runId);
    state.drafts.delete(runId);
    if (state.current?.id === runId) {
      const wasBrowsingResearch = state.view === 'research';
      const next = state.runs.find(item => item.projectId === run.projectId) ?? state.runs[0];
      if (next) selectRun(next);
      else newRun(undefined, run.projectId);
      if (wasBrowsingResearch) showView('research');
    }
    announce('会话已删除。');
  } catch (error) {
    alertError(error);
  } finally {
    state.deletingRunIds.delete(runId);
    renderCapacity();
    if (state.view === 'research') renderResearch();
  }
}

async function refreshBootstrapQuietly(): Promise<void> {
  const model = selectedTaskModel();
  const wasConfigured = state.bootstrap?.model.configured;
  const bootstrap = await fetchBootstrap();
  state.bootstrap = bootstrap;
  if (!wasConfigured && bootstrap.model.configured && !state.current) $<HTMLSelectElement>('task-runtime').value = 'live';
  renderTaskModels(model);
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
  if (sourceRun.profile === 'agent' && sourceRun.mode === 'live' && sourceRun.permission === 'explore' && !sourceRun.conversation
      && !isInvestigation(sourceRun.task) && !sourceRun.task.context && sourceRun.task.allowedSources.length === 1 && sourceRun.task.allowedSources[0] === 'web'
      && sourceRun.error?.startsWith('budget_timeout') && sourceRun.task.instruction.length <= 2000) {
    newRun(sourceRun);
    await submitTaskPrompt(sourceRun.task.instruction);
    return;
  }
  clearError();
  state.submitting = true;
  renderRun();
  try {
    const task = structuredClone(sourceRun.task);
    if (sourceRun.mode === 'live') {
      task.taskId = (isInvestigation(task) ? 'web-' : 'task-') + Date.now();
    }
    const input: RunStartInput = {
      profile: sourceRun.profile,
      mode: sourceRun.mode,
      permission: sourceRun.permission,
      ...(sourceRun.projectId ? { projectId: sourceRun.projectId } : {}),
      ...(sourceRun.model ? { model: sourceRun.model } : {}),
      ...(sourceRun.conversation ? { conversation: true } : {}),
      ...(sourceRun.mode === 'live' && isInvestigation(task) ? { requirePlanApproval: true } : {}),
      task,
      skills: [...document.querySelectorAll<HTMLInputElement>('input[name=skill]:checked')].map(inputEl => inputEl.value),
      limits: buildRunLimits(
        Number($<HTMLInputElement>('tool-timeout').value) || 120,
        Math.max(Number($<HTMLInputElement>('tokens').value) || DEPTH_PRESETS.standard.tokens, 100),
      ),
    };
    const nextRun = await startRunApi(input);
    state.runs.unshift(nextRun);
    selectRun(nextRun);
    $('run-title').focus();
    announce(isInvestigation(task) ? '已重新启动调查。' : '已重新启动任务。');
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
  if (state.submitting || $('task-editor').hidden) return;
  clearError();
  setSettingsOpen(false);
  void (async () => {
    state.submitting = true;
    modeChanged();
    try {
      const profile = currentProfile();
      const replay = currentMode() === 'replay';
      const task = structuredClone(profile.task);
      const deliverable = replay ? '' : $<HTMLTextAreaElement>('task-deliverable').value.trim();
      const model = selectedTaskModel();

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
        task.evidencePolicy = readSpecifiedSources();
        if (task.evidencePolicy.sources.length && !task.allowedSources.includes('web')) throw Error('使用指定的网址需要开启联网搜索。');
        if (task.evidencePolicy.scope === 'only' && task.allowedSources.some(source => source !== 'web')) throw Error('选择「只查指定网址」时请关闭其他扩展来源。');
        if (task.evidencePolicy.scope === 'only') task.competitor.domains = [...new Set(task.evidencePolicy.sources.map(source => new URL(source.url).hostname))];
        task.signalTypes = [...document.querySelectorAll<HTMLInputElement>('input[name=signal-type]:checked')].map(input => input.value as typeof task.signalTypes[number]);
        if (!task.signalTypes.length) throw Error('请至少选择一种关注类型。');
        const focus = $<HTMLTextAreaElement>('research-focus').value.trim();
        if (focus || deliverable) task.researchBrief = { ...(focus ? { focus } : {}), ...(deliverable ? { deliverable } : {}) };
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
        ...(!replay && isInvestigation(task) ? { requirePlanApproval: true } : {}),
        ...(state.composeProjectId ? { projectId: state.composeProjectId } : {}),
        ...(model ? { model } : {}),
        task,
        skills: [...document.querySelectorAll<HTMLInputElement>('input[name=skill]:checked')].map(input => input.value),
        limits: buildRunLimits(
          Number($<HTMLInputElement>('tool-timeout').value),
          Number($<HTMLInputElement>('tokens').value),
        ),
      };

      const run = await startRunApi(input);
      state.runs.unshift(run);
      selectRun(run);
      $('run-title').focus();
      announce('调查已启动。');
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

async function submitTaskPrompt(prompt: string): Promise<void> {
  const model = selectedTaskModel();
  const composer = $('task-setup');
  state.submitting = true;
  composer.setAttribute('aria-busy', 'true');
  announce('正在判断任务类型。');
  modeChanged();
  try {
    const intent = await taskIntentApi({ instruction: prompt, ...(model ? { model } : {}) });
    if (state.current || state.view !== 'workbench') return;
    if (intent.kind === 'investigation') {
      populateProfileForm();
      $<HTMLInputElement>('competitor-name').value = intent.competitor ?? '';
      $<HTMLInputElement>('product').value = intent.product ?? '';
      $<HTMLInputElement>('start-date').value = '';
      $<HTMLInputElement>('end-date').value = '';
      $<HTMLTextAreaElement>('research-focus').value = prompt;
      syncWindowPresetState();
      openTaskEditor();
      return;
    }
    const run = await startRunApi({
      profile: 'agent', mode: 'live', permission: 'explore',
      ...(state.composeProjectId ? { projectId: state.composeProjectId } : {}),
      ...(model ? { model } : {}),
      ...(intent.needsWeb ? { limits: quickLookupLimits } : {}),
      task: { kind: 'agent', taskId: 'task-' + Date.now(), instruction: prompt, allowedSources: intent.needsWeb ? ['web'] : [] },
    });
    state.runs.unshift(run);
    selectRun(run);
    $('run-title').focus();
    announce('任务已启动。');
  } catch (error) {
    alertError(error);
  } finally {
    composer.removeAttribute('aria-busy');
    state.submitting = false;
    modeChanged();
  }
}

for (const id of ['new-run', 'sidebar-new-run']) {
  $(id).addEventListener('click', () => { newRun(); $('task-prompt').focus(); });
}
$('task-setup').addEventListener('submit', event => {
  event.preventDefault();
  if (!state.bootstrap || state.submitting || state.current) return;
  const input = $<HTMLTextAreaElement>('task-prompt');
  const prompt = input.value.trim();
  if (prompt.length > input.maxLength && currentMode() === 'live') {
    alertError(`调研重点最多支持 ${input.maxLength} 个字符。`);
    input.focus();
    return;
  }
  clearError();
  if (currentMode() === 'live' && prompt && prompt !== state.investigationFormPrompt) {
    if (state.bootstrap.model.configured) void submitTaskPrompt(prompt);
    else alertError('请先在「来源与连接」添加模型供应商，或在 .env 配置模型凭据。');
    return;
  }
  if (currentMode() === 'live' && !prompt) $<HTMLTextAreaElement>('research-focus').value = '';
  openTaskEditor();
});
$('task-prompt').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  $<HTMLFormElement>('task-setup').requestSubmit();
});
$('task-back').addEventListener('click', closeTaskEditor);

$('toggle-web-search').addEventListener('change', syncWebToggleAndBadges);
$('domains').addEventListener('input', syncWebToggleAndBadges);

$('settings-toggle').addEventListener('click', () => setSettingsOpen(!state.settingsOpen));

$('task-suggestions').addEventListener('click', event => {
  if (state.submitting) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-template]');
  if (!button || button.hidden || state.current) return;
  newRun(undefined, state.composeProjectId);
  const replay = currentMode() === 'replay';
  if (!replay && button.dataset.company) {
    $<HTMLInputElement>('competitor-name').value = button.dataset.company;
    $<HTMLInputElement>('product').value = button.dataset.product ?? '';
    $<HTMLTextAreaElement>('research-focus').value = button.dataset.focus ?? '';
    $<HTMLTextAreaElement>('task-prompt').value = button.dataset.focus ?? '';
    const signal = button.dataset.signal;
    if (signal) {
      for (const input of document.querySelectorAll<HTMLInputElement>('input[name=signal-type]')) {
        input.checked = input.value === signal;
      }
    }
    applyWindowPreset(30);
  }
  openTaskEditor();
  announce('已填入产品调查示例。');
});

$('run-form').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('task-editor').hidden && !$<HTMLButtonElement>('start-run').disabled) {
    event.preventDefault();
    $<HTMLFormElement>('run-form').requestSubmit();
  }
});
$('task-runtime').addEventListener('change', () => modeChanged(true));
$('task-model').addEventListener('change', () => modeChanged());
$('permission').addEventListener('change', permissionChanged);

// Quick Date Window & 3-Tier Depth Presets
$('task-details').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const windowBtn = target.closest<HTMLButtonElement>('[data-window-days]');
  if (windowBtn) {
    applyWindowPreset(Number(windowBtn.dataset.windowDays));
    return;
  }
  const depthBtn = target.closest<HTMLButtonElement>('[data-depth-preset]');
  if (depthBtn) {
    const key = depthBtn.dataset.depthPreset as DepthPresetKey;
    if (key in DEPTH_PRESETS) applyDepthPreset(key);
  }
});
$('start-date').addEventListener('input', syncWindowPresetState);
$('start-date').addEventListener('change', syncWindowPresetState);
$('end-date').addEventListener('input', syncWindowPresetState);
$('end-date').addEventListener('change', syncWindowPresetState);
$('tokens').addEventListener('input', syncDepthPresetState);
$('tokens').addEventListener('change', syncDepthPresetState);

// Interactive 5-Stage Pipeline & Detail Panel
$('pipeline').addEventListener('click', event => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pipeline-stage]');
  if (!btn || !state.current) return;
  const stageIndex = Number(btn.dataset.pipelineStage);
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= PIPELINE_STAGES.length) return;
  state.selectedPipelineStage = state.selectedPipelineStage === stageIndex ? undefined : stageIndex;
  renderPipelineSection();
  renderProcess();
  if (state.tab === 'report' && !state.current.reportReady) renderReport();
});
$('pipeline-detail').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-close-pipeline-detail]')) {
    const stageIndex = state.selectedPipelineStage;
    state.selectedPipelineStage = undefined;
    renderPipelineSection();
    renderProcess();
    if (state.tab === 'report' && !state.current?.reportReady) renderReport();
    $('pipeline').querySelector<HTMLButtonElement>(`[data-pipeline-stage="${stageIndex}"]`)?.focus({ preventScroll: true });
  }
});

$('cancel-run').addEventListener('click', () => {
  const run = state.current;
  if (!run) return;
  clearError();
  void cancelRunApi(run.id).then(updateRun).catch(alertError);
});

// Theme toggle
$('theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('cwatch-theme', state.theme); } catch { /* ignore */ }
  applyTheme(true);
  announce(state.theme === 'dark' ? '已切换到深色模式。' : '已切换到浅色模式。');
});

// Return focus to the disclosure control on Escape.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (isExportModalOpen()) {
      event.preventDefault();
      closeExportModal(true);
    } else if (isConnectionEditorOpen()) {
      event.preventDefault();
      closeConnectionEditor(true);
    } else if (isSkillModalOpen()) {
      event.preventDefault();
      closeSkillModal(true);
    } else if (state.settingsOpen) {
      event.preventDefault();
      setSettingsOpen(false);
      $('settings-toggle').focus();
    } else if (!state.submitting && !$('task-editor').hidden && $('task-editor').contains(document.activeElement)) {
      closeTaskEditor();
    }
  }
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
$('approval-spotlight').addEventListener('submit', event => {
  const form = event.target;
  const run = state.current;
  if (!(form instanceof HTMLFormElement) || !form.dataset.planFeedback || !run) return;
  event.preventDefault();
  const field = form.elements.namedItem('feedback') as HTMLTextAreaElement;
  const feedback = field.value.trim();
  if (!feedback) { field.focus(); return; }
  const button = form.querySelector<HTMLButtonElement>('button')!;
  if (button.disabled) return;
  button.disabled = true;
  clearError();
  void respondApprovalApi(run.id, form.dataset.planFeedback, { feedback }, form.dataset.hash!)
    .then(updateRun)
    .catch(error => { alertError(error); button.disabled = false; });
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

// Connections / Extensions interactions
$('connections-panel').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const add = target.closest<HTMLButtonElement>('[data-edit-connection]');
  if (add) { openConnectionEditor(add.dataset.editConnection!); return; }
  if (target.closest('[data-ext-refresh]')) {
    void loadExtensions(true);
    return;
  }
  const deleteProviderBtn = target.closest<HTMLButtonElement>('[data-delete-provider]');
  if (deleteProviderBtn) {
    void handleDeleteProvider(deleteProviderBtn.dataset.deleteProvider!, refreshBootstrapQuietly);
    return;
  }
  if (target.closest('[data-delete-search]')) {
    void handleDeleteSearch(refreshBootstrapQuietly);
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
  const deleteSkillBtn = target.closest<HTMLButtonElement>('[data-delete-skill]');
  if (deleteSkillBtn) {
    void handleDeleteSkill(deleteSkillBtn.dataset.deleteSkill!, refreshBootstrapQuietly);
    return;
  }
  const toggleMcpBtn = target.closest<HTMLButtonElement>('[data-toggle-mcp]');
  if (toggleMcpBtn) {
    void handleToggleMcp(toggleMcpBtn.dataset.toggleMcp!, toggleMcpBtn.dataset.nextEnabled === 'true', refreshBootstrapQuietly);
    return;
  }
  const deleteMcpBtn = target.closest<HTMLButtonElement>('[data-delete-mcp]');
  if (deleteMcpBtn) {
    void handleDeleteMcp(deleteMcpBtn.dataset.deleteMcp!, refreshBootstrapQuietly);
    return;
  }
  const testMcpBtn = target.closest<HTMLButtonElement>('[data-test-mcp]');
  if (testMcpBtn) {
    void handleTestMcp(testMcpBtn.dataset.testMcp!);
  }
});

$('skill-modal').addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('[data-close-skill]')) {
    closeSkillModal(true);
  }
});
$('skill-modal-backdrop').addEventListener('click', () => closeSkillModal(true));

$('connection-editor').addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('[data-close-connection]')) {
    closeConnectionEditor(true);
  }
});
$('connection-modal-backdrop').addEventListener('click', () => closeConnectionEditor(true));
$('connection-editor').addEventListener('submit', event => {
  event.preventDefault();
  if (event.target instanceof HTMLFormElement) void saveConnection(event.target, refreshBootstrapQuietly);
});

$('export-modal').addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('[data-close-export]')) {
    closeExportModal(true);
  }
});
$('export-modal-backdrop').addEventListener('click', () => closeExportModal(true));

$('nav-sources').addEventListener('click', () => showView(state.view === 'connections' ? 'workbench' : 'connections'));
$('mobile-sources').addEventListener('click', () => showView(state.view === 'connections' ? 'workbench' : 'connections'));
$('nav-workbench').addEventListener('click', () => showView('workbench'));
$('mobile-workbench').addEventListener('click', () => showView('workbench'));

function openResearch(): void {
  clearError();
  showView('research');
  window.scrollTo(0, 0);
  $('research-title').focus({ preventScroll: true });
}

$('nav-research').addEventListener('click', openResearch);
$('mobile-research').addEventListener('click', () => {
  if (state.view === 'research') showView('workbench');
  else openResearch();
});
$('back-to-research').addEventListener('click', openResearch);
$('start-research').addEventListener('click', () => {
  newRun();
  $('task-prompt').focus();
});
$('research-search').addEventListener('input', renderResearch);
$('research-mode').addEventListener('change', renderResearch);
bindResearchComparison();
bindSpecifiedSources();
$('research-list').addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-research-run], [data-delete-run]');
  if (target?.dataset.deleteRun) {
    void handleDeleteRun(target.dataset.deleteRun);
    return;
  }
  const run = state.runs.find(item => item.id === target?.dataset.researchRun);
  if (!run) return;
  clearError();
  selectRun(run, true);
  window.scrollTo(0, 0);
  $('run-title').focus({ preventScroll: true });
});

// Global delegated actions (copy, jump tab, open trace drawer, clone run)
document.body.addEventListener('click', event => {
  const target = event.target as HTMLElement;

  const openExportBtn = target.closest<HTMLButtonElement>('[data-open-export]');
  if (openExportBtn) {
    openExportModal(openExportBtn);
    return;
  }

  const copyReportBtn = target.closest<HTMLButtonElement>('#copy-report, [data-copy-report]');
  if (copyReportBtn && state.current) {
    const run = state.current;
    void (async () => {
      try {
        const saved = state.savedReportMode;
        const review = currentReview(run, renderReport);
        const cached = run.reportReview ? review?.markdown : state.reportCache.get(run.id);
        const report = cached ?? await fetchReportApi(run.id, saved);
        if (!run.reportReview) state.reportCache.set(run.id, report);
        await navigator.clipboard.writeText(report);
        copyReportBtn.textContent = '已复制';
        announce('报告已复制。');
      } catch {
        alertError('浏览器未允许复制，请下载报告。');
      }
    })();
    return;
  }

  if (target.closest('[data-print-report]')) {
    if (isExportModalOpen()) closeExportModal();
    const details = $('report-content').querySelector<HTMLDetailsElement>('.report-full');
    if (details) details.open = true;
    window.print();
    return;
  }

  const tocLink = target.closest<HTMLElement>('[data-toc-target]');
  if (tocLink) {
    event.preventDefault();
    const targetId = tocLink.dataset.tocTarget;
    if (targetId) {
      const details = tocLink.closest('details');
      if (details) details.open = true;
      const heading = $('report-content').querySelector<HTMLElement>('#' + CSS.escape(targetId))
        ?? document.getElementById(targetId);
      if (heading) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        for (const item of document.querySelectorAll<HTMLElement>('.toc-link.is-active')) {
          item.classList.remove('is-active');
        }
        tocLink.classList.add('is-active');
      }
    }
    return;
  }

  if (target.closest('[data-jump-report]')) {
    if (state.tab !== 'report') showTab('report');
    $('report-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  if (target.closest('[data-retry-run]')) {
    void retryCurrentRun();
    return;
  }

  if (target.closest('[data-clone-run]') && state.current) {
    const run = state.current;
    newRun({ profile: run.profile, mode: run.mode, permission: run.permission, task: structuredClone(run.task), model: run.model });
    $('task-prompt').focus();
  }
});

window.addEventListener('beforeprint', () => {
  const details = $('report-content').querySelector<HTMLDetailsElement>('.report-full');
  if (details) details.open = true;
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
    state.projects = bootstrap.projects ?? [];
    $<HTMLSelectElement>('task-runtime').value = bootstrap.model.configured ? 'live' : 'replay';
    renderTaskModels();
    renderSkillCheckboxes();
    setConnection('本地服务已连接');
    populateProfileForm();
    permissionChanged();
    renderCapacity();
    const selected = state.runs.find(run => run.id === localStorage.getItem('cwatch-selected-run'))
      ?? state.runs.find(isActiveRun);
    if (selected) selectRun(selected);
    else { showTab('report'); renderRun(); }
    $<HTMLTextAreaElement>('task-prompt').disabled = false;
    $<HTMLSelectElement>('task-runtime').disabled = false;
    $<HTMLButtonElement>('nav-research').disabled = false;
    $<HTMLButtonElement>('mobile-research').disabled = false;
  } catch (error) {
    setConnection('本地服务未连接', false);
    $('start-note').textContent = '连接失败，请刷新页面重试。';
    alertError(error);
    $<HTMLButtonElement>('start-run').disabled = true;
  }
}

bindHistory(run => { clearError(); selectRun(run); $('run-title').focus(); }, projectId => {
  newRun(undefined, projectId);
  $('task-prompt').focus();
}, updateRun, runId => { void handleDeleteRun(runId); });

bindReportReview(renderReport, (id, review) => {
  const run = state.runs.find(item => item.id === id);
  if (!run || (run.reportReview?.revision ?? 0) > review.revision) return;
  updateRun({ ...run, reportReview: { revision: review.revision, savedRevision: review.savedRevision, savedAt: review.savedAt } });
}, () => { if (state.current) selectRun(state.current); });

void init();
