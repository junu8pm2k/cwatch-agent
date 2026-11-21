import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlanSchema, type AgentState, type CompetitorTask, type Decision, type ModelPort, type RetrievalResult } from '@cwatch/core/types';
import type { RunSnapshot } from '@cwatch/core/types/runs';
import { EvidenceStore } from '@cwatch/shared/intelligence/evidence';
import { PreferredWebSource, type WebOptions } from '@cwatch/shared/sources/web';
import { readWebApi } from '@cwatch/shared/sources/web-api-config';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { runInvestigation } from '@cwatch/server-core/runtime/investigation';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { WorkingStateTracker, type WorkingStateInput } from '@cwatch/server-core/runtime/working-state';
import { check, CountingClient, emptySchema, fixture, json, store, task } from './harness.ts';

const live = new AbortController().signal;
const pageUrl = 'https://nodejs.org/en/blog/release/v24.1.0';
const pageTitle = 'Node.js v24.1.0 Release';
const pageText = 'Official Announcement:\nNode.js v24.1.0   was released with V8 13.6 upgrades and security fixes for production workloads.';
const pageQuote = 'Node.js v24.1.0 was released with V8 13.6 upgrades';
const publishedAt = '2025-05-12T10:00:00Z';

function webTask(overrides: Partial<CompetitorTask> = {}): CompetitorTask {
  return { ...task(), allowedSources: ['web'], ...overrides };
}

function planStep(t: CompetitorTask): Decision {
  return {
    kind: 'call_tool',
    name: 'workflow__save_plan',
    args: {
      taskId: t.taskId,
      objective: 'Verify ' + t.competitor.name + ' releases via controlled extraction',
      sources: t.allowedSources,
      queries: [t.competitor.name + ' release'],
      evidenceRequirements: ['Fetched page snapshot and verbatim quote'],
      window: { start: t.window.start, end: t.window.end },
    },
  };
}

function scriptedModel(steps: Decision[]): ModelPort {
  let cursor = 0;
  return {
    async decide(input, signal) {
      signal.throwIfAborted();
      const step = structuredClone(steps[cursor++]);
      if (!step) throw new Error('script_exhausted');
      if (step.kind === 'call_tool' && step.name === 'workflow__draft' && step.args.claimIds === '$latest_claim_ids') {
        const latest = [...input.state.observations].reverse().find(o => o.name === 'workflow__analyze')?.result as { claims?: Array<{ id: string }> } | undefined;
        step.args.claimIds = latest?.claims?.map(c => c.id) ?? [];
      }
      return step;
    },
  };
}

function webFetchSource(pages: Record<string, { title: string; content: string }>, domains: string[] = ['nodejs.org']): PreferredWebSource {
  const options: WebOptions = {
    slug: 'web',
    allowedDomains: domains,
    webApi: readWebApi({ fetch: { url: 'https://reader-fixture.example/extract' } }, {}),
  };
  return new PreferredWebSource(options, {
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { url: string };
      const entry = pages[body.url];
      if (!entry) return new Response('not found', { status: 404 });
      return Response.json({ url: body.url, title: entry.title, content: entry.content });
    },
  });
}

