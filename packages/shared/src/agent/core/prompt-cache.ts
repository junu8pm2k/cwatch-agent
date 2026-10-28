export type CachePurpose = 'turn' | 'summary' | 'memory' | 'rejected';
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** SDK-normalized observations only; zero is not proof of a cache miss or lack of support. */
export function cacheUsage(usage: unknown) {
  const value = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const readTokens = count(value.cacheRead), creationTokens = count(value.cacheWrite), uncachedInputTokens = count(value.input);
  const sum = readTokens !== null && creationTokens !== null && uncachedInputTokens !== null ? readTokens + creationTokens + uncachedInputTokens : null;
  const inputTokens = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  return { source: 'sdk_normalized_usage' as const, readTokens, creationTokens, inputTokens,
    observation: (readTokens ?? 0) > 0 ? 'reuse_reported' : readTokens === null ? 'unavailable' : 'no_positive_reuse_reported',
    reportedCacheReadInputShare: inputTokens && readTokens !== null ? readTokens / inputTokens : null,
    financialSavings: 'not_estimated' as const };
}
export class PromptCacheStats {
  private purposes: Partial<Record<CachePurpose, { responses: number; reuseReportedResponses: number; readTokens: number; creationTokens: number; inputTokens: number; unavailableReadResponses: number; unavailableCreationResponses: number }>> = {};
  observe(usage: unknown, purpose: CachePurpose) {
    const result = cacheUsage(usage);
    const totals = this.purposes[purpose] ??= { responses: 0, reuseReportedResponses: 0, readTokens: 0, creationTokens: 0, inputTokens: 0, unavailableReadResponses: 0, unavailableCreationResponses: 0 };
    totals.responses++; if (result.observation === 'reuse_reported') totals.reuseReportedResponses++;
    totals.readTokens += result.readTokens ?? 0; totals.creationTokens += result.creationTokens ?? 0; totals.inputTokens += result.inputTokens ?? 0;
    if (result.readTokens === null) totals.unavailableReadResponses++;
    if (result.creationTokens === null) totals.unavailableCreationResponses++;
    return result;
  }
  snapshot() { return { source: 'sdk_normalized_usage', byPurpose: structuredClone(this.purposes), financialSavings: 'not_estimated', zeroMeaning: 'No positive reuse was reported; support and raw-field availability may be unknown.' }; }
}
