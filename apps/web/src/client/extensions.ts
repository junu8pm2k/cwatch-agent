import {
  deleteMcpApi,
  deleteProviderApi,
  deleteSearchApi,
  deleteSkillApi,
  fetchExtensionsApi,
  fetchSkillDetailApi,
  saveConnectionApi,
  testMcpApi,
  toggleMcpApi,
  toggleSkillApi,
  type ConnectionKind,
} from './api.ts';
import { renderMarkdown } from './markdown.ts';
import { $, alertError, announce, clearError, escapeHtml, state } from './state.ts';

const editorMeta: Record<ConnectionKind, { title: string; subtitle: string }> = {
  providers: {
    title: '添加模型供应商',
    subtitle: '添加 OpenAI 兼容的模型接口，保存后即可在首页模型下拉框中选择。',
  },
  search: {
    title: '配置搜索工具',
    subtitle: '连接 Tavily、Exa、Brave、Bocha、Firecrawl 等搜索 API 或搜索 MCP 服务。',
  },
  mcp: {
    title: '添加自定义 MCP',
    subtitle: '接入远程 Streamable HTTP 或 SSE MCP 服务，保存后可测试连通并在任务设置里选用。',
  },
  skills: {
    title: '添加 Skill',
    subtitle: '选择本地 SKILL.md 文件，或直接粘贴包含 YAML frontmatter 的说明正文。',
  },
};

const maxProviderModelIds = 32;

function providerModelIdField(required: boolean): string {
  return `<div class="provider-model-id-row">
    <input name="modelIds" aria-label="模型 ID" maxlength="256" placeholder="例如 deepseek-chat" ${required ? 'required pattern=".*\\S.*"' : ''}>
    ${required ? '' : '<button type="button" class="button ghost sm" aria-label="移除此模型 ID">移除</button>'}
  </div>`;
}

