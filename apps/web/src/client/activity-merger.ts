import type { RunActivity } from '@cwatch/core/types/runs';

export type SemanticCategory =
  | 'plan'
  | 'search'
  | 'fetch'
  | 'local'
  | 'analysis'
  | 'review'
  | 'draft'
  | 'approval'
  | 'mcp'
  | 'system'
  | 'error';

export interface MergedActivity {
  id: string;
  category: SemanticCategory;
  badge: string;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'info';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  tool?: string;
  detail?: string;
  errorDetail?: string;
  stage?: number;
  callId?: string;
  batchId?: string;
  batchSize?: number;
  skipped?: boolean;
}

export interface BatchStepCounts {
  completed: number;
  failed: number;
  running: number;
  skipped: number;
}

export type StepRenderNode =
  | { kind: 'single'; item: MergedActivity }
  | {
    kind: 'batch';
    batchId: string;
    items: MergedActivity[];
    state: MergedActivity['state'];
    counts: BatchStepCounts;
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
  };

function parseJsonSafe(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function shortUrlLabel(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname === '/' ? '' : u.pathname;
    const label = u.hostname + path;
    return label.length > 68 ? label.slice(0, 68) + '…' : label;
  } catch {
    return rawUrl.slice(0, 68);
  }
}

function describeToolCall(tool: string, detail?: string): { category: SemanticCategory; badge: string; title: string } {
  const args = parseJsonSafe(detail);
  if (tool === 'workflow__save_plan') {
    return { category: 'plan', badge: '计划', title: '生成并提交调查计划' };
  }
  if (tool === 'workflow__extract_signal') {
    const title = typeof args?.title === 'string' ? args.title.trim() : '';
    return { category: 'analysis', badge: '抽取', title: title ? `抽取结构化证据：${title}` : '从网页抽取结构化证据' };
  }
  if (tool === 'workflow__assess_search') return { category: 'search', badge: '筛选', title: '筛选搜索候选来源' };
  if (tool === 'workflow__collection_status') return { category: 'search', badge: '采集', title: '检查采集覆盖情况' };
  if (tool === 'workflow__submit_analysis') return { category: 'analysis', badge: '分析', title: '提交逐项分析结论' };
  if (tool === 'workflow__analyze') {
    return { category: 'analysis', badge: '分析', title: '归因分析与结构化整理' };
  }
  if (tool === 'workflow__review') {
    return { category: 'review', badge: '审阅', title: '规则审阅与快照核验' };
  }
  if (tool === 'workflow__draft') {
    return { category: 'draft', badge: '草稿', title: '生成带引用调查草稿' };
  }
  if (tool === 'web_search') {
    const q = typeof args?.query === 'string' ? args.query.trim() : '';
    return { category: 'search', badge: '搜索', title: q ? `联网搜索：${q}` : '执行联网搜索' };
  }
  if (tool === 'web_fetch') {
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    return { category: 'fetch', badge: '读取', title: url ? `读取网页：${shortUrlLabel(url)}` : '读取公开网页' };
  }
  if (tool === 'read') {
    const path = typeof args?.path === 'string' ? args.path : '';
    return { category: 'local', badge: '读取', title: path ? `读取文件：${path}` : '读取本地文件' };
  }
  if (tool === 'grep') {
    const pattern = typeof args?.pattern === 'string' ? args.pattern : '';
    return { category: 'local', badge: '检索', title: pattern ? `检索工作区：“${pattern}”` : '检索工作区内容' };
  }
  if (tool === 'find' || tool === 'ls') {
    const path = typeof args?.path === 'string' ? args.path : '.';
    return { category: 'local', badge: '浏览', title: `浏览目录：${path}` };
  }
  if (tool === 'write' || tool === 'edit') {
    const path = typeof args?.path === 'string' ? args.path : '';
    return { category: 'local', badge: '写入', title: path ? `修改文件：${path}` : '修改本地文件' };
  }
  if (tool === 'bash') {
    const cmd = typeof args?.command === 'string' ? args.command.slice(0, 60) : '';
    return { category: 'local', badge: '命令', title: cmd ? `执行命令：${cmd}` : '执行本地命令' };
  }
  if (tool.startsWith('mcp__')) {
    const clean = tool.replace(/^mcp__/, '').replace(/__/g, ' · ');
    return { category: 'mcp', badge: 'MCP', title: `调用扩展工具：${clean}` };
  }
  if (tool.startsWith('session__')) {
    return { category: 'local', badge: '会话', title: `调用 ${tool.replace(/^session__/, '')}` };
  }
  return { category: 'search', badge: '工具', title: `调用 ${tool}` };
}

