import { fetchExtensionsApi, fetchSkillDetailApi, testMcpApi, toggleMcpApi, toggleSkillApi } from './api.ts';
import { renderMarkdown } from './markdown.ts';
import { $, alertError, announce, clearError, escapeHtml, isActiveRun, state } from './state.ts';

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

export async function inspectSkill(name: string): Promise<void> {
  if (state.activeSkillName === name && state.skillDetailCache.has(name)) {
    state.activeSkillName = undefined;
    renderExtensions();
    return;
  }
  state.activeSkillName = name;
  state.skillError = undefined;
  if (state.skillDetailCache.has(name)) {
    renderExtensions();
    return;
  }
  state.loadingSkillName = name;
  renderExtensions();
  try {
    const detail = await fetchSkillDetailApi(name);
    state.skillDetailCache.set(name, detail);
  } catch (error) {
    state.skillError = error instanceof Error ? error.message : String(error);
  } finally {
    state.loadingSkillName = undefined;
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

export function renderExtensions(): void {
  const panel = $('connections-panel');
  const bootstrap = state.bootstrap;
  if (!bootstrap) return;

  const ext = state.extensions;
  const activeCount = state.runs.filter(isActiveRun).length;
  const maxSlots = bootstrap.maxConcurrentRuns ?? 2;

  const builtinSources = ext?.builtinSources ?? [...new Map(bootstrap.profiles.flatMap(p => p.sources).map(s => [s.slug, { ...s, profiles: [] as string[] }])).values()];
  const mcpServers = ext?.mcpServers ?? [];
  const builtinSkills = ext?.builtinSkills ?? [];
  const userSkills = ext?.userSkills ?? bootstrap.skills.map(s => ({ ...s, originKind: 'local' as const, installedAt: '', fileCount: 0 }));

  const activeSkillDetail = state.activeSkillName ? state.skillDetailCache.get(state.activeSkillName) : undefined;

  panel.innerHTML = `
    <div class="ext-header">
      <div>
        <h2>来源与连接</h2>
        <p>查看本机模型配置、内建采集来源、自定义 MCP 连通状态以及可用 Skill 说明；密钥始终保留在本地环境变量中。</p>
      </div>
      <div class="ext-header-actions">
        <button type="button" class="button secondary sm" data-ext-refresh ${state.loadingExtensions ? 'disabled' : ''}>${state.loadingExtensions ? '刷新中…' : '刷新状态'}</button>
      </div>
    </div>

    <div class="ext-env-grid">
      <div class="ext-card">
        <span class="ext-card-label">模型配置</span>
        <strong class="ext-card-value">${bootstrap.model.configured ? `${escapeHtml(bootstrap.model.provider)} / ${escapeHtml(bootstrap.model.id)}` : '未配置 .env（离线演示可用）'}</strong>
        <span class="ext-card-note">${bootstrap.model.configured ? '真实任务与多轮会话已就绪' : '复制 .env.example 并填写模型凭据后重启服务'}</span>
      </div>
      <div class="ext-card">
        <span class="ext-card-label">并发执行槽位</span>
        <strong class="ext-card-value">${activeCount} / ${maxSlots}</strong>
        <span class="ext-card-note">等待追问的会话也会占用槽位，结束或取消后释放</span>
      </div>
      <div class="ext-card">
        <span class="ext-card-label">数据与安全边界</span>
        <strong class="ext-card-value">仅本机 127.0.0.1</strong>
        <span class="ext-card-note">运行记录与 Trace 保存在 .runtime/web，工具均经主进程门禁</span>
      </div>
    </div>

    <section class="ext-section" aria-labelledby="ext-sources-title">
      <div class="ext-section-head">
        <h3 id="ext-sources-title">内建数据来源</h3>
        <span class="ext-count">${builtinSources.length} 项</span>
      </div>
      <div class="ext-list">
        ${builtinSources.map(source => `
          <div class="ext-row">
            <div class="ext-row-main">
              <strong>${escapeHtml(source.name)}</strong>
              <span class="mono ext-slug">${escapeHtml(source.slug)}</span>
              ${source.profiles.length ? `<span class="ext-sub">适用于：${escapeHtml(source.profiles.join('、'))}</span>` : ''}
            </div>
            <div class="ext-row-meta">
              <span class="inline-chip">${escapeHtml(source.channel === 'mcp' ? 'MCP 包装' : '内建')}</span>
              <span class="status-chip tone-${source.active ? 'ok' : 'idle'}">${source.active ? '已配置' : '未启用'}</span>
            </div>
          </div>`).join('')}
      </div>
    </section>

    <section class="ext-section" aria-labelledby="ext-mcp-title">
      <div class="ext-section-head">
        <h3 id="ext-mcp-title">自定义 MCP 服务</h3>
        <span class="ext-count">${mcpServers.length} 项</span>
      </div>
      ${mcpServers.length
        ? `<div class="ext-cards-grid">${mcpServers.map(server => {
            const testResult = state.mcpTestResults.get(server.slug);
            const testing = state.testingMcpSlugs.has(server.slug);
            const toggling = state.togglingKeys.has('mcp:' + server.slug);
            return `<div class="ext-item-card">
              <div class="ext-item-top">
                <div>
                  <strong>${escapeHtml(server.slug)}</strong>
                  <div class="ext-tags">
                    <span class="inline-chip">${escapeHtml(server.transport)}</span>
                    <span class="inline-chip">默认权限：${escapeHtml(server.defaultAction)}</span>
                    ${server.hasAuth ? '<span class="inline-chip">环境变量鉴权</span>' : ''}
                  </div>
                </div>
                <span class="status-chip tone-${server.enabled ? 'ok' : 'idle'}">${server.enabled ? '已启用' : '已停用'}</span>
              </div>
              ${server.endpoint ? `<p class="ext-endpoint mono">${escapeHtml(server.endpoint)}</p>` : ''}
              <div class="ext-item-actions">
                <button type="button" class="button secondary sm" data-test-mcp="${escapeHtml(server.slug)}" ${testing ? 'disabled' : ''}>${testing ? '测试中…' : '测试连通'}</button>
                <button type="button" class="button secondary sm" data-toggle-mcp="${escapeHtml(server.slug)}" data-next-enabled="${String(!server.enabled)}" ${toggling ? 'disabled' : ''}>${server.enabled ? '停用' : '启用'}</button>
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
        : '<div class="ext-empty"><p>尚未添加自定义 MCP 服务。可通过 CLI 添加：</p><pre class="json-pre">npm start -- mcp add custom --config examples/mcp-custom.json</pre></div>'}
    </section>

    <section class="ext-section" aria-labelledby="ext-skills-title">
      <div class="ext-section-head">
        <h3 id="ext-skills-title">技能库 (Skills)</h3>
        <span class="ext-count">内置 ${builtinSkills.length} · 已安装 ${userSkills.length}</span>
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
              <button type="button" class="button secondary sm" data-inspect-skill="${escapeHtml(skill.name)}">${state.activeSkillName === skill.name ? '收起说明' : '查看说明'}</button>
              ${skill.resources.length ? `<span class="ext-sub">${skill.resources.length} 份参考文件</span>` : ''}
            </div>
          </div>`).join('')}
        ${userSkills.map(skill => {
          const toggling = state.togglingKeys.has('skill:' + skill.name);
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
              <button type="button" class="button secondary sm" data-inspect-skill="${escapeHtml(skill.name)}">${state.activeSkillName === skill.name ? '收起说明' : '查看说明'}</button>
              <button type="button" class="button secondary sm" data-toggle-skill="${escapeHtml(skill.name)}" data-next-enabled="${String(!skill.enabled)}" ${toggling ? 'disabled' : ''}>${skill.enabled ? '停用' : '启用'}</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      ${state.activeSkillName ? renderSkillDetailDrawer(state.activeSkillName, activeSkillDetail) : ''}
    </section>
  `;
}

function renderSkillDetailDrawer(name: string, detail?: { name: string; kind: string; description: string; body: string; resources: string[] }): string {
  if (state.loadingSkillName === name) {
    return '<div class="skill-drawer"><p class="field-note">正在读取 Skill 说明…</p></div>';
  }
  if (state.skillError) {
    return `<div class="skill-drawer"><div class="run-notice tone-error">${escapeHtml(state.skillError)}</div></div>`;
  }
  if (!detail) return '';
  return `<section class="skill-drawer" aria-label="Skill 详情">
    <div class="skill-drawer-head">
      <div>
        <h4>${escapeHtml(detail.name)}</h4>
        <p>${escapeHtml(detail.description)}</p>
      </div>
      <button type="button" class="button secondary sm" data-close-skill>关闭</button>
    </div>
    ${detail.resources.length ? `<div class="skill-resources"><span>附带参考文件：</span>${detail.resources.map(r => `<code>${escapeHtml(r)}</code>`).join(' ')}</div>` : ''}
    <div class="md-body skill-md">${renderMarkdown(detail.body)}</div>
  </section>`;
}
