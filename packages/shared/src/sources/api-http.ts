import { HttpResponseMetadataSchema, type HttpResponseMetadata, type RetrievalResult } from '@cwatch/core/types';

const maxDateMs = 253402300799999; // ISO timestamps through year 9999, never unbounded header strings.
const integer = (value: string | null): number | undefined => {
  if (value === null || !/^\d{1,16}$/.test(value.trim())) return undefined;
  const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};
const iso = (value: number | undefined): string | undefined => value !== undefined && value >= 0 && value <= maxDateMs ? new Date(value).toISOString() : undefined;
function retryAfter(value: string | null, receivedAt: number): number | undefined {
  const seconds = integer(value);
  if (seconds !== undefined) return iso(receivedAt + seconds * 1000) ? receivedAt + seconds * 1000 : undefined;
  if (!value || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && iso(parsed) ? parsed : undefined;
}

/** GitHub's documented 403 semantics apply only to its configured public REST origin. No retry is performed. */
export function classifyApiResponse(endpoint: string, response: Pick<Response, 'status' | 'headers'>, raw: string, receivedAt = Date.now()): { status: RetrievalResult['status']; http: HttpResponseMetadata } {
  const github = new URL(endpoint).origin === 'https://api.github.com';
  const { status: code, headers } = response;
  const remaining = github ? integer(headers.get('x-ratelimit-remaining')) : undefined;
  const limit = github ? integer(headers.get('x-ratelimit-limit')) : undefined;
  const resetSeconds = github ? integer(headers.get('x-ratelimit-reset')) : undefined;
  const resetAt = resetSeconds === undefined ? undefined : iso(resetSeconds * 1000);
  const after = retryAfter(headers.get('retry-after'), receivedAt);
  let message = '';
  if (github && (code === 403 || code === 429)) {
    try { const body = JSON.parse(raw); if (typeof body?.message === 'string') message = body.message; } catch { /* Headers still carry authoritative quota information. */ }
  }
  const secondary = /\bsecondary rate limit\b/i.test(message);
  const rateMessage = secondary || /\b(?:api rate limit exceeded|rate limit (?:exceeded|reached)|you have exceeded (?:a |your )?rate limit)\b/i.test(message);
  const limited = code === 429 || github && code === 403 && (remaining === 0 || after !== undefined || rateMessage);
  const status = code === 401 ? 'auth_failed' : limited ? 'rate_limited' : code === 403 ? 'auth_failed' : code >= 200 && code < 300 ? 'success_with_data' : 'unknown';
  const http: HttpResponseMetadata = { status: code };
  if (limited || github && (remaining !== undefined || limit !== undefined || resetAt !== undefined)) {
    const kind = github && remaining === 0 ? 'primary' : github && (secondary || limited && after !== undefined) ? 'secondary' : github && !limited ? 'primary' : 'unspecified';
    const quota: NonNullable<HttpResponseMetadata['rateLimit']> = { kind, ...(remaining === undefined ? {} : { remaining }), ...(limit === undefined ? {} : { limit }), ...(resetAt ? { resetAt } : {}) };
    if (status === 'rate_limited') {
      const candidates: Array<{ at: number; source: 'retry-after' | 'x-ratelimit-reset' | 'secondary-minimum' }> = [];
      if (after !== undefined && after >= receivedAt) { candidates.push({ at: after, source: 'retry-after' }); quota.retryAfterSeconds = Math.ceil((after - receivedAt) / 1000); }
      if (remaining === 0 && resetAt && Date.parse(resetAt) > receivedAt) candidates.push({ at: Date.parse(resetAt), source: 'x-ratelimit-reset' });
      if (!candidates.length && kind === 'secondary') candidates.push({ at: receivedAt + 60_000, source: 'secondary-minimum' });
      if (candidates.length) {
        quota.retryAt = iso(Math.max(...candidates.map(candidate => candidate.at)));
        quota.retrySource = candidates.length > 1 ? 'combined' : candidates[0].source;
      }
    }
    http.rateLimit = quota;
  }
  return { status, http: HttpResponseMetadataSchema.parse(http) };
}
