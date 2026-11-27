import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonical, hash, PlanSchema, RetrievalSchema, SignalSchema, SourceAuthorshipSchema, timestamp, abortable, type AgentState, type CompetitorSignal, type CompetitorTask, type Plan, type RetrievalResult, type SourceClient, type ToolDefinition, type ToolExecutionContext, type ToolBudgetSnapshot } from '@cwatch/core/types';
import { EvidenceStore, attribution, timeStatus, reviewClaims, renderReport, type Claim, type Comparison, type Review } from '@cwatch/shared/intelligence/evidence';
import type { FileStore } from '@cwatch/shared/sessions/storage';
import { loadPageSnapshot } from '@cwatch/shared/sessions/page-snapshots';
import type { Trace } from '@cwatch/shared/sessions/trace';
import type { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import type { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import type { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ReadPlanSchema, WorkingStateTracker } from './working-state.ts';
import { SessionTools } from './session-tools.ts';
import type { RuntimeOptions } from './investigation.ts';
import { assessSearchSchema, InvestigationProgress, type Recheck } from './investigation-progress.ts';
import { inspectFindings, reviewAnalysisSchema, submitAnalysisSchema, submitFindings, type Finding } from './investigation-analysis.ts';
const empty = { type: 'object', properties: {}, additionalProperties: false };
const savePlanInputSchema = PlanSchema.omit({ specifiedSources: true, sourceScope: true });
const legacyPlanInputSchema = savePlanInputSchema.omit({ questions: true });
const draftSchema = z.object({ narrative: z.string().min(1).max(12000), claimIds: z.array(z.string()) }).strict();
const extractSignalSchema = z.object({
  url: z.string().url(),
  signalType: z.enum(['release', 'price', 'content', 'campaign']),
  eventKey: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  value: z.string().min(1).max(600),
  quote: z.string().min(12).max(500),
  publishedAt: timestamp.nullable().optional(),
  authorship: SourceAuthorshipSchema.optional(),
  polarity: z.enum(['supports', 'contradicts']).default('supports'),
}).strict();
function extractionToolSchema(input: z.ZodType) {
  const schema = z.toJSONSchema(input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (props?.url) delete props.url.format;
  return schema;
}
const extractSignalInputSchema = extractionToolSchema(extractSignalSchema);
const legacyExtractSignalInputSchema = extractionToolSchema(extractSignalSchema.omit({ authorship: true }));
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
  private progress?: InvestigationProgress;
  private collection?: ReturnType<InvestigationProgress['snapshot']>;
  private findings?: Finding[];
  private reviewedAnalysis?: ReturnType<typeof inspectFindings>;
  private recheck?: Recheck;
  constructor(readonly task: CompetitorTask, readonly state: AgentState, readonly registry: ToolRegistry, readonly store: FileStore, readonly trace: Trace, readonly mode: string, readonly options: RuntimeOptions, readonly transcript?: SessionTranscript, readonly workingState = new WorkingStateTracker(), readonly sessionMemory?: SessionMemoryStore, readonly toolBudgets: () => ToolBudgetSnapshot | undefined = () => undefined) {
    this.sessionTools = new SessionTools(task, registry, store, trace.runId, options.userSkills, transcript, workingState, sessionMemory);
    this.facts = new EvidenceStore(store); this.before = structuredClone(this.facts.events()); this.gaps = [...(options.initialGaps ?? [])];
  }
  canReworkCollect(): boolean { return this.reworkUnlocked && !this.drafted && this.reworkCount < this.maxReworkRounds; }
  get reworkAvailable(): boolean { return this.canReworkCollect(); }
  stage(): string {
    if (this.drafted) return 'draft_saved';
    if (!this.submitted) return 'plan';
    if (!this.analyzed) return 'collection';
    if (this.reworkUnlocked) return 'review_recheck_available';
    if (this.reviewed) return 'draft';
    return this.progress && !this.findings ? 'analysis' : 'review';
  }
  guardCollection(tool: string, args: Record<string, unknown>): string | undefined { return this.progress?.guard(tool, args, this.recheck); }
  observeCollection(tool: string, result: unknown, args: Record<string, unknown>): void { this.progress?.observe(tool, result, args); }

  private persistAssessment(): void {
    if (!this.progress) return;
    const findings = this.reviewedAnalysis?.findings ?? this.findings;
    this.store.write('assessments/' + this.trace.runId + '.json', this.trace.redactor.clean({
      collection: this.collection, findings, analysisCoverage: findings ? this.analysisCoverage(findings) : undefined,
      review: this.reviewedAnalysis?.assessments,
    }));
  }
  private analysisCoverage(findings: Finding[]) {
    const ids = new Set(findings.filter(finding => finding.status === 'verified').flatMap(finding => finding.claimIds));
    return { questions: { processed: findings.length, total: this.plan!.questions!.length }, evidence: {
      linked: this.claims.filter(claim => ids.has(claim.id) && claim.evidenceIds.length).length, total: ids.size,
    } };
  }
  async listTools(): Promise<ToolDefinition[]> { return [
    ...await this.sessionTools.listTools(),
    ...(this.transcript ? [{ name: 'read_plan', description: 'Read a verified page of the saved plan for this run. No path argument; use nextOffset for subsequent pages.', action: 'analyze' as const, inputSchema: z.toJSONSchema(ReadPlanSchema, { target: 'draft-7' }) }] : []),
    { name: 'save_plan', description: 'Persist and verify a scoped investigation plan, then submit via host callback.' + (this.task.evidencePolicy ? ' Include uniquely identified questions and their required number of distinct candidate URLs. The host copies specified sources from the task.' : ''), action: 'local_draft', inputSchema: z.toJSONSchema(this.task.evidencePolicy ? savePlanInputSchema : legacyPlanInputSchema, { target: 'draft-7' }) },
    ...(this.task.evidencePolicy ? [
      { name: 'collection_status', description: 'Read required URL attempts, question coverage, assessed search rounds and remaining collection gates.', action: 'analyze' as const, inputSchema: empty },
      { name: 'assess_search', description: 'Choose relevant returned URLs for the question and exact search query. Also accepts already-read URLs with query omitted. Empty search results are assessed automatically.', action: 'analyze' as const, inputSchema: z.toJSONSchema(assessSearchSchema, { target: 'draft-7' }) },
      { name: 'submit_analysis', description: 'Give one verified, conflict, or insufficient finding per planned question, using claim IDs from analyze. Verified findings require supported claims.', action: 'analyze' as const, inputSchema: z.toJSONSchema(submitAnalysisSchema, { target: 'draft-7' }) },
    ] : []),
    { name: 'extract_signal', description: 'Extract a verifiable CompetitorSignal from an already fetched page using a verbatim quote checked against the fetched text/snapshot (publishedAt: ISO-8601 or null).' + (this.task.evidencePolicy ? ' For non-forum pages without a visible author byline (official docs, pricing, changelog), omit authorship or set authorship.role="unknown". Only set a non-unknown role with a verbatim byline copied from the page (required for official_forum posts).' : ''), action: 'analyze', inputSchema: this.task.evidencePolicy ? extractSignalInputSchema : legacyExtractSignalInputSchema },
    { name: 'analyze', description: 'Normalize collected observations, attribute entities, store evidence/fact versions and compare history.', action: 'analyze', inputSchema: empty },
    { name: 'review', description: this.task.evidencePolicy ? 'Audit every analyzed question against all six dimensions. For each issue give a correction. Only propose a targeted recheck with a concrete allowed URL or query for an unresolved question.' : 'Read-only reviewer checks claim/evidence identity, chronology and counter evidence.', action: 'analyze', inputSchema: this.task.evidencePolicy ? z.toJSONSchema(reviewAnalysisSchema, { target: 'draft-7' }) : empty },
    { name: 'draft', description: this.task.evidencePolicy ? 'Save the reviewed findings. Pass exactly the approvedClaimIds returned by review.' : 'Save a draft from reviewed claims and your narrative; only known claim IDs allowed.', action: 'local_draft', inputSchema: z.toJSONSchema(this.task.evidencePolicy ? draftSchema.partial({ narrative: true }) : draftSchema, { target: 'draft-7' }) },
  ]; }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<unknown> {
    signal.throwIfAborted();
    if (SessionTools.handles(name)) return this.sessionTools.callTool(name, args, signal, context);
    if (name === 'read_plan') return this.workingState.readPlan({ store: this.store, runId: this.trace.runId, workflow: this }, args);
    if (name === 'save_plan') {
      if (this.submitted) throw new Error('plan_already_submitted');
      const plan: Plan = savePlanInputSchema.parse(args);
      if (plan.taskId !== this.task.taskId || plan.window.start !== this.task.window.start || plan.window.end !== this.task.window.end || plan.sources.some(s => !this.task.allowedSources.includes(s)) || this.task.allowedSources.some(s => !plan.sources.includes(s))) throw new Error('plan_scope_mismatch');
      let progress: InvestigationProgress | undefined;
      if (this.task.evidencePolicy) {
        if (!plan.questions?.length || new Set(plan.questions.map(question => question.id)).size !== plan.questions.length) throw Error('plan_requires_unique_questions');
        progress = new InvestigationProgress(this.task, plan, this.toolBudgets, tool => {
          try { return this.registry.active(this.registry.binding(tool).source_slug); } catch { return false; }
        });
        plan.specifiedSources = progress.sources;
        plan.sourceScope = this.task.evidencePolicy.scope;
      }
      const key = 'plans/' + this.trace.runId + '.json';
      try { this.store.write(key, plan); const saved = PlanSchema.parse(this.store.read(key, null)); if (canonical(saved) !== canonical(plan)) throw new Error('plan_readback_mismatch'); this.trace.emit('plan_saved', { path: key }); }
      catch (e) { this.trace.emit('plan_file_failed', { error: String(e) }); throw e; }
      try {
        const review = this.options.onPlanSubmitted && await abortable(this.options.onPlanSubmitted(structuredClone(plan), this.store.path(key), signal), signal);
        signal.throwIfAborted();
        if (review) return { submitted: false, status: 'revision_requested', feedback: review.feedback, instruction: 'Revise the investigation plan according to the user feedback within the confirmed task scope. Call workflow__save_plan with the revised plan for approval before collecting evidence.' };
      }
      catch (e) { this.trace.emit('plan_submit_failed', { error: String(e) }); throw e; }
      this.plan = plan; this.progress = progress; this.submitted = true; this.trace.emit('plan_submitted', { path: key });
      return { submitted: true, path: key, sources: plan.sources, ...(progress ? { questions: plan.questions, specifiedSources: progress.sources, sourceScope: plan.sourceScope } : {}) };
    }
    if (!this.submitted) throw new Error('plan_required');
    if (name === 'collection_status' && this.progress) return this.progress.snapshot();
    if (name === 'assess_search' && this.progress) {
      if (this.analyzed && !this.canReworkCollect()) throw Error('collection_already_closed');
      const input = assessSearchSchema.parse(args);
      if (this.recheck && input.questionId !== this.recheck.questionId) throw Error('assessment_outside_recheck_scope');
      this.progress.assess(input);
      return this.progress.snapshot();
    }
    if (name === 'extract_signal') {
      if (this.drafted) throw new Error('already_drafted');
      if (this.analyzed && !this.canReworkCollect()) throw new Error('already_analyzed');
      const input = extractSignalSchema.parse(args);
      if (this.progress) {
        const block = this.progress.guard('web_fetch', { url: input.url }, this.recheck);
        if (block) throw Error(block);
      }
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
      let matched: ((typeof candidates)[number] & { pageNorm: string }) | undefined;
      for (const candidate of candidates) {
        let snapshotRaw: string | undefined;
        if (candidate.retrieval.snapshot) {
          try { snapshotRaw = readFileSync(this.store.path(candidate.retrieval.snapshot.path), 'utf8'); }
          catch { throw new Error('retrieval_snapshot_mismatch'); }
          if (hash(snapshotRaw) !== candidate.retrieval.snapshot.hash) throw new Error('retrieval_snapshot_mismatch');
        }
        const pageNorm = normalizeText(candidate.page.textSnapshot
          ? loadPageSnapshot(this.store, this.trace.runId, candidate.page.textSnapshot.id)
          : candidate.page.text);
        const snapNorm = !candidate.page.textSnapshot && snapshotRaw !== undefined ? normalizeText(snapshotRaw) : '';
        const inPage = pageNorm.includes(normalizedQuote);
        const inSnapshot = snapNorm.includes(normalizedQuote);
        const inSameUrlCorroborated = strippedDateQuote.length >= 10
          && (pageNorm.includes(strippedDateQuote) || snapNorm.includes(strippedDateQuote))
          && verifySameUrlSearchQuote(candidate.sourceSlug);
        if (inPage || inSnapshot || inSameUrlCorroborated) { matched = { ...candidate, pageNorm }; break; }
      }
      if (!matched) throw new Error('quote_not_found_in_fetched_page: copy a shorter verbatim substring directly from the fetched page text or snapshot (avoid paraphrasing or inserting punctuation/dates not in the page).');
      const hostname = new URL(input.url).hostname.toLowerCase();
      const matchedDomain = domainMatchesCompetitor(this.task.competitor.domains, hostname);
      const openDomains = this.task.competitor.domains.some(entry => entry.trim() === '*');
      const mentionCorpus = [matched.page.title, matched.pageNorm, input.quote].join('\n').toLowerCase();
      const entityTerms = [this.task.competitor.name, ...this.task.competitor.aliases, this.task.product].map(term => term.trim().toLowerCase()).filter(Boolean);
      const entityId = matchedDomain || (openDomains && entityTerms.some(term => mentionCorpus.includes(term))) ? this.task.competitor.id : null;
      const cleanQuote = this.trace.redactor.clean(input.quote.trim());
      const authorship = input.authorship;
      const isForum = this.progress?.sourceKind(input.url) === 'official_forum';
      let effectiveAuthorship = authorship;
      let authorshipNote: string | undefined;
      if (authorship?.role === 'official_announcement' && !authorship.byline && !isForum) {
        effectiveAuthorship = { role: 'unknown' };
        authorshipNote = 'Normalized authorship.role to "unknown" because no verbatim byline was supplied on this non-forum page (non-forum official pages are attributed by URL domain).';
      } else if (authorship?.role !== undefined && authorship.role !== 'unknown' && (!authorship.byline || !matched.pageNorm.includes(normalizeText(authorship.byline)))) {
        throw Error('authorship_requires_verifiable_byline: non-unknown authorship.role requires a verbatim byline present in the fetched page; for pages without a visible author byline (such as official docs, pricing, or changelog pages), omit authorship or set authorship.role="unknown".');
      }
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
        ...(effectiveAuthorship ? { authorship: effectiveAuthorship } : this.progress ? { authorship: { role: 'unknown' } } : {}),
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
        ...(authorshipNote ? { authorshipNote } : {}),
      };
    }
    if (name === 'analyze') {
      if (this.drafted) throw new Error('already_drafted');
      if (this.analyzed && !this.reworkUnlocked) throw new Error('already_analyzed');
      const isRework = this.analyzed && this.reworkUnlocked;
      if (this.progress) {
        const pending = this.progress.errors(this.recheck);
        if (pending.length) throw Error('collection_incomplete: ' + pending.slice(0, 8).join(', '));
      }
      if (!this.baseGaps) this.baseGaps = [...this.gaps];
      if (isRework) {
        this.reworkCount++;
        this.reworkUnlocked = false;
        this.reviewed = false;
        this.recheck = undefined;
        this.findings = undefined;
        this.reviewedAnalysis = undefined;
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
          if (this.progress && observation.name === 'web_search') continue;
          if (this.progress && this.task.evidencePolicy?.scope === 'only' && data.signals.some(item => {
            try { this.progress!.url(item.url); return false; } catch { return true; }
          })) { this.gaps.push('evidence_outside_specified_sources:' + slug); continue; }
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
      if (this.progress) {
        const allowed = new Set(this.claims.flatMap(claim => claim.evidenceIds));
        const evidenceUrls = new Set(this.facts.evidence().filter(item => allowed.has(item.id)).flatMap(item => {
          try { return [this.progress!.url(item.signal.url)]; } catch { return []; }
        }));
        this.collection = this.progress.snapshot(evidenceUrls);
        for (const source of this.collection.sources) if (source.status !== 'evidence_found') this.gaps.push(`specified_source:${source.status}:${source.url}`);
        this.persistAssessment();
      }
      this.store.write('comparisons/' + this.trace.runId + '.json', this.comparisons);
      this.trace.emit('evidence_saved', { evidenceIds: this.evidenceIds, eventIds: this.eventIds, reworkRound: this.reworkCount, ...(this.collection ? { collection: this.collection } : {}) });
      const claimEvidence = this.progress ? this.facts.evidence().filter(item => this.claims.some(claim => claim.evidenceIds.includes(item.id))).map(item => ({
        id: item.id, url: item.signal.url, source: item.signal.sourceSlug, authorship: item.signal.authorship ?? { role: 'unknown' }, publishedAt: item.signal.published_at, excerpt: item.excerpt?.slice(0, 500),
      })) : undefined;
      return {
        claims: this.claims,
        comparisons: this.comparisons,
        gaps: this.gaps,
        evidenceIds: this.evidenceIds,
        reworkRound: this.reworkCount,
        nextStep: this.progress
          ? 'Call workflow__submit_analysis now with one finding per planned question based on the returned claims and gaps (use status="insufficient" where verified claims are missing). Do not re-read page snapshots before submitting analysis.'
          : 'Call workflow__review now with the analyzed claims.',
        ...(this.collection ? { collection: this.collection, claimEvidence } : {}),
      };
    }
    if (name === 'submit_analysis' && this.progress) {
      if (!this.analyzed || this.reviewed || this.drafted) throw Error('analysis_submission_out_of_order');
      this.findings = submitFindings(this.plan!, this.claims, args);
      this.persistAssessment();
      return { findings: this.findings, analysisCoverage: this.analysisCoverage(this.findings) };
    }
    if (name === 'review') {
      if (!this.analyzed) throw new Error('analysis_required');
      if (this.progress && (!this.findings || this.reviewed)) throw Error('analysis_submission_required_or_already_reviewed');
      // Reviewer has data only. No SourceClient, registry, executor or mutation callback is supplied.
      const linkedClaims = this.findings ? this.claims.filter(claim => this.findings!.some(finding => finding.claimIds.includes(claim.id))) : this.claims;
      this.review = reviewClaims(this.task, structuredClone(linkedClaims), this.facts.events(), this.facts.versions(), this.facts.evidence());
      // Snapshots on disk must exist and have their original hash before review can accept them.
      for (const eid of this.review.evidenceRefs) { const e = this.facts.evidence().find(e => e.id === eid); if (!e) continue; try { if (hash(readFileSync(this.store.path(e.rawPath), 'utf8')) !== e.snapshotHash) throw new Error('mismatch'); } catch { this.review.issues.push('snapshot_missing_or_corrupt:' + eid); this.review.decision = 'needs_evidence'; } }
      if (this.progress && this.findings) {
        const signals = new Map(this.facts.evidence().map(item => [item.id, item.signal]));
        for (const claim of linkedClaims) {
          const items = claim.evidenceIds.flatMap(id => signals.get(id) ?? []);
          if (items.length && items.every(item => item.authorship?.role === 'community')) this.review.issues.push('community_only:' + claim.id);
          else if (items.length && items.every(item => item.authorship?.role === 'community' || ((!item.authorship || item.authorship.role === 'unknown') && this.progress!.sourceKind(item.url) === 'official_forum'))) this.review.issues.push('forum_identity_unverified:' + claim.id);
        }
        const inspected = inspectFindings(args, this.findings, this.claims, this.review);
        if (inspected.recheck) inspected.recheck = this.progress.validateLead(inspected.recheck);
        this.reviewedAnalysis = inspected;
        this.review = inspected.review;
        this.recheck = this.reworkCount < this.maxReworkRounds && inspected.recheck && this.progress.canRecheck(inspected.recheck) ? inspected.recheck : undefined;
        this.persistAssessment();
      }
      this.reviewed = true;
      const reworkAvailable = !this.drafted && this.review.decision === 'needs_evidence' && this.reworkCount < this.maxReworkRounds && (!this.progress || Boolean(this.recheck));
      this.reworkUnlocked = reworkAvailable;
      this.store.write('reviews/' + this.trace.runId + '.json', { ...this.review, reworkCount: this.reworkCount });
      return { ...this.review, reworkAvailable, reworkRound: this.reworkCount, maxReworkRounds: this.maxReworkRounds,
        ...(this.reviewedAnalysis ? { findings: this.reviewedAnalysis.findings, assessments: this.reviewedAnalysis.assessments, approvedClaimIds: this.reviewedAnalysis.claimIds, ...(reworkAvailable ? { recheck: this.recheck } : {}) } : {}) };
    }
    if (name === 'draft') {
      if (!this.reviewed) throw new Error('review_required'); if (this.drafted) throw new Error('already_drafted');
      const draft = (this.progress ? draftSchema.partial({ narrative: true }) : draftSchema).parse(args);
      const claims = this.reviewedAnalysis ? this.claims.filter(claim => this.reviewedAnalysis!.claimIds.includes(claim.id)) : this.claims;
      if (new Set(draft.claimIds).size !== draft.claimIds.length || draft.claimIds.some(id => !claims.some(c => c.id === id)) || claims.some(c => !draft.claimIds.includes(c.id))) throw new Error('draft_claim_set_mismatch');
      this.report = 'reports/' + this.trace.runId + '.md';
      const statuses = { verified: '已核验', conflict: '证据冲突', insufficient: '证据不足' };
      const narrative = this.reviewedAnalysis ? this.reviewedAnalysis.findings.map(finding => {
        const title = this.plan!.questions!.find(question => question.id === finding.questionId)!.question;
        return `- ${title}（${statuses[finding.status]}）\n  ${finding.conclusion.replace(/\r?\n/g, ' ')}${finding.status === 'verified' ? ' [' + finding.claimIds.join('、') + ']' : ''}`;
      }).join('\n') : draft.narrative!;
      const reasons = { candidate_coverage: '候选覆盖完成', no_new_candidates: '两种策略均无新增候选', budget: '达到工具预算', source_unavailable: '来源或工具不可用', pending: '待查' };
      const sourceStates: Record<string, string> = { evidence_found: '已取得核验证据', read: '已读取，暂无核验证据', empty: '已读取，结果为空', failed: '无法访问', not_attempted: '未查' };
      const progressText = this.collection ? '\n## 搜索结束依据\n\n' + this.collection.questions.map(question => `- ${question.question} · ${reasons[question.stopReason]} · 候选 ${question.candidates.length}/${question.required}`).concat(this.collection.sources.map(source => `- ${source.url} · ${sourceStates[source.status]}`)).join('\n') + '\n' : '';
      const approvedEvidence = new Set(claims.flatMap(claim => claim.evidenceIds));
      const approvedEvents = new Set(claims.map(claim => claim.eventId));
      const comparisons = this.reviewedAnalysis ? this.comparisons.filter(row => approvedEvents.has(row.eventId)) : this.comparisons;
      const additional = this.reviewedAnalysis ? this.facts.evidence().filter(item => this.review.evidenceRefs.includes(item.id) && !approvedEvidence.has(item.id)) : [];
      const auditText = additional.length ? '\n## 复核材料\n\n' + additional.map(item => `- [${item.id}](${item.signal.url}) · ${item.excerpt ?? item.signal.content.title}`).join('\n') + '\n' : '';
      this.store.text(this.report, renderReport(this.task, claims, this.facts.evidence(), this.review, comparisons, this.gaps, this.trace.redactor.clean(narrative), this.mode) + this.trace.redactor.clean(progressText + auditText));
      if (this.reviewedAnalysis) this.store.write('comparisons/' + this.trace.runId + '.json', comparisons);
      this.store.write('claims/' + this.trace.runId + '.json', claims); this.drafted = true; this.reworkUnlocked = false;
      return { path: this.report, claimIds: claims.map(c => c.id), review: this.review.decision, gaps: this.gaps };
    }
    throw new Error('unknown_workflow_tool');
  }
  async close(): Promise<void> {}
}
