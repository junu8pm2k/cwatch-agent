import { SignalSchema, RetrievalSchema, hash, now, type CompetitorSignal, type CompetitorTask, type RetrievalResult } from "@cwatch/core/types";
import { FileStore } from "../sessions/storage.ts";
import { readFileSync } from 'node:fs';

export interface Evidence { id: string; signal: CompetitorSignal; rawPath: string; snapshotHash: string; provenance: 'fixture' | 'live'; attribution: 'matched' | 'ambiguous' | 'wrong_entity'; timeStatus: 'in_window' | 'out_of_window' | 'unknown_time'; excerpt?: string }
export interface EventRecord { id: string; entityId: string; product: string; signalType: string; eventKey: string; versionIds: string[]; evidenceIds: string[] }
export interface FactVersion { id: string; eventId: string; value: string; title: string; firstSeenAt: string; evidenceIds: string[]; polarity: 'supports' | 'contradicts' }
export interface Claim { id: string; text: string; eventId: string; versionId: string; evidenceIds: string[] }
export interface Review { decision: 'accept' | 'needs_evidence' | 'reject'; issues: string[]; evidenceRefs: string[] }
export interface Comparison { eventId: string; status: 'new' | 'unchanged' | 'updated'; previousVersions: string[]; currentVersions: string[] }

function domainMatchesCompetitor(domains: string[], domain: string): boolean {
  const lower = domain.toLowerCase();
  return domains.some(entry => {
    const clean = entry.trim().toLowerCase();
    return Boolean(clean) && clean !== '*' && (lower === clean || lower.endsWith('.' + clean));
  });
}