function connectionFields(kind: ConnectionKind): string {
  if (kind === 'providers') return `
    <div class="field-row">
      <label class="field"><span>供应商标识</span><input name="provider" required pattern="[a-z][a-z0-9\u005c-]{0,39}" placeholder="例如 deepseek"></label>
      <label class="field"><span>API 地址</span><input name="baseUrl" type="url" required placeholder="https://api.deepseek.com/v1"></label>
    </div>
    <label class="field"><span>API Key</span><input name="apiKey" type="password" autocomplete="off" required maxlength="4096" placeholder="sk-..."></label>
    <div class="field" role="group" aria-labelledby="provider-model-ids-label">
      <span id="provider-model-ids-label">模型 ID</span>
      <div class="provider-model-id-list" data-provider-model-ids>${providerModelIdField(true)}</div>
      <button type="button" class="button secondary sm provider-model-id-add" data-add-model-id>添加模型 ID</button>
    </div>
    <label class="option-chip"><input type="checkbox" name="reasoning"><span>此供应商支持低 / 中 / 高思考强度</span></label>
    <p class="field-note">凭据仅保存在本机 .cwatch 目录中，不会暴露给模型或写入 Trace。</p>`;
  if (kind === 'search') {
    const current = state.extensions?.search;
    return `
    <div class="field-row">
      <label class="field"><span>搜索地址</span><input name="url" type="url" required value="${escapeHtml(current?.url ?? '')}" placeholder="https://api.tavily.com/search 或 MCP 地址"></label>
      <label class="field"><span>连接类型</span><select name="protocol">
        ${[['auto', '自动识别'], ['mcp', 'MCP'], ['rest', '搜索 API']].map(([value, label]) => `<option value="${value}" ${current?.protocol === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select></label>
    </div>
    <label class="field"><span>搜索密钥（可选）</span><input name="token" type="password" autocomplete="off" maxlength="4096" placeholder="填写搜索 API Key 或 Bearer Token"></label>
    <div class="field-row">
      <label class="field"><span>网页读取地址（可选）</span><input name="fetchUrl" type="url" value="${escapeHtml(current?.fetchUrl ?? '')}" placeholder="例如 https://api.tavily.com/extract"></label>
      <label class="field"><span>网页读取密钥（可选）</span><input name="fetchToken" type="password" autocomplete="off" maxlength="4096" placeholder="留空则复用搜索密钥"></label>
    </div>
    <p class="field-note">${current?.source === 'workbench' ? '重新保存时，请重新填写要使用的密钥；如需恢复 .env 默认设置，可在卡片点击「恢复默认」。' : '支持 HTTPS 搜索 API 与远程搜索 MCP，保存后立即用于真实联网调研。'}</p>`;
  }
  if (kind === 'mcp') return `
    <div class="field-row">
      <label class="field"><span>连接名称</span><input name="slug" required pattern="[a-zA-Z0-9_-]{1,40}" maxlength="40" placeholder="例如 docs-reader"></label>
      <label class="field"><span>MCP 地址</span><input name="url" type="url" required placeholder="https://service.example/mcp"></label>
    </div>
    <label class="field"><span>Bearer Token（可选）</span><input name="token" type="password" autocomplete="off" maxlength="4096" placeholder="如需鉴权请填写"></label>
    <div class="field-row">
      <label class="field"><span>传输方式</span><select name="transport"><option value="auto">自动识别</option><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></select></label>
      <label class="field"><span>工具权限</span><select name="defaultAction"><option value="modify">按写入工具处理（默认安全）</option><option value="collect">确认全部工具只读</option></select></label>
    </div>
    <p class="field-note">支持 HTTPS 或本机 localhost HTTP 地址；Token 仅保存在本机独立凭据文件中。</p>`;
  return `
    <label class="field"><span>从本地选择 SKILL.md（可选）</span><input id="connection-skill-file" type="file" accept=".md,text/markdown,text/plain"></label>
    <label class="field"><span>SKILL.md 内容</span><textarea name="content" rows="10" maxlength="60000" required placeholder="---&#10;name: my-skill&#10;description: 说明这个 Skill 什么时候使用&#10;---&#10;# 使用指南&#10;写下具体指导步骤。"></textarea></label>
    <p class="field-note">name 仅支持小写字母、数字与短横线（例如 pricing-audit），保存后可在任务设置中勾选。</p>`;
}

export function isConnectionEditorOpen(): boolean {
  return !$('connection-editor').hidden;
}

export function isSkillModalOpen(): boolean {
  return !$('skill-modal').hidden;
}

function bindProviderModelIds(editor: HTMLElement): void {
  const list = editor.querySelector<HTMLElement>('[data-provider-model-ids]')!;
  const add = editor.querySelector<HTMLButtonElement>('[data-add-model-id]')!;
  add.addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', providerModelIdField(false));
    const row = list.lastElementChild!;
    add.disabled = list.childElementCount >= maxProviderModelIds;
    row.querySelector('input')!.focus();
    row.querySelector('button')!.addEventListener('click', () => {
      row.remove();
      add.disabled = false;
      add.focus();
    });
  });
}

export function openConnectionEditor(value: string): void {
  if (!Object.hasOwn(editorMeta, value)) return;
  closeSkillModal(false);
  const kind = value as ConnectionKind;
  const meta = editorMeta[kind];
  const editor = $('connection-editor');
  editor.innerHTML = `
    <div class="modal-head">
      <div class="modal-head-main">
        <h2 id="connection-editor-title">${escapeHtml(meta.title)}</h2>
        <p class="modal-sub">${escapeHtml(meta.subtitle)}</p>
      </div>
      <button type="button" class="icon-close-btn" data-close-connection aria-label="关闭弹窗">×</button>
    </div>
    <form class="ext-editor-form" data-kind="${kind}" aria-labelledby="connection-editor-title">
      <div class="modal-body ext-editor-body">
        ${connectionFields(kind)}
        <p id="connection-editor-error" class="ext-editor-error" role="alert" hidden></p>
      </div>
      <div class="modal-foot">
        <span></span>
        <div class="modal-foot-actions">
          <button type="button" class="button secondary sm" data-close-connection>取消</button>
          <button type="submit" class="button primary sm">保存</button>
        </div>
      </div>
    </form>`;
  $('connection-modal-backdrop').hidden = false;
  editor.hidden = false;
  const firstInput = editor.querySelector<HTMLElement>('input:not([type=file]), textarea, select');
  (firstInput ?? editor).focus();
  if (kind === 'providers') bindProviderModelIds(editor);
  if (kind === 'skills') {
    const fileInput = $<HTMLInputElement>('connection-skill-file');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        if (file.size > 60000) throw Error('SKILL.md 需小于 60 KB。');
        const content = await file.text();
        const textarea = fileInput.form?.querySelector<HTMLTextAreaElement>('textarea[name=content]');
        if (textarea) textarea.value = content;
        $('connection-editor-error').hidden = true;
      } catch (error) { if (fileInput.isConnected) showEditorError(error); }
    });
  }
}

export function closeConnectionEditor(restoreFocus = false): void {
  const editor = $('connection-editor');
  if (editor.hidden) return;
  const kind = editor.querySelector('form')?.dataset.kind;
  editor.replaceChildren();
  editor.hidden = true;
  $('connection-modal-backdrop').hidden = true;
  if (restoreFocus && kind) document.querySelector<HTMLElement>(`[data-edit-connection="${CSS.escape(kind)}"]`)?.focus();
}

function showEditorError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const element = $('connection-editor-error');
  element.textContent = message.startsWith('skill_requires_')
    ? 'SKILL.md 需要包含 YAML frontmatter（name、description）和具体指导内容。'
    : message.includes('skill_already_installed')
      ? '该名称的 Skill 已安装，请先删除或更换名称。'
      : message.includes('mcp_already_exists')
        ? '该名称的 MCP 已存在，请先删除或更换名称。'
        : message.includes('SEARCH_MCP_URL_requires_HTTPS')
          ? '搜索地址必须使用 HTTPS，且不要在 URL 中嵌入密钥参数。'
          : message.includes('BASE_URL is the API root')
            ? 'API 地址请填写根路径（例如 https://api.deepseek.com/v1），不要包含 /chat/completions。'
            : message;
  element.hidden = false;
}

export async function saveConnection(form: HTMLFormElement, refresh: () => Promise<void>): Promise<void> {
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  if (submit.disabled) return;
  const kind = form.dataset.kind as ConnectionKind;
  const values = new FormData(form);
  const data: Record<string, unknown> = Object.fromEntries([...values].filter(([, value]) => typeof value === 'string' && value.trim()));
  if (kind === 'providers') {
    data.modelIds = values.getAll('modelIds').map(value => String(value).trim()).filter(Boolean);
    data.supportsReasoningEffort = values.has('reasoning');
    delete data.reasoning;
  }
  submit.disabled = true;
  $('connection-editor-error').hidden = true;
  try {
    state.extensions = await saveConnectionApi(kind, data);
    if (form.isConnected) closeConnectionEditor();
    await refresh();
    renderExtensions();
    document.querySelector<HTMLElement>(`[data-edit-connection="${kind}"]`)?.focus();
    announce('配置已保存。');
  } catch (error) {
    if (form.isConnected) showEditorError(error);
    else alertError(error);
  } finally { submit.disabled = false; }
}

export async function loadExtensions(force = false): Promise<void> {
  if (!force && state.extensions) return;
  if (state.loadingExtensions) return;
  state.loadingExtensions = true;
  renderExtensions();
  try {
    state.extensions = await fetchExtensionsApi();
  } catch (error) {
    alertError(error);
  } finally {
    state.loadingExtensions = false;
    renderExtensions();
  }
}

export function closeSkillModal(restoreFocus = false): void {
  const modal = $('skill-modal');
  const previous = state.activeSkillName;
  state.activeSkillName = undefined;
  state.loadingSkillName = undefined;
  state.skillError = undefined;
  if (!modal.hidden) {
    modal.hidden = true;
    $('skill-modal-backdrop').hidden = true;
    $('skill-modal-body').replaceChildren();
    renderExtensions();
    if (restoreFocus && previous) {
      document.querySelector<HTMLElement>(`[data-inspect-skill="${CSS.escape(previous)}"]`)?.focus();
    }
  }
}

export function renderSkillModal(): void {
  const modal = $('skill-modal');
  const backdrop = $('skill-modal-backdrop');
  const name = state.activeSkillName;
  if (!name) {
    modal.hidden = true;
    backdrop.hidden = true;
    return;
  }

  const detail = state.skillDetailCache.get(name);
  const titleEl = $('skill-modal-title');
  const badgeEl = $('skill-modal-badge');
  const descEl = $('skill-modal-desc');
  const bodyEl = $('skill-modal-body');
  const metaEl = $('skill-modal-meta');

  titleEl.textContent = detail?.name ?? name;
  if (detail) {
    badgeEl.hidden = false;
    badgeEl.textContent = detail.kind === 'builtin' ? '内置' : detail.enabled ? '已启用' : '已停用';
    badgeEl.className = `status-chip tone-${detail.kind === 'builtin' || detail.enabled ? 'ok' : 'idle'}`;
    descEl.hidden = !detail.description;
    descEl.textContent = detail.description;
    metaEl.textContent = detail.kind === 'builtin'
      ? '工作台内置技能'
      : `${detail.origin?.kind === 'github' ? 'GitHub 安装' : '网页 / 本地添加'}${detail.installedAt ? ` · ${new Date(detail.installedAt).toLocaleDateString('zh-CN')}` : ''}`;
  } else {
    badgeEl.hidden = true;
    descEl.hidden = true;
    metaEl.textContent = '';
  }

  if (state.loadingSkillName === name) {
    bodyEl.innerHTML = '<p class="field-note">正在读取 Skill 说明…</p>';
  } else if (state.skillError) {
    bodyEl.innerHTML = `<div class="run-notice tone-error">${escapeHtml(state.skillError)}</div>`;
  } else if (detail) {
    bodyEl.innerHTML = `
      ${detail.resources.length ? `<div class="skill-resources"><span>附带参考文件：</span>${detail.resources.map(r => `<code>${escapeHtml(r)}</code>`).join(' ')}</div>` : ''}
      <div class="md-body skill-md">${renderMarkdown(detail.body)}</div>`;
  } else {
    bodyEl.replaceChildren();
  }

  backdrop.hidden = false;
  modal.hidden = false;
}

export async function inspectSkill(name: string): Promise<void> {
  closeConnectionEditor(false);
  state.activeSkillName = name;
  state.skillError = undefined;
  renderExtensions();
  if (state.skillDetailCache.has(name)) {
    renderSkillModal();
    $('skill-modal').focus();
    return;
  }
  state.loadingSkillName = name;
  renderSkillModal();
  $('skill-modal').focus();
  try {
    const detail = await fetchSkillDetailApi(name);
    state.skillDetailCache.set(name, detail);
  } catch (error) {
    if (state.activeSkillName === name) {
      state.skillError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (state.loadingSkillName === name) state.loadingSkillName = undefined;
    if (state.activeSkillName === name) renderSkillModal();
  }
}

export async function handleDeleteProvider(provider: string, onRefreshBootstrap: () => Promise<void>): Promise<void> {
  const key = 'provider:del:' + provider;
  if (state.togglingKeys.has(key)) return;
  state.togglingKeys.add(key);
  clearError();
  renderExtensions();
  try {
    state.extensions = await deleteProviderApi(provider);
    await onRefreshBootstrap();
    announce(`模型供应商 ${provider} 已移除。`);
  } catch (error) {
    alertError(error);
  } finally {
    state.togglingKeys.delete(key);
    renderExtensions();
  }
}

export async function handleDeleteSearch(onRefreshBootstrap: () => Promise<void>): Promise<void> {
  const key = 'search:del';
  if (state.togglingKeys.has(key)) return;
  state.togglingKeys.add(key);
  clearError();
  renderExtensions();
  try {
    state.extensions = await deleteSearchApi();
    await onRefreshBootstrap();
    announce('已恢复默认搜索配置。');
  } catch (error) {
    alertError(error);
  } finally {
    state.togglingKeys.delete(key);
    renderExtensions();
  }
}

export async function handleToggleSkill(name: string, enabled: boolean, onRefreshBootstrap: () => Promise<void>): Promise<void> {
  const key = 'skill:' + name;
  if (state.togglingKeys.has(key)) return;
  state.togglingKeys.add(key);
  clearError();
  renderExtensions();
  try {
    state.extensions = await toggleSkillApi(name, enabled);
    state.skillDetailCache.delete(name);
    await onRefreshBootstrap();
    announce(`技能 ${name} 已${enabled ? '启用' : '停用'}。`);
  } catch (error) {
    alertError(error);
  } finally {
    state.togglingKeys.delete(key);
    renderExtensions();
  }
}

export async function handleDeleteSkill(name: string, onRefreshBootstrap: () => Promise<void>): Promise<void> {
  const key = 'skill:del:' + name;
  if (state.togglingKeys.has(key)) return;
  state.togglingKeys.add(key);
  clearError();
  renderExtensions();
  try {
    state.extensions = await deleteSkillApi(name);
    state.skillDetailCache.delete(name);
    if (state.activeSkillName === name) closeSkillModal(false);
    await onRefreshBootstrap();
    announce(`技能 ${name} 已删除。`);
  } catch (error) {
    alertError(error);
  } finally {
    state.togglingKeys.delete(key);
    renderExtensions();
  }
}

export async function handleToggleMcp(slug: string, enabled: boolean, onRefreshBootstrap: () => Promise<void>): Promise<void> {
  const key = 'mcp:' + slug;
  if (state.togglingKeys.has(key)) return;
  state.togglingKeys.add(key);
  clearError();
  renderExtensions();
  try {
    state.extensions = await toggleMcpApi(slug, enabled);
    await onRefreshBootstrap();
    announce(`MCP ${slug} 已${enabled ? '启用' : '停用'}。`);
  } catch (error) {
    alertError(error);
  } finally {
    state.togglingKeys.delete(key);
    renderExtensions();
  }
}

export async function handleDeleteMcp(slug: string, onRefreshBootstrap: () => Promise<void>): Promise<void> {
  const key = 'mcp:del:' + slug;
  if (state.togglingKeys.has(key)) return;
  state.togglingKeys.add(key);
  clearError();
  renderExtensions();
  try {
    state.extensions = await deleteMcpApi(slug);
    state.mcpTestResults.delete(slug);
    await onRefreshBootstrap();
    announce(`MCP ${slug} 已删除。`);
  } catch (error) {
    alertError(error);
  } finally {
    state.togglingKeys.delete(key);
    renderExtensions();
  }
}

export async function handleTestMcp(slug: string): Promise<void> {
  if (state.testingMcpSlugs.has(slug)) return;
  state.testingMcpSlugs.add(slug);
  clearError();
  renderExtensions();
  try {
    const result = await testMcpApi(slug);
    state.mcpTestResults.set(slug, result);
    announce(result.ok ? `MCP ${slug} 连通正常，发现 ${result.tools.length} 个工具。` : `MCP ${slug} 测试失败。`);
  } catch (error) {
    alertError(error);
  } finally {
    state.testingMcpSlugs.delete(slug);
    renderExtensions();
  }
}

const protocolLabels: Record<string, string> = {
  auto: '自动识别',
  mcp: 'MCP',
  rest: '搜索 API',
};

export function renderExtensions(): void {
  const panel = $('connections-overview');
  const bootstrap = state.bootstrap;
  if (!bootstrap) return;

  const ext = state.extensions;
  const builtinSources = ext?.builtinSources ?? [];
  const descriptions: Record<string, string> = {
    official: '内置官网发布页抓取来源（对应预设模板「官网与发布」，按指定域名与页面 URL 采集）。',
    web: '联网搜索与网页读取工具（供调查任务检索公开网页并抓取原文，由上方配置的搜索工具驱动）。',
    browser: '只读无头浏览器抓取来源（对应模板「浏览器读取」，用于读取需要 JavaScript 渲染的预设公开页面）。',
  };
  const search = ext?.search;
  const model = bootstrap.model;
  const providers = [
    ...(model.id ? [{ provider: model.provider, modelIds: model.availableIds, fromEnv: true }] : []),
    ...model.providers.map(provider => ({ ...provider, fromEnv: false })),
  ];
  const mcpServers = ext?.mcpServers ?? [];
  const builtinSkills = ext?.builtinSkills ?? [];
  const userSkills = ext?.userSkills ?? bootstrap.skills.map(s => ({ ...s, originKind: 'local' as const, installedAt: '', fileCount: 0 }));

  panel.innerHTML = `
    <div class="ext-header">
      <div>
        <h2>来源与连接</h2>
        <p>配置任务使用的模型供应商、搜索工具、自定义 MCP 与任务技能。</p>
      </div>
      <div class="ext-header-actions">
        <button type="button" class="button secondary sm" data-ext-refresh ${state.loadingExtensions ? 'disabled' : ''}>${state.loadingExtensions ? '刷新中…' : '刷新状态'}</button>
      </div>
    </div>

    <div class="ext-connection-grid">
      <section class="ext-card ext-card-model" aria-labelledby="ext-model-title">
        <div class="ext-section-head">
          <h3 id="ext-model-title">模型供应商</h3>
          <span class="ext-count">${providers.length} 家</span>
        </div>
        ${providers.length
          ? `<ul class="ext-provider-list">${providers.map(provider => {
              const deleting = state.togglingKeys.has('provider:del:' + provider.provider);
              return `<li>
                <div class="ext-provider-head">
                  <strong>${escapeHtml(provider.provider)}</strong>
                  <span class="inline-chip">${provider.fromEnv ? '本机配置' : '网页添加'}</span>
                  ${provider.fromEnv ? '' : `<button type="button" class="ghost-btn ext-inline-delete" data-delete-provider="${escapeHtml(provider.provider)}" aria-label="移除供应商 ${escapeHtml(provider.provider)}" ${deleting ? 'disabled' : ''}>移除</button>`}
                </div>
                <span class="ext-sub">${escapeHtml(provider.modelIds.join('、'))}</span>
              </li>`;
            }).join('')}</ul>`
          : '<p class="ext-desc">点击右下角「＋」添加模型供应商后，即可在首页选择模型。</p>'}
        <div class="ext-card-actions">
          <button type="button" class="button ext-add" data-edit-connection="providers" aria-label="添加模型供应商" title="添加其他模型供应商">＋</button>
        </div>
      </section>

      <section class="ext-card ext-card-search" aria-labelledby="ext-search-title">
        <div class="ext-section-head">
          <h3 id="ext-search-title">搜索工具</h3>
          <span class="status-chip tone-${search && search.source !== 'none' ? 'ok' : 'idle'}">${search && search.source !== 'none' ? '已配置' : '未配置'}</span>
        </div>
        ${search?.url
          ? `<p class="ext-endpoint mono">${escapeHtml(search.url)}</p>`
          : `<p class="ext-desc">${search?.source === 'environment' ? '使用本机配置的搜索能力。' : '连接搜索 API（如 Tavily、Exa、Bocha）或搜索 MCP，供联网调研使用。'}</p>`}
        ${search && search.source !== 'none'
          ? `<div class="ext-tags">
              <span class="inline-chip">${search.source === 'workbench' ? '网页配置' : '本机配置'}</span>
              ${search.protocol ? `<span class="inline-chip">${escapeHtml(protocolLabels[search.protocol] ?? search.protocol)}</span>` : ''}
              ${search.hasToken ? '<span class="inline-chip">已设置密钥</span>' : ''}
            </div>`
          : ''}
        ${search?.fetchUrl ? `<span class="ext-sub">网页读取：${escapeHtml(search.fetchUrl)}</span>` : ''}
        <div class="ext-card-actions">
          ${search?.source === 'workbench' ? `<button type="button" class="button ghost sm" data-delete-search ${state.togglingKeys.has('search:del') ? 'disabled' : ''}>恢复默认</button>` : ''}
          <button type="button" class="button secondary sm" data-edit-connection="search">配置搜索工具</button>
        </div>
      </section>
    </div>

    <section class="ext-section" aria-labelledby="ext-mcp-title">
      <div class="ext-section-head">
        <h3 id="ext-mcp-title">自定义 MCP 服务</h3>
        <button type="button" class="button secondary sm" data-edit-connection="mcp">＋ 添加 MCP</button>
      </div>
      ${mcpServers.length
        ? `<div class="ext-cards-grid">${mcpServers.map(server => {
            const testResult = state.mcpTestResults.get(server.slug);
            const testing = state.testingMcpSlugs.has(server.slug);
            const toggling = state.togglingKeys.has('mcp:' + server.slug);
            const deleting = state.togglingKeys.has('mcp:del:' + server.slug);
            return `<div class="ext-item-card">
              <div class="ext-item-top">
                <div>
                  <strong>${escapeHtml(server.slug)}</strong>
                  <div class="ext-tags">
                    <span class="inline-chip">${escapeHtml(server.transport)}</span>
                    <span class="inline-chip">默认权限：${escapeHtml(server.defaultAction)}</span>
                    ${server.hasAuth ? '<span class="inline-chip">已设置鉴权</span>' : ''}
                  </div>
                </div>
                <span class="status-chip tone-${server.enabled ? 'ok' : 'idle'}">${server.enabled ? '已启用' : '已停用'}</span>
              </div>
              ${server.endpoint ? `<p class="ext-endpoint mono">${escapeHtml(server.endpoint)}</p>` : ''}
              <div class="ext-item-actions">
                <button type="button" class="button secondary sm" data-test-mcp="${escapeHtml(server.slug)}" ${testing ? 'disabled' : ''}>${testing ? '测试中…' : '测试连通'}</button>
                <button type="button" class="button secondary sm" data-toggle-mcp="${escapeHtml(server.slug)}" data-next-enabled="${String(!server.enabled)}" ${toggling ? 'disabled' : ''}>${server.enabled ? '停用' : '启用'}</button>
                <button type="button" class="button ghost sm ext-danger-btn" data-delete-mcp="${escapeHtml(server.slug)}" aria-label="删除 MCP ${escapeHtml(server.slug)}" ${deleting ? 'disabled' : ''}>删除</button>
              </div>
              ${testResult ? `<div class="mcp-test-box tone-${testResult.ok ? 'ok' : 'error'}">
                <div class="mcp-test-head">
                  <strong>${testResult.ok ? `连通正常 · 发现 ${testResult.tools.length} 个工具` : '连接测试失败'}</strong>
                  <span>${testResult.durationMs}ms</span>
                </div>
                ${testResult.error ? `<p class="mcp-test-err">${escapeHtml(testResult.error)}</p>` : ''}
                ${testResult.tools.length ? `<ul class="mcp-tool-list">${testResult.tools.map(t => `<li><code>${escapeHtml(t.name)}</code> <span class="inline-chip">${escapeHtml(t.action)}</span>${t.description ? ` — ${escapeHtml(t.description)}` : ''}</li>`).join('')}</ul>` : ''}
              </div>` : ''}
            </div>`;
          }).join('')}</div>`
        : '<div class="ext-empty"><p>尚未添加自定义 MCP 服务。点击右上角「＋ 添加 MCP」即可在网页中接入。</p></div>'}
    </section>

    <section class="ext-section" aria-labelledby="ext-skills-title">
      <div class="ext-section-head">
        <h3 id="ext-skills-title">技能库 (Skills)</h3>
        <button type="button" class="button secondary sm" data-edit-connection="skills">＋ 添加 Skill</button>
      </div>
      <div class="ext-cards-grid">
        ${builtinSkills.map(skill => `
          <div class="ext-item-card ${state.activeSkillName === skill.name ? 'selected' : ''}">
            <div class="ext-item-top">
              <strong>${escapeHtml(skill.name)}</strong>
              <span class="status-chip tone-ok">内置</span>
            </div>
            <p class="ext-desc">${escapeHtml(skill.description)}</p>
            <div class="ext-item-actions">
              <button type="button" class="button secondary sm" data-inspect-skill="${escapeHtml(skill.name)}">查看说明</button>
              ${skill.resources.length ? `<span class="ext-sub">${skill.resources.length} 份参考文件</span>` : ''}
            </div>
          </div>`).join('')}
        ${userSkills.map(skill => {
          const toggling = state.togglingKeys.has('skill:' + skill.name);
          const deleting = state.togglingKeys.has('skill:del:' + skill.name);
          return `<div class="ext-item-card ${state.activeSkillName === skill.name ? 'selected' : ''}">
            <div class="ext-item-top">
              <div>
                <strong>${escapeHtml(skill.name)}</strong>
                <div class="ext-tags"><span class="inline-chip">${skill.originKind === 'github' ? 'GitHub' : '本地安装'}</span></div>
              </div>
              <span class="status-chip tone-${skill.enabled ? 'ok' : 'idle'}">${skill.enabled ? '已启用' : '已停用'}</span>
            </div>
            <p class="ext-desc">${escapeHtml(skill.description)}</p>
            <div class="ext-item-actions">
              <button type="button" class="button secondary sm" data-inspect-skill="${escapeHtml(skill.name)}">查看说明</button>
              <button type="button" class="button secondary sm" data-toggle-skill="${escapeHtml(skill.name)}" data-next-enabled="${String(!skill.enabled)}" ${toggling ? 'disabled' : ''}>${skill.enabled ? '停用' : '启用'}</button>
              <button type="button" class="button ghost sm ext-danger-btn" data-delete-skill="${escapeHtml(skill.name)}" aria-label="删除 Skill ${escapeHtml(skill.name)}" ${deleting ? 'disabled' : ''}>删除</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>

    ${builtinSources.length ? `<details class="ext-builtin">
      <summary>工作台内置数据来源说明（${builtinSources.length} 项）</summary>
      <dl>${builtinSources.map(source => `<div><dt>${escapeHtml(source.name)} <code class="mono">${escapeHtml(source.slug)}</code></dt><dd>${escapeHtml(descriptions[source.slug] ?? '由对应任务模板提供。')}</dd></div>`).join('')}</dl>
    </details>` : ''}
  `;
}
