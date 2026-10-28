import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { assertCompleteApiRounds, groupApiRounds } from '@cwatch/shared/agent/backend/pi/api-rounds';
import { check } from './harness.ts';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (manager: SessionManager, calls: Array<{ id: string; name: string }>) => manager.appendMessage({ role: 'assistant', content: calls.map(call => ({ type: 'toolCall', ...call, arguments: {} })), api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: calls.length ? 'toolUse' : 'stop', usage, timestamp: Date.now() });
const result = (manager: SessionManager, id: string, name: string, isError = false) => manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: isError ? 'failed' : 'ok' }], isError, timestamp: Date.now() });

check('contract', 'API round grouping keeps all calls and out-of-order results together and permits IDs reused in later rounds', () => {
  const manager = SessionManager.inMemory();
  const userId = manager.appendMessage({ role: 'user', content: 'First task', timestamp: Date.now() });
  const first = assistant(manager, [{ id: 'reused', name: 'a' }, { id: 'b', name: 'b' }]);
  result(manager, 'b', 'b', true); manager.appendCustomEntry('audit-only', {}); const lastResult = result(manager, 'reused', 'a');
  const nextUser = manager.appendMessage({ role: 'user', content: 'Follow-up task', timestamp: Date.now() });
  assistant(manager, [{ id: 'reused', name: 'a' }]); result(manager, 'reused', 'a');
  const entries = manager.getEntries(), rounds = groupApiRounds(entries);
  assert.equal(rounds.length, 2); assert.equal(rounds[0].firstEntryId, userId); assert.equal(rounds[0].assistantEntryId, first);
  assert.equal(entries[rounds[0].endIndex].id, lastResult); assert.equal(rounds[1].firstEntryId, nextUser);
  assert.deepEqual(rounds[0].toolCallIds, ['reused', 'b']); assertCompleteApiRounds(manager.buildSessionContext().messages);
});

check('contract', 'API round validation rejects missing, orphaned, duplicate and mismatched results without pairing across responses', () => {
  for (const mode of ['missing', 'orphan', 'duplicate-call', 'duplicate-result', 'wrong-name', 'next-assistant', 'next-user']) {
    const manager = SessionManager.inMemory();
    if (mode === 'orphan') result(manager, 'a', 'a');
    else {
      assistant(manager, mode === 'duplicate-call' ? [{ id: 'a', name: 'a' }, { id: 'a', name: 'b' }] : [{ id: 'a', name: 'a' }]);
      if (mode === 'wrong-name') result(manager, 'a', 'other');
      if (mode === 'duplicate-result') { result(manager, 'a', 'a'); result(manager, 'a', 'a'); }
      if (mode === 'next-assistant') assistant(manager, [{ id: 'a', name: 'a' }]);
      if (mode === 'next-user') manager.appendMessage({ role: 'user', content: 'interruption', timestamp: Date.now() });
    }
    assert.throws(() => groupApiRounds(manager.getEntries()), /context_round_/, mode);
    assert.throws(() => assertCompleteApiRounds(manager.buildSessionContext().messages), /context_round_/, mode);
  }
});
