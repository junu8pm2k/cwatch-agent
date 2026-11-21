import type { RunActivity, RunSnapshot } from '@cwatch/core/types/runs';
import { renderMarkdown } from './markdown.ts';
import { $, escapeHtml, formatTime, isActiveRun, state } from './state.ts';

function formatArgsSummary(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function renderApprovalBanner(): void {
  const banner = $('approval-banner');
  const run = state.current;
  if (!run || !run.approvals.length || state.tab === 'approvals') {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const first = run.approvals[0];
  banner.hidden = false;
  banner.innerHTML = `
    <div class="approval-banner-body">
      <span class="pulse-dot tone-warn" aria-hidden="true"></span>
      <div class="approval-banner-text">
        <strong>有 ${run.approvals.length} 项写入操作等待你的确认</strong>
        <span>${escapeHtml(first.tool)} · <span class="approval-clock" data-expires="${escapeHtml(first.expiresAt)}"></span></span>
      </div>
    </div>
    <button type="button" class="button primary sm" data-jump-tab="approvals">前往处理审批</button>
  `;
}

export function renderApprovals(): void {
  const run = state.current;
  if (!run?.approvals.length) {
    $('approval-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-symbol" aria-hidden="true">✓</div>
        <h3>当前没有待处理审批</h3>
        <p>Ask 模式下，修改、发送或发布操作会在这里等待你逐次确认。</p>
      </div>`;
    return;
  }
  $('approval-content').innerHTML = run.approvals.map(request => `
    <article class="approval-card">
      <div class="approval-card-head">
        <h3>这次操作需要你的确认</h3>
        <span class="approval-clock" data-expires="${escapeHtml(request.expiresAt)}"></span>
      </div>
      <p class="approval-tool"><code>${escapeHtml(request.tool)}</code></p>
      <p class="approval-desc">仅批准本次请求和下方参数。批准后，主进程仍会复查来源与当前权限。</p>
      <pre class="approval-params">${escapeHtml(formatArgsSummary(request.argsSummary))}</pre>
      <dl class="kv-grid">
        <dt>请求</dt><dd class="mono">${escapeHtml(request.requestId)}</dd>
        <dt>参数哈希</dt><dd class="mono">${escapeHtml(request.argsHash)}</dd>
      </dl>
      <div class="approval-actions">
        <button type="button" class="button primary approve" data-approve="${escapeHtml(request.requestId)}" data-hash="${escapeHtml(request.argsHash)}">批准这一次</button>
        <button type="button" class="button secondary" data-deny="${escapeHtml(request.requestId)}" data-hash="${escapeHtml(request.argsHash)}">拒绝操作</button>
      </div>
    </article>`).join('');
  updateApprovalClocks();
}

export function updateApprovalClocks(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-expires]')) {
    const remaining = Math.ceil((Date.parse(node.dataset.expires!) - Date.now()) / 1000);
    node.textContent = remaining > 0 ? `审批剩余 ${remaining} 秒` : '审批已到期，正在更新状态';
  }
}

function inlineToolsBlock(activities: RunActivity[]): string {
  const toolEvents = activities.filter(a => a.kind === 'tool' || a.kind === 'plan' || a.kind === 'analysis' || a.kind === 'approval');
  if (!toolEvents.length) return '';
  const recent = toolEvents.slice(-8);
  return `<details class="inline-tools">
    <summary>
      <span class="inline-tools-title">工具与执行轨迹（${toolEvents.length} 条记录）</span>
      <span class="inline-tools-links">
        <span class="inline-link-hint">展开预览</span>
      </span>
    </summary>
    <div class="inline-tools-body">
      <ul class="inline-tool-list">
        ${recent.map(ev => `<li class="inline-tool-item kind-${escapeHtml(ev.kind)}"><span class="inline-tool-msg">${escapeHtml(ev.message)}</span><time datetime="${escapeHtml(ev.timestamp)}">${formatTime(ev.timestamp)}</time></li>`).join('')}
      </ul>
      <div class="inline-tools-footer">
        <button type="button" class="link-btn" data-jump-tab="process">查看完整运行过程 →</button>
        <button type="button" class="link-btn" data-jump-tab="trace">查看结构化 Trace →</button>
      </div>
    </div>
  </details>`;
}

export function renderConversation(): void {
  const run = state.current;
  const container = $('conversation');
  container.hidden = !run?.conversation;
  if (!run?.conversation) return;

  const messages = run.messages ?? [];
  const busy = run.status === 'preparing' || run.status === 'running' || run.status === 'cancelling';
  const latestActivity = run.activities.at(-1);
  const key = [
    run.id,
    messages.length,
    run.activities.length,
    run.status,
    latestActivity?.sequence ?? 0,
  ].join(':');

  const log = $('conversation-messages');
  if (log.dataset.key !== key) {
    const html: string[] = [];
    messages.forEach((message, idx) => {
      const isUser = message.role === 'user';
      if (isUser) {
        html.push(`
          <article class="chat-msg chat-user">
            <div class="chat-msg-head">
              <span class="chat-role">你</span>
              <time datetime="${escapeHtml(message.createdAt)}">${formatTime(message.createdAt)}</time>
            </div>
            <div class="chat-user-text">${escapeHtml(message.content)}</div>
          </article>`);
      } else {
        html.push(`
          <article class="chat-msg chat-assistant">
            <div class="chat-msg-head">
              <span class="chat-role">Agent</span>
              <div class="chat-msg-actions">
                <time datetime="${escapeHtml(message.createdAt)}">${formatTime(message.createdAt)}</time>
                <button type="button" class="ghost-btn" data-copy-msg="${idx}" aria-label="复制该条回复">复制</button>
              </div>
            </div>
            <div class="md-body">${renderMarkdown(message.content)}</div>
          </article>`);
      }
    });

    const toolsSummary = inlineToolsBlock(run.activities);
    if (toolsSummary) html.push(toolsSummary);

    if (busy) {
      html.push(`
        <div class="chat-working" role="status">
          <span class="pulse-dot tone-busy" aria-hidden="true"></span>
          <span>${escapeHtml(latestActivity?.message ?? 'Agent 正在思考并调用工具…')}</span>
        </div>`);
    }

    log.innerHTML = html.join('');
    log.dataset.key = key;
  }

  const waiting = run.status === 'awaiting_user' && !state.sending;
  const input = $<HTMLTextAreaElement>('follow-up');
  if (input.dataset.run !== run.id) {
    input.value = state.drafts.get(run.id) ?? '';
    input.dataset.run = run.id;
  }
  input.disabled = !waiting;
  $<HTMLButtonElement>('send-message').disabled = !waiting;
  $<HTMLButtonElement>('end-conversation').disabled = !waiting;
  $('conversation-note').textContent = run.status === 'awaiting_user'
    ? '对话与工具结果会保留，用量按整段会话累计 · Ctrl+Enter 发送。'
    : isActiveRun(run)
      ? '正在处理，答复后可以继续追问。'
      : run.status === 'unknown'
        ? '服务已重启，会话已中断；请新建会话。'
        : '会话已结束，对话记录已保存。';
}

export function renderProcess(): void {
  const run: RunSnapshot | undefined = state.current;
  const target = $('process-content');
  if (!run) {
    target.innerHTML = '<div class="empty-state"><h3>开始之后，在这里查看每一步</h3><p>回答、工具调用与来源会随任务保存在这里。</p></div>';
    return;
  }
  const old = target.querySelector('.activity-scroll');
  const scroll = old?.scrollTop ?? 0;
  const atBottom = !old || old.scrollHeight - old.clientHeight - scroll < 70;
  const kindBadge: Record<RunActivity['kind'], string> = {
    system: '系统',
    plan: '计划',
    tool: '工具',
    approval: '审批',
    analysis: '分析',
    error: '异常',
  };

  target.innerHTML = (run.mode === 'replay' ? '<div class="run-notice">离线演示使用固定脚本和合成数据。</div>' : '')
    + (run.error ? `<div class="run-notice tone-error">${escapeHtml(run.error)}</div>` : '')
    + `<div class="activity-scroll"><ol class="activity-list">${run.activities.map(event => `
      <li class="activity kind-${escapeHtml(event.kind)}">
        <div class="activity-header">
          <div class="activity-main">
            <span class="activity-tag tag-${escapeHtml(event.kind)}">${escapeHtml(kindBadge[event.kind])}</span>
            <span class="activity-message">${escapeHtml(event.message)}</span>
          </div>
          <time datetime="${escapeHtml(event.timestamp)}">${formatTime(event.timestamp)}</time>
        </div>
        ${event.detail ? `<details><summary>查看调用详情</summary><pre class="json-pre">${escapeHtml(formatArgsSummary(event.detail))}</pre></details>` : ''}
      </li>`).join('')}</ol></div>`;
  const next = target.querySelector('.activity-scroll');
  if (next) next.scrollTop = atBottom ? next.scrollHeight : scroll;
}
