import type { RunSnapshot } from '@cwatch/core/types/runs';
import { mergeActivities, type MergedActivity } from './activity-merger.ts';
import { renderMarkdown } from './markdown.ts';
import { $, escapeHtml, formatDurationMs, formatTime, isActiveRun, state } from './state.ts';

function formatArgsSummary(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Inline Approval Spotlight: floats prominently right at the top of the active run
 * whenever Ask mode requests human confirmation — zero tab hunting.
 */
export function renderApprovalSpotlight(): void {
  const host = $('approval-spotlight');
  const run = state.current;
  if (!run?.approvals.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = run.approvals.map(request => `
    <article class="approval-card">
      <div class="approval-card-head">
        <div class="approval-title-group">
          <span class="pulse-dot tone-warn" aria-hidden="true"></span>
          <h3>这次操作需要你的确认</h3>
        </div>
        <span class="approval-clock" data-expires="${escapeHtml(request.expiresAt)}"></span>
      </div>
      <p class="approval-tool"><code>${escapeHtml(request.tool)}</code></p>
      <p class="approval-desc">仅批准本次请求与下方参数。批准后，主进程仍会复查来源与当前权限。</p>
      <pre class="approval-params">${escapeHtml(formatArgsSummary(request.argsSummary))}</pre>
      <details class="approval-meta-details">
        <summary>请求校验信息</summary>
        <dl class="kv-grid">
          <dt>请求 ID</dt><dd class="mono">${escapeHtml(request.requestId)}</dd>
          <dt>参数哈希</dt><dd class="mono">${escapeHtml(request.argsHash)}</dd>
        </dl>
      </details>
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

function renderMergedCard(item: MergedActivity): string {
  const icon = item.state === 'completed' ? '✓' : item.state === 'failed' ? '!' : item.state === 'running' ? '…' : '·';
  const hasPayload = Boolean(item.detail || item.errorDetail);
  const body = `
    <div class="step-card-row">
      <span class="step-state state-${item.state}" aria-hidden="true">${icon}</span>
      <span class="step-pill cat-${escapeHtml(item.category)}">${escapeHtml(item.badge)}</span>
      <span class="step-title">${escapeHtml(item.title)}</span>
      <span class="step-right">
        ${item.durationMs !== undefined ? `<span class="step-dur">${escapeHtml(formatDurationMs(item.durationMs))}</span>` : ''}
        <time datetime="${escapeHtml(item.startedAt)}">${formatTime(item.startedAt)}</time>
      </span>
    </div>`;

  if (!hasPayload) {
    return `<li class="step-card state-${item.state}">${body}</li>`;
  }
  return `<li class="step-card state-${item.state}">
    <details>
      <summary>${body}</summary>
      <div class="step-card-detail">
        ${item.detail ? `<pre class="json-pre">${escapeHtml(formatArgsSummary(item.detail))}</pre>` : ''}
        ${item.errorDetail ? `<pre class="json-pre error-pre">${escapeHtml(formatArgsSummary(item.errorDetail))}</pre>` : ''}
      </div>
    </details>
  </li>`;
}

function inlineToolsBlock(run: RunSnapshot): string {
  const merged = mergeActivities(run.activities).filter(item => item.category !== 'system');
  if (!merged.length) return '';
  const running = merged.find(item => item.state === 'running');
  const completedCount = merged.filter(item => item.state === 'completed').length;
  const label = running
    ? `正在${running.title}…`
    : `已执行 ${completedCount || merged.length} 项工具步骤`;
  return `<details class="inline-tools">
    <summary>
      <span class="inline-tools-left">
        <span class="${running ? 'pulse-dot tone-busy' : 'dot'}" aria-hidden="true"></span>
        <span class="inline-tools-title">${escapeHtml(label)}</span>
      </span>
      <span class="inline-link-hint">展开步骤</span>
    </summary>
    <div class="inline-tools-body">
      <ul class="step-card-list compact">${merged.slice(-8).map(renderMergedCard).join('')}</ul>
      <div class="inline-tools-footer">
        <button type="button" class="link-btn" data-jump-tab="process">查看全部执行步骤 →</button>
        <button type="button" class="link-btn" data-open-trace>打开 Trace 抽屉 →</button>
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
  const merged = mergeActivities(run.activities);
  const latestItem = merged.at(-1);
  const key = [
    run.id,
    messages.length,
    run.activities.length,
    run.status,
    latestItem?.id ?? '',
    latestItem?.state ?? '',
  ].join(':');

  const log = $('conversation-messages');
  if (log.dataset.key !== key) {
    const html: string[] = [];
    messages.forEach((message, idx) => {
      if (message.role === 'user') {
        html.push(`
          <article class="chat-msg chat-user">
            <div class="chat-user-text">${escapeHtml(message.content)}</div>
            <time class="chat-user-time" datetime="${escapeHtml(message.createdAt)}">${formatTime(message.createdAt)}</time>
          </article>`);
      } else {
        html.push(`
          <article class="chat-msg chat-assistant">
            <div class="chat-msg-head">
              <span class="chat-role">Cwatch Agent</span>
              <div class="chat-msg-actions">
                <time datetime="${escapeHtml(message.createdAt)}">${formatTime(message.createdAt)}</time>
                <button type="button" class="ghost-btn" data-copy-msg="${idx}" aria-label="复制该条回复">复制</button>
              </div>
            </div>
            <div class="md-body">${renderMarkdown(message.content)}</div>
          </article>`);
      }
    });

    const toolsSummary = inlineToolsBlock(run);
    if (toolsSummary) html.push(toolsSummary);

    if (busy) {
      const liveText = latestItem?.state === 'running' ? latestItem.title : (latestItem?.title ?? '正在思考并检索信息…');
      html.push(`
        <div class="chat-working" role="status">
          <span class="pulse-dot tone-busy" aria-hidden="true"></span>
          <span>${escapeHtml(liveText)}</span>
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
    ? 'Ctrl+Enter 发送追问 · 保留完整上下文与工具记忆'
    : isActiveRun(run)
      ? '正在处理中，答复后可继续追问'
      : run.status === 'unknown'
        ? '服务曾重启，该会话已中断，请新建任务。'
        : '会话已结束，记录已保存。';
}

export function renderProcess(): void {
  const run = state.current;
  const target = $('process-content');
  if (!run) {
    target.innerHTML = '<div class="empty-state"><h3>暂无执行轨迹</h3><p>启动任务后，每一步规划、搜索、读取与审阅都会以卡片呈现。</p></div>';
    return;
  }
  const merged = mergeActivities(run.activities);
  const old = target.querySelector('.activity-scroll');
  const scroll = old?.scrollTop ?? 0;
  const atBottom = !old || old.scrollHeight - old.clientHeight - scroll < 70;

  target.innerHTML = (run.mode === 'replay' ? '<div class="run-notice">当前为离线演示，使用合成测试快照。</div>' : '')
    + (run.error ? `<div class="run-notice tone-error">${escapeHtml(run.error)}</div>` : '')
    + (merged.length
      ? `<div class="activity-scroll"><ul class="step-card-list">${merged.map(renderMergedCard).join('')}</ul></div>`
      : '<div class="empty-state"><p>正在准备执行环境…</p></div>');

  const next = target.querySelector('.activity-scroll');
  if (next) next.scrollTop = atBottom ? next.scrollHeight : scroll;
}