const stageByCategory: Partial<Record<SemanticCategory, number>> = {
  plan: 0, search: 1, fetch: 1, mcp: 1, analysis: 2, review: 3, draft: 4,
};

/**
 * Merges paired `准备调用 <tool>` + `<tool> 已完成/未完成` events into clean single-row
 * semantic progress cards, infers legacy parallel batches, detects soft tool failures,
 * and filters repetitive process-lifecycle noise.
 */
export function mergeActivities(activities: RunActivity[], runActive = true): MergedActivity[] {
  const items: MergedActivity[] = [];
  const openByTool = new Map<string, MergedActivity[]>();
  const openByCallId = new Map<string, MergedActivity>();
  let lastStage = 0;
  let legacyBurst: MergedActivity[] = [];
  let legacyBurstFirstSeq = 0;
  let legacyBurstLastMs = 0;

  const flushLegacyBurst = () => {
    if (legacyBurst.length >= 2) {
      const batchId = `legacy-batch-${legacyBurstFirstSeq}`;
      for (const card of legacyBurst) {
        if (!card.batchId) {
          card.batchId = batchId;
          card.batchSize = legacyBurst.length;
        }
      }
    }
    legacyBurst = [];
  };

  for (const ev of activities) {
    // Skip noisy low-value boilerplate messages that clutter the stream
    if (
      ev.kind === 'system' && (
        ev.message === 'Agent 进程：started'
        || ev.message === 'Agent 进程：stopping'
        || ev.message === 'Agent 子进程已就绪。'
        || ev.message === 'Agent 子进程已退出。'
      )
    ) {
      continue;
    }
    if (ev.kind === 'plan' && ev.message === '调查计划已保存并提交。') {
      flushLegacyBurst();
      lastStage = 1;
      continue;
    }

    const meta = ev.tool ? describeToolCall(ev.tool, ev.detail) : undefined;
    const stage = ev.stage === -1 ? 0 : ev.stage ?? (ev.tool === 'workflow__extract_signal' ? 1 : (meta && stageByCategory[meta.category]) ?? lastStage);
    lastStage = stage;

    // Tool start event
    if (ev.tool && meta && ev.message.startsWith('准备调用 ')) {
      const evMs = Date.parse(ev.timestamp);
      if (ev.batchId) {
        flushLegacyBurst();
      } else if (legacyBurst.length && (!Number.isFinite(evMs) || !Number.isFinite(legacyBurstLastMs) || Math.abs(evMs - legacyBurstLastMs) > 250)) {
        flushLegacyBurst();
      }
      const card: MergedActivity = {
        id: `act-${ev.sequence}`,
        category: meta.category,
        badge: meta.badge,
        title: meta.title,
        state: 'running',
        startedAt: ev.timestamp,
        tool: ev.tool,
        detail: ev.detail,
        stage,
        ...(ev.callId ? { callId: ev.callId } : {}),
        ...(ev.batchId ? { batchId: ev.batchId, batchSize: ev.batchSize } : {}),
      };
      items.push(card);
      const queue = openByTool.get(ev.tool) ?? [];
      queue.push(card);
      openByTool.set(ev.tool, queue);
      if (ev.callId) openByCallId.set(ev.callId, card);
      if (!ev.batchId) {
        if (!legacyBurst.length) legacyBurstFirstSeq = ev.sequence;
        legacyBurst.push(card);
        legacyBurstLastMs = evMs;
      }
      continue;
    }

    flushLegacyBurst();

    // Tool finish event — prefer exact callId match, then fall back to earliest matching running card
    if (ev.tool && meta && (ev.state === 'skipped' || ev.message.endsWith(' 已完成') || ev.message.endsWith(' 未完成'))) {
      let target: MergedActivity | undefined;
      const queue = openByTool.get(ev.tool);
      if (ev.callId && openByCallId.has(ev.callId)) {
        target = openByCallId.get(ev.callId);
        openByCallId.delete(ev.callId);
        if (target && queue) {
          const idx = queue.indexOf(target);
          if (idx >= 0) queue.splice(idx, 1);
        }
      } else {
        target = queue?.shift();
        if (target?.callId) openByCallId.delete(target.callId);
      }
      const skipped = ev.state === 'skipped';
      // Back-compat: historical activity logs marked soft tool errors as completed with error detail.
      const hasSoftError = ev.state === 'completed' && Boolean(ev.detail) && ev.message.endsWith(' 已完成');
      const succeeded = !skipped && !hasSoftError && (ev.state === 'completed' || ev.message.endsWith(' 已完成'));
      if (target) {
        target.state = skipped ? 'info' : succeeded ? 'completed' : 'failed';
        if (skipped) {
          target.skipped = true;
          target.title += '（额度受限，已跳过）';
        }
        target.endedAt = ev.timestamp;
        const delta = Date.parse(ev.timestamp) - Date.parse(target.startedAt);
        if (Number.isFinite(delta) && delta >= 0) target.durationMs = delta;
        if (!succeeded && !skipped && ev.detail) target.errorDetail = ev.detail;
        continue;
      }
      items.push({
        id: `act-${ev.sequence}`,
        category: succeeded || skipped ? meta.category : 'error',
        badge: skipped ? '跳过' : succeeded ? meta.badge : '异常',
        title: ev.message,
        state: skipped ? 'info' : succeeded ? 'completed' : 'failed',
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        tool: ev.tool,
        errorDetail: !succeeded && !skipped ? ev.detail : undefined,
        stage,
        ...(skipped ? { skipped: true } : {}),
      });
      continue;
    }

    if (ev.kind === 'approval') {
      items.push({
        id: `act-${ev.sequence}`,
        category: 'approval',
        badge: '审批',
        title: ev.message,
        state: 'info',
        startedAt: ev.timestamp,
        tool: ev.tool,
        stage,
      });
      continue;
    }

    if (ev.kind === 'error') {
      items.push({
        id: `act-${ev.sequence}`,
        category: 'error',
        badge: '异常',
        title: ev.message,
        state: 'failed',
        startedAt: ev.timestamp,
        errorDetail: ev.detail,
        stage,
      });
      continue;
    }

    items.push({
      id: `act-${ev.sequence}`,
      category: 'system',
      badge: '状态',
      title: ev.message,
      state: 'info',
      startedAt: ev.timestamp,
      detail: ev.detail,
      stage,
    });
  }

  flushLegacyBurst();

  // Finalize any still-running tool starts once the run has terminated so ended runs never report ghost "running" counts.
  if (!runActive) {
    for (const card of items) {
      if (card.state === 'running') {
        card.state = 'failed';
        card.errorDetail = card.errorDetail ?? '运行已结束，该工具调用未返回结果。';
      }
    }
  }

  return items;
}

