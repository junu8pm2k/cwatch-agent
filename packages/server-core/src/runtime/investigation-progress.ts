import { z } from 'zod';
import { RetrievalSchema, type CompetitorTask, type Plan, type ToolBudgetSnapshot } from '@cwatch/core/types';
import { toolBudgetSkip } from '@cwatch/shared/agent/core/budgets';
import { allowedScopedUrl, allowedUrl, specifiedSearchScope } from '@cwatch/shared/sources/web';
import { WebSearchInputSchema } from '@cwatch/shared/sources/web-tools';

export const assessSearchSchema = z.object({ questionId: z.string(), query: z.string().max(500).optional(), candidateUrls: z.array(z.string().max(2000)).max(10) }).strict();
export const recheckSchema = z.object({ questionId: z.string(), query: z.string().trim().min(1).max(500).optional(), url: z.string().max(2000).optional() }).strict().refine(input => Boolean(input.query) !== Boolean(input.url), 'supply one query or one URL');
export type Recheck = z.infer<typeof recheckSchema>;
type Question = NonNullable<Plan['questions']>[number];
type Strategy = NonNullable<z.infer<typeof WebSearchInputSchema>['strategy']>;
type FetchStatus = 'read' | 'empty' | 'failed';
type SearchStop = 'candidate_coverage' | 'no_new_candidates' | 'budget' | 'source_unavailable';
interface SearchRound { query: string; strategy: Strategy; returned: string[]; newCandidates?: number; failed?: boolean }
interface QuestionProgress { question: Question; candidates: Set<string>; rounds: SearchRound[] }

