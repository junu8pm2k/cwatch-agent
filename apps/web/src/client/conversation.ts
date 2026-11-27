import type { RunSnapshot } from '@cwatch/core/types/runs';
import { formatBatchSummary, groupMergedActivities, mergeActivities, type MergedActivity, type StepRenderNode } from './activity-merger.ts';
import { renderMarkdown } from './markdown.ts';
import { displayedPipelineStage, renderPlanStageBody } from './report-view.ts';
import { $, escapeHtml, formatDurationMs, formatTime, isActiveRun, langfuseTraceHref, state } from './state.ts';

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
export function renderApprovalSpotlight(visible: boolean): void {
  const host = $('approval-spotlight');
  const run = state.current;
  if (!run?.approvals.length) {
    host.hidden = true;
    host.innerHTML = '';
    delete host.dataset.requests;
    return;
  }
  host.hidden = !visible;
  const requests = run.approvals.map(request => request.requestId).join(',');
  if (host.dataset.requests === requests) return;
  host.dataset.requests = requests;
  host.innerHTML = run.approvals.map(request => {
    const isPlan = request.tool === 'workflow__save_plan';
    return `
    <article class="approval-card">
      <div class="approval-card-head">
        <div class="approval-title-group">
          <span class="pulse-dot tone-warn" aria-hidden="true"></span>
          <h3>${isPlan ? '审批调查计划' : '这次操作需要你的确认'}</h3>
        </div>
        ${request.expiresAt
          ? `<span class="approval-clock" data-expires="${escapeHtml(request.expiresAt)}"></span>`
          : '<span class="approval-clock">等待确认</span>'}
      </div>
      ${isPlan
        ? `<p class="approval-desc">批准后开始采集。${run.mode === 'live' ? '也可以提交修改意见，让 Agent 重拟后再审批。' : ''}</p>${renderPlanStageBody(run)}
      ${run.planApproval?.feedback ? `<p class="approval-desc">上次修改意见</p><p class="plan-feedback-text">${escapeHtml(run.planApproval.feedback)}</p>` : ''}`
        : `<p class="approval-tool"><code>${escapeHtml(request.tool)}</code></p>
      <p class="approval-desc">仅批准本次请求与下方参数。批准后，主进程仍会复查来源与当前权限。</p>
      <pre class="approval-params">${escapeHtml(formatArgsSummary(request.argsSummary))}</pre>`}
      <details class="approval-meta-details">
        <summary>请求校验信息</summary>
        <dl class="kv-grid">
          <dt>请求 ID</dt><dd class="mono">${escapeHtml(request.requestId)}</dd>
          <dt>参数哈希</dt><dd class="mono">${escapeHtml(request.argsHash)}</dd>
        </dl>
      </details>
      <div class="approval-actions">
        <button type="button" class="button primary approve" data-approve="${escapeHtml(request.requestId)}" data-hash="${escapeHtml(request.argsHash)}">${isPlan ? '批准计划并开始采集' : '批准这一次'}</button>
        <button type="button" class="button secondary" data-deny="${escapeHtml(request.requestId)}" data-hash="${escapeHtml(request.argsHash)}">${isPlan ? '拒绝计划' : '拒绝操作'}</button>
      </div>
      ${isPlan && run.mode === 'live' ? `<form class="plan-feedback-form" data-plan-feedback="${escapeHtml(request.requestId)}" data-hash="${escapeHtml(request.argsHash)}">
        <label class="field"><span>计划修改意见</span><textarea name="feedback" rows="3" maxlength="2000" placeholder="例如，优先查官方定价页，并把历史价格和当前价格分开核验。" required></textarea></label>
        <button type="submit" class="button secondary">提交修改意见</button>
      </form>` : ''}
    </article>`;
  }).join('');
  updateApprovalClocks();
}

export function updateApprovalClocks(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-expires]')) {
    const expires = node.dataset.expires;
    if (!expires) continue;
    const remaining = Math.ceil((Date.parse(expires) - Date.now()) / 1000);
    node.textContent = remaining > 0 ? `审批剩余 ${remaining} 秒` : '审批已到期，正在更新状态';
  }
}

function renderMergedCardContent(item: MergedActivity): string {
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

  if (!hasPayload) return body;
  return `<details>
      <summary>${body}</summary>
      <div class="step-card-detail">
        ${item.detail ? `<pre class="json-pre">${escapeHtml(formatArgsSummary(item.detail))}</pre>` : ''}
        ${item.errorDetail ? `<pre class="json-pre error-pre">${escapeHtml(formatArgsSummary(item.errorDetail))}</pre>` : ''}
      </div>
    </details>`;
}