export function attribution(task: CompetitorTask, signal: CompetitorSignal): Evidence['attribution'] {
  if (signal.product !== task.product) return 'wrong_entity';
  if (signal.entity.id && signal.entity.id !== task.competitor.id) return 'wrong_entity';
  const openDomains = task.competitor.domains.some(entry => entry.trim() === '*');
  const matchedDomain = Boolean(signal.entity.domain && domainMatchesCompetitor(task.competitor.domains, signal.entity.domain));
  if (signal.entity.domain && !openDomains && !matchedDomain) return 'wrong_entity';
  if (signal.entity.id === task.competitor.id || matchedDomain) return 'matched';
  // A matching display name alone is never sufficient evidence of identity.
  return 'ambiguous';
}
export function timeStatus(task: CompetitorTask, signal: CompetitorSignal): Evidence['timeStatus'] {
  const selected = signal[task.window.basis]; if (!selected) return 'unknown_time';
  const time = Date.parse(selected);
  return time >= Date.parse(task.window.start) && time < Date.parse(task.window.end) ? 'in_window' : 'out_of_window';
}
export class EvidenceStore {
  constructor(readonly store: FileStore) {}
  evidence(): Evidence[] { return this.store.read('evidence/index.json', []); }
  events(): EventRecord[] { return this.store.read('facts/events.json', []); }
  versions(): FactVersion[] { return this.store.read('facts/versions.json', []); }
  ingest(task: CompetitorTask, rawResult: RetrievalResult, options?: { excerpts?: readonly (string | undefined)[] }): { evidenceIds: string[]; eventIds: string[]; gaps: string[] } {
    const result = RetrievalSchema.parse(rawResult);
    const evidences = this.evidence(), events = this.events(), versions = this.versions();
    const evidenceIds: string[] = [], eventIds: string[] = [], gaps: string[] = [];
    if (result.status !== 'success_with_data') gaps.push(result.status === 'success_empty' ? 'source_returned_empty: no inference of no activity' : result.status + ': ' + (result.error ?? 'source_failure'));
    if ((result.searchResults?.length || result.pages?.length) && !result.signals.length) gaps.push('discovery_only: search/page content retained; structured facts require a verified source parser');
    if (result.snapshot) { if (hash(readFileSync(this.store.path(result.snapshot.path), 'utf8')) !== result.snapshot.hash) throw new Error('retrieval_snapshot_mismatch'); }
    if (result.rawTruncated && !result.snapshot) throw new Error('missing_full_retrieval_snapshot');
    for (let index = 0; index < result.signals.length; index++) {
      const value = result.signals[index];
      const signal = SignalSchema.parse(value);
      if (!task.allowedSources.includes(signal.sourceSlug)) throw new Error('evidence_source_outside_task');
      const attr = attribution(task, signal), time = timeStatus(task, signal);
      const snapshotHash = result.snapshot?.hash ?? hash(result.raw), evidenceId = 'ev-' + hash({ signal, snapshotHash }).slice(0, 24);
      const excerpt = options?.excerpts?.[index];
      const evidence: Evidence = { id: evidenceId, signal, rawPath: result.snapshot?.path ?? 'evidence/snapshots/' + snapshotHash + '.txt', snapshotHash, provenance: result.provenance, attribution: attr, timeStatus: time, ...(excerpt !== undefined ? { excerpt } : {}) };
      const existing = evidences.find(e => e.id === evidenceId);
      if (!existing) { evidences.push(evidence); if (!result.snapshot) this.store.text(evidence.rawPath, result.raw); }
      else if (excerpt !== undefined && !existing.excerpt) { existing.excerpt = excerpt; }
      evidenceIds.push(evidenceId);
      if (attr !== 'matched' || time !== 'in_window' || !task.signalTypes.includes(signal.signalType)) { gaps.push(evidenceId + ': ' + [attr, time].join('/')); continue; }
      const eventId = 'event-' + hash({ entity: task.competitor.id, product: signal.product, kind: signal.signalType, key: signal.eventKey }).slice(0, 24);
      let event = events.find(e => e.id === eventId);
      if (!event) { event = { id: eventId, entityId: task.competitor.id, product: signal.product, signalType: signal.signalType, eventKey: signal.eventKey, versionIds: [], evidenceIds: [] }; events.push(event); }
      const versionId = 'ver-' + hash({ eventId, value: signal.content.value, polarity: signal.content.polarity }).slice(0, 24);
      let version = versions.find(v => v.id === versionId);
      if (!version) { version = { id: versionId, eventId, title: signal.content.title, value: signal.content.value, firstSeenAt: signal.retrieved_at, evidenceIds: [], polarity: signal.content.polarity }; versions.push(version); }
      if (!event.versionIds.includes(versionId)) event.versionIds.push(versionId);
      if (!event.evidenceIds.includes(evidenceId)) event.evidenceIds.push(evidenceId);
      if (!version.evidenceIds.includes(evidenceId)) version.evidenceIds.push(evidenceId);
      if (!eventIds.includes(eventId)) eventIds.push(eventId);
    }
    this.store.write('evidence/index.json', evidences); this.store.write('facts/events.json', events); this.store.write('facts/versions.json', versions);
    return { evidenceIds, eventIds, gaps };
  }
  claims(task: CompetitorTask, evidenceIds: string[]): Claim[] {
    const evidence = new Map(this.evidence().filter(e => evidenceIds.includes(e.id) && task.allowedSources.includes(e.signal.sourceSlug) && task.signalTypes.includes(e.signal.signalType) && attribution(task, e.signal) === 'matched' && timeStatus(task, e.signal) === 'in_window').map(e => [e.id, e]));
    return this.versions().filter(v => v.polarity === 'supports' && v.evidenceIds.some(id => evidence.has(id))).map(v => ({ id: 'claim-' + v.id, text: v.title + ': ' + v.value, eventId: v.eventId, versionId: v.id, evidenceIds: v.evidenceIds.filter(id => evidence.has(id)) }));
  }
  compare(before: EventRecord[], eventIds: string[]): Comparison[] {
    return this.events().filter(e => eventIds.includes(e.id)).map(e => { const previous = before.find(b => b.id === e.id); return { eventId: e.id, status: !previous ? 'new' : previous.versionIds.join() === e.versionIds.join() ? 'unchanged' : 'updated', previousVersions: previous?.versionIds ?? [], currentVersions: e.versionIds }; });
  }
}
// A reviewer receives immutable data snapshots only, never an executor or writable store.
export function reviewClaims(task: CompetitorTask, claims: Claim[], events: readonly EventRecord[], versions: readonly FactVersion[], evidence: readonly Evidence[]): Review {
  const issues: string[] = [], refs = new Set<string>();
  if (!claims.length) issues.push('no_supported_claims');
  for (const claim of claims) {
    const event = events.find(e => e.id === claim.eventId), version = versions.find(v => v.id === claim.versionId);
    if (!event || !version || version.eventId !== event.id || !event.versionIds.includes(version.id) || event.entityId !== task.competitor.id || event.product !== task.product || !task.signalTypes.includes(event.signalType as CompetitorSignal['signalType'])) { issues.push('broken_event_version:' + claim.id); continue; }
    if (claim.text !== version.title + ': ' + version.value) issues.push('claim_text_mismatch:' + claim.id);
    if (!claim.evidenceIds.length) issues.push('missing_evidence:' + claim.id);
    for (const eid of claim.evidenceIds) {
      const e = evidence.find(e => e.id === eid); refs.add(eid);
      if (!e || !task.allowedSources.includes(e.signal.sourceSlug) || !task.signalTypes.includes(e.signal.signalType) || e.signal.signalType !== event.signalType || !version.evidenceIds.includes(eid) || attribution(task, e.signal) !== 'matched' || timeStatus(task, e.signal) !== 'in_window' || e.signal.eventKey !== event.eventKey || e.signal.content.value !== version.value || e.signal.content.polarity !== version.polarity) issues.push('invalid_evidence:' + eid);
    }
    const counter = versions.filter(v => v.eventId === event.id && v.polarity === 'contradicts').flatMap(v => v.evidenceIds);
    if (counter.length) { issues.push('counter_evidence:' + event.id); counter.forEach(id => refs.add(id)); }
  }
  for (const eventId of new Set(claims.map(c => c.eventId))) if (new Set(claims.filter(c => c.eventId === eventId).map(c => c.versionId)).size > 1) issues.push('conflicting_supported_versions:' + eventId);
  return { decision: issues.some(i => /counter_evidence|conflicting_supported|claim_text_mismatch|broken_event/.test(i)) ? 'reject' : issues.length ? 'needs_evidence' : 'accept', issues, evidenceRefs: [...refs] };
}
export function renderReport(task: CompetitorTask, claims: Claim[], evidence: Evidence[], review: Review, comparison: Comparison[], gaps: string[], modelNarrative: string, mode: string): string {
  const lines = [`# ${task.competitor.name} / ${task.product} 调查草稿`, '', `模式：${mode}；生成：${now()}；结构化主张审阅：${review.decision}`, `时间窗：[${task.window.start}, ${task.window.end})；依据 ${task.window.basis}；时区 ${task.window.timezone}`, '', '## 模型调查说明（待人工核对）', '', modelNarrative, '', '## 结构化主张（已核对引用）', ''];
  const authorRoles = { official_announcement: '官方公告', staff: '员工答复', community: '社区用户', unknown: '发言者身份未核验' };
  for (const c of claims) { lines.push(`- **${c.id}** ${c.text}（事件 ${c.eventId}；版本 ${c.versionId}）`); for (const eid of c.evidenceIds) { const e = evidence.find(e => e.id === eid)!; const author = e.signal.authorship; lines.push(`  - [${eid}](${e.signal.url})；发布时间 ${e.signal.published_at ?? '未知'}；采集时间 ${e.signal.retrieved_at}；依据时间 ${e.signal[task.window.basis] ?? '未知'}；${e.provenance}${author ? '；' + authorRoles[author.role] + (author.byline ? `（${author.byline}）` : '') : ''}；[原始快照](../${e.rawPath})`); } }
  lines.push('', '## 历史比较', '', ...comparison.map(c => `- ${c.eventId}: ${c.status}；${c.previousVersions.length} → ${c.currentVersions.length} 个版本`), '', '## 冲突与采集缺口', '', ...[...gaps, ...review.issues].map(g => '- ' + g));
  if (!gaps.length && !review.issues.length) lines.push('- 本次已配置来源内未发现需补查项；不代表覆盖全部市场动态。');
  lines.push('', '本文件仅为草稿。未知时点、空结果和失败来源不构成“没有动态”的证据。');
  return lines.join('\n') + '\n';
}