check('integration', 'workflow__extract_signal verifies fetched snapshot and quote, preserves excerpt, and blocks hallucinated quotes or unfetched URLs', async () => {
  const data = store(), registry = new ToolRegistry(), t = webTask();
  await registry.register('web', 'builtin', webFetchSource({ [pageUrl]: { title: pageTitle, content: pageText } }), live);
  try {
    const result = await runInvestigation(t, scriptedModel([
      planStep(t),
      { kind: 'call_tool', name: 'web_fetch', args: { url: pageUrl } },
      // Unfetched URL must be rejected.
      { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: 'https://nodejs.org/unfetched', signalType: 'release', eventKey: 'release:unfetched', title: 'Unfetched', value: 'v0', quote: 'This page was never fetched in observations', publishedAt } },
      // Fabricated quote not present in fetched page must be rejected.
      { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: pageUrl, signalType: 'release', eventKey: 'release:fake', title: 'Fabricated', value: 'v99.0.0', quote: 'Node.js v99.0.0 includes completely fabricated benchmarks', publishedAt } },
      // Valid quote (with normalized whitespace + different case) must succeed.
      { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: pageUrl, signalType: 'release', eventKey: 'release:v24.1.0', title: pageTitle, value: 'v24.1.0 with V8 13.6 upgrades', quote: pageQuote.toUpperCase(), publishedAt } },
      { kind: 'call_tool', name: 'workflow__analyze', args: {} },
      { kind: 'call_tool', name: 'workflow__review', args: {} },
      { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Extracted verified release claim from fetched official page.', claimIds: '$latest_claim_ids' } },
      { kind: 'respond', text: 'Draft saved.' },
    ]), registry, data, 'replay');

    assert.equal(result.status, 'complete', result.error);
    assert.deepEqual(result.gaps, []);
    const state = data.read<AgentState>('states/' + result.runId + '.json', null!);
    const extracts = state.observations.filter(o => o.name === 'workflow__extract_signal').map(o => o.result as Record<string, unknown>);
    assert.equal(extracts.length, 3);
    assert.match(String(extracts[0].error), /fetched_page_not_found/);
    assert.match(String(extracts[1].error), /quote_not_found_in_fetched_page/);
    assert.equal(extracts[2].extracted, true);
    assert.equal(extracts[2].attribution, 'matched');
    assert.equal(extracts[2].timeStatus, 'in_window');

    const facts = new EvidenceStore(data);
    assert.equal(facts.evidence().length, 1);
    assert.equal(facts.evidence()[0].excerpt, pageQuote.toUpperCase());
    assert.equal(facts.events().length, 1);
    const claims = data.read<Array<{ id: string; text: string; evidenceIds: string[] }>>('claims/' + result.runId + '.json', []);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].evidenceIds[0], facts.evidence()[0].id);
    assert.deepEqual(validateTrace(data.lines<TraceEvent>('traces/' + result.runId + '.jsonl')), []);
  } finally {
    await registry.close();
  }
});

check('contract', 'workflow__extract_signal rejects tampered disk snapshots and enforces wildcard domain mention attribution', async () => {
  const data = store(), registry = new ToolRegistry();
  const openUrl = 'https://news-blog.example/post-1';
  const unrelatedUrl = 'https://news-blog.example/post-2';
  const t = webTask({ competitor: { id: 'nodejs', name: 'Node.js', aliases: ['Node'], domains: ['*'] } });
  await registry.register('web', 'builtin', webFetchSource({
    [openUrl]: { title: 'Ecosystem update', content: 'The Node.js runtime introduced v24.1.0 with V8 13.6 improvements.' },
    [unrelatedUrl]: { title: 'Weather report', content: 'Sunny skies expected across coastal regions through Friday afternoon.' },
  }, ['*']), live);

  let tampered = false;
  try {
    const result = await runInvestigation(t, {
      steps: [
        planStep(t),
        { kind: 'call_tool', name: 'web_fetch', args: { url: openUrl } },
        { kind: 'call_tool', name: 'web_fetch', args: { url: unrelatedUrl } },
        { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: openUrl, signalType: 'release', eventKey: 'release:open', title: 'Open domain match', value: 'v24.1.0', quote: 'Node.js runtime introduced v24.1.0 with V8 13.6', publishedAt } },
        { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: unrelatedUrl, signalType: 'release', eventKey: 'release:ambiguous', title: 'Unrelated post', value: 'sunny', quote: 'Sunny skies expected across coastal regions', publishedAt } },
        { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: openUrl, signalType: 'release', eventKey: 'release:tampered', title: 'Tampered', value: 'v24.1.0', quote: 'Node.js runtime introduced v24.1.0 with V8 13.6', publishedAt } },
        { kind: 'call_tool', name: 'workflow__analyze', args: {} },
        { kind: 'call_tool', name: 'workflow__review', args: {} },
        { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Wildcard domain test.', claimIds: '$latest_claim_ids' } },
        { kind: 'respond', text: 'Done.' },
      ] as Decision[],
      cursor: 0,
      async decide(input, signal) {
        signal.throwIfAborted();
        const step = structuredClone((this as any).steps[(this as any).cursor++]);
        if (!tampered && (this as any).cursor === 6) {
          tampered = true;
          const fetchObs = input.state.observations.find(o => o.name === 'web_fetch' && (o.result as RetrievalResult).pages?.[0]?.url === openUrl)!.result as RetrievalResult;
          writeFileSync(data.path(fetchObs.snapshot!.path), 'tampered-disk-snapshot', 'utf8');
        }
        if (step.kind === 'call_tool' && step.name === 'workflow__draft') {
          const latest = [...input.state.observations].reverse().find(o => o.name === 'workflow__analyze')?.result as { claims?: Array<{ id: string }> } | undefined;
          step.args.claimIds = latest?.claims?.map(c => c.id) ?? [];
        }
        return step;
      },
    } as ModelPort & { steps: Decision[]; cursor: number }, registry, data, 'replay');

    const state = data.read<AgentState>('states/' + result.runId + '.json', null!);
    const extracts = state.observations.filter(o => o.name === 'workflow__extract_signal').map(o => o.result as Record<string, unknown>);
    assert.equal(extracts[0].attribution, 'matched');
    assert.equal(extracts[1].attribution, 'ambiguous');
    assert.match(String(extracts[2].error), /retrieval_snapshot_mismatch/);
  } finally {
    await registry.close();
  }
});

