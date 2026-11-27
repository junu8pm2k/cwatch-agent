import assert from 'node:assert/strict';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiContextManager, getMessagesAfterCompactBoundary } from '@cwatch/shared/agent/backend/pi/context';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { type AgentSessionHooks, id } from '@cwatch/core/types';
import { TOOL_RESULT_VIEW, ToolResultGovernor, type ToolResultPolicy } from '@cwatch/shared/agent/backend/pi/tool-result-context';
import { assertCompleteApiRounds } from '@cwatch/shared/agent/backend/pi/api-rounds';
import { COMPACT_ATTACHMENT, COMPACT_COMMIT, COMPACT_HOOK_RESULT } from '@cwatch/shared/agent/backend/pi/compact-entries';
import { check, store } from './harness.ts';

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 190, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function toolTurn(manager: SessionManager, index: number, text = 'x'.repeat(6000)) {
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'auxiliary explanation ' + index }, { type: 'toolCall', id: 'call-' + index, name: 'mcp__source__read', arguments: { index } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'call-' + index, toolName: 'mcp__source__read', content: [{ type: 'text', text: 'raw-marker-' + index + ':' + text }], isError: false, timestamp: Date.now() });
}
async function harness(policy?: ToolResultPolicy, maxChars = 21_000) {
  const data = store(), sessionId = id(), manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const transcript = new SessionTranscript(data, sessionId, new Redactor(['fixture-secret']));
  let summaryCalls = 0, recordedUsage = 0;
  const hooks = {
    onTranscript: entries => transcript.append(entries),
    beforeRequest: () => ({ maxOutputTokens: 4096 }),
    onUsage: () => { recordedUsage++; },
  } as Pick<AgentSessionHooks, 'onTranscript' | 'beforeRequest' | 'onUsage'> as AgentSessionHooks;
  const { model } = await createPiRuntime('fixture-context', 'fixture', { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1/unused' }, new AbortController().signal);
  const runtime = { completeSimple: async (_model: unknown, _context: unknown, options: { cacheRetention?: string }) => { assert.equal(options.cacheRetention, 'none'); summaryCalls++; return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ userGoal: 'Summary ' + summaryCalls, completedWork: ['plan saved'], keyFiles: ['snapshot/path.txt'], errorsAndFixes: [], unfinishedTasks: ['continue investigation'], nextSteps: ['collect and analyze evidence'], references: ['claim-exact-123'], sourceGaps: ['failed source remains a gap'] }) }], usage, stopReason: 'stop' }; } } as unknown as ModelRuntime;
  const context = new PiContextManager(manager, hooks, maxChars, 32_000, policy);
  manager.appendMessage({ role: 'user', content: 'Pinned original task fixture-secret', timestamp: Date.now() });
  const view = () => ({ systemPrompt: 'Current host permission: explore.', tools: [], messages: getMessagesAfterCompactBoundary(manager) });
  return { data, sessionId, transcript, manager, hooks, context, runtime, model, view, counts: () => ({ summaryCalls, recordedUsage }) };
}

check('integration', 'Repeated compaction preserves full native transcript, exact latest tool pairs and pinned task after reload', async () => {
  const h = await harness();
  for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
  const first = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  assert.ok(JSON.stringify(first).includes('Summary 1'));
  assert.ok(!JSON.stringify(first).includes('raw-marker-1'));
  assert.ok(JSON.stringify(first).includes('raw-marker-3'));
  for (let i = 4; i <= 5; i++) toolTurn(h.manager, i);
  const second = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  toolTurn(h.manager, 6, 'new message after boundary'); await h.context.flush();
  assert.ok(JSON.stringify(second).includes('Summary 2'));
  assert.ok(!JSON.stringify(second).includes('raw-marker-3'));
  assert.ok(JSON.stringify(second).includes('raw-marker-5'));
  const lines = h.data.lines<any>(h.transcript.key);
  assert.equal(lines.filter(entry => entry.type === 'compaction').length, 2);
  assert.equal(lines.filter(entry => entry.type === 'message').length, 13);
  assert.ok(JSON.stringify(lines).includes('raw-marker-1'));
  assert.ok(JSON.stringify(lines).includes('auxiliary explanation 1'));
  assert.ok(!JSON.stringify(lines).includes('fixture-secret'));
  assert.deepEqual(h.counts(), { summaryCalls: 2, recordedUsage: 2 });
  const loaded = SessionManager.open(h.data.path(h.transcript.key));
  const active = getMessagesAfterCompactBoundary(loaded);
  assert.match(JSON.stringify(active.find(message => message.role === 'user')), /Pinned original task \[REDACTED\]/);
  assert.match(JSON.stringify(active), /Summary 2/);
  assert.match(JSON.stringify(active), /new message after boundary/);
  assert.ok(!JSON.stringify(active).includes('raw-marker-1'));
  const calls = new Set(active.flatMap(message => message.role === 'assistant' ? message.content.filter(item => item.type === 'toolCall').map(item => item.id) : []));
  for (const message of active) if (message.role === 'toolResult') assert.ok(calls.has(message.toolCallId));
});

