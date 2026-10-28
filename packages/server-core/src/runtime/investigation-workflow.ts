import { z } from 'zod';
import { canonical, PlanSchema, RetrievalSchema, abortable, type AgentState, type CompetitorTask, type Plan, type SourceClient, type ToolDefinition, type ToolExecutionContext } from '@cwatch/core/types';
import { EvidenceStore, reviewClaims, renderReport, type Claim, type Comparison, type Review } from '@cwatch/shared/intelligence/evidence';
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
export class InvestigationWorkflow implements SourceClient {
  readonly sessionTools: SessionTools;
  plan?: Plan; submitted = false; analyzed = false; reviewed = false; drafted = false;
  readonly facts: EvidenceStore;
  readonly before;
  evidenceIds: string[] = []; eventIds: string[] = []; claims: Claim[] = []; comparisons: Comparison[] = [];
  review: Review = { decision: 'needs_evidence', issues: ['not_reviewed'], evidenceRefs: [] };
  gaps: string[];
  report?: string;
  constructor(readonly task: CompetitorTask, readonly state: AgentState, readonly registry: ToolRegistry, readonly store: FileStore, readonly trace: Trace, readonly mode: string, readonly options: RuntimeOptions, readonly transcript?: SessionTranscript, readonly workingState = new WorkingStateTracker(), readonly sessionMemory?: SessionMemoryStore) {
    this.sessionTools = new SessionTools(task, registry, options.userSkills, transcript, workingState, sessionMemory);
    this.facts = new EvidenceStore(store); this.before = structuredClone(this.facts.events()); this.gaps = [...(options.initialGaps ?? [])];
  }
  async listTools(): Promise<ToolDefinition[]> { return [
    ...await this.sessionTools.listTools(),
    ...(this.transcript ? [{ name: 'read_plan', description: 'Read a verified page of the saved plan for this run. No path argument; use nextOffset for subsequent pages.', action: 'analyze' as const, inputSchema: z.toJSONSchema(ReadPlanSchema, { target: 'draft-7' }) }] : []),
    { name: 'save_plan', description: 'Persist and verify a scoped investigation plan, then submit via host callback.', action: 'local_draft', inputSchema: z.toJSONSchema(PlanSchema, { target: 'draft-7' }) },
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
    if (name === 'analyze') {
      if (this.analyzed) throw new Error('already_analyzed');
      for (const slug of this.plan!.sources) {
        const observations = this.state.observations.filter(o => { try {
          const binding = this.registry.binding(o.name), generic = o.result as { kind?: string; isError?: boolean } | null;
          return binding.source_slug === slug && !(binding.action !== 'collect' && generic?.kind === 'mcp_tool_result' && generic.isError === false);
        } catch { return false; } });
        if (!observations.length) { this.gaps.push('source_not_collected:' + slug); continue; }
        for (const observation of observations) {
          const parsed = RetrievalSchema.safeParse(observation.result);
          if (!parsed.success) {
            const generic = observation.result as { kind?: string; isError?: boolean } | null;
            this.gaps.push(generic?.kind === 'mcp_tool_result' && generic.isError === false ? 'source_unstructured_result:' + slug + ':requires_structured_signals' : 'source_failed:' + slug + ':' + JSON.stringify(observation.result)); continue;
          }
          if (parsed.data.signals.some(s => s.sourceSlug !== slug)) { this.gaps.push('source_provenance_mismatch:' + slug); continue; }
          const data = this.trace.redactor.clean(parsed.data);
          const ingested = this.facts.ingest(this.task, data);
          this.evidenceIds.push(...ingested.evidenceIds); this.eventIds.push(...ingested.eventIds); this.gaps.push(...ingested.gaps.map(g => slug + ':' + g));
        }
      }
      this.evidenceIds = [...new Set(this.evidenceIds)]; this.eventIds = [...new Set(this.eventIds)];
      this.claims = this.facts.claims(this.task, this.evidenceIds); this.comparisons = this.facts.compare(this.before, this.eventIds); this.analyzed = true;
      this.trace.emit('evidence_saved', { evidenceIds: this.evidenceIds, eventIds: this.eventIds });
      return { claims: this.claims, comparisons: this.comparisons, gaps: this.gaps, evidenceIds: this.evidenceIds };
    }
    if (name === 'review') {
      if (!this.analyzed) throw new Error('analysis_required');
      // Reviewer has data only. No SourceClient, registry, executor or mutation callback is supplied.
      this.review = reviewClaims(this.task, structuredClone(this.claims), this.facts.events(), this.facts.versions(), this.facts.evidence());
      // Snapshots on disk must exist and have their original hash before review can accept them.
      for (const eid of this.review.evidenceRefs) { const e = this.facts.evidence().find(e => e.id === eid); if (!e) continue; try { const { readFileSync } = await import('node:fs'); const { hash } = await import("@cwatch/core/types"); if (hash(readFileSync(this.store.path(e.rawPath), 'utf8')) !== e.snapshotHash) throw new Error('mismatch'); } catch { this.review.issues.push('snapshot_missing_or_corrupt:' + eid); this.review.decision = 'needs_evidence'; } }
      this.reviewed = true; this.store.write('reviews/' + this.trace.runId + '.json', this.review); return this.review;
    }
    if (name === 'draft') {
      if (!this.reviewed) throw new Error('review_required'); if (this.drafted) throw new Error('already_drafted');
      const draft = draftSchema.parse(args);
      if (new Set(draft.claimIds).size !== draft.claimIds.length || draft.claimIds.some(id => !this.claims.some(c => c.id === id)) || this.claims.some(c => !draft.claimIds.includes(c.id))) throw new Error('draft_claim_set_mismatch');
      this.report = 'reports/' + this.trace.runId + '.md';
      this.store.text(this.report, renderReport(this.task, this.claims, this.facts.evidence(), this.review, this.comparisons, this.gaps, this.trace.redactor.clean(draft.narrative), this.mode));
      this.store.write('claims/' + this.trace.runId + '.json', this.claims); this.drafted = true;
      return { path: this.report, claimIds: this.claims.map(c => c.id), review: this.review.decision, gaps: this.gaps };
    }
    throw new Error('unknown_workflow_tool');
  }
  async close(): Promise<void> {}
}