const normalizedQuery = (query: string) => query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export class InvestigationProgress {
  readonly sources: NonNullable<Plan['specifiedSources']>;
  private readonly questions = new Map<string, QuestionProgress>();
  private readonly fetches = new Map<string, FetchStatus>();

  constructor(readonly task: CompetitorTask, plan: Plan, private readonly budgets: () => ToolBudgetSnapshot | undefined, private readonly hasWebTool: (tool: string) => boolean) {
    const input = task.evidencePolicy!;
    this.sources = input.sources.map(({ url, kind }) => ({ url: allowedUrl(url, input.scope === 'only' ? ['*'] : task.competitor.domains).href, kind }));
    for (const question of plan.questions ?? []) this.questions.set(question.id, { question, candidates: new Set(), rounds: [] });
  }

  url(input: string): string {
    const only = this.task.evidencePolicy?.scope === 'only';
    return allowedScopedUrl(input, only ? ['*'] : this.task.competitor.domains, only ? this.sources.map(source => source.url) : []).href;
  }

  sourceKind(url: string): string | undefined {
    return [...this.sources].sort((left, right) => right.url.length - left.url.length).find(source => {
      try { allowedScopedUrl(url, ['*'], [source.url]); return true; } catch { return false; }
    })?.kind;
  }

  private blocker(tool: string): 'budget' | 'source_unavailable' | undefined {
    if (!this.task.allowedSources.includes('web') || !this.hasWebTool(tool)) return 'source_unavailable';
    const budgets = this.budgets();
    const skipped = budgets && toolBudgetSkip(budgets, tool);
    if (skipped) return skipped.budget === 'tool_failures' ? 'source_unavailable' : 'budget';
  }

  private stop(entry: QuestionProgress): SearchStop | undefined {
    if (entry.candidates.size >= entry.question.candidatesRequired) return 'candidate_coverage';
    const zeroStrategies = new Set<Strategy>();
    for (const round of entry.rounds) {
      if (round.newCandidates === 0) zeroStrategies.add(round.strategy);
      else if (round.newCandidates) zeroStrategies.clear();
    }
    if (zeroStrategies.size >= 2) return 'no_new_candidates';
    return this.blocker('web_search') ?? this.blocker('web_fetch');
  }

  validateLead(recheck: Recheck): Recheck {
    if (recheck.url) return { ...recheck, url: this.url(recheck.url) };
    const query = recheck.query!;
    if (this.task.evidencePolicy?.scope === 'only' && !specifiedSearchScope(query, this.sources.map(source => source.url))) throw Error('recheck_query_outside_specified_sources');
    if (this.questions.get(recheck.questionId)?.rounds.some(round => normalizedQuery(round.query) === normalizedQuery(query))) throw Error('recheck_requires_new_query');
    return recheck;
  }

  canRecheck(recheck: Recheck): boolean {
    if (recheck.url && this.fetches.get(recheck.url) === 'read') return true;
    return !this.blocker('web_fetch') && (!recheck.query || !this.blocker('web_search'));
  }

  guard(tool: string, args: Record<string, unknown>, recheck?: Recheck): string | undefined {
    if (tool === 'web_fetch') {
      let url: string;
      try { url = this.url(String(args.url)); } catch { return 'fetch_outside_specified_scope'; }
      if (this.sources.some(source => !this.fetches.has(source.url)) && !this.sources.some(source => source.url === url)) return 'fetch_specified_sources_first';
      if (!recheck) return undefined;
      const entry = this.questions.get(recheck.questionId);
      return url === recheck.url || (recheck.query && entry?.candidates.has(url)) ? undefined : 'fetch_outside_recheck_scope';
    }
    if (!this.blocker('web_fetch') && this.sources.some(source => !this.fetches.has(source.url))) return 'fetch_specified_sources_before_search';
    if (tool !== 'web_search') return recheck ? 'collection_outside_recheck_scope' : undefined;
    const input = WebSearchInputSchema.safeParse(args);
    if (!input.success || !input.data.questionId || !input.data.strategy) return 'search_requires_question_and_strategy';
    const { query, questionId } = input.data, entry = this.questions.get(questionId);
    if (!entry) return 'search_unknown_question';
    if (this.task.evidencePolicy?.scope === 'only' && !specifiedSearchScope(query, this.sources.map(source => source.url))) return 'search_outside_specified_scope';
    if (recheck && (questionId !== recheck.questionId || !recheck.query || normalizedQuery(query) !== normalizedQuery(recheck.query))) return 'search_outside_recheck_scope';
    const stop = this.stop(entry);
    if (!recheck && stop && stop !== 'budget') return 'search_question_already_stopped';
    if (entry.rounds.some(round => normalizedQuery(round.query) === normalizedQuery(query))) return 'search_query_already_attempted';
    if (entry.rounds.some(round => !round.failed && round.newCandidates === undefined)) return 'assess_previous_search_results_first';
  }

  observe(tool: string, result: unknown, args: Record<string, unknown>): void {
    if (tool !== 'web_fetch' && tool !== 'web_search') return;
    const raw = result as { status?: string; error?: string; reason?: string } | undefined;
    if (raw?.status === 'tool_budget_skipped' || raw?.status === 'blocked' || /^Error: policy_block:/.test(raw?.error ?? '')) return;
    const parsed = RetrievalSchema.safeParse(result);
    const data = parsed.success ? parsed.data : undefined;
    if (tool === 'web_fetch') {
      let url: string;
      try { url = this.url(String(args.url)); } catch { return; }
      const next = data?.status === 'success_with_data' && (data.pages?.length || data.signals.length) ? 'read' : data?.status === 'success_empty' ? 'empty' : 'failed';
      if (this.fetches.get(url) !== 'read') this.fetches.set(url, next);
      return;
    }
    const input = WebSearchInputSchema.safeParse(args);
    if (!input.success || !input.data.questionId || !input.data.strategy) return;
    const entry = this.questions.get(input.data.questionId);
    if (!entry) return;
    const { query, strategy } = input.data;
    const returned = (data?.searchResults ?? []).flatMap(hit => { try { return [this.url(hit.url)]; } catch { return []; } });
    const failed = data?.status !== 'success_with_data' && data?.status !== 'success_empty';
    entry.rounds.push({ query, strategy, returned: [...new Set(returned)], ...(failed ? { failed } : !returned.length ? { newCandidates: 0 } : {}) });
  }

  assess(raw: unknown): void {
    const input = assessSearchSchema.parse(raw), entry = this.questions.get(input.questionId);
    if (!entry) throw Error('search_unknown_question');
    const round = input.query === undefined ? undefined : entry.rounds.find(row => normalizedQuery(row.query) === normalizedQuery(input.query!));
    if (input.query !== undefined && (!round || round.failed || round.newCandidates !== undefined)) throw Error('search_round_not_awaiting_assessment');
    const urls = [...new Set(input.candidateUrls.map(url => this.url(url)))];
    if (urls.some(url => round ? !round.returned.includes(url) : this.fetches.get(url) !== 'read')) throw Error('search_candidate_not_observed');
    const newCandidates = urls.filter(url => !entry.candidates.has(url));
    for (const url of urls) entry.candidates.add(url);
    if (round) round.newCandidates = newCandidates.length;
  }

  snapshot(evidenceUrls: ReadonlySet<string> = new Set()) {
    const questions = [...this.questions.values()].map(entry => ({
      questionId: entry.question.id, question: entry.question.question, required: entry.question.candidatesRequired,
      candidates: [...entry.candidates].map(url => ({ url, status: evidenceUrls.has(url) ? 'evidence_found' : this.fetches.get(url) ?? 'not_attempted' })),
      rounds: entry.rounds.map(({ query, strategy, returned, newCandidates, failed }) => ({ query, strategy, returned: returned.length, newCandidates: newCandidates ?? null, ...(failed ? { failed } : {}) })),
      stopReason: this.stop(entry) ?? ('pending' as const),
    }));
    const sources = this.sources.map(source => {
      const state = this.fetches.get(source.url);
      const hasEvidence = evidenceUrls.has(source.url) || (state === 'read' && [...evidenceUrls].some(url => {
        try { allowedScopedUrl(url, ['*'], [source.url]); return true; } catch { return false; }
      }));
      return { ...source, status: hasEvidence ? 'evidence_found' : state ?? 'not_attempted' };
    });
    return { questions, sources, candidateCoverage: { covered: questions.filter(question => question.stopReason === 'candidate_coverage').length, total: questions.length },
      specifiedCoverage: { attempted: sources.filter(source => source.status !== 'not_attempted').length, total: sources.length },
      pendingSearchAssessments: [...this.questions.values()].flatMap(entry => entry.rounds.filter(round => !round.failed && round.newCandidates === undefined).map(round => ({ questionId: entry.question.id, query: round.query, candidates: round.returned }))),
      ...(this.blocker('web_fetch') ? { fetchStop: this.blocker('web_fetch') } : {}) };
  }

  errors(recheck?: Recheck): string[] {
    const progress = this.snapshot();
    const fetchBlocked = progress.fetchStop;
    if (recheck) {
      if (recheck.query && !this.blocker('web_search') && !this.questions.get(recheck.questionId)?.rounds.some(round => normalizedQuery(round.query) === normalizedQuery(recheck.query!))) return ['recheck_search_not_attempted'];
      if (recheck.url && !fetchBlocked && !this.fetches.has(recheck.url)) return ['recheck_url_not_attempted'];
    }
    return [
      ...(!this.blocker('web_search') && progress.pendingSearchAssessments.length ? ['search_assessment_pending'] : []),
      ...(!recheck ? progress.questions.filter(question => question.stopReason === 'pending').map(question => 'search_pending:' + question.questionId) : []),
      ...(!fetchBlocked ? progress.sources.filter(source => source.status === 'not_attempted').map(source => 'specified_source_unattempted:' + source.url) : []),
      ...(!fetchBlocked ? progress.questions.flatMap(question => question.candidates.filter(candidate => candidate.status === 'not_attempted').map(candidate => 'candidate_unattempted:' + candidate.url)) : []),
    ];
  }
}