/**
 * Groups merged activities belonging to the same parallel tool call batch into tree nodes.
 * Single-item batches (e.g. after stage filtering) remain ordinary single cards.
 */
export function groupMergedActivities(items: MergedActivity[]): StepRenderNode[] {
  const byBatch = new Map<string, MergedActivity[]>();
  for (const item of items) {
    if (!item.batchId) continue;
    const list = byBatch.get(item.batchId) ?? [];
    list.push(item);
    byBatch.set(item.batchId, list);
  }

  const nodes: StepRenderNode[] = [];
  const emittedBatches = new Set<string>();
  for (const item of items) {
    if (!item.batchId) {
      nodes.push({ kind: 'single', item });
      continue;
    }
    const group = byBatch.get(item.batchId)!;
    if (group.length < 2) {
      nodes.push({ kind: 'single', item });
      continue;
    }
    if (emittedBatches.has(item.batchId)) continue;
    emittedBatches.add(item.batchId);

    const counts: BatchStepCounts = {
      completed: group.filter(s => s.state === 'completed').length,
      failed: group.filter(s => s.state === 'failed').length,
      running: group.filter(s => s.state === 'running').length,
      skipped: group.filter(s => s.skipped).length,
    };
    const state: MergedActivity['state'] = counts.running > 0
      ? 'running'
      : counts.failed > 0
        ? 'failed'
        : counts.completed > 0
          ? 'completed'
          : 'info';

    const startTimes = group.map(s => Date.parse(s.startedAt)).filter(Number.isFinite);
    const endTimes = group.map(s => (s.endedAt ? Date.parse(s.endedAt) : NaN)).filter(Number.isFinite);
    const startedAt = group[0].startedAt;
    const maxEnd = counts.running === 0 && endTimes.length ? Math.max(...endTimes) : undefined;
    const minStart = startTimes.length ? Math.min(...startTimes) : undefined;
    const durationMs = maxEnd !== undefined && minStart !== undefined && maxEnd >= minStart
      ? maxEnd - minStart
      : undefined;

    nodes.push({
      kind: 'batch',
      batchId: item.batchId,
      items: group,
      state,
      counts,
      startedAt,
      endedAt: maxEnd !== undefined ? new Date(maxEnd).toISOString() : undefined,
      durationMs,
    });
  }
  return nodes;
}

export function formatBatchSummary(counts: BatchStepCounts): string {
  const parts: string[] = [];
  if (counts.completed) parts.push(`${counts.completed} 成功`);
  if (counts.failed) parts.push(`${counts.failed} 异常`);
  if (counts.skipped) parts.push(`${counts.skipped} 跳过`);
  if (counts.running) parts.push(`${counts.running} 进行中`);
  return parts.join(' · ');
}