check('integration', 'Review needs_evidence unlocks 1 bounded rework round to reach complete, and blocks a 2nd excess rework round', async () => {
  // Part 1: Round 1 has no evidence -> needs_evidence unlocks rework -> rework collects + extracts -> 2nd analyze/review accept -> complete.
  {
    const data = store(), registry = new ToolRegistry(), t = webTask();
    await registry.register('web', 'builtin', webFetchSource({ [pageUrl]: { title: pageTitle, content: pageText } }), live);
    try {
      const result = await runInvestigation(t, scriptedModel([
        planStep(t),
        // Round 1 skips collection -> analyze produces source_not_collected gap & 0 claims.
        { kind: 'call_tool', name: 'workflow__analyze', args: {} },
        { kind: 'call_tool', name: 'workflow__review', args: {} },
        // Rework round 1: collect and extract now unlocked.
        { kind: 'call_tool', name: 'web_fetch', args: { url: pageUrl } },
        { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: pageUrl, signalType: 'release', eventKey: 'release:v24.1.0', title: pageTitle, value: 'v24.1.0', quote: pageQuote, publishedAt } },
        { kind: 'call_tool', name: 'workflow__analyze', args: {} },
        { kind: 'call_tool', name: 'workflow__review', args: {} },
        { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Self-healed in rework round 1 with verified extracted evidence.', claimIds: '$latest_claim_ids' } },
        { kind: 'respond', text: 'Complete after bounded rework.' },
      ]), registry, data, 'replay');

      assert.equal(result.status, 'complete', result.error);
      assert.deepEqual(result.gaps, []);
      const state = data.read<AgentState>('states/' + result.runId + '.json', null!);
      const reviews = state.observations.filter(o => o.name === 'workflow__review').map(o => o.result as Record<string, unknown>);
      assert.equal(reviews.length, 2);
      assert.equal(reviews[0].decision, 'needs_evidence');
      assert.equal(reviews[0].reworkAvailable, true);
      assert.equal(reviews[0].reworkRound, 0);
      assert.equal(reviews[0].maxReworkRounds, 1);
      assert.equal(reviews[1].decision, 'accept');
      assert.equal(reviews[1].reworkAvailable, false);
      assert.equal(reviews[1].reworkRound, 1);
      assert.equal(reviews[1].maxReworkRounds, 1);

      const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
      assert.deepEqual(validateTrace(events), []);
      const savedEvents = events.filter(e => e.type === 'evidence_saved');
      assert.deepEqual(savedEvents.map(e => e.data.reworkRound), [0, 1]);
      const comparisons = data.read<Array<{ eventId: string; status: string }>>('comparisons/' + result.runId + '.json', []);
      assert.equal(comparisons.length, 1);
      assert.equal(comparisons[0].status, 'new');
      const persistedReview = data.read<{ decision: string; reworkCount?: number }>('reviews/' + result.runId + '.json', null!);
      assert.equal(persistedReview.decision, 'accept');
      assert.equal(persistedReview.reworkCount, 1);
    } finally {
      await registry.close();
    }
  }

  // Part 2: After 1 rework round still has no evidence, a 2nd collection attempt is blocked by collection_after_analysis_requires_new_run.
  {
    const data = store(), registry = new ToolRegistry(), t = { ...task(), allowedSources: ['official'] };
    const emptySource = new CountingClient(
      [{ name: 'op', description: 'empty test source', action: 'collect', inputSchema: emptySchema }],
      async (): Promise<RetrievalResult> => ({ status: 'success_empty', signals: [], raw: '', provenance: 'fixture' }),
    );
    await registry.register('official', 'mcp', emptySource, live);
    try {
      const result = await runInvestigation(t, scriptedModel([
        planStep(t),
        { kind: 'call_tool', name: 'workflow__analyze', args: {} },
        { kind: 'call_tool', name: 'workflow__review', args: {} },
        // Rework round 1: allowed (executes once, returns empty).
        { kind: 'call_tool', name: 'mcp__official__op', args: {} },
        { kind: 'call_tool', name: 'workflow__analyze', args: {} },
        { kind: 'call_tool', name: 'workflow__review', args: {} },
        // Excess 2nd rework round: collection and analyze must both be rejected.
        { kind: 'call_tool', name: 'mcp__official__op', args: {} },
        { kind: 'call_tool', name: 'workflow__analyze', args: {} },
        { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'No supported claims found after 1 rework round.', claimIds: [] } },
        { kind: 'respond', text: 'Partial draft saved.' },
      ]), registry, data, 'replay');

      assert.equal(result.status, 'partial', result.error);
      assert.equal(emptySource.calls.length, 1);
      const state = data.read<AgentState>('states/' + result.runId + '.json', null!);
      const reviews = state.observations.filter(o => o.name === 'workflow__review').map(o => o.result as Record<string, unknown>);
      assert.equal(reviews[0].reworkAvailable, true);
      assert.equal(reviews[1].decision, 'needs_evidence');
      assert.equal(reviews[1].reworkAvailable, false);
      assert.equal(reviews[1].reworkRound, 1);

      const records = data.executions().filter(r => r.sourceSlug === 'official');
      assert.equal(records.length, 2);
      assert.equal(records.filter(r => r.execute_count === 1).length, 1);
      assert.ok(records.some(r => r.execute_count === 0 && /collection_after_analysis_requires_new_run/.test(r.error ?? '')));
      const analyses = state.observations.filter(o => o.name === 'workflow__analyze').map(o => o.result as Record<string, unknown>);
      assert.match(String(analyses[2].error), /already_analyzed/);
      assert.deepEqual(validateTrace(data.lines<TraceEvent>('traces/' + result.runId + '.jsonl')), []);
    } finally {
      await registry.close();
    }
  }
});