const readPolicy: ToolResultPolicy = { canRead: true, microcompactTools: ['mcp__source__read'] };

check('integration', 'Every compact summary carries a refreshed host transcript link and retrieves exact pre-compact assistant content', async () => {
  const h = await harness({ ...readPolicy, canReadTranscript: true });
  h.hooks.afterCompact = () => ({ attachments: [], hookResults: [], transcript: h.transcript.reference() });
  for (let i = 1; i <= 3; i++) toolTurn(h.manager, i, 'x'.repeat(12_000));
  // Preserve assistant text so result governance cannot by itself remove all pressure.
  h.manager.appendMessage({ role: 'user', content: 'continued task ' + 'u'.repeat(11_000), timestamp: Date.now() });
  const first = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  const boundary = h.manager.getEntries().find(entry => entry.type === 'compaction');
  assert.ok(boundary?.type === 'compaction');
  const summary = JSON.parse(boundary.summary), link = summary.transcript;
  assert.equal(link.path, h.data.path(h.transcript.key)); assert.equal(link.tool, 'session__read_transcript');
  const lookup = h.transcript.readTranscript({ throughEntryId: link.throughEntryId, query: 'auxiliary explanation 1', limit: 4096 });
  assert.match(lookup.content, /auxiliary explanation 1/); assert.equal(lookup.snapshotHash, link.snapshotHash);
  assert.match(JSON.stringify(first), /transcriptLookup/);
  const loaded = SessionManager.open(h.data.path(h.transcript.key));
  assert.match(JSON.stringify(getMessagesAfterCompactBoundary(loaded)), new RegExp(link.throughEntryId));
  for (let i = 4; i <= 6; i++) toolTurn(h.manager, i);
  await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  const latest = h.manager.getEntries().filter(entry => entry.type === 'compaction').at(-1)!;
  const latestLink = JSON.parse(latest.summary).transcript;
  assert.notEqual(latestLink.throughEntryId, link.throughEntryId);
  assert.ok(latestLink.entryCount > link.entryCount);
  h.context.setToolResultPolicy({ ...readPolicy, canReadTranscript: false });
  await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal), /transcript lookup tool is no longer active/);
});

check('integration', 'Whole-result snip bounds non-raw content and details while preserving originals for paged readback', async () => {
  const h = await harness(readPolicy);
  toolTurn(h.manager, 1, 'HEAD-marker:' + 'x'.repeat(100_000) + ':TAIL-marker');
  const original = h.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'toolResult')!;
  assert.equal(original.type, 'message'); if (original.type !== 'message' || original.message.role !== 'toolResult') return;
  original.message.details = { nonRawLargeObject: 'y'.repeat(60_000) };
  const active = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  const result = active.messages.find(message => message.role === 'toolResult')!;
  assert.ok(JSON.stringify(result).length <= 4200);
  assert.match(JSON.stringify(result), /HEAD-marker/); assert.match(JSON.stringify(result), /TAIL-marker/);
  assert.match(JSON.stringify(result), /session__read_tool_result/);
  assert.deepEqual(h.counts(), { summaryCalls: 0, recordedUsage: 0 });
  assert.ok(JSON.stringify(h.data.lines(h.transcript.key)).includes('y'.repeat(60_000)));
  let offset = 0, reconstructed = '';
  do {
    const page = h.transcript.readToolResult({ entryId: original.id, toolCallId: original.message.toolCallId, offset, limit: 4096 });
    reconstructed += page.content; offset = page.nextOffset ?? -1;
  } while (offset !== -1);
  assert.equal(reconstructed, original.message.content.map(item => item.type === 'text' ? item.text : '').join('\n'));
});

