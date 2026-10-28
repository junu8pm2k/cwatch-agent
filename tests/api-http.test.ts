import assert from 'node:assert/strict';
import { HttpResponseMetadataSchema } from '@cwatch/core/types';
import { classifyApiResponse } from '@cwatch/shared/sources/api-http';
import { check } from './harness.ts';

const at = Date.parse('2026-10-24T14:00:00Z'), endpoint = 'https://api.github.com';
const reset = String(at / 1000 + 90);
const classify = (status: number, headers: Record<string, string> = {}, message = '', base = endpoint) => classifyApiResponse(base, { status, headers: new Headers(headers) }, JSON.stringify({ message }), at);

check('contract', 'GitHub primary 403 quota exhaustion carries a safe UTC reset and remains a failed collection', () => {
  const result = classify(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': reset }, 'API rate limit exceeded');
  assert.equal(result.status, 'rate_limited');
  assert.deepEqual(result.http.rateLimit, { kind: 'primary', limit: 60, remaining: 0, resetAt: '2026-10-24T14:01:30.000Z', retryAt: '2026-10-24T14:01:30.000Z', retrySource: 'x-ratelimit-reset' });
});
check('contract', 'GitHub secondary limits honor Retry-After even with remaining primary quota', () => {
  const result = classify(403, { 'x-ratelimit-remaining': '42', 'retry-after': '120' }, 'You have exceeded a secondary rate limit.');
  assert.equal(result.status, 'rate_limited'); assert.equal(result.http.rateLimit!.kind, 'secondary');
  assert.equal(result.http.rateLimit!.retryAt, '2026-10-24T14:02:00.000Z'); assert.equal(result.http.rateLimit!.remaining, 42);
});
check('contract', 'GitHub true authentication failures and ordinary forbidden responses are not reclassified from quota hints', () => {
  const auth = classify(401, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset, 'retry-after': '120' }, 'Bad credentials');
  assert.equal(auth.status, 'auth_failed'); assert.equal(auth.http.rateLimit!.retryAt, undefined);
  const forbidden = classify(403, { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': reset }, 'Resource not accessible by integration');
  assert.equal(forbidden.status, 'auth_failed'); assert.equal(forbidden.http.rateLimit!.retryAt, undefined);
});
check('contract', 'GitHub quota rules never reinterpret another platform 403 or an unrelated 503', () => {
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset };
  assert.equal(classify(403, headers, 'API rate limit exceeded', 'https://other.example').status, 'auth_failed');
  assert.equal(classify(503, headers, 'API rate limit exceeded').status, 'unknown');
});
check('contract', 'Secondary GitHub limits without a usable deadline record a labeled minimum rather than an invented server reset', () => {
  const result = classify(403, {}, 'You have exceeded a secondary rate limit.');
  assert.equal(result.status, 'rate_limited'); assert.equal(result.http.rateLimit!.retryAt, '2026-10-24T14:01:00.000Z');
  assert.equal(result.http.rateLimit!.retrySource, 'secondary-minimum'); assert.equal(result.http.rateLimit!.resetAt, undefined);
});
check('contract', 'Retry-After HTTP dates are accepted and combined limits never suggest an earlier retry', () => {
  const result = classify(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset, 'retry-after': 'Sat, 24 Oct 2026 14:03:00 GMT' });
  assert.equal(result.http.rateLimit!.retryAt, '2026-10-24T14:03:00.000Z'); assert.equal(result.http.rateLimit!.retrySource, 'combined');
  const laterReset = classify(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset, 'retry-after': '10' });
  assert.equal(laterReset.http.rateLimit!.retryAt, '2026-10-24T14:01:30.000Z');
});
check('contract', 'Malformed, credential-bearing, overflowing and expired retry headers do not fabricate a deadline', () => {
  for (const bad of ['private-api-key', '-1', 'Infinity', '99999999999999999999999999999', '1.5']) {
    const result = classify(429, { 'retry-after': bad, 'x-ratelimit-reset': bad, 'x-ratelimit-limit': bad, 'x-ratelimit-remaining': bad, 'authorization': 'Bearer private-api-key', 'set-cookie': 'private-api-key' });
    assert.deepEqual(result.http, { status: 429, rateLimit: { kind: 'unspecified' } });
    assert.ok(!JSON.stringify(result.http).includes('private-api-key'));
  }
  const past = classify(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(at / 1000 - 60) });
  assert.equal(past.status, 'rate_limited'); assert.equal(past.http.rateLimit!.retryAt, undefined);
});
check('contract', 'Successful GitHub responses expose actual quota without promising a retry or another request allowance', () => {
  const result = classify(200, { 'x-ratelimit-remaining': '2', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': reset });
  assert.equal(result.status, 'success_with_data'); assert.equal(result.http.rateLimit!.remaining, 2);
  assert.equal(result.http.rateLimit!.retryAt, undefined);
  assert.equal(HttpResponseMetadataSchema.safeParse({ ...result.http, authorization: 'secret' }).success, false);
});