check('contract', 'WorkingStateTracker exposes reworkCount and reworkAvailable in post-compact workflow snapshot', async () => {
  const data = store(), registry = new ToolRegistry(), tracker = new WorkingStateTracker();
  const t = { ...task(), allowedSources: ['official'] };
  await registry.register('official', 'mcp', new CountingClient(), live);
  const plan = PlanSchema.parse({ ...json('fixtures/model-script.json')[0].args, taskId: t.taskId, sources: t.allowedSources });
  data.write('plans/rework-run.json', plan);
  const workflow: WorkingStateInput['workflow'] = {
    plan, submitted: true, analyzed: true, reviewed: true, drafted: false,
    claims: [], evidenceIds: [], gaps: ['source_not_collected:official'],
    review: { decision: 'needs_evidence', issues: ['no_supported_claims'] },
    reworkCount: 0, reworkAvailable: true,
  };
  const input: WorkingStateInput = {
    task: t, runId: 'rework-run',
    state: { task: t, observations: [], decisions: [], iteration: 3 },
    workflow, store: data, registry, permissionMode: 'explore', visibleTools: registry.list(),
  };
  const first = JSON.parse(tracker.attachments(input).find(a => a.name === 'Current workflow state')!.content);
  assert.equal(first.reworkCount, 0);
  assert.equal(first.reworkAvailable, true);
  assert.equal(first.nextAction, 'rework_collect_or_workflow__draft');

  workflow.reworkCount = 1;
  workflow.reworkAvailable = false;
  const second = JSON.parse(tracker.attachments(input).find(a => a.name === 'Current workflow state')!.content);
  assert.equal(second.reworkCount, 1);
  assert.equal(second.reworkAvailable, false);
  assert.equal(second.nextAction, 'workflow__draft');
  await registry.close();
});

