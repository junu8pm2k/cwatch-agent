import type { StructuredTrace, TraceStep } from '@cwatch/shared/sessions/structured-trace';
import { fetchTraceApi } from './api.ts';
import { $, escapeHtml, formatDurationMs, formatTime, safeUrl, state, type TraceFilter } from './state.ts';

const kindLabels: Record<TraceStep['kind'], string> = {
  run: 'RUN',
  model: 'MODEL',
  tool: 'TOOL',
  backend: 'BACKEND',
  process: 'PROC',
};

const stepStatusLabels: Record<TraceStep['status'], string> = {
  pending: '等待中',
  running: '执行中',
  completed: '完成',
  partial: '部分完成',
  blocked: '已拦截',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
};

const retrievalStatusLabels: Record<string, { label: string; tone: string }> = {
  success_with_data: { label: '抓取成功', tone: 'ok' },
  success_empty: { label: '无内容返回', tone: 'warn' },
  auth_failed: { label: '鉴权失败', tone: 'error' },
  rate_limited: { label: '触发限流', tone: 'warn' },
  timeout: { label: '请求超时', tone: 'error' },
  parse_failed: { label: '解析失败', tone: 'error' },
  cancelled: { label: '已取消', tone: 'warn' },
  unknown: { label: '状态未知', tone: 'warn' },
};

const reviewDecisionMeta: Record<string, { label: string; tone: string }> = {
  accept: { label: '通过 (accept)', tone: 'ok' },
  needs_evidence: { label: '需补充证据 (needs_evidence)', tone: 'warn' },
  reject: { label: '驳回 (reject)', tone: 'error' },
};

const signalTypeLabels: Record<string, string> = {
  release: '产品发布',
  price: '价格变动',
  content: '内容更新',
  campaign: '营销活动',
};