function renderMergedNode(node: StepRenderNode): string {
  if (node.kind === 'single') {
    return `<li class="step-card state-${node.item.state}">${renderMergedCardContent(node.item)}</li>`;
  }
  const icon = node.state === 'completed' ? '✓' : node.state === 'failed' ? '!' : node.state === 'running' ? '…' : '·';
  const summary = formatBatchSummary(node.counts);
  return `<li class="step-batch state-${node.state}" data-batch-id="${escapeHtml(node.batchId)}">
    <div class="step-batch-head">
      <span class="step-state state-${node.state}" aria-hidden="true">${icon}</span>
      <span class="step-pill cat-batch">并行 ×${node.items.length}</span>
      <span class="step-title">并行调用 ${node.items.length} 项工具${summary ? `<span class="step-batch-meta">（${escapeHtml(summary)}）</span>` : ''}</span>
      <span class="step-right">
        ${node.durationMs !== undefined ? `<span class="step-dur">${escapeHtml(formatDurationMs(node.durationMs))}</span>` : ''}
        <time datetime="${escapeHtml(node.startedAt)}">${formatTime(node.startedAt)}</time>
      </span>
    </div>
    <ul class="step-tree-list" aria-label="并行工具调用列表">
      ${node.items.map(item => `<li class="step-tree-item state-${item.state}">${renderMergedCardContent(item)}</li>`).join('')}
    </ul>
  </li>`;
}

function inlineToolsBlock(run: RunSnapshot): string {
  const merged = mergeActivities(run.activities, isActiveRun(run)).filter(item => item.category !== 'system');
  if (!merged.length) return '';
  const running = merged.find(item => item.state === 'running');
  const completedCount = merged.filter(item => item.state === 'completed').length;
  const label = running
    ? `正在${running.title}…`
    : `已执行 ${completedCount || merged.length} 项工具步骤`;
  const nodes = groupMergedActivities(merged.slice(-8));
  return `<details class="inline-tools">
    <summary>
      <span class="inline-tools-left">
        <span class="${running ? 'pulse-dot tone-busy' : 'dot'}" aria-hidden="true"></span>
        <span class="inline-tools-title">${escapeHtml(label)}</span>
      </span>
      <span class="inline-link-hint">展开步骤</span>
    </summary>
    <div class="inline-tools-body">
      <ul class="step-card-list compact">${nodes.map(renderMergedNode).join('')}</ul>
      <div class="inline-tools-footer">
        <button type="button" class="link-btn" data-jump-tab="process">查看全部执行步骤 →</button>
        ${langfuseTraceHref(run) ? `<a class="link-btn" href="${escapeHtml(langfuseTraceHref(run))}" target="_blank" rel="noopener noreferrer">在 Langfuse 查看 Trace ↗</a>` : ''}
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
  const merged = mergeActivities(run.activities, isActiveRun(run));
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
    } else if (['failed', 'cancelled', 'unknown'].includes(run.status)) {
      html.push(`
        <div class="run-notice tone-error run-error-bar" role="status">
          <span>${escapeHtml(run.error ?? '本次会话已中断或失败。')}</span>
          <button type="button" class="button secondary sm" data-retry-run ${state.submitting ? 'disabled' : ''}>尝试重试</button>
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
  const stage = displayedPipelineStage(run, state.selectedPipelineStage);
  const merged = mergeActivities(run.activities, isActiveRun(run)).filter(item => stage === undefined || item.stage === stage);
  const nodes = groupMergedActivities(merged);
  $('process-count').textContent = String(merged.length);
  const old = target.querySelector('.activity-scroll');
  const scroll = old?.scrollTop ?? 0;
  const atBottom = !old || old.scrollHeight - old.clientHeight - scroll < 70;

  const canRetry = ['failed', 'cancelled', 'unknown', 'partial'].includes(run.status);
  target.innerHTML = (run.mode === 'replay' ? '<div class="run-notice">当前为离线演示，使用合成测试快照。</div>' : '')
    + (run.error && (stage === undefined || stage === run.stage)
      ? `<div class="run-notice tone-error run-error-bar"><span>${escapeHtml(run.error)}</span>${canRetry ? `<button type="button" class="button secondary sm" data-retry-run ${state.submitting ? 'disabled' : ''}>尝试重试</button>` : ''}</div>`
      : '')
    + (nodes.length
      ? `<div class="activity-scroll"><ul class="step-card-list">${nodes.map(renderMergedNode).join('')}</ul></div>`
      : `<div class="empty-state"><p>${stage === undefined ? '正在准备执行环境…' : '该阶段暂无执行步骤。'}</p></div>`);

  const next = target.querySelector('.activity-scroll');
  if (next) next.scrollTop = atBottom ? next.scrollHeight : scroll;
}
