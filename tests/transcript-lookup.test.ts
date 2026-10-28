import assert from 'node:assert/strict';
import { id } from '@cwatch/core/types';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { check, store } from './harness.ts';

function harness() {
  const data = store(), sessionId = id(), transcript = new SessionTranscript(data, sessionId, new Redactor(['original"secret']));
  const timestamp = new Date().toISOString();
  const header = { type: 'session', id: sessionId, version: 3, timestamp, cwd: process.cwd(), parentSession: undefined };
  const entries = [
    { type: 'message', id: 'user-1', parentId: null, timestamp, message: { role: 'user', content: 'Exact user requirement: keep literal .* and original"secret' } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Old-source-marker: const answer = 42;\nError: E_FIXTURE\n' + 'x'.repeat(7000) }], toolCalls: [] } },
    { type: 'message', id: 'result-1', parentId: 'assistant-1', timestamp, message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'mcp__source__read', content: [{ type: 'text', text: 'old tool result original"secret' }] } },
    { type: 'custom', id: 'request-1', parentId: 'result-1', timestamp, customType: 'cwatch.summary_request', data: { exact: 'original request snapshot' } },
  ];
  transcript.append([header, ...entries]);
  return { data, transcript, timestamp, entries, reference: transcript.reference() };
}

check('contract', 'Transcript lookup pages the exact redacted native JSONL including old user, assistant, error and request entries', () => {
  const h = harness(); let offset = 0, text = '';
  do {
    const page = h.transcript.readTranscript({ throughEntryId: h.reference.throughEntryId, offset, limit: 97 });
    assert.equal(page.snapshotHash, h.reference.snapshotHash); assert.equal(page.untrusted, true);
    assert.ok(page.content.length <= 97); text += page.content; offset = page.nextOffset ?? -1;
  } while (offset !== -1);
  assert.deepEqual(text.trim().split('\n').map(line => JSON.parse(line)), h.data.lines(h.transcript.key));
  assert.match(text, /Exact user requirement/); assert.match(text, /const answer = 42/); assert.match(text, /E_FIXTURE/);
  assert.match(text, /original request snapshot/); assert.match(text, /\[REDACTED\]/); assert.ok(!text.includes('secret'));
  const original = h.transcript.readTranscript({ throughEntryId: h.reference.throughEntryId, entryId: 'assistant-1', offset: 0, limit: 4096 });
  assert.equal(original.matchedEntries, 1); assert.match(original.content, /Old-source-marker/);
  const search = h.transcript.readTranscript({ throughEntryId: h.reference.throughEntryId, query: 'E_FIXTURE', limit: 4096 });
  assert.equal(search.matchedEntries, 1); assert.match(search.content, /assistant-1/);
  assert.equal(h.transcript.readTranscript({ throughEntryId: h.reference.throughEntryId, query: '^.*$' }).matchedEntries, 0);
});

check('contract', 'Transcript anchors keep pagination stable as the session and read receipts grow', () => {
  const h = harness(), args = { throughEntryId: h.reference.throughEntryId, offset: 10, limit: 100 };
  const first = h.transcript.readTranscript(args);
  h.transcript.append([{ type: 'message', id: 'later-read-receipt', parentId: 'request-1', timestamp: h.timestamp, message: { role: 'user', content: 'new-read-receipt-marker' } }]);
  assert.deepEqual(h.transcript.readTranscript(args), first);
  assert.throws(() => h.transcript.readTranscript({ ...args, entryId: 'later-read-receipt' }), /outside_snapshot/);
  assert.equal(h.transcript.readTranscript({ throughEntryId: 'later-read-receipt', query: 'new-read-receipt-marker' }).matchedEntries, 1);
  assert.notEqual(h.transcript.reference().snapshotHash, h.reference.snapshotHash);
});

check('contract', 'Transcript lookup rejects foreign anchors, arbitrary paths, invalid pages and cross-session identities', () => {
  const h = harness();
  const other = new SessionTranscript(store(), id(), new Redactor());
  other.append([{ type: 'session', id: other.sessionId, version: 3, timestamp: h.timestamp, cwd: process.cwd() }, { type: 'message', id: 'foreign-entry', parentId: null, timestamp: h.timestamp, message: { role: 'user', content: 'foreign-private-marker' } }]);
  const args = { throughEntryId: h.reference.throughEntryId };
  assert.throws(() => h.transcript.readTranscript({ throughEntryId: 'foreign-entry' }), /current_session/);
  assert.throws(() => h.transcript.readTranscript({ ...args, entryId: 'foreign-entry' }), /outside_snapshot/);
  for (const invalid of [{ ...args, path: other.key }, { ...args, sessionId: other.sessionId }, { ...args, offset: -1 }, { ...args, offset: Number.MAX_SAFE_INTEGER + 1 }, { ...args, limit: 4097 }, { ...args, entryId: 'assistant-1', query: 'x' }]) assert.throws(() => h.transcript.readTranscript(invalid));
  assert.throws(() => h.transcript.readTranscript({ ...args, offset: 1e9 }), /offset_out_of_range/);
  assert.ok(!JSON.stringify(h.transcript.readTranscript(args)).includes('foreign-private-marker'));
});

check('contract', 'Transcript lookup detects changed or missing headers, content, metadata, order and lines', () => {
  for (const mutate of [
    (lines: any[]) => { lines[0].cwd = 'tampered'; },
    (lines: any[]) => { lines[1].message.content = 'tampered'; },
    (lines: any[]) => { lines[2].timestamp = 'tampered'; },
    (lines: any[]) => { lines[4].data.exact = 'tampered'; },
    (lines: any[]) => { [lines[1], lines[2]] = [lines[2], lines[1]]; },
    (lines: any[]) => { lines.splice(1, 1); },
    (lines: any[]) => { lines.length = 0; },
  ]) {
    const h = harness(), lines = h.data.lines<any>(h.transcript.key); mutate(lines);
    h.data.text(h.transcript.key, lines.map(line => JSON.stringify(line)).join('\n'));
    assert.throws(() => h.transcript.readTranscript({ throughEntryId: h.reference.throughEntryId }), /snapshot_mismatch/);
  }
});