check('integration', 'Microcompact runs before summaries, retains recent tool pairs and never edits ordinary assistant messages', async () => {
  const h = await harness(readPolicy, 25_000);
  for (let i = 1; i <= 6; i++) toolTurn(h.manager, i, 'x'.repeat(3500));
  const assistants = h.view().messages.filter(message => message.role === 'assistant');
  h.context.markRequest(h.view()); h.context.recordUsage({ input: 120_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 120_100 });
  const active = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  assert.deepEqual(active.messages.filter(message => message.role === 'assistant'), assistants);
  assert.match(JSON.stringify(active), /microcompact/);
  assert.match(JSON.stringify(active), /raw-marker-5/); assert.match(JSON.stringify(active), /raw-marker-6/);
  assert.ok(!JSON.stringify(active).includes('raw-marker-1'));
  assert.equal(h.counts().summaryCalls, 0);
  assert.equal(h.manager.getEntries().filter(entry => entry.type === 'compaction').length, 0);
  const loaded = SessionManager.open(h.data.path(h.transcript.key));
  assert.deepEqual(JSON.parse(JSON.stringify(getMessagesAfterCompactBoundary(loaded))), JSON.parse(JSON.stringify(active.messages).replaceAll('fixture-secret', '[REDACTED]')));
  assert.match(JSON.stringify(h.data.lines(h.transcript.key)), /raw-marker-1/);
});

check('contract', 'Tool result views and readback use entry identity even when provider tool-call IDs repeat', async () => {
  const h = await harness(readPolicy);
  toolTurn(h.manager, 1, 'first-original:' + 'x'.repeat(20_000)); toolTurn(h.manager, 2, 'second-original:' + 'y'.repeat(20_000));
  for (const entry of h.manager.getEntries()) if (entry.type === 'message') {
    if (entry.message.role === 'toolResult') entry.message.toolCallId = 'reused-provider-id';
    if (entry.message.role === 'assistant') for (const item of entry.message.content) if (item.type === 'toolCall') item.id = 'reused-provider-id';
  }
  await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  const originals = h.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult');
  assert.equal(originals.length, 2);
  assert.match(h.transcript.readToolResult({ entryId: originals[0].id, toolCallId: 'reused-provider-id' }).content, /first-original/);
  assert.match(h.transcript.readToolResult({ entryId: originals[1].id, toolCallId: 'reused-provider-id' }).content, /second-original/);
  assert.throws(() => h.transcript.readToolResult({ entryId: originals[0].id, toolCallId: 'other-call' }), /not_found_in_current_session/);
  const other = await harness(readPolicy);
  assert.throws(() => other.transcript.readToolResult({ entryId: originals[0].id, toolCallId: 'reused-provider-id' }), /not_found_in_current_session/);
  assert.throws(() => h.transcript.readToolResult({ entryId: originals[0].id, toolCallId: 'reused-provider-id', path: '.env' }), /unrecognized/i);
  assert.throws(() => h.transcript.readToolResult({ entryId: originals[0].id, toolCallId: 'reused-provider-id', offset: 999_999 }), /offset_out_of_range/);
});

check('contract', 'Microcompact excludes errors, write receipts and unclassified dynamic tools', async () => {
  const h = await harness(readPolicy);
  for (let i = 1; i <= 7; i++) toolTurn(h.manager, i, 'x'.repeat(2000));
  const results = h.manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult');
  for (const [index, entry] of results.entries()) if (entry.type === 'message' && entry.message.role === 'toolResult') {
    if (index === 0) entry.message.isError = true;
    if (index === 1) entry.message.details = { status: 'tool_failed', error: 'retain error' };
    if (index === 2) entry.message.toolName = 'mcp__source__publish';
    if (index === 3) entry.message.toolName = 'mcp__source__dynamic_api';
    if (index === 4) entry.message.details = { isError: true, content: 'retain MCP failure' };
  }
  const governor = new ToolResultGovernor(h.manager, 25_000, readPolicy), before = h.view();
  assert.equal(governor.microcompactNext(), false); assert.deepEqual(h.view(), before);
});