function stepTone(status: TraceStep['status']): string {
  if (status === 'completed') return 'ok';
  if (status === 'running' || status === 'pending') return 'busy';
  if (status === 'blocked' || status === 'partial') return 'warn';
  return 'error';
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asRawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function truncateText(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

interface TreeRow {
  step: TraceStep;
  depth: number;
}

interface StepNav {
  index: number;
  total: number;
  prevStepId?: string;
  nextStepId?: string;
}

function buildStepTree(steps: TraceStep[]): TreeRow[] {
  const byParent = new Map<string | null, TraceStep[]>();
  const knownIds = new Set(steps.map(s => s.stepId));
  for (const step of steps) {
    const key = step.parentStepId && knownIds.has(step.parentStepId) ? step.parentStepId : null;
    const list = byParent.get(key) ?? [];
    list.push(step);
    byParent.set(key, list);
  }
  const rows: TreeRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const child of byParent.get(parentId) ?? []) {
      rows.push({ step: child, depth: Math.min(depth, 4) });
      visit(child.stepId, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

function matchesFilter(step: TraceStep, filter: TraceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errors') return Boolean(step.error) || ['failed', 'blocked', 'cancelled'].includes(step.status);
  return step.kind === filter;
}

function renderReviewDecisionChip(decision: string): string {
  const meta = reviewDecisionMeta[decision] ?? { label: decision, tone: 'neutral' };
  return `<span class="trace-semantic-badge tone-${meta.tone}">${escapeHtml(meta.label)}</span>`;
}

function renderWebSearchSummary(step: TraceStep): string {
  const input = asRecord(step.input);
  const output = asRecord(step.output);
  if (!input && !output) return '';

  const query = asString(input?.query);
  const limit = asNumber(input?.limit);
  const rawHits = asArray(output?.searchResults ?? output?.results ?? output?.hits);
  const statusKey = asString(output?.status) ?? asString(step.resultStatus);
  const statusInfo = statusKey ? (retrievalStatusLabels[statusKey] ?? { label: statusKey, tone: 'neutral' }) : undefined;

  const hitsHtml = rawHits.length
    ? `<ul class="trace-url-list">${rawHits.map(item => {
        const hit = asRecord(item);
        const rawUrl = asString(hit?.url ?? hit?.link ?? hit?.uri) ?? '';
        const title = asString(hit?.title ?? hit?.name) ?? (rawUrl || '未命名结果');
        const snippet = asString(hit?.snippet ?? hit?.description);
        const url = rawUrl ? safeUrl(rawUrl) : undefined;
        let host = '';
        if (url) {
          try { host = new URL(url).hostname; } catch { host = ''; }
        }
        return `<li class="trace-url-item">
          <div class="trace-url-title">
            ${url
              ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
              : `<span>${escapeHtml(title)}</span>`}
            ${host ? `<span class="trace-url-host">${escapeHtml(host)}</span>` : ''}
          </div>
          ${snippet ? `<p class="trace-url-snippet">${escapeHtml(truncateText(snippet, 160))}</p>` : ''}
        </li>`;
      }).join('')}</ul>`
    : `<p class="trace-semantic-empty">${output ? '本次检索未返回命中结果。' : '等待检索结果返回。'}</p>`;

  return `<section class="trace-semantic-card" aria-label="联网搜索语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">联网搜索摘要</span>
      <div class="trace-semantic-badges">
        <span class="trace-semantic-badge tone-busy">命中 ${rawHits.length} 条</span>
        ${statusInfo ? `<span class="trace-semantic-badge tone-${statusInfo.tone}">${escapeHtml(statusInfo.label)}</span>` : ''}
      </div>
    </div>
    <dl class="trace-semantic-kv">
      <dt>检索词</dt>
      <dd><strong>${escapeHtml(query ?? '—')}</strong>${limit !== undefined ? ` <span class="trace-semantic-muted">(上限 ${limit})</span>` : ''}</dd>
    </dl>
    <div class="trace-semantic-block">
      <span class="trace-semantic-label">命中来源列表</span>
      ${hitsHtml}
    </div>
  </section>`;
}

function renderWebFetchSummary(step: TraceStep): string {
  const input = asRecord(step.input);
  const output = asRecord(step.output);
  if (!input && !output) return '';

  const pages = asArray(output?.pages);
  const firstPage = asRecord(pages[0] ?? output?.page);
  const signals = asArray(output?.signals);
  const firstSignal = asRecord(signals[0]);
  const firstSignalContent = asRecord(firstSignal?.content);
  const httpMeta = asRecord(output?.http);

  const rawUrl = asString(firstPage?.url) ?? asString(input?.url) ?? asString(output?.url) ?? asString(firstSignal?.url);
  const safeTargetUrl = rawUrl ? safeUrl(rawUrl) : undefined;
  const statusKey = asString(output?.status) ?? asString(step.resultStatus);
  const statusInfo = statusKey
    ? (retrievalStatusLabels[statusKey] ?? { label: statusKey, tone: 'neutral' })
    : { label: stepStatusLabels[step.status], tone: stepTone(step.status) };
  const httpStatus = asNumber(httpMeta?.status);
  const pageTitle = asString(firstPage?.title) ?? asString(output?.title) ?? asString(firstSignalContent?.title);
  const textBody = asRawString(firstPage?.text) ?? asRawString(output?.text) ?? asRawString(output?.raw);
  const textChars = textBody !== undefined ? textBody.length : asNumber(output?.textLength);
  const truncated = asBoolean(firstPage?.truncated) ?? asBoolean(output?.truncated) ?? asBoolean(output?.rawTruncated);

  return `<section class="trace-semantic-card" aria-label="网页抓取语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">网页抓取摘要</span>
      <div class="trace-semantic-badges">
        <span class="trace-semantic-badge tone-${statusInfo.tone}">${escapeHtml(statusInfo.label)}${httpStatus !== undefined ? ` · HTTP ${httpStatus}` : ''}</span>
        ${truncated === true
          ? '<span class="trace-semantic-badge tone-warn">正文已截断</span>'
          : truncated === false
            ? '<span class="trace-semantic-badge tone-ok">未截断</span>'
            : ''}
      </div>
    </div>
    <dl class="trace-semantic-kv">
      <dt>目标 URL</dt>
      <dd>${safeTargetUrl
        ? `<a class="trace-semantic-link" href="${escapeHtml(safeTargetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safeTargetUrl)}</a>`
        : `<span>${escapeHtml(rawUrl ?? '—')}</span>`}</dd>
      <dt>页面标题</dt>
      <dd>${escapeHtml(pageTitle ?? '—')}</dd>
      <dt>正文字符数</dt>
      <dd>${textChars !== undefined ? `${textChars.toLocaleString()} 字符` : '—'}${truncated === true ? '（已截断）' : truncated === false ? '（完整）' : ''}</dd>
    </dl>
  </section>`;
}

function renderSavePlanSummary(step: TraceStep): string {
  const input = asRecord(step.input);
  const output = asRecord(step.output);
  if (!input && !output) return '';

  const objective = asString(input?.objective);
  const sources = asStringArray(input?.sources ?? output?.sources);
  const queries = asStringArray(input?.queries);
  const requirements = asStringArray(input?.evidenceRequirements);
  const submitted = asBoolean(output?.submitted);
  const path = asString(output?.path);

  return `<section class="trace-semantic-card" aria-label="调查计划语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">调查计划摘要</span>
      <div class="trace-semantic-badges">
        ${submitted === true ? '<span class="trace-semantic-badge tone-ok">计划已提交</span>' : ''}
        ${sources.length ? `<span class="trace-semantic-badge tone-neutral">${sources.length} 个目标来源</span>` : ''}
      </div>
    </div>
    ${objective ? `<div class="trace-semantic-block"><span class="trace-semantic-label">调查目标</span><p class="trace-semantic-text">${escapeHtml(objective)}</p></div>` : ''}
    ${sources.length ? `<div class="trace-semantic-block"><span class="trace-semantic-label">目标来源</span><div class="trace-chip-row">${sources.map(src => `<span class="trace-chip">${escapeHtml(src)}</span>`).join('')}</div></div>` : ''}
    ${queries.length ? `<div class="trace-semantic-block"><span class="trace-semantic-label">检索查询 (${queries.length})</span><ul class="trace-semantic-list">${queries.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul></div>` : ''}
    ${requirements.length ? `<div class="trace-semantic-block"><span class="trace-semantic-label">证据要求 (${requirements.length})</span><ul class="trace-semantic-list">${requirements.map(req => `<li>${escapeHtml(req)}</li>`).join('')}</ul></div>` : ''}
    ${path ? `<dl class="trace-semantic-kv"><dt>计划存档</dt><dd class="mono">${escapeHtml(path)}</dd></dl>` : ''}
  </section>`;
}

function renderExtractSignalSummary(step: TraceStep): string {
  const input = asRecord(step.input);
  const output = asRecord(step.output);
  if (!input && !output) return '';

  const outSignal = asRecord(output?.signal);
  const inpContent = asRecord(input?.content);
  const outContent = asRecord(outSignal?.content ?? output?.content);

  const signalType = asString(input?.signalType) ?? asString(outSignal?.signalType) ?? asString(output?.signalType);
  const eventKey = asString(input?.eventKey) ?? asString(outSignal?.eventKey) ?? asString(output?.eventKey);
  const title = asString(input?.title) ?? asString(inpContent?.title) ?? asString(outContent?.title) ?? asString(output?.title);
  const value = asString(input?.value) ?? asString(inpContent?.value) ?? asString(outContent?.value) ?? asString(output?.value);
  const quote = asString(input?.quote) ?? asString(input?.excerpt) ?? asString(output?.quote) ?? asString(output?.excerpt);
  const polarity = asString(input?.polarity) ?? asString(inpContent?.polarity) ?? asString(outContent?.polarity);
  const rawUrl = asString(input?.url) ?? asString(outSignal?.url) ?? asString(output?.url);
  const safeTargetUrl = rawUrl ? safeUrl(rawUrl) : undefined;
  const signalTypeText = signalType ? (signalTypeLabels[signalType] ? `${signalTypeLabels[signalType]} · ${signalType}` : signalType) : undefined;

  return `<section class="trace-semantic-card" aria-label="信号提取语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">结构化信号提取</span>
      <div class="trace-semantic-badges">
        ${signalTypeText ? `<span class="trace-semantic-badge tone-busy">${escapeHtml(signalTypeText)}</span>` : ''}
        ${polarity === 'contradicts'
          ? '<span class="trace-semantic-badge tone-warn">反证信号</span>'
          : polarity === 'supports'
            ? '<span class="trace-semantic-badge tone-ok">支持信号</span>'
            : ''}
      </div>
    </div>
    <dl class="trace-semantic-kv">
      ${eventKey ? `<dt>事件标识</dt><dd class="mono">${escapeHtml(eventKey)}</dd>` : ''}
      <dt>提取结论</dt>
      <dd>
        ${title ? `<strong>${escapeHtml(title)}</strong>` : ''}
        ${title && value ? '：' : ''}
        ${value ? escapeHtml(value) : (!title ? '—' : '')}
      </dd>
      ${safeTargetUrl ? `<dt>来源链接</dt><dd><a class="trace-semantic-link" href="${escapeHtml(safeTargetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safeTargetUrl)}</a></dd>` : ''}
    </dl>
    ${quote ? `<div class="trace-semantic-block"><span class="trace-semantic-label">引用原话</span><blockquote class="trace-quote">${escapeHtml(quote)}</blockquote></div>` : ''}
  </section>`;
}

function renderAnalyzeSummary(step: TraceStep): string {
  const output = asRecord(step.output);
  if (!output && step.input === null) return '';

  const claims = asArray(output?.claims);
  const comparisons = asArray(output?.comparisons);
  const evidenceIds = asArray(output?.evidenceIds);
  const gaps = asStringArray(output?.gaps);

  return `<section class="trace-semantic-card" aria-label="归因分析语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">归因分析摘要</span>
      <div class="trace-semantic-badges">
        <span class="trace-semantic-badge tone-${gaps.length ? 'warn' : 'ok'}">${gaps.length ? `${gaps.length} 项缺口` : '无缺口'}</span>
      </div>
    </div>
    <div class="trace-semantic-kpis">
      <div class="trace-kpi"><span>产出主张</span><strong>${claims.length}</strong></div>
      <div class="trace-kpi"><span>历史比较</span><strong>${comparisons.length}</strong></div>
      <div class="trace-kpi"><span>核验证据</span><strong>${evidenceIds.length}</strong></div>
      <div class="trace-kpi"><span>缺口条目</span><strong>${gaps.length}</strong></div>
    </div>
    <div class="trace-semantic-block">
      <span class="trace-semantic-label">信息缺口列表</span>
      ${gaps.length
        ? `<ul class="trace-semantic-list trace-gap-list">${gaps.map(gap => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>`
        : '<p class="trace-semantic-empty">本次分析未记录信息缺口。</p>'}
    </div>
  </section>`;
}

function renderReviewSummary(step: TraceStep): string {
  const output = asRecord(step.output);
  if (!output && step.input === null) return '';

  const decision = asString(output?.decision) ?? 'unknown';
  const issues = asStringArray(output?.issues);
  const evidenceRefs = asArray(output?.evidenceRefs);
  const reworkAvailable = asBoolean(output?.reworkAvailable);

  return `<section class="trace-semantic-card" aria-label="规则审阅语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">规则审阅摘要</span>
      <div class="trace-semantic-badges">
        ${renderReviewDecisionChip(decision)}
        ${reworkAvailable === true
          ? '<span class="trace-semantic-badge tone-busy">已解锁返工补充</span>'
          : reworkAvailable === false
            ? '<span class="trace-semantic-badge tone-neutral">未解锁返工</span>'
            : ''}
      </div>
    </div>
    <dl class="trace-semantic-kv">
      <dt>核验引用</dt>
      <dd>${evidenceRefs.length} 条</dd>
      ${reworkAvailable !== undefined ? `<dt>返工机制</dt><dd>${reworkAvailable ? '可发起补充采集与返工' : '当前不允许返工'}</dd>` : ''}
    </dl>
    <div class="trace-semantic-block">
      <span class="trace-semantic-label">审阅发现 (${issues.length})</span>
      ${issues.length
        ? `<ul class="trace-semantic-list trace-issue-list">${issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
        : '<p class="trace-semantic-empty">所有主张与原始快照均通过一致性核验。</p>'}
    </div>
  </section>`;
}

function renderDraftSummary(step: TraceStep): string {
  const input = asRecord(step.input);
  const output = asRecord(step.output);
  if (!input && !output) return '';

  const path = asString(output?.path);
  const claimIds = asArray(output?.claimIds ?? input?.claimIds);
  const review = asString(output?.review);
  const gaps = asStringArray(output?.gaps);

  return `<section class="trace-semantic-card" aria-label="调查草稿语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">报告草稿产出摘要</span>
      <div class="trace-semantic-badges">
        ${review ? renderReviewDecisionChip(review) : ''}
        <span class="trace-semantic-badge tone-neutral">引用 ${claimIds.length} 条主张</span>
      </div>
    </div>
    <dl class="trace-semantic-kv">
      <dt>报告路径</dt>
      <dd class="mono">${escapeHtml(path ?? '—')}</dd>
      <dt>引用主张数</dt>
      <dd>${claimIds.length} 条</dd>
      ${review ? `<dt>审阅结果</dt><dd>${renderReviewDecisionChip(review)}</dd>` : ''}
      ${gaps.length ? `<dt>保留缺口</dt><dd>${gaps.length} 项</dd>` : ''}
    </dl>
  </section>`;
}

function memoryReasonLabel(reason?: string, stop?: string): string | undefined {
  if (reason === 'output_limit') return '达到输出上限';
  if (reason === 'invalid_working_state') return '记忆 JSON 校验失败';
  if (reason === 'unexpected_tool_call') return '返回异常工具调用';
  if (reason === 'unsuccessful_response') return '模型未正常结束';
  if (reason === 'delta_too_large') return '单轮增量超出维护输入上限';
  return stop === 'stop' ? '正常结束' : stop;
}

function renderModelSummary(step: TraceStep): string {
  const input = asRecord(step.input);
  const output = asRecord(step.output);
  const attrs = asRecord(step.attributes);
  const blockingStep = asString(attrs?.blockedByMemoryStep);
  if (blockingStep) return `<section class="trace-semantic-card" aria-label="模型轮次摘要">
    <p>会话记忆更新未完成，本轮模型请求未发送。</p>
    <button type="button" class="button secondary sm" data-trace-step="${escapeHtml(blockingStep)}">查看记忆尝试</button>
  </section>`;
  if (step.name === 'model.memory') {
    const attempt = asNumber(input?.attempt);
    const limit = asNumber(input?.wireMaxOutputTokens ?? input?.maxOutputTokens);
    const usage = asRecord(step.usage[0]?.reported);
    const used = asNumber(usage?.output ?? usage?.completionTokens ?? usage?.completion_tokens);
    const textChars = asNumber(output?.textChars);
    const thinkingChars = asNumber(output?.thinkingChars);
    const reason = asString(output?.reason);
    const stop = asString(output?.stopReason);
    const checkpoint = asNumber(output?.savedRevision ?? input?.checkpointRevision);
    const checkpointStatus = output?.checkpointStatus === 'saved' ? '已保存' : output?.checkpointStatus === 'unchanged' ? '保留原版本' : undefined;
    const validation = asStringArray(output?.validationErrors);
    const pendingRounds = asNumber(output?.pendingRounds);
    const circuitOpen = asBoolean(output?.circuitOpen);
    const reasonLabel = memoryReasonLabel(reason, stop);
    const action = output?.action === 'retry'
      ? '重试'
      : output?.action === 'stop'
        ? '停止'
        : output?.action === 'degrade'
          ? `降级放行主任务${circuitOpen ? '（本运行已熔断后续记忆更新）' : ''}`
          : undefined;
    return `<section class="trace-semantic-card" aria-label="会话记忆更新摘要">
      <div class="trace-semantic-head"><span class="trace-semantic-title">会话记忆更新${attempt === undefined ? '' : ` · 第 ${attempt} 次`}</span></div>
      <dl class="trace-semantic-kv">
        ${reasonLabel ? `<dt>停止原因</dt><dd>${escapeHtml(reasonLabel)}</dd>` : ''}
        ${used !== undefined || limit !== undefined ? `<dt>输出用量 / 上限</dt><dd>${used?.toLocaleString() ?? '—'} / ${limit?.toLocaleString() ?? '—'} tokens</dd>` : ''}
        ${textChars !== undefined ? `<dt>正文长度</dt><dd>${textChars.toLocaleString()} 字符</dd>` : ''}
        ${thinkingChars !== undefined ? `<dt>推理长度</dt><dd>${thinkingChars.toLocaleString()} 字符</dd>` : ''}
        ${action ? `<dt>处理结果</dt><dd>${escapeHtml(action)}</dd>` : ''}
        ${pendingRounds !== undefined ? `<dt>待处理轮次</dt><dd>${pendingRounds} 轮</dd>` : ''}
        ${checkpointStatus && checkpoint !== undefined ? `<dt>记忆检查点</dt><dd>${checkpointStatus} · 修订 ${checkpoint}</dd>` : ''}
      </dl>
      ${validation.length ? `<div class="trace-semantic-block"><span class="trace-semantic-label">校验错误</span><ul class="trace-semantic-list">${validation.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${attempt === undefined && !reason ? '<p class="trace-semantic-empty">该记录仅包含模型用量。</p>' : ''}
    </section>`;
  }
  if (!input && !output && !step.usage.length) return '';

  const memoryDegraded = asRecord(attrs?.memoryDegraded);
  const degradedStep = asString(memoryDegraded?.stepId);
  const degradedReason = memoryReasonLabel(asString(memoryDegraded?.reason));
  const degradedBanner = memoryDegraded
    ? `<div class="trace-semantic-block">
      <span class="trace-semantic-label">会话记忆降级</span>
      <p class="trace-semantic-text">本轮记忆更新未成功（${escapeHtml(degradedReason ?? '未知原因')}），已沿用旧检查点继续主任务${memoryDegraded.circuitOpen === true ? '，并已熔断本运行后续自动记忆更新' : ''}。</p>
      ${degradedStep ? `<button type="button" class="button secondary sm" data-trace-step="${escapeHtml(degradedStep)}">查看记忆尝试</button>` : ''}
    </div>`
    : '';

  const modelMeta = asRecord(attrs?.model);
  const modelName = [asString(modelMeta?.provider), asString(modelMeta?.id)].filter(Boolean).join(' · ');
  const contextChars = asNumber(input?.contextChars);

  let decisionBadge = '<span class="trace-semantic-badge tone-neutral">等待决策</span>';
  let decisionBody = '<p class="trace-semantic-empty">本轮未记录结构化决策输出。</p>';
  const decisionKind = asString(output?.kind);

  if (decisionKind === 'call_tool') {
    const toolName = asString(output?.name) ?? 'unknown_tool';
    decisionBadge = '<span class="trace-semantic-badge tone-busy">调用工具</span>';
    decisionBody = `<div class="trace-chip-row"><code class="trace-tool-chip">${escapeHtml(toolName)}</code></div>`;
  } else if (decisionKind === 'call_tools') {
    const calls = asArray(output?.calls)
      .map(item => asString(asRecord(item)?.name))
      .filter((name): name is string => Boolean(name));
    decisionBadge = `<span class="trace-semantic-badge tone-busy">并行调用 ${calls.length} 个工具</span>`;
    decisionBody = calls.length
      ? `<div class="trace-chip-row">${calls.map(name => `<code class="trace-tool-chip">${escapeHtml(name)}</code>`).join('')}</div>`
      : '<p class="trace-semantic-empty">并行工具列表为空。</p>';
  } else if (decisionKind === 'respond') {
    const responseText = asRawString(output?.text) ?? '';
    decisionBadge = '<span class="trace-semantic-badge tone-ok">输出文本响应</span>';
    decisionBody = responseText
      ? `<blockquote class="trace-quote">${escapeHtml(truncateText(responseText.trim(), 220))}</blockquote><span class="trace-semantic-muted">共 ${responseText.length.toLocaleString()} 字符</span>`
      : '<p class="trace-semantic-empty">空文本响应。</p>';
  }

  let totalTokens = 0;
  let hasTotalTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasBreakdown = false;

  for (const rawEntry of step.usage) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const reported = asRecord(entry.reported);
    const total = asNumber(entry.totalTokens) ?? asNumber(reported?.totalTokens);
    if (total !== undefined) {
      totalTokens += total;
      hasTotalTokens = true;
    }
    const inp = asNumber(reported?.input ?? reported?.promptTokens ?? reported?.prompt_tokens);
    const out = asNumber(reported?.output ?? reported?.completionTokens ?? reported?.completion_tokens);
    if (inp !== undefined) { inputTokens += inp; hasBreakdown = true; }
    if (out !== undefined) { outputTokens += out; hasBreakdown = true; }
  }

  const tokenText = hasTotalTokens
    ? `${totalTokens.toLocaleString()} tokens${hasBreakdown ? `（输入 ${inputTokens.toLocaleString()} · 输出 ${outputTokens.toLocaleString()}）` : ''}`
    : hasBreakdown
      ? `${(inputTokens + outputTokens).toLocaleString()} tokens（输入 ${inputTokens.toLocaleString()} · 输出 ${outputTokens.toLocaleString()}）`
      : '未记录';

  return `<section class="trace-semantic-card" aria-label="模型决策语义摘要">
    <div class="trace-semantic-head">
      <span class="trace-semantic-title">模型轮次摘要</span>
      <div class="trace-semantic-badges">
        ${memoryDegraded ? '<span class="trace-semantic-badge tone-warn">记忆降级</span>' : ''}
        ${decisionBadge}
        ${hasTotalTokens ? `<span class="trace-semantic-badge tone-neutral">${totalTokens.toLocaleString()} tokens</span>` : ''}
      </div>
    </div>
    ${degradedBanner}
    <div class="trace-semantic-block">
      <span class="trace-semantic-label">本轮决策</span>
      ${decisionBody}
    </div>
    <dl class="trace-semantic-kv">
      <dt>Token 消耗</dt>
      <dd>${escapeHtml(tokenText)}</dd>
      ${contextChars !== undefined ? `<dt>上下文长度</dt><dd>${contextChars.toLocaleString()} 字符</dd>` : ''}
      ${modelName ? `<dt>模型标识</dt><dd class="mono">${escapeHtml(modelName)}</dd>` : ''}
    </dl>
  </section>`;
}

function renderSemanticSummary(step: TraceStep): string {
  if (step.kind === 'model') return renderModelSummary(step);
  if (step.kind !== 'tool') return '';
  if (step.name === 'web_search' || step.name.endsWith('__web_search')) return renderWebSearchSummary(step);
  if (step.name === 'web_fetch' || step.name.endsWith('__web_fetch')) return renderWebFetchSummary(step);
  if (step.name === 'workflow__save_plan' || step.name === 'save_plan') return renderSavePlanSummary(step);
  if (step.name === 'workflow__extract_signal' || step.name === 'extract_signal') return renderExtractSignalSummary(step);
  if (step.name === 'workflow__analyze' || step.name === 'analyze') return renderAnalyzeSummary(step);
  if (step.name === 'workflow__review' || step.name === 'review') return renderReviewSummary(step);
  if (step.name === 'workflow__draft' || step.name === 'draft') return renderDraftSummary(step);
  return '';
}

export async function loadTrace(runId: string, force = false): Promise<void> {
  const run = state.runs.find(r => r.id === runId);
  const revision = run?.revision ?? 0;
  const cached = state.traceCache.get(runId);
  if (!force && cached && cached.revision === revision) return;
  if (state.loadingTraces.has(runId)) return;

  state.loadingTraces.add(runId);
  state.traceErrors.delete(runId);
  if (state.current?.id === runId && state.traceDrawerOpen) renderTrace();

  try {
    const trace = await fetchTraceApi(runId);
    state.traceCache.set(runId, { revision, trace });
    if (state.current?.id === runId && !state.selectedTraceStepId && trace.steps.length) {
      state.selectedTraceStepId = trace.steps[0].stepId;
    }
  } catch (error) {
    state.traceErrors.set(runId, error instanceof Error ? error.message : String(error));
  } finally {
    state.loadingTraces.delete(runId);
    if (state.current?.id === runId && state.traceDrawerOpen) renderTrace();
  }
}

export function renderTrace(): void {
  const panel = $('trace-content');
  const run = state.current;
  if (!run) {
    panel.innerHTML = '<div class="empty-state"><h3>暂无 Trace</h3><p>选择一次运行后，可在此查看完整结构化调用链。</p></div>';
    return;
  }

  const cached = state.traceCache.get(run.id);
  const loading = state.loadingTraces.has(run.id);
  const error = state.traceErrors.get(run.id);

  if (!cached && !loading && !error) {
    void loadTrace(run.id);
    panel.innerHTML = '<div class="empty-state"><h3>正在加载 Trace…</h3><p>读取本次运行的模型、工具与后端审计记录。</p></div>';
    return;
  }
  if (!cached && loading) {
    panel.innerHTML = '<div class="empty-state"><h3>正在加载 Trace…</h3><p>读取本次运行的模型、工具与后端审计记录。</p></div>';
    return;
  }
  if (!cached && error) {
    const waiting = error.includes('trace_not_ready');
    panel.innerHTML = `<div class="empty-state"><h3>${waiting ? 'Trace 尚未就绪' : 'Trace 读取失败'}</h3><p>${escapeHtml(waiting ? '执行开始后将生成结构化 Trace，请稍后刷新。' : error)}</p><div class="empty-actions"><button type="button" class="button secondary sm" data-trace-refresh>重新读取</button></div></div>`;
    return;
  }

  const trace: StructuredTrace = cached!.trace;
  const rows = buildStepTree(trace.steps);
  const filtered = rows.filter(row => matchesFilter(row.step, state.traceFilter));
  const foundIndex = filtered.findIndex(r => r.step.stepId === state.selectedTraceStepId);
  const selectedIndex = foundIndex >= 0 ? foundIndex : (filtered.length ? 0 : -1);
  const selected = selectedIndex >= 0 ? filtered[selectedIndex].step : undefined;
  if (selected) state.selectedTraceStepId = selected.stepId;

  const stepNav: StepNav | undefined = selected
    ? {
        index: selectedIndex,
        total: filtered.length,
        prevStepId: selectedIndex > 0 ? filtered[selectedIndex - 1].step.stepId : undefined,
        nextStepId: selectedIndex < filtered.length - 1 ? filtered[selectedIndex + 1].step.stepId : undefined,
      }
    : undefined;

  const rootStart = trace.timing.startedAt ? Date.parse(trace.timing.startedAt) : NaN;
  const rootDuration = Math.max(1, trace.timing.durationMs ?? 1);
  const integrityClass = !trace.integrity.valid ? 'error' : trace.integrity.complete ? 'ok' : 'busy';
  const integrityLabel = !trace.integrity.valid ? '审计异常' : trace.integrity.complete ? '审计完整' : '运行中快照';

  const filters: Array<{ id: TraceFilter; label: string; count: number }> = [
    { id: 'all', label: '全部', count: rows.length },
    { id: 'model', label: '模型', count: rows.filter(r => r.step.kind === 'model').length },
    { id: 'tool', label: '工具', count: rows.filter(r => r.step.kind === 'tool').length },
    { id: 'backend', label: '后端', count: rows.filter(r => r.step.kind === 'backend').length },
    { id: 'errors', label: '异常', count: rows.filter(r => matchesFilter(r.step, 'errors')).length },
  ];

  const rowsHtml = filtered.length
    ? filtered.map(({ step, depth }) => {
        const startMs = step.timing.startedAt ? Date.parse(step.timing.startedAt) : step.timing.requestedAt ? Date.parse(step.timing.requestedAt) : NaN;
        const leftPct = Number.isFinite(rootStart) && Number.isFinite(startMs)
          ? Math.max(0, Math.min(96, ((startMs - rootStart) / rootDuration) * 100))
          : 0;
        const duration = step.timing.durationMs ?? step.timing.executionDurationMs ?? 0;
        const widthPct = Math.max(2, Math.min(100 - leftPct, (duration / rootDuration) * 100));
        const activeClass = selected?.stepId === step.stepId ? 'selected' : '';
        const tone = stepTone(step.status);
        return `<button type="button" class="trace-row trace-depth-${depth} ${activeClass}" data-trace-step="${escapeHtml(step.stepId)}">
          <span class="trace-row-main">
            <span class="trace-kind kind-${escapeHtml(step.kind)}">${escapeHtml(kindLabels[step.kind])}</span>
            <span class="trace-name">${escapeHtml(step.name)}</span>
          </span>
          <span class="trace-row-meta">
            <span class="trace-waterfall" aria-hidden="true"><span class="trace-bar-fill tone-${tone}" data-bar-left="${leftPct.toFixed(1)}" data-bar-width="${widthPct.toFixed(1)}"></span></span>
            <span class="trace-duration">${escapeHtml(formatDurationMs(step.timing.durationMs ?? step.timing.executionDurationMs))}</span>
            <span class="trace-status tone-${tone}">${escapeHtml(stepStatusLabels[step.status])}</span>
          </span>
        </button>`;
      }).join('')
    : '<p class="trace-empty-filter">当前筛选下没有匹配步骤。</p>';

  panel.innerHTML = `
    <div class="trace-header">
      <div class="trace-badges">
        <span class="status-chip tone-${integrityClass}">${escapeHtml(integrityLabel)}</span>
        <span class="trace-meta-text">${trace.events.length} 事件</span>
      </div>
      <div class="trace-actions">
        <button type="button" class="button secondary sm" data-trace-refresh ${loading ? 'disabled' : ''}>${loading ? '刷新中…' : '刷新'}</button>
        <a class="button secondary sm" href="/api/runs/${escapeHtml(run.id)}/trace" download="trace-${escapeHtml(run.id.slice(0, 8))}.json">导出 JSON</a>
      </div>
    </div>
    <div class="trace-summary-grid">
      <div class="mini-stat"><span>模型轮次</span><strong>${trace.summary.modelRounds}</strong></div>
      <div class="mini-stat"><span>工具执行</span><strong>${trace.summary.toolExecutions}/${trace.summary.toolRequests}</strong></div>
      <div class="mini-stat"><span>Token</span><strong>${(trace.summary.totalTokens ?? trace.summary.knownTokens).toLocaleString()}</strong></div>
      <div class="mini-stat"><span>总耗时</span><strong>${escapeHtml(formatDurationMs(trace.timing.durationMs))}</strong></div>
    </div>
    <div class="filter-pills" role="group" aria-label="Trace 步骤筛选">
      ${filters.map(f => `<button type="button" class="filter-pill ${state.traceFilter === f.id ? 'active' : ''}" data-trace-filter="${f.id}">${escapeHtml(f.label)} <span class="pill-count">${f.count}</span></button>`).join('')}
    </div>
    <div class="trace-split">
      <div class="trace-tree" aria-label="Trace 步骤树">${rowsHtml}</div>
      ${selected && stepNav ? renderStepDetail(selected, stepNav) : ''}
    </div>
  `;

  for (const bar of panel.querySelectorAll<HTMLElement>('[data-bar-width]')) {
    bar.style.left = (bar.dataset.barLeft ?? '0') + '%';
    bar.style.width = (bar.dataset.barWidth ?? '2') + '%';
  }

  const tree = panel.querySelector<HTMLElement>('.trace-tree');
  const activeRow = tree?.querySelector<HTMLElement>('.trace-row.selected');
  if (tree && activeRow) {
    const rowTop = activeRow.offsetTop;
    const rowBottom = rowTop + activeRow.offsetHeight;
    if (rowTop < tree.scrollTop) {
      tree.scrollTop = Math.max(0, rowTop - 8);
    } else if (rowBottom > tree.scrollTop + tree.clientHeight) {
      tree.scrollTop = rowBottom - tree.clientHeight + 8;
    }
  }
}

function renderStepDetail(step: TraceStep, nav: StepNav): string {
  const corrEntries = Object.entries(step.correlation).filter(([, v]) => v !== null);
  const hasAttrs = Object.keys(step.attributes).length > 0;
  const semanticHtml = renderSemanticSummary(step);
  const hasSemantic = semanticHtml.length > 0;
  const rawOpenAttr = hasSemantic ? '' : ' open';
  const inputSummary = hasSemantic ? '原始输入载荷 (JSON)' : '输入 (input)';
  const outputSummary = hasSemantic ? '原始输出载荷 (JSON)' : '输出 (output)';

  return `<section class="trace-detail" aria-label="步骤详情">
    <div class="trace-replay-bar" role="navigation" aria-label="步骤回放导航">
      <span class="trace-step-position">第 ${nav.index + 1} / ${nav.total} 步</span>
      <div class="trace-replay-controls">
        <button type="button" class="button secondary sm trace-replay-btn" ${nav.prevStepId ? `data-trace-step="${escapeHtml(nav.prevStepId)}"` : 'disabled'}>上一步</button>
        <button type="button" class="button secondary sm trace-replay-btn" ${nav.nextStepId ? `data-trace-step="${escapeHtml(nav.nextStepId)}"` : 'disabled'}>下一步</button>
      </div>
    </div>
    <div class="trace-detail-head">
      <div class="trace-detail-title-wrap">
        <span class="trace-kind kind-${escapeHtml(step.kind)}">${escapeHtml(kindLabels[step.kind])}</span>
        <h4>${escapeHtml(step.name)}</h4>
      </div>
      <span class="status-chip tone-${stepTone(step.status)}">${escapeHtml(stepStatusLabels[step.status])}</span>
    </div>
    <dl class="kv-grid">
      <dt>全程耗时</dt><dd>${escapeHtml(formatDurationMs(step.timing.durationMs))}</dd>
      <dt>实际执行</dt><dd>${escapeHtml(formatDurationMs(step.timing.executionDurationMs))}</dd>
      <dt>开始时间</dt><dd>${escapeHtml(step.timing.startedAt ? formatTime(step.timing.startedAt) : step.timing.requestedAt ? formatTime(step.timing.requestedAt) : '—')}</dd>
      ${corrEntries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="mono">${escapeHtml(v)}</dd>`).join('')}
    </dl>
    ${step.error ? `<div class="trace-error-box"><strong>${escapeHtml(step.error.category)} · ${escapeHtml(step.error.code)}</strong><p>${escapeHtml(step.error.message)}</p></div>` : ''}
    ${semanticHtml}
    ${step.input !== null ? `<details class="trace-raw-details"${rawOpenAttr}><summary>${inputSummary}</summary><pre class="json-pre">${escapeHtml(prettyJson(step.input))}</pre></details>` : ''}
    ${step.output !== null ? `<details class="trace-raw-details"${rawOpenAttr}><summary>${outputSummary}</summary><pre class="json-pre">${escapeHtml(prettyJson(step.output))}</pre></details>` : ''}
    ${step.usage.length ? `<details><summary>用量明细 (${step.usage.length})</summary><pre class="json-pre">${escapeHtml(prettyJson(step.usage))}</pre></details>` : ''}
    ${hasAttrs ? `<details><summary>属性与权限裁决</summary><pre class="json-pre">${escapeHtml(prettyJson(step.attributes))}</pre></details>` : ''}
  </section>`;
}
