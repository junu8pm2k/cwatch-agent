import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonical, hash, PlanSchema, RetrievalSchema, SignalSchema, timestamp, abortable, type AgentState, type CompetitorSignal, type CompetitorTask, type Plan, type RetrievalResult, type SourceClient, type ToolDefinition, type ToolExecutionContext } from '@cwatch/core/types';
import { EvidenceStore, attribution, timeStatus, reviewClaims, renderReport, type Claim, type Comparison, type Review } from '@cwatch/shared/intelligence/evidence';
import type { FileStore } from '@cwatch/shared/sessions/storage';
import type { Trace } from '@cwatch/shared/sessions/trace';
import type { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import type { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import type { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ReadPlanSchema, WorkingStateTracker } from './working-state.ts';
import { SessionTools } from './session-tools.ts';
import type { RuntimeOptions } from './investigation.ts';
const empty = { type: 'object', properties: {}, additionalProperties: false };
const draftSchema = z.object({ narrative: z.string().min(1).max(12000), claimIds: z.array(z.string()) }).strict();
const extractSignalSchema = z.object({
  url: z.string().url(),
  signalType: z.enum(['release', 'price', 'content', 'campaign']),
  eventKey: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  value: z.string().min(1).max(600),
  quote: z.string().min(12).max(500),
  publishedAt: timestamp.nullable().optional(),
  polarity: z.enum(['supports', 'contradicts']).default('supports'),
}).strict();
const extractSignalInputSchema = (() => {
  const schema = z.toJSONSchema(extractSignalSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (props?.url) delete props.url.format;
  return schema;
})();
interface ExtractedSignalRecord {
  observationIndex: number;
  sourceSlug: string;
  provenance: 'fixture' | 'live';
  raw: string;
  rawTruncated?: boolean;
  snapshot?: { path: string; hash: string };
  signal: CompetitorSignal;
  excerpt: string;
}
function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
function domainMatchesCompetitor(domains: string[], domain: string): boolean {
  const lower = domain.toLowerCase();
  return domains.some(entry => {
    const clean = entry.trim().toLowerCase();
    return Boolean(clean) && clean !== '*' && (lower === clean || lower.endsWith('.' + clean));
  });
}
export class InvestigationWorkflow implements SourceClient {
  readonly sessionTools: SessionTools;
  plan?: Plan; submitted = false; analyzed = false; reviewed = false; drafted = false;
  reworkCount = 0;
  readonly maxReworkRounds = 1;
  reworkUnlocked = false;
  readonly facts: EvidenceStore;
  readonly before;
  evidenceIds: string[] = []; eventIds: string[] = []; claims: Claim[] = []; comparisons: Comparison[] = [];
  review: Review = { decision: 'needs_evidence', issues: ['not_reviewed'], evidenceRefs: [] };
  gaps: string[];
  report?: string;
  private baseGaps?: string[];
  private extractedSignals: ExtractedSignalRecord[] = [];
  constructor(readonly task: CompetitorTask, readonly state: AgentState, readonly registry: ToolRegistry, readonly store: FileStore, readonly trace: Trace, readonly mode: string, readonly options: RuntimeOptions, readonly transcript?: SessionTranscript, readonly workingState = new WorkingStateTracker(), readonly sessionMemory?: SessionMemoryStore) {
    this.sessionTools = new SessionTools(task, registry, options.userSkills, transcript, workingState, sessionMemory);
    this.facts = new EvidenceStore(store); this.before = structuredClone(this.facts.events()); this.gaps = [...(options.initialGaps ?? [])];
  }
  canReworkCollect(): boolean { return this.reworkUnlocked && !this.drafted && this.reworkCount < this.maxReworkRounds; }
  get reworkAvailable(): boolean { return this.canReworkCollect(); }
  async listTools(): Promise<ToolDefinition[]> { return [
    ...await this.sessionTools.listTools(),
    ...(this.transcript ? [{ name: 'read_plan', description: 'Read a verified page of the saved plan for this run. No path argument; use nextOffset for subsequent pages.', action: 'analyze' as const, inputSchema: z.toJSONSchema(ReadPlanSchema, { target: 'draft-7' }) }] : []),
    { name: 'save_plan', description: 'Persist and verify a scoped investigation plan, then submit via host callback.', action: 'local_draft', inputSchema: z.toJSONSchema(PlanSchema, { target: 'draft-7' }) },
    { name: 'extract_signal', description: 'Extract a verifiable CompetitorSignal from an already fetched page using a verbatim quote checked against the fetched text/snapshot (publishedAt: ISO-8601 or null).', action: 'analyze', inputSchema: extractSignalInputSchema },
    { name: 'analyze', description: 'Normalize collected observations, attribute entities, store evidence/fact versions and compare history.', action: 'analyze', inputSchema: empty },
    { name: 'review', description: 'Read-only reviewer checks claim/evidence identity, chronology and counter evidence.', action: 'analyze', inputSchema: empty },
    { name: 'draft', description: 'Save a draft from reviewed claims and your narrative; only known claim IDs allowed.', action: 'local_draft', inputSchema: z.toJSONSchema(draftSchema, { target: 'draft-7' }) },
  ]; }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<unknown> {
    signal.throwIfAborted();
    if (SessionTools.handles(name)) return this.sessionTools.callTool(name, args, signal, context);
    if (name === 'read_plan') return this.workingState.readPlan({ store: this.store, runId: this.trace.runId, workflow: this }, args);
    if (name === 'save_plan') {
      if (this.submitted) throw new Error('plan_already_submitted');
      const plan = PlanSchema.parse(args);
      if (plan.taskId !== this.task.taskId || plan.window.start !== this.task.window.start || plan.window.end !== this.task.window.end || plan.sources.some(s => !this.task.allowedSources.includes(s)) || this.task.allowedSources.some(s => !plan.sources.includes(s))) throw new Error('plan_scope_mismatch');
      const key = 'plans/' + this.trace.runId + '.json';
      try { this.store.write(key, plan); const saved = PlanSchema.parse(this.store.read(key, null)); if (canonical(saved) !== canonical(plan)) throw new Error('plan_readback_mismatch'); this.trace.emit('plan_saved', { path: key }); }
      catch (e) { this.trace.emit('plan_file_failed', { error: String(e) }); throw e; }
      try { await abortable((this.options.onPlanSubmitted ?? (async () => {}))(plan, this.store.path(key)), signal); signal.throwIfAborted(); }
      catch (e) { this.trace.emit('plan_submit_failed', { error: String(e) }); throw e; }
      this.plan = plan; this.submitted = true; this.trace.emit('plan_submitted', { path: key });
      return { submitted: true, path: key, sources: plan.sources };
    }
    if (!this.submitted) throw new Error('plan_required');
    if (name === 'extract_signal') {
      if (this.drafted) throw new Error('already_drafted');
      if (this.analyzed && !this.canReworkCollect()) throw new Error('already_analyzed');
      const input = extractSignalSchema.parse(args);
      const candidates: Array<{ observationIndex: number; sourceSlug: string; retrieval: RetrievalResult; page: NonNullable<RetrievalResult['pages']>[number] }> = [];
      for (let index = this.state.observations.length - 1; index >= 0; index--) {
        const observation = this.state.observations[index];
        const parsed = RetrievalSchema.safeParse(observation.result);
        if (!parsed.success || parsed.data.status !== 'success_with_data' || !parsed.data.pages?.length) continue;
        const page = parsed.data.pages.find(item => item.url === input.url);
        if (!page) continue;
        let sourceSlug: string;
        try { sourceSlug = this.registry.binding(observation.name).source_slug; } catch { continue; }
        if (!this.task.allowedSources.includes(sourceSlug)) continue;
        candidates.push({ observationIndex: index, sourceSlug, retrieval: parsed.data, page });
      }
      if (!candidates.length) throw new Error('fetched_page_not_found');
      const normalizedQuote = normalizeText(input.quote);
      if (!normalizedQuote) throw new Error('quote_not_found_in_fetched_page');
      const strippedDateQuote = normalizeText(input.quote.replace(/^\s*(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*)+/, ''));
      const verifySameUrlSearchQuote = (sourceSlug: string): boolean => {
        for (let idx = this.state.observations.length - 1; idx >= 0; idx--) {
          const obs = this.state.observations[idx];
          try { if (this.registry.binding(obs.name).source_slug !== sourceSlug) continue; } catch { continue; }
          const parsed = RetrievalSchema.safeParse(obs.result);
          if (!parsed.success || parsed.data.status !== 'success_with_data' || !parsed.data.searchResults?.some(hit => hit.url === input.url)) continue;
          let searchSnap: string | undefined;
          if (parsed.data.snapshot) {
            try { searchSnap = readFileSync(this.store.path(parsed.data.snapshot.path), 'utf8'); } catch { throw new Error('retrieval_snapshot_mismatch'); }
            if (hash(searchSnap) !== parsed.data.snapshot.hash) throw new Error('retrieval_snapshot_mismatch');
          }
          const inHit = parsed.data.searchResults.some(hit => hit.url === input.url && normalizeText([hit.title, hit.snippet].join(' ')).includes(normalizedQuote));
          const inSearchSnap = searchSnap !== undefined && normalizeText(searchSnap).includes(normalizedQuote);
          if (inHit || inSearchSnap) return true;
        }
        return false;
      };
      let matched: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        let snapshotRaw: string | undefined;
        if (candidate.retrieval.snapshot) {
          try { snapshotRaw = readFileSync(this.store.path(candidate.retrieval.snapshot.path), 'utf8'); }
          catch { throw new Error('retrieval_snapshot_mismatch'); }
          if (hash(snapshotRaw) !== candidate.retrieval.snapshot.hash) throw new Error('retrieval_snapshot_mismatch');
        }
        const pageNorm = normalizeText(candidate.page.text);
        const snapNorm = snapshotRaw !== undefined ? normalizeText(snapshotRaw) : '';
        const inPage = pageNorm.includes(normalizedQuote);
        const inSnapshot = snapNorm.includes(normalizedQuote);
        const inSameUrlCorroborated = strippedDateQuote.length >= 10
          && (pageNorm.includes(strippedDateQuote) || snapNorm.includes(strippedDateQuote))
          && verifySameUrlSearchQuote(candidate.sourceSlug);
        if (inPage || inSnapshot || inSameUrlCorroborated) { matched = candidate; break; }
      }
      if (!matched) throw new Error('quote_not_found_in_fetched_page');
      const hostname = new URL(input.url).hostname.toLowerCase();
      const matchedDomain = domainMatchesCompetitor(this.task.competitor.domains, hostname);
      const openDomains = this.task.competitor.domains.some(entry => entry.trim() === '*');
      const mentionCorpus = [matched.page.title, matched.page.text, input.quote].join('\n').toLowerCase();
      const entityTerms = [this.task.competitor.name, ...this.task.competitor.aliases, this.task.product].map(term => term.trim().toLowerCase()).filter(Boolean);
      const entityId = matchedDomain || (openDomains && entityTerms.some(term => mentionCorpus.includes(term))) ? this.task.competitor.id : null;
      const cleanQuote = this.trace.redactor.clean(input.quote.trim());
      const extractedSignal = SignalSchema.parse(this.trace.redactor.clean({
        entity: { id: entityId, name: this.task.competitor.name, domain: hostname },
        product: this.task.product,
        signalType: input.signalType,
        sourceSlug: matched.sourceSlug,
        url: input.url,
        eventKey: input.eventKey,
        content: { title: input.title, value: input.value, polarity: input.polarity },
        published_at: input.publishedAt !== undefined ? input.publishedAt : matched.page.published_at,
        retrieved_at: matched.page.retrieved_at,
        collectionStatus: 'success_with_data',
      }));
      const record: ExtractedSignalRecord = {
        observationIndex: matched.observationIndex,
        sourceSlug: matched.sourceSlug,
        provenance: matched.retrieval.provenance,
        raw: matched.retrieval.raw,
        ...(matched.retrieval.rawTruncated !== undefined ? { rawTruncated: matched.retrieval.rawTruncated } : {}),
        ...(matched.retrieval.snapshot ? { snapshot: matched.retrieval.snapshot } : {}),
        signal: extractedSignal,
        excerpt: cleanQuote,
      };
      if (!this.extractedSignals.some(item => item.observationIndex === record.observationIndex && canonical(item.signal) === canonical(record.signal) && item.excerpt === record.excerpt)) {
        this.extractedSignals.push(record);
      }
      return {
        extracted: true,
        sourceSlug: record.sourceSlug,
        url: extractedSignal.url,
        signalType: extractedSignal.signalType,
        eventKey: extractedSignal.eventKey,
        attribution: attribution(this.task, extractedSignal),
        timeStatus: timeStatus(this.task, extractedSignal),
        excerpt: record.excerpt,
        stagedCount: this.extractedSignals.length,
        signal: extractedSignal,
      };
    }
    if (name === 'analyze') {
      if (this.drafted) throw new Error('already_drafted');
      if (this.analyzed && !this.reworkUnlocked) throw new Error('already_analyzed');
      const isRework = this.analyzed && this.reworkUnlocked;
      if (!this.baseGaps) this.baseGaps = [...this.gaps];
      if (isRework) {
        this.reworkCount++;
        this.reworkUnlocked = false;
        this.reviewed = false;
        const budgetGaps = this.gaps.filter(gap => /^(tool_budget_skipped|tool_failure_limit):/.test(gap));
        this.gaps.splice(0, this.gaps.length, ...this.baseGaps, ...budgetGaps);
        this.evidenceIds = [];
        this.eventIds = [];
      }
      for (const slug of this.plan!.sources) {
        const observations = this.state.observations
          .map((observation, index) => ({ observation, index }))
          .filter(({ observation: o }) => { try {
            const binding = this.registry.binding(o.name), generic = o.result as { kind?: string; isError?: boolean; status?: string } | null;
            return binding.source_slug === slug && generic?.status !== 'tool_budget_skipped' && !(binding.action !== 'collect' && generic?.kind === 'mcp_tool_result' && generic.isError === false);
          } catch { return false; } });
        if (!observations.length) { this.gaps.push('source_not_collected:' + slug); continue; }
        for (const { observation, index } of observations) {
          const parsed = RetrievalSchema.safeParse(observation.result);
          if (!parsed.success) {
            const generic = observation.result as { kind?: string; isError?: boolean } | null;
            this.gaps.push(generic?.kind === 'mcp_tool_result' && generic.isError === false ? 'source_unstructured_result:' + slug + ':requires_structured_signals' : 'source_failed:' + slug + ':' + JSON.stringify(observation.result)); continue;
          }
          if (parsed.data.signals.some(s => s.sourceSlug !== slug)) { this.gaps.push('source_provenance_mismatch:' + slug); continue; }
          const data = this.trace.redactor.clean(parsed.data);
          const extracted = this.extractedSignals.filter(item => item.observationIndex === index && item.sourceSlug === slug);
          const merged = extracted.length
            ? { ...data, signals: [...data.signals, ...extracted.map(item => this.trace.redactor.clean(item.signal))] }
            : data;
          const excerpts = extracted.length
            ? [...data.signals.map(() => undefined), ...extracted.map(item => this.trace.redactor.clean(item.excerpt))]
            : undefined;
          const ingested = this.facts.ingest(this.task, merged, excerpts ? { excerpts } : undefined);
          this.evidenceIds.push(...ingested.evidenceIds); this.eventIds.push(...ingested.eventIds); this.gaps.push(...ingested.gaps.map(g => slug + ':' + g));
        }
      }
      this.evidenceIds = [...new Set(this.evidenceIds)]; this.eventIds = [...new Set(this.eventIds)];
      this.claims = this.facts.claims(this.task, this.evidenceIds); this.comparisons = this.facts.compare(this.before, this.eventIds); this.analyzed = true;
      this.store.write('comparisons/' + this.trace.runId + '.json', this.comparisons);
      this.trace.emit('evidence_saved', { evidenceIds: this.evidenceIds, eventIds: this.eventIds, reworkRound: this.reworkCount });
      return { claims: this.claims, comparisons: this.comparisons, gaps: this.gaps, evidenceIds: this.evidenceIds, reworkRound: this.reworkCount };
    }
    if (name === 'review') {
      if (!this.analyzed) throw new Error('analysis_required');
      // Reviewer has data only. No SourceClient, registry, executor or mutation callback is supplied.
      this.review = reviewClaims(this.task, structuredClone(this.claims), this.facts.events(), this.facts.versions(), this.facts.evidence());
      // Snapshots on disk must exist and have their original hash before review can accept them.
      for (const eid of this.review.evidenceRefs) { const e = this.facts.evidence().find(e => e.id === eid); if (!e) continue; try { if (hash(readFileSync(this.store.path(e.rawPath), 'utf8')) !== e.snapshotHash) throw new Error('mismatch'); } catch { this.review.issues.push('snapshot_missing_or_corrupt:' + eid); this.review.decision = 'needs_evidence'; } }
      this.reviewed = true;
      const reworkAvailable = !this.drafted && this.review.decision === 'needs_evidence' && this.reworkCount < this.maxReworkRounds;
      this.reworkUnlocked = reworkAvailable;
      this.store.write('reviews/' + this.trace.runId + '.json', { ...this.review, reworkCount: this.reworkCount });
      return { ...this.review, reworkAvailable, reworkRound: this.reworkCount, maxReworkRounds: this.maxReworkRounds };
    }
    if (name === 'draft') {
      if (!this.reviewed) throw new Error('review_required'); if (this.drafted) throw new Error('already_drafted');
      const draft = draftSchema.parse(args);
      if (new Set(draft.claimIds).size !== draft.claimIds.length || draft.claimIds.some(id => !this.claims.some(c => c.id === id)) || this.claims.some(c => !draft.claimIds.includes(c.id))) throw new Error('draft_claim_set_mismatch');
      this.report = 'reports/' + this.trace.runId + '.md';
      this.store.text(this.report, renderReport(this.task, this.claims, this.facts.evidence(), this.review, this.comparisons, this.gaps, this.trace.redactor.clean(draft.narrative), this.mode));
      this.store.write('claims/' + this.trace.runId + '.json', this.claims); this.drafted = true; this.reworkUnlocked = false;
      return { path: this.report, claimIds: this.claims.map(c => c.id), review: this.review.decision, gaps: this.gaps };
    }
    throw new Error('unknown_workflow_tool');
  }
  async close(): Promise<void> {}
}