check('integration', 'Formal summary fallback consumes microcompacted views without resurrecting archived tool bodies', async () => {
  const h = await harness(readPolicy);
  for (let i = 1; i <= 6; i++) toolTurn(h.manager, i, 'x'.repeat(3500));
  await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  assert.ok(!JSON.stringify(h.view()).includes('raw-marker-1'));
  for (const i of [7, 8]) {
    toolTurn(h.manager, i, 'small recent result');
    const assistant = h.manager.getEntries().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
    if (assistant?.type === 'message' && assistant.message.role === 'assistant') assistant.message.content.unshift({ type: 'text', text: 'Ordinary assistant text ' + i + ':' + 'a'.repeat(10_000) });
  }
  let summaryInput = '';
  const complete = h.runtime.completeSimple;
  h.runtime.completeSimple = async (...args) => { summaryInput = JSON.stringify(args[1]); return complete(...args); };
  const active = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  assert.equal(h.counts().summaryCalls, 1);
  assert.ok(!summaryInput.includes('raw-marker-1'));
  assert.match(summaryInput, /microcompact/); assert.match(summaryInput, /Ordinary assistant text 7/);
  assert.match(JSON.stringify(active), /Ordinary assistant text 8/);
});

check('contract', 'Projection durability failure blocks continuation and forged assistant edits are rejected', async () => {
  const h = await harness(readPolicy); toolTurn(h.manager, 1, 'x'.repeat(20_000)); await h.context.flush();
  const append = h.hooks.onTranscript!;
  h.hooks.onTranscript = entries => {
    if (entries.some(entry => entry.type === 'custom' && entry.customType === TOOL_RESULT_VIEW)) throw new Error('fixture_projection_disk_failure');
    return append(entries);
  };
  await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal), /projection_disk_failure/);
  assert.equal(h.counts().summaryCalls, 0);
  const other = await harness(readPolicy); toolTurn(other.manager, 1, 'small');
  const assistant = other.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant')!;
  other.manager.appendCustomEntry(TOOL_RESULT_VIEW, { entryId: assistant.id, toolCallId: 'call-1', toolName: 'mcp__source__read', mode: 'microcompact', originalChars: 100, text: 'forged removal' });
  assert.throws(() => other.view(), /projection_identity_mismatch/);
});

check('contract', 'Archive reads remain redacted and integrity checked, and revoking the read tool blocks edited context', async () => {
  const h = await harness(readPolicy); toolTurn(h.manager, 1, 'fixture-secret ' + 'x'.repeat(20_000));
  await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  const original = h.manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'toolResult')!;
  const args = { entryId: original.id, toolCallId: 'call-1' };
  assert.match(h.transcript.readToolResult(args).content, /\[REDACTED\]/);
  h.context.setToolResultPolicy({ canRead: false, microcompactTools: [] });
  await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal), /read tool is no longer active/);
  const lines = h.data.lines<any>(h.transcript.key);
  const saved = lines.find(entry => entry.id === original.id); saved.message.content[0].text = 'tampered archived content';
  h.data.text(h.transcript.key, lines.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.throws(() => h.transcript.readToolResult(args), /snapshot_mismatch/);
});

check('contract', 'Window pressure includes cache usage, newly appended messages and reserved output without double-counting totals', async () => {
  const h = await harness();
  const model = { ...h.model, contextWindow: 12_000, maxTokens: 4096 };
  const view = h.view(); h.context.markRequest(view);
  h.context.recordUsage({ input: 2000, output: 1000, cacheRead: 4000, cacheWrite: 1000, totalTokens: 8000 });
  const pressure = h.context.pressure(view, model, 4096);
  assert.ok(pressure.tokens >= 8000 && pressure.tokens < 8100);
  assert.equal(pressure.inputLimit, 7904); assert.equal(pressure.compact, true);
  assert.throws(() => h.context.guardWindow(view, model, 4096), /reserve output/);
  const baseline = pressure.tokens;
  // The generated assistant is already covered by output usage; adding it must not count it twice.
  toolTurn(h.manager, 1, '');
  const assistantOnly = { ...h.view(), messages: h.view().messages.slice(0, -1) };
  assert.equal(h.context.pressure(assistantOnly, model, 4096).tokens, baseline);
  toolTurn(h.manager, 2, 'new'.repeat(1000));
  assert.ok(h.context.pressure(h.view(), model, 4096).tokens > pressure.tokens);
});

check('contract', 'Unmetered or oversized summary responses cannot create a compaction boundary', async () => {
  for (const response of [{ content: [{ type: 'text', text: 'summary' }], usage: undefined }, { content: [{ type: 'text', text: 'x'.repeat(33_000) }], usage }]) {
    const h = await harness(); for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
    const runtime = { completeSimple: async () => ({ ...response, stopReason: 'stop' }) } as unknown as ModelRuntime;
    await assert.rejects(h.context.prepare(h.view(), runtime, h.model, 4096, new AbortController().signal), /budget_usage_unavailable|budget_response_chars/);
    assert.equal(h.manager.getEntries().filter(entry => entry.type === 'compaction').length, 0);
  }
});

