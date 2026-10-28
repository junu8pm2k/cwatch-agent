/** Host-owned limits shared by CLI and programmatic callers. */
export const DEFAULT_LIMITS = {
  maxSteps: 24, maxToolCalls: 20, maxSameToolCalls: 8,
  contextChars: 150_000, maxResponseChars: 32_000,
  maxOutputTokens: 4096, maxTokens: 100_000,
  timeoutMs: 120_000, modelTimeoutMs: 60_000, toolTimeoutMs: 15_000,
} as const;
export type RunLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };
export type LimitOptions = Partial<RunLimits>;
export function resolveLimits(options: LimitOptions = {}): RunLimits {
  const limits = { ...DEFAULT_LIMITS } as RunLimits;
  for (const key of Object.keys(limits) as Array<keyof RunLimits>) {
    const value = options[key] ?? limits[key];
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
