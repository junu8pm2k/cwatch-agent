import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInvestigation } from '@cwatch/server-core/runtime/investigation';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import { allowedScopedUrl, PreferredWebSource } from '@cwatch/shared/sources/web';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import type { Decision, RetrievalResult } from '@cwatch/core/types';
import type { InvestigationAssessment } from '@cwatch/core/types/runs';
import { check, fixture, store, task } from './harness.ts';
import { releaseUrl, reviewChecks } from './tracked-investigation-fixture.ts';

check('integration', 'Tracked investigation gates collection, measures search saturation, and drops a reviewed unsupported claim', async () => {
  const value = task(), data = store(), registry = new ToolRegistry();
  const unavailableUrl = 'https://nodejs.org/en/about';
  value.allowedSources = ['web'];
  value.evidencePolicy = { scope: 'only', sources: [{ url: releaseUrl, kind: 'changelog' }, { url: unavailableUrl, kind: 'official_site' }] };
  const observedArguments: string[] = [];
  await registry.register('web', 'builtin', {
    listTools: async () => createWebToolDefinitions(),
    callTool: async (name, args): Promise<RetrievalResult> => {
      observedArguments.push(String(args.url ?? args.query));
      if (name === 'web_search') return { status: 'success_empty', raw: '', signals: [], searchResults: [], provenance: 'fixture' };
      if (args.url === unavailableUrl) return { status: 'timeout', raw: '', signals: [], provenance: 'fixture', error: 'fixture source timeout' };
      const result = fixture(); result.signals[0].sourceSlug = 'web'; return result;
    }, close: async () => {},
  }, new AbortController().signal);
  const query = 'site:nodejs.org/en/blog/release/v24.0.0 Node.js historical', alt = 'site:nodejs.org/en/about Node.js release dates';
  const question = (id: string) => ({ id, question: id, candidatesRequired: 1 });
  const tool = (name: string, args: Record<string, unknown> = {}): Decision => ({ kind: 'call_tool', name, args });
  const steps: Decision[] = [
    tool('workflow__save_plan', { taskId: value.taskId, objective: 'check gates', sources: value.allowedSources, queries: [query, alt], evidenceRequirements: ['release URL'], window: { start: value.window.start, end: value.window.end }, questions: [question('release'), question('history')] }),
    tool('web_search', { query, limit: 3, questionId: 'history', strategy: 'historical' }),
    tool('workflow__analyze'),
    tool('web_fetch', { url: releaseUrl }), tool('web_fetch', { url: unavailableUrl }),
    tool('workflow__assess_search', { questionId: 'release', candidateUrls: [releaseUrl] }),
    tool('web_search', { query, limit: 3, questionId: 'history', strategy: 'historical' }),
    tool('web_search', { query: alt, limit: 3, questionId: 'history', strategy: 'alternate_terms' }),
    tool('workflow__analyze'), tool('workflow__submit_analysis', { findings: [{ questionId: 'history', status: 'insufficient', conclusion: '缺历史资料。', claimIds: [] }] }),
    tool('workflow__submit_analysis'), tool('workflow__review', { assessments: [{ questionId: 'release', checks: reviewChecks.slice(0, 5) }] }),
    tool('workflow__review'), tool('workflow__draft', { claimIds: [] }), { kind: 'respond', text: '保存草稿。' },
  ];
  let turn = 0;
  try {
    const result = await runInvestigation(value, { decide: async input => {
      const current = steps[turn++];
      if (current.kind !== 'call_tool') return current;
      const lookup = (name: string) => input.state.observations.filter(row => row.name === name).map(row => row.result);
      if (turn === 11) {
        const analysis = lookup('workflow__analyze') as Array<{ claims?: Array<{ id: string }> }>;
        assert.equal(analysis.at(-1)?.claims?.length, 1);
        current.args.findings = [{ questionId: 'release', status: 'verified', conclusion: '没有依据的跨时间对比。', claimIds: [analysis.at(-1)!.claims![0].id] }, { questionId: 'history', status: 'insufficient', conclusion: '缺历史资料。', claimIds: [] }];
      }
      if (turn === 13) {
        assert.match(JSON.stringify(lookup('workflow__review')), /fewer|too_small|schema|invalid/);
        current.args.assessments = [{ questionId: 'release', checks: reviewChecks.map(check => check.dimension === 'evidence_support' ? { ...check, status: 'issue', correction: '证据只支持一个日期。' } : check) }, { questionId: 'history', checks: reviewChecks }];
      }
      return current;
    } }, registry, data, 'replay');
    assert.equal(result.status, 'partial', result.error);
    assert.deepEqual(observedArguments, [releaseUrl, unavailableUrl, query, alt]);
    const audit = data.read<InvestigationAssessment>('assessments/' + result.runId + '.json', {});
    assert.deepEqual(audit.collection?.specifiedCoverage, { attempted: 2, total: 2 });
    assert.deepEqual(audit.collection?.questions.map(question => question.stopReason), ['candidate_coverage', 'no_new_candidates']);
    assert.equal(audit.findings?.find(row => row.questionId === 'release')?.status, 'insufficient');
    assert.deepEqual(audit.analysisCoverage, { questions: { processed: 2, total: 2 }, evidence: { linked: 0, total: 0 } });
    assert.equal(audit.review?.[0].fixes[0].evidenceIds.length, 1);
    assert.deepEqual(data.read('claims/' + result.runId + '.json', []), []);
    const report = readFileSync(data.path(result.report!), 'utf8');
    assert.match(report, /两种策略均无新增候选/);
    assert.match(report, /证据只支持一个日期/);
    assert.doesNotMatch(report, /没有依据的跨时间对比/);
  } finally { await registry.close(); }
});