check('contract', 'Empty, truncated or failed summaries preserve old active history and never commit a boundary', async () => {
  for (const response of [{ stopReason: 'stop', content: [] }, { stopReason: 'length', content: [{ type: 'text', text: 'cut' }] }, { stopReason: 'error', content: [] }]) {
    const h = await harness(); for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
    const runtime = { completeSimple: async () => ({ ...response, usage }) } as unknown as ModelRuntime;
    await assert.rejects(h.context.prepare(h.view(), runtime, h.model, 4096, new AbortController().signal), /context_compaction_failed/);
    assert.equal(h.manager.getEntries().filter(entry => entry.type === 'compaction').length, 0);
    assert.match(JSON.stringify(h.view()), /raw-marker-1/);
    assert.match(JSON.stringify(h.data.lines(h.transcript.key)), /raw-marker-1/);
  }
});

check('contract', 'Concurrent transcript flushes append once and durability failure blocks summary requests', async () => {
  const h = await harness();
  await Promise.all([h.context.flush(), h.context.flush(), h.context.flush()]);
  assert.equal(h.data.lines(h.transcript.key).length, 2);
  for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
  h.hooks.onTranscript = () => { throw new Error('fixture_disk_failure'); };
  await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal), /fixture_disk_failure/);
  assert.equal(h.counts().summaryCalls, 0);
});

check('contract', 'Cancellation or exhausted summary allowance prevents boundary commit', async () => {
  const h = await harness(); for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
  h.hooks.beforeRequest = () => { throw new Error('budget_tokens'); };
  await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal), /budget_tokens/);
  assert.equal(h.counts().summaryCalls, 0);
  h.hooks.beforeRequest = () => ({ maxOutputTokens: 4096 });
  const controller = new AbortController();
  const runtime = { completeSimple: async () => { controller.abort(); return { content: [{ type: 'text', text: 'summary' }], stopReason: 'stop', usage }; } } as unknown as ModelRuntime;
  await assert.rejects(h.context.prepare(h.view(), runtime, h.model, 4096, controller.signal), /abort/i);
  assert.equal(h.manager.getEntries().filter(entry => entry.type === 'compaction').length, 0);
});

check('integration', 'Formal compaction retains a whole multi-tool API response and its complete result set', async () => {
  const h = await harness(); toolTurn(h.manager, 1); toolTurn(h.manager, 2);
  h.manager.appendMessage({ role: 'user', content: 'Retain this follow-up together with the response', timestamp: Date.now() });
  h.manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'parallel-a', name: 'mcp__source__read', arguments: {} }, { type: 'toolCall', id: 'parallel-b', name: 'mcp__source__read', arguments: {} }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
  for (const callId of ['parallel-b', 'parallel-a']) h.manager.appendMessage({ role: 'toolResult', toolCallId: callId, toolName: 'mcp__source__read', content: [{ type: 'text', text: callId + ':' + 'x'.repeat(3500) }], isError: callId === 'parallel-b', timestamp: Date.now() });
  const active = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  assert.equal(h.counts().summaryCalls, 1); assertCompleteApiRounds(active.messages);
  assert.match(JSON.stringify(active), /Retain this follow-up/);
  const calls = active.messages.flatMap(message => message.role === 'assistant' ? message.content.filter(item => item.type === 'toolCall').map(item => item.id) : []);
  const results = active.messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId);
  assert.deepEqual(calls.sort(), ['parallel-a', 'parallel-b']); assert.deepEqual(results.sort(), calls.sort());
});

check('contract', 'Incomplete API rounds never enter formal compaction or create a boundary', async () => {
  const h = await harness(); toolTurn(h.manager, 1); toolTurn(h.manager, 2); toolTurn(h.manager, 3);
  const view = h.view();
  h.manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'mcp__source__read', arguments: {} }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
  await assert.rejects(h.context.prepare(view, h.runtime, h.model, 4096, new AbortController().signal), /context_round_incomplete/);
  assert.equal(h.counts().summaryCalls, 0); assert.ok(!h.manager.getEntries().some(entry => entry.type === 'compaction'));
});

