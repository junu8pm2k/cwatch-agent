import type { ToolBudgetSkip, ToolBudgetSnapshot } from '@cwatch/core/types';

/** Host-owned limits shared by CLI and programmatic callers. */
export const DEFAULT_LIMITS = {
  maxSteps: 64, maxToolCalls: 128, maxSameToolCalls: 128, maxConsecutiveToolFailures: 4,
  contextChars: 150_000, maxResponseChars: 32_000,
  maxOutputTokens: 4096, maxTokens: 400_000,
  timeoutMs: 300_000, modelTimeoutMs: 90_000, toolTimeoutMs: 45_000,
} as const;
const completionTools = new Set(['workflow__analyze', 'workflow__review', 'workflow__draft']);
export const isCompletionTool = (name: string): boolean => completionTools.has(name);
const countFor = (counts: Record<string, number> | undefined, name: string) =>
  counts && Object.hasOwn(counts, name) ? counts[name] : 0;

export function remainingToolBudget(snapshot: ToolBudgetSnapshot, name: string) {
  const reserve = isCompletionTool(name) ? 0 : snapshot.reservedForCompletion ?? 0;
  return {
    sameTool: Math.max(0, snapshot.maxSameToolCalls - countFor(snapshot.callsByTool, name)),
    available: Math.max(0, snapshot.maxToolCalls - snapshot.toolCalls - reserve),
  };
}

export function toolBudgetSkip(snapshot: ToolBudgetSnapshot, name: string): ToolBudgetSkip | null {
  const remaining = remainingToolBudget(snapshot, name);
  const failureLimit = snapshot.maxConsecutiveToolFailures ?? DEFAULT_LIMITS.maxConsecutiveToolFailures;
  if (countFor(snapshot.failuresByTool, name) >= failureLimit) {
    return { status: 'tool_budget_skipped', tool: name, budget: 'tool_failures', limit: failureLimit,
      message: 'This tool has reached its consecutive failure limit. Use another source or continue with the available evidence.' };
  }
  if (snapshot.toolCalls >= snapshot.maxToolCalls) {
    return { status: 'tool_budget_skipped', tool: name, budget: 'tools', limit: snapshot.maxToolCalls,
      message: 'The run tool budget is exhausted. Use the available results to finish and disclose gaps.' };
  }
  if (!remaining.sameTool) {
    return { status: 'tool_budget_skipped', tool: name, budget: 'same_tool', limit: snapshot.maxSameToolCalls,
      message: 'This tool has reached its call limit. Use existing results or other available tools.' };
  }
  if (!remaining.available) {
    return { status: 'tool_budget_skipped', tool: name, budget: 'completion_reserve', limit: snapshot.maxToolCalls,
      message: 'The remaining calls are reserved for analysis, review and drafting. Continue with the evidence already collected.' };
  }
  return null;
}

const failureStatuses = new Set(['tool_failed', 'auth_failed', 'rate_limited', 'timeout', 'parse_failed', 'cancelled', 'unknown']);
export function isFailedToolResult(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const { status, isError, error } = result as { status?: string; isError?: boolean; error?: unknown };
  if (status === 'success_with_data' || status === 'success_empty') return false;
  return isError === true || failureStatuses.has(status ?? '') || typeof error === 'string';
}
export type RunLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };
export type LimitOptions = Partial<RunLimits>;
export function resolveLimits(options: LimitOptions = {}): RunLimits {
  const limits = { ...DEFAULT_LIMITS } as RunLimits;
  for (const key of Object.keys(limits) as Array<keyof RunLimits>) {
    const value = options[key] ?? (key === 'maxSameToolCalls' ? limits.maxToolCalls : limits[key]);
    const minimum = ['maxSteps', 'maxToolCalls', 'maxSameToolCalls'].includes(key) ? 0 : 1;
    const maximum = key.endsWith('Ms') ? 2_147_483_647 : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('invalid_limit:' + key);
    limits[key] = value;
  }
  return limits;
}
export class BudgetError extends Error {
  constructor(readonly budget: string, readonly limit: number, readonly actual: number, readonly tool?: string) {
    super('budget_' + budget + ': ' + actual + '/' + limit + (tool ? ' tool=' + tool : ''));
  }
}
/** Cache and reasoning subtotals must never be counted twice. */
export function reportedTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const value = usage as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const parts = [value.input, value.output, value.cacheRead, value.cacheWrite];
  const sum = parts.every(valid) ? (parts as number[]).reduce((a,b) => a+b,0) : undefined;
  const total = valid(value.totalTokens) ? Math.max(value.totalTokens, sum ?? 0) : sum;
  return total && Number.isSafeInteger(total) ? total : undefined;
}