check('integration', 'Tracked investigation reserves finish tools and preserves unattempted URLs when fetch budget is exhausted', async () => {
  const value = task(), data = store(), registry = new ToolRegistry();
  value.allowedSources = ['web'];
  value.evidencePolicy = { scope: 'prefer', sources: [{ url: releaseUrl, kind: 'changelog' }, { url: 'https://nodejs.org/about', kind: 'official_site' }] };
  await registry.register('web', 'builtin', {
    listTools: async () => createWebToolDefinitions(),
    callTool: async () => ({ status: 'success_empty', raw: '', signals: [], provenance: 'fixture' }), close: async () => {},
  }, new AbortController().signal);
  try {
    const model = new ReplayModel([
      { kind: 'call_tool', name: 'workflow__save_plan', args: { taskId: value.taskId, objective: 'budget test', sources: value.allowedSources, queries: ['Node.js'], evidenceRequirements: ['official history'], window: { start: value.window.start, end: value.window.end }, questions: [{ id: 'history', question: '历史版本是什么？', candidatesRequired: 1 }] } },
      { kind: 'call_tool', name: 'web_fetch', args: { url: releaseUrl } },
      { kind: 'call_tool', name: 'workflow__analyze', args: {} },
      { kind: 'call_tool', name: 'workflow__submit_analysis', args: { findings: [{ questionId: 'history', status: 'insufficient', conclusion: '未取得资料。', claimIds: [] }] } },
      { kind: 'call_tool', name: 'workflow__review', args: { assessments: [{ questionId: 'history', checks: reviewChecks }] } },
      { kind: 'call_tool', name: 'workflow__draft', args: { claimIds: [] } },
      { kind: 'respond', text: '已生成草稿。' },
    ]);
    const result = await runInvestigation(value, model, registry, data, 'replay', { maxSameToolCalls: 1 });
    assert.equal(result.status, 'partial', result.error);
    const audit = data.read<InvestigationAssessment>('assessments/' + result.runId + '.json', {});
    assert.deepEqual(audit.collection?.specifiedCoverage, { attempted: 1, total: 2 });
    assert.equal(audit.collection?.sources[1].status, 'not_attempted');
    assert.equal(audit.collection?.questions[0].stopReason, 'budget');
  } finally { await registry.close(); }
});

check('contract', 'Strict specified sources keep search and fetch within the selected origin and path', async () => {
  const urls = ['https://docs.example.com/forum/releases'];
  assert.equal(allowedScopedUrl('https://docs.example.com/forum/releases/posts/2', ['docs.example.com'], urls).pathname, '/forum/releases/posts/2');
  assert.throws(() => allowedScopedUrl('https://docs.example.com/forum/releases-unrelated', ['docs.example.com'], urls), /outside_specified/);
  assert.throws(() => allowedScopedUrl('https://sub.docs.example.com/forum/releases', ['docs.example.com'], urls), /outside_specified/);
  assert.throws(() => allowedScopedUrl('https://docs.example.com/forum/releases/%252e%252e/private', ['docs.example.com'], urls), /outside_specified/);
  const value = task();
  const web = new PreferredWebSource({ slug: 'web', allowedDomains: ['docs.example.com'], urls, restrictToUrls: true });
  assert.equal(web.validateScope('web_search', { query: 'site:docs.example.com Node.js' }, value), 'web_query_outside_specified_sources');
  assert.equal(web.validateScope('web_search', { query: 'site:docs.example.com/forum/releases Node.js' }, value), undefined);
  assert.equal(web.validateScope('web_fetch', { url: 'https://docs.example.com/forum' }, value), 'web_url_outside_scope');
});