check('integration', 'Committed compact context orders summary, kept rounds, attachments and hook results and reloads identically', async () => {
  const h = await harness(); for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
  h.hooks.afterCompact = request => {
    assert.ok(request.summary.nextSteps.length); assert.ok(request.keptEntryIds.length >= 2);
    return { attachments: [{ name: 'Saved plan', content: 'plans/run.json' }, { name: 'Exact IDs', content: 'claim-exact-123' }], hookResults: [{ name: 'Host continuation hook', content: 'hook-marker: finish the remaining evidence work' }] };
  };
  const active = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  assert.equal(active.messages[0].role, 'compactionSummary');
  const lastResult = active.messages.findLastIndex(message => message.role === 'toolResult');
  const attachment = active.messages.findIndex(message => message.role === 'custom' && message.customType === COMPACT_ATTACHMENT);
  const hook = active.messages.findIndex(message => message.role === 'custom' && message.customType === COMPACT_HOOK_RESULT);
  assert.ok(lastResult < attachment && attachment < hook); assertCompleteApiRounds(active.messages);
  const lines = h.data.lines<any>(h.transcript.key), commit = lines.find(entry => entry.customType === COMPACT_COMMIT);
  assert.equal(commit.data.attachmentEntryIds.length, 2); assert.equal(commit.data.hookResultEntryIds.length, 1);
  assert.equal(lines.find(entry => entry.type === 'compaction').details.charsAfter, JSON.stringify(active).length);
  const loaded = SessionManager.open(h.data.path(h.transcript.key));
  assert.deepEqual(JSON.parse(JSON.stringify(getMessagesAfterCompactBoundary(loaded))), JSON.parse(JSON.stringify(active.messages).replaceAll('fixture-secret', '[REDACTED]')));
  // The stored order is part of the commit contract, not just a rendering preference.
  commit.data.attachmentEntryIds.reverse();
  h.data.text(h.transcript.key, lines.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.throws(() => getMessagesAfterCompactBoundary(SessionManager.open(h.data.path(h.transcript.key))), /invalid_commit/);
});

check('contract', 'Vague summaries, failed hooks and oversized attachments cannot commit a compact context', async () => {
  for (const kind of ['vague-summary', 'missing-next-steps', 'hook-failed', 'oversized-attachment', 'hook-cancelled']) {
    const h = await harness(); for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
    const controller = new AbortController();
    if (kind === 'vague-summary') h.runtime.completeSimple = async () => ({ content: [{ type: 'text', text: 'We did some work.' }], stopReason: 'stop', usage }) as any;
    if (kind === 'missing-next-steps') h.runtime.completeSimple = async () => ({ content: [{ type: 'text', text: JSON.stringify({ userGoal: 'goal', completedWork: [], keyFiles: [], errorsAndFixes: [], unfinishedTasks: [], nextSteps: [], references: [], sourceGaps: [] }) }], stopReason: 'stop', usage }) as any;
    if (kind === 'hook-failed') h.hooks.afterCompact = () => { throw new Error('fixture_hook_failed'); };
    if (kind === 'oversized-attachment') h.hooks.afterCompact = () => ({ attachments: [{ name: 'too much', content: 'x'.repeat(20_000) }], hookResults: [] });
    if (kind === 'hook-cancelled') h.hooks.afterCompact = () => { controller.abort(); return { attachments: [], hookResults: [] }; };
    await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, controller.signal), /invalid continuation|hook_failed|context_budget|abort/i, kind);
    assert.ok(!h.manager.getEntries().some(entry => entry.type === 'compaction'), kind);
  }
});

check('contract', 'A partial compact append without a commit reloads the previous complete context', async () => {
  const h = await harness(); for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
  h.hooks.afterCompact = () => ({ attachments: [{ name: 'plan', content: 'plan-path' }], hookResults: [{ name: 'hook', content: 'hook-output' }] });
  const append = h.data.append.bind(h.data);
  h.data.append = (name, value) => {
    if ((value as any).customType === COMPACT_COMMIT) throw new Error('fixture_compact_commit_disk_failed');
    append(name, value);
  };
  await assert.rejects(h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal), /commit_disk_failed/);
  const lines = h.data.lines<any>(h.transcript.key);
  assert.ok(lines.some(entry => entry.type === 'compaction')); assert.ok(!lines.some(entry => entry.customType === COMPACT_COMMIT));
  const active = getMessagesAfterCompactBoundary(SessionManager.open(h.data.path(h.transcript.key)));
  assert.match(JSON.stringify(active), /raw-marker-1/); assert.ok(!JSON.stringify(active).includes('POST-COMPACT'));
  assertCompleteApiRounds(active);
});

