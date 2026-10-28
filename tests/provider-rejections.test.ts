import assert from 'node:assert/strict';
import { isContextRejection, ReactiveCompactCircuit, PROVIDER_REJECTION, rejectedEntryIds } from '@cwatch/shared/agent/backend/pi/provider-rejections';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getMessagesAfterCompactBoundary } from '@cwatch/shared/agent/backend/pi/context';
import { check } from './harness.ts';

check('contract', 'Only explicit provider context errors without partial output qualify for reactive compression', () => {
  for (const text of ['400 context_length_exceeded', 'prompt is too long: 100 > 90 maximum', 'prompt too long', 'Your input exceeds the context window of this model', 'Requested token count exceeds the model\'s maximum context length of 123 tokens', 'The input token count exceeds the maximum allowed', 'request_too_large', 'Range of input length should be [1, 100]']) assert.equal(isContextRejection({ stopReason: 'error', errorMessage: text, content: [] }), true, text);
  for (const text of ['401 context_length_exceeded', '403 prompt too long', '429 context_length_exceeded', '503 prompt is too long', 'rate limit: too many tokens', 'tokens per minute context_length_exceeded', 'network error: prompt too long', 'max_tokens must be <= 4096', '413 Payload Too Large', 'invalid schema']) assert.equal(isContextRejection({ stopReason: 'error', errorMessage: text, content: [] }), false, text);
  for (const stopReason of ['stop', 'length', 'aborted']) assert.equal(isContextRejection({ stopReason, errorMessage: 'prompt too long', content: [] }), false);
  assert.equal(isContextRejection({ stopReason: 'error', errorMessage: 'prompt too long', content: [{ type: 'text', text: 'partial answer' }] }), false);
  assert.equal(isContextRejection({ stopReason: 'error', errorMessage: 'prompt too long', content: [{ type: 'toolCall', name: 'write' }] }), false);
});

check('contract', 'Reactive circuit allows one retry per consecutive incident and caps total recoveries even after success', () => {
  const repeated = new ReactiveCompactCircuit(); repeated.begin();
  assert.throws(() => repeated.begin(), /circuit_open/); assert.equal(repeated.attempts, 1); assert.equal(repeated.open, true);
  const separated = new ReactiveCompactCircuit(); separated.begin(); separated.success(); separated.begin(); separated.success();
  assert.equal(separated.consecutiveRejections, 0); assert.throws(() => separated.begin(), /circuit_open/); assert.equal(separated.attempts, 2);
  const failed = new ReactiveCompactCircuit(); failed.begin(); failed.failed(); assert.throws(() => failed.begin(), /circuit_open/);
});

check('contract', 'Rejected response projection omits only checked failed native responses and rejects forged identities', () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: 'user', content: 'original goal', timestamp: Date.now() });
  const failedId = manager.appendMessage({ role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: Date.now(), stopReason: 'error', errorMessage: 'prompt too long', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendCustomEntry(PROVIDER_REJECTION, { entryId: failedId, reason: 'context_length_exceeded' });
  assert.equal(rejectedEntryIds(manager).size, 1);
  assert.ok(!JSON.stringify(getMessagesAfterCompactBoundary(manager)).includes('prompt too long'));
  assert.match(JSON.stringify(manager.getEntries()), /prompt too long/);
  manager.appendCustomEntry(PROVIDER_REJECTION, { entryId: failedId, reason: 'context_length_exceeded' });
  assert.throws(() => getMessagesAfterCompactBoundary(manager), /projection_mismatch/);
  const forged = SessionManager.inMemory(process.cwd());
  const userId = forged.appendMessage({ role: 'user', content: 'Do not hide this message', timestamp: Date.now() });
  forged.appendCustomEntry(PROVIDER_REJECTION, { entryId: userId, reason: 'context_length_exceeded' });
  assert.throws(() => getMessagesAfterCompactBoundary(forged), /projection_mismatch/);
});