check('integration', 'RunService populates, persists and restores plan, review, comparisons, reworkCount and enriched claim evidence', async () => {
  const data = store(), outputRoot = resolve(data.root, 'runs');
  const t = webTask();
  let runId = '';
  const service = new RunService({
    root: process.cwd(),
    outputRoot,
    configureRegistry: async (registry, signal) => {
      await registry.register('web', 'builtin', webFetchSource({ [pageUrl]: { title: pageTitle, content: pageText } }), signal);
    },
    modelFactory: () => scriptedModel([
      planStep(t),
      { kind: 'call_tool', name: 'workflow__analyze', args: {} },
      { kind: 'call_tool', name: 'workflow__review', args: {} },
      { kind: 'call_tool', name: 'web_fetch', args: { url: pageUrl } },
      { kind: 'call_tool', name: 'workflow__extract_signal', args: { url: pageUrl, signalType: 'release', eventKey: 'release:v24.1.0', title: pageTitle, value: 'v24.1.0', quote: pageQuote, publishedAt } },
      { kind: 'call_tool', name: 'workflow__analyze', args: {} },
      { kind: 'call_tool', name: 'workflow__review', args: {} },
      { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Verified extracted release report after rework.', claimIds: '$latest_claim_ids' } },
      { kind: 'respond', text: 'Saved enriched run.' },
    ]),
  });

  try {
    const started = service.start({ profile: 'web', mode: 'replay', permission: 'explore', task: t });
    runId = started.id;
    const snapshots: RunSnapshot[] = [];
    const off = service.subscribe(runId, snap => snapshots.push(snap));
    const finished = await service.wait(runId);
    off();

    assert.equal(finished.status, 'complete', finished.error);
    assert.ok(snapshots.some(s => s.plan?.taskId === t.taskId && s.status === 'running'));
    assert.equal(finished.plan?.taskId, t.taskId);
    assert.deepEqual(finished.plan?.sources, ['web']);
    assert.equal(finished.reworkCount, 1);
    assert.equal(finished.review?.decision, 'accept');
    assert.deepEqual(finished.review?.issues, []);
    assert.equal(finished.review?.evidenceRefs.length, 1);

    assert.equal(finished.comparisons?.length, 1);
    assert.equal(finished.comparisons?.[0].status, 'new');
    assert.equal(finished.comparisons?.[0].title, pageTitle);
    assert.equal(finished.comparisons?.[0].signalType, 'release');
    assert.deepEqual(finished.comparisons?.[0].previousVersions, []);
    assert.equal(finished.comparisons?.[0].currentVersions.length, 1);

    assert.equal(finished.claims.length, 1);
    const ev = finished.claims[0].evidence[0];
    assert.equal(ev.source, 'web');
    assert.equal(ev.url, pageUrl);
    assert.equal(ev.title, pageTitle);
    assert.equal(ev.publishedAt, publishedAt);
    assert.equal(ev.provenance, 'live');
    assert.ok(ev.retrievedAt && Number.isFinite(Date.parse(ev.retrievedAt)));
    assert.equal(ev.excerpt, pageQuote);
    assert.equal(ev.domain, 'nodejs.org');
    assert.match(ev.snapshotHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(ev.snapshotVerified, true);
    assert.equal(ev.attribution, 'matched');
    assert.equal(ev.timeStatus, 'in_window');
  } finally {
    await service.close();
  }

  // Restart RunService on the same outputRoot and verify full metadata restoration.
  const restored = new RunService({ root: process.cwd(), outputRoot });
  try {
    const view = restored.get(runId);
    assert.equal(view.status, 'complete');
    assert.equal(view.plan?.taskId, t.taskId);
    assert.equal(view.reworkCount, 1);
    assert.equal(view.review?.decision, 'accept');
    assert.equal(view.comparisons?.length, 1);
    assert.equal(view.comparisons?.[0].title, pageTitle);
    assert.equal(view.comparisons?.[0].signalType, 'release');
    assert.equal(view.claims[0].evidence[0].excerpt, pageQuote);
    assert.equal(view.claims[0].evidence[0].snapshotVerified, true);
    assert.equal(view.claims[0].evidence[0].domain, 'nodejs.org');
    assert.equal(view.claims[0].evidence[0].attribution, 'matched');
    assert.equal(view.claims[0].evidence[0].timeStatus, 'in_window');
  } finally {
    await restored.close();
  }

  // Standard fixture replay populates default metadata cleanly (reworkCount = 0, excerpt falls back to content.value).
  const standardData = store(), standardService = new RunService({ root: process.cwd(), outputRoot: resolve(standardData.root, 'runs') });
  try {
    const finished = await standardService.wait(standardService.start({ profile: 'standard', mode: 'replay', permission: 'explore' }).id);
    assert.equal(finished.status, 'complete');
    assert.equal(finished.reworkCount, 0);
    assert.equal(finished.plan?.taskId, task().taskId);
    assert.equal(finished.review?.decision, 'accept');
    assert.equal(finished.comparisons?.[0].status, 'new');
    assert.equal(finished.comparisons?.[0].title, fixture().signals[0].content.title);
    assert.equal(finished.comparisons?.[0].signalType, 'release');
    assert.equal(finished.claims[0].evidence[0].excerpt, fixture().signals[0].content.value);
    assert.equal(finished.claims[0].evidence[0].snapshotVerified, true);
    assert.equal(finished.claims[0].evidence[0].domain, 'nodejs.org');
  } finally {
    await standardService.close();
  }
});