check('integration', 'Retention prefers two complete recent API rounds when they fit and preserves a queued user request', async () => {
  const h = await harness(); toolTurn(h.manager, 1, 'x'.repeat(10_000)); toolTurn(h.manager, 2, 'second'); toolTurn(h.manager, 3, 'third');
  h.manager.appendMessage({ role: 'user', content: 'Queued follow-up must survive compaction', timestamp: Date.now() });
  h.context.markRequest(h.view()); h.context.recordUsage({ input: 120_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 120_100 });
  const active = await h.context.prepare(h.view(), h.runtime, h.model, 4096, new AbortController().signal);
  const results = active.messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId);
  assert.deepEqual(results, ['call-2', 'call-3']); assert.match(JSON.stringify(active), /Queued follow-up/);
  const boundary = h.manager.getEntries().find(entry => entry.type === 'compaction');
  assert.equal((boundary as any).details.retainedRoundIds.length, 2); assertCompleteApiRounds(active.messages);
});

check('contract', 'Historical compaction entries without a commit remain readable with complete retained tool rounds', async () => {
  const h = await harness(); toolTurn(h.manager, 1); toolTurn(h.manager, 2);
  const lastAssistant = h.manager.getEntries().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')!;
  h.manager.appendCompaction('Historical plain-text summary', lastAssistant.id, 1000, { pinnedEntryIds: [] });
  await h.context.flush();
  const active = getMessagesAfterCompactBoundary(SessionManager.open(h.data.path(h.transcript.key)));
  assert.match(JSON.stringify(active), /Historical plain-text summary/); assert.ok(!JSON.stringify(active).includes('raw-marker-1'));
  assertCompleteApiRounds(active);
});

check('contract', 'Formal summary uses Step 5 maintenance contract and recovers once from output truncation or invalid JSON without retrying provider errors', async () => {
  const h = await harness();
  for (let i = 1; i <= 3; i++) toolTurn(h.manager, i);
  const { model: step5Model } = await createPiRuntime('stepfun-summary', 'step-5-preview', { apiKey: 'fixture-key', baseUrl: 'https://api.stepfun.com/v1' }, new AbortController().signal);
  h.hooks.beforeRequest = () => ({ maxOutputTokens: 12_288 });
  const calls: Array<{ maxTokens?: number; reasoning?: string; samplingParams?: Record<string, unknown>; systemPrompt?: string }> = [];
  const runtime = {
    completeSimple: async (_model: unknown, context: any, options: any) => {
      calls.push({ maxTokens: options.maxTokens, reasoning: options.reasoning, samplingParams: options.samplingParams, systemPrompt: context.systemPrompt });
      if (calls.length === 1) return { role: 'assistant', content: [{ type: 'thinking', thinking: 'exhausted thinking' }], usage, stopReason: 'length' };
      return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ userGoal: 'Recovered summary', completedWork: ['plan saved'], keyFiles: [], errorsAndFixes: [], unfinishedTasks: [], nextSteps: ['continue investigation'], references: [], sourceGaps: [] }) }], usage, stopReason: 'stop' };
    },
  } as unknown as ModelRuntime;
  const active = await h.context.prepare(h.view(), runtime, step5Model, 12_288, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.maxTokens), [6144, 8192]);
  assert.ok(calls.every(c => c.reasoning === 'low' && (c.samplingParams as any)?.reasoning_effort === 'low' && (c.samplingParams as any)?.response_format?.type === 'json_object'));
  assert.match(calls[1].systemPrompt ?? '', /exhausted its output limit/);
  assert.match(JSON.stringify(active), /Recovered summary/);

  // Provider error responses must stop immediately without retrying.
  const errHarness = await harness();
  for (let i = 1; i <= 3; i++) toolTurn(errHarness.manager, i);
  let errorAttempts = 0;
  const errRuntime = { completeSimple: async () => { errorAttempts++; return { role: 'assistant', content: [], usage, stopReason: 'error' }; } } as unknown as ModelRuntime;
  await assert.rejects(errHarness.context.prepare(errHarness.view(), errRuntime, errHarness.model, 4096, new AbortController().signal), /context_compaction_failed/);
  assert.equal(errorAttempts, 1);
});
