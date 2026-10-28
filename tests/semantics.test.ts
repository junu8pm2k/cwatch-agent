import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { check, fixture, json, signal, store, task as defaultTask } from './harness.ts';
import { EvidenceStore, attribution, timeStatus, reviewClaims } from "@cwatch/shared/intelligence/evidence";
import { SignalSchema, RetrievalSchema, type RetrievalResult } from "@cwatch/core/types";
import { SourceConfigsSchema, SourceServerBuilder } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";

const task = () => { const value = defaultTask(); value.allowedSources.push('news'); return value; };
check('semantic', 'official and reprint merge one event with two snapshots', () => {
  const data = store(), facts = new EvidenceStore(data); facts.ingest(task(), fixture()); facts.ingest(task(), fixture('news'));
  assert.equal(facts.events().length, 1); assert.equal(facts.versions().length, 1); assert.equal(facts.evidence().length, 2); assert.equal(facts.events()[0].evidenceIds.length, 2);
  for (const evidence of facts.evidence()) assert.ok(existsSync(data.path(evidence.rawPath)));
});
check('semantic', 'same headline with distinct event identity stays separate', () => {
  const facts = new EvidenceStore(store()), a = fixture(), b = fixture('news'); b.signals[0].content.title = a.signals[0].content.title; b.signals[0].eventKey = 'release:v24.2.0'; b.signals[0].content.value = 'v24.2.0'; facts.ingest(task(), a); facts.ingest(task(), b); assert.equal(facts.events().length, 2);
});
check('semantic', 'same display name never forces attribution; conflicting ID rejected', () => {
  const ambiguous = signal(); ambiguous.entity = { id: null, name: 'Node.js', domain: null }; assert.equal(attribution(task(), ambiguous), 'ambiguous');
  const wrong = signal(); wrong.entity.id = 'other-company'; assert.equal(attribution(task(), wrong), 'wrong_entity');
  const facts = new EvidenceStore(store()); facts.ingest(task(), { ...fixture(), signals: [ambiguous, wrong] }); assert.equal(facts.evidence().length, 2); assert.equal(facts.events().length, 0);
});
check('semantic', 'unknown publication never replaced by retrieval time', () => {
  const s = signal(); s.published_at = null; assert.equal(timeStatus(task(), s), 'unknown_time');
  const facts = new EvidenceStore(store()); const result = facts.ingest(task(), { ...fixture(), signals: [s] }); assert.equal(facts.events().length, 0); assert.equal(facts.evidence()[0].signal.published_at, null); assert.ok(result.gaps.some(g => g.includes('unknown_time')));
});
check('semantic', 'timezone-equivalent timestamps and [start,end) boundary', () => {
  const t = task(), s = signal(); s.published_at = '2025-04-30T16:00:00Z'; assert.equal(timeStatus(t, s), 'in_window');
  s.published_at = t.window.end; assert.equal(timeStatus(t, s), 'out_of_window'); s.published_at = '2025-04-30T15:59:59Z'; assert.equal(timeStatus(t, s), 'out_of_window');
});
check('semantic', 'selected occurred/effective time basis never falls back', () => {
  const t = task(); t.window.basis = 'effective_at'; assert.equal(timeStatus(t, signal()), 'unknown_time'); const s = signal(); s.effective_at = t.window.start; assert.equal(timeStatus(t, s), 'in_window');
});
check('semantic', 'same fact update appends version and preserves old evidence', () => {
  const data = store(), facts = new EvidenceStore(data); const first = facts.ingest(task(), fixture()); const before = structuredClone(facts.events()); const oldSnapshot = readFileSync(data.path(facts.evidence()[0].rawPath), 'utf8');
  const changed = fixture(); changed.raw = 'synthetic update: revised price/details'; changed.signals[0].content.value = 'v24.0.0 updated notes'; changed.signals[0].retrieved_at = '2026-10-17T11:00:00+08:00'; facts.ingest(task(), changed);
  assert.equal(facts.events().length, 1); assert.equal(facts.versions().length, 2); assert.equal(facts.evidence().length, 2); assert.equal(facts.compare(before, first.eventIds)[0].status, 'updated'); assert.equal(readFileSync(data.path(facts.evidence()[0].rawPath), 'utf8'), oldSnapshot);
});
check('semantic', 'evidence gaps and counter evidence cannot receive accept review', () => {
  const facts = new EvidenceStore(store()); const collected = facts.ingest(task(), fixture()); const claims = facts.claims(task(), collected.evidenceIds);
  const missing = structuredClone(claims); missing[0].evidenceIds = []; assert.equal(reviewClaims(task(), missing, facts.events(), facts.versions(), facts.evidence()).decision, 'needs_evidence');
  const counter = fixture('news'); counter.signals[0].content.polarity = 'contradicts'; counter.signals[0].content.value = 'release withdrawn'; counter.raw = 'synthetic counter evidence'; facts.ingest(task(), counter);
  const review = reviewClaims(task(), claims, facts.events(), facts.versions(), facts.evidence()); assert.equal(review.decision, 'reject'); assert.equal(review.evidenceRefs.length, 2);
});
check('semantic', 'review rejects unsupported claim text', () => {
  const facts = new EvidenceStore(store()); const r = facts.ingest(task(), fixture()); const claims = facts.claims(task(), r.evidenceIds); claims[0].text = 'invented sales grew 200%'; assert.equal(reviewClaims(task(), claims, facts.events(), facts.versions(), facts.evidence()).decision, 'reject');
});
check('semantic', 'divergent supported values for same event require conflict review', () => {
  const facts = new EvidenceStore(store()), first = facts.ingest(task(), fixture()), other = fixture('news'); other.raw = 'conflicting same-event test'; other.signals[0].content.value = 'different value'; const second = facts.ingest(task(), other);
  const review = reviewClaims(task(), facts.claims(task(), [...first.evidenceIds, ...second.evidenceIds]), facts.events(), facts.versions(), facts.evidence()); assert.equal(review.decision, 'reject'); assert.ok(review.issues.some(i => i.startsWith('conflicting_supported_versions')));
});
check('semantic', 'fixed independent labels match complete corpus; all source evidence retained', () => {
  const facts = new EvidenceStore(store()), evidenceIds: string[] = []; for (const name of ['official', 'github', 'news']) evidenceIds.push(...facts.ingest(task(), fixture(name)).evidenceIds);
  const expected = json('fixtures/labels.json').expected;
  assert.equal(facts.events().length, expected.events); assert.equal(facts.versions().length, expected.versions); assert.equal(facts.evidence().length, expected.evidence); assert.equal(facts.claims(task(), evidenceIds).length, expected.claims); assert.equal(facts.events().find(e => e.eventKey === 'release:v24.0.0')!.evidenceIds.length, expected.v24_0_0_evidence);
});
check('semantic', 'failure statuses and empty results remain gaps not no-activity', () => {
  const facts = new EvidenceStore(store());
  for (const status of ['success_empty', 'auth_failed', 'rate_limited', 'timeout', 'parse_failed', 'cancelled', 'unknown'] as const) {
    const r = facts.ingest(task(), { status, signals: [], raw: '', error: status, provenance: 'fixture' }); assert.equal(r.eventIds.length, 0); assert.equal(r.gaps.length, 1); assert.ok(!r.gaps[0].includes('no activity detected'));
  }
});
check('semantic', 'runtime partial source failure keeps good facts and failure in draft', async () => {
  const configs = SourceConfigsSchema.parse(json('examples/sources.json')), registry = new ToolRegistry(), data = store();
  await new SourceServerBuilder(process.cwd()).register(configs, 'replay', registry, new AbortController().signal);
  registry.setActive('github', false);
  const run = await runInvestigation(defaultTask(), ReplayModel.fromFile('fixtures/model-script.json'), registry, data, 'replay');
  assert.equal(run.status, 'partial'); assert.ok(run.gaps.some(g => g.includes('github'))); const report = readFileSync(data.path(run.report!), 'utf8'); assert.match(report, /github/); assert.match(report, /未知时点、空结果和失败来源/); assert.equal(data.read<any[]>('facts/events.json', []).length, 1); await registry.close();
});
check('semantic', 'signal runtime validation rejects naive timestamps and impossible status/data', () => {
  assert.equal(SignalSchema.safeParse({ ...signal(), published_at: '2025-05-06' }).success, false);
  assert.equal(RetrievalSchema.safeParse({ ...fixture(), status: 'success_empty' }).success, false);
});
