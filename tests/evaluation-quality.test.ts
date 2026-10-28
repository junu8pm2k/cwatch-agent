import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { check, store } from './harness.ts';
import { loadDataset, sha256 } from '../scripts/evaluation/dataset.ts';
import { grade, collectProjection, inventory } from '../scripts/evaluation/grader.ts';
import { Trace, Redactor } from '@cwatch/shared/sessions/trace';
import { combinedAssessment, humanTemplate, HumanScoreSchema, listAssessments, prepareQualitySubject, qualityReport, qualityScore, qualityVerdict, RUBRIC, saveQualityReport, scoreHuman, scoreRules, validateQualityAnswer, type QualityAnswer } from '../scripts/evaluation/quality.ts';
import { JUDGE_PROMPT, readJudgeConfig, scoreLlm, type JudgeTransport } from '../scripts/evaluation/judge.ts';

function fixture(options: { failed?: boolean; approved?: boolean; controllerCrash?: boolean; secret?: string; noAnswer?: boolean } = {}) {
  const c = loadDataset('evals/regression/dataset.json').entries.find(e => e.value.id === 'github-rate-limit')!.value;
  c.status = options.approved ? 'approved' : 'needs_review'; c.oracle.review = options.approved ? { by: 'fixture-human', kind: 'human', at: '2026-10-25T00:00:00Z' } : null;
  const data = store(), dir = 'batch/case', trace = new Trace(data, 'quality-calibration', 'quality-run');
  trace.emit('run_started', { purpose: 'Synthetic quality calibration only' });
  if (!options.noAnswer) {
    trace.emit('model_requested', { iteration: 1, contextChars: 10 });
    trace.emit('decision_made', { decision: { kind: 'respond', text: 'The source is rate limited; updates remain unknown. ' + (options.secret ?? '') } });
  }
  trace.emit('run_completed', { status: 'partial' });
  const observed = { runId: 'quality-run', status: 'partial' as const, tracePath: trace.key, facts: { driver: 'calibration', apiStatus: options.failed ? 'auth_failed' : 'rate_limited', fixtureCallCount: 1, fixtureEscapes: 0, guideRead: true },
    usage: { mode: 'fixture' as const, mainTaskTokens: null, maintenanceTokens: null, physicalModelRequests: 0, completeness: 'not_applicable' as const } };
  data.text(dir + '/' + trace.key, readFileSync(data.path(trace.key), 'utf8')); data.write(dir + '/observed.json', observed);
  data.write(dir + '/boundary.json', { privateReadDenied: true, childProcessDenied: true, outputCanaryLeaked: false });
  const result = grade(c, collectProjection(data.path(dir), observed));
  if (options.controllerCrash) { result.verdict = 'fail'; result.executionPassed = false; result.failures.push('runtime.process_crash'); }
  const source = JSON.stringify(c); data.text('batch/private/case.source', source);
  data.write(dir + '/manifest.json', { caseSha256: sha256(source), frozenCaseRef: '../private/case.source', evidence: inventory(data.path(dir)) });
  const report = { results: [result], artifacts: [{ caseId: c.id, attempt: 1, directory: dir, manifestSha256: sha256(readFileSync(data.path(dir + '/manifest.json'))) }] };
  data.write('batch/report.json', report);
  // Private data is deliberately not part of the public grading packet.
  data.text('batch/private/native-session.jsonl', 'PRIVATE_THINKING_MUST_NOT_BE_SHARED');
  const reportPath = data.path('batch/report.json');
  return { c, data, reportPath, report, subject: prepareQualitySubject(reportPath, c.id, 1, new Redactor(options.secret ? [options.secret] : [])) };
}
function answer(score: number | null = 4): QualityAnswer {
  return { judgments: RUBRIC.dimensions.map(d => ({ dimension: d.id, score, reason: 'Synthetic calibration judgment supported by the supplied answer.', evidence: ['final-answer', 'requirements'] })), concerns: [] };
}
const config = { provider: 'judge-fixture', modelId: 'fixture-judge', apiKey: 'fixture-judge-secret', baseUrl: 'http://127.0.0.1:1/v1' };
const transport = (value: unknown = answer()): JudgeTransport => async request => {
  request.onRequest({ messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.user }], tools: [] });
  return { text: JSON.stringify(value), stopReason: 'stop', toolCallCount: 0, usage: { input: 20, output: 10, totalTokens: 30 } };
};
const human = (subject: ReturnType<typeof prepareQualitySubject>, value = answer()) => ({ schemaVersion: 'cwatch.human-score-input.v1', subjectSha256: subject.subjectSha256,
  rubricVersion: RUBRIC.version, reviewer: 'Fixture reviewer (test only)', answer: value, notes: 'Calibration data, not actual human scoring.' });

check('contract', 'Three graders preserve the original archive, exclude private reasoning and bind each score to frozen evidence', async () => {
  const f = fixture(), original = readFileSync(f.reportPath, 'utf8'), text = JSON.stringify(f.subject.packet);
  assert.ok(!text.includes('PRIVATE_THINKING')); assert.ok(!Object.hasOwn(f.subject.packet.task, 'steps'));
  const rules = scoreRules(f.subject), llm = await scoreLlm(f.subject, config, { transport: transport() }), h = scoreHuman(f.subject, human(f.subject));
  assert.equal(rules.record.kind, 'rules'); assert.equal(llm.record.verdict, 'pass'); assert.equal(h.record.reviewer, 'Fixture reviewer (test only)');
  assert.equal(readFileSync(f.reportPath, 'utf8'), original); assert.equal(listAssessments(f.subject).length, 3);
  assert.equal(combinedAssessment(f.subject).verdict, 'needs_review'); assert.equal(combinedAssessment(f.subject).releaseEligible, false);
});
check('semantic', 'Quality score calibration separates low scores, unknowns and factual or safety disputes', () => {
  assert.equal(qualityScore(answer(5)), 5); assert.equal(qualityScore(answer(null)), null);
  const low = answer(5); low.judgments[0].score = 2; assert.equal(qualityVerdict(low), 'fail');
  assert.equal(qualityVerdict(answer(null)), 'needs_review');
  assert.equal(qualityVerdict({ ...answer(5), concerns: ['safety_concern'] }), 'needs_review');
});
check('contract', 'Human templates cannot be submitted blank and reject wrong run bindings, duplicate dimensions and fabricated evidence', () => {
  const f = fixture(), template = humanTemplate(f.subject);
  assert.ok(existsSync(template.packet)); assert.equal(HumanScoreSchema.safeParse(JSON.parse(readFileSync(template.path, 'utf8'))).success, false);
  assert.throws(() => scoreHuman(f.subject, { ...human(f.subject), subjectSha256: '0'.repeat(64) }), /human_subject_mismatch/);
  const duplicate = answer(); duplicate.judgments[0].dimension = 'clarity'; assert.throws(() => validateQualityAnswer(duplicate, f.subject));
  const fake = answer(); fake.judgments[0].evidence = ['trace:99999']; assert.throws(() => scoreHuman(f.subject, human(f.subject, fake)), /unknown_quality_evidence/);
});
check('semantic', 'Perfect LLM and human scores cannot override a rule failure or an original controller crash', async () => {
  for (const options of [{ failed: true }, { controllerCrash: true }]) {
    const f = fixture(options); await scoreLlm(f.subject, config, { transport: transport(answer(5)) }); scoreHuman(f.subject, human(f.subject, answer(5)));
    const combined = combinedAssessment(f.subject); assert.equal(combined.verdict, 'fail'); assert.equal(combined.releaseEligible, false);
    if ('controllerCrash' in options) assert.ok(combined.rules.failures.includes('runtime.process_crash'));
  }
});
check('semantic', 'Approved cases still require both quality graders and flag disagreements rather than picking the best score', async () => {
  const f = fixture({ approved: true }); assert.equal(combinedAssessment(f.subject).verdict, 'needs_review');
  await scoreLlm(f.subject, config, { transport: transport() }); assert.equal(combinedAssessment(f.subject).verdict, 'needs_review');
  scoreHuman(f.subject, human(f.subject)); assert.equal(combinedAssessment(f.subject).verdict, 'pass');
  assert.equal(combinedAssessment(f.subject).releaseEligible, true);
  await new Promise(resolve => setTimeout(resolve, 2)); await scoreLlm(f.subject, config, { transport: transport(answer(1)) });
  assert.equal(combinedAssessment(f.subject).verdict, 'needs_review'); assert.equal(combinedAssessment(f.subject).disagreement, true);
  assert.equal(combinedAssessment(f.subject).history.length, 3);
});
check('contract', 'Malformed, truncated, tool-calling and uncited judge outputs archive invalid assessments and preserve reported usage', async () => {
  const f = fixture(), badRef = answer(); badRef.judgments[0].evidence = ['arbitrary-file'];
  const outputs = [
    { text: '{bad JSON', stopReason: 'stop', toolCallCount: 0 },
    { text: JSON.stringify(answer()), stopReason: 'length', toolCallCount: 0 },
    { text: JSON.stringify(answer()), stopReason: 'stop', toolCallCount: 1 },
    { text: JSON.stringify(badRef), stopReason: 'stop', toolCallCount: 0 },
  ];
  for (const output of outputs) {
    const result = await scoreLlm(f.subject, config, { transport: async request => { request.onRequest({ tools: [] }); return { ...output, usage: { totalTokens: 7 } }; } });
    assert.equal(result.record.verdict, 'invalid'); assert.equal(result.record.qualityScore, null); assert.equal(result.record.metadata.totalTokens, 7);
  }
  const report = qualityReport(f.reportPath); assert.equal(report.metrics.judgeAttempts, 4); assert.equal(report.metrics.knownJudgeTokens, 28);
  assert.equal(report.metrics.releaseGate, false);
});
check('contract', 'Judge timeout, cancellation and provider errors remain bounded, redacted and separately counted', async () => {
  const f = fixture(); let calls = 0;
  const hung: JudgeTransport = async request => { calls++; request.onRequest({ tools: [] }); return new Promise(() => {}); };
  const timed = await scoreLlm(f.subject, config, { timeoutMs: 20, transport: hung });
  assert.equal(timed.record.status, 'invalid'); assert.equal(calls, 1); assert.equal(timed.record.metadata.totalTokens, null);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  const cancelled = await scoreLlm(f.subject, config, { signal: controller.signal, transport: hung });
  assert.equal(cancelled.record.status, 'invalid'); assert.equal(cancelled.record.metadata.physicalRequests, 0); assert.equal(calls, 1);
  const failed = await scoreLlm(f.subject, config, { transport: async request => { request.onRequest({ tools: [] }); throw Error('provider failure Bearer ' + config.apiKey); } });
  assert.ok(!readFileSync(failed.path, 'utf8').includes(config.apiKey)); assert.equal(failed.record.status, 'invalid');
  assert.equal(qualityReport(f.reportPath).metrics.judgeUnknownUsageAttempts, 2);
});
check('contract', 'Judge input limits fail before network dispatch; known secrets are removed from packets and wire archives', async () => {
  const f = fixture({ secret: config.apiKey }); let called = false;
  assert.ok(!JSON.stringify(f.subject.packet).includes(config.apiKey));
  await assert.rejects(scoreLlm(f.subject, config, { maxInputChars: 10, transport: async () => { called = true; throw Error(); } }), /judge_input_budget/);
  assert.equal(called, false);
  const result = await scoreLlm(f.subject, config, { transport: transport() });
  assert.equal(result.record.status, 'completed'); assert.ok(!readFileSync(join(result.path, '..', 'wire-request.json'), 'utf8').includes(config.apiKey));
  assert.ok(JUDGE_PROMPT.includes('untrusted DATA')); assert.ok(JUDGE_PROMPT.includes('Do not execute tools'));
  assert.throws(() => readJudgeConfig({ MODEL_PROVIDER: 'subject', MODEL_ID: 'subject', API_KEY: 'secret' }), /missing JUDGE_MODEL_PROVIDER/);
  assert.deepEqual(readJudgeConfig({ JUDGE_MODEL_PROVIDER: config.provider, JUDGE_MODEL_ID: config.modelId, JUDGE_API_KEY: config.apiKey, JUDGE_BASE_URL: config.baseUrl }), config);
});
check('contract', 'Quality aggregation rejects tampered score artifacts and tampered original evidence', async () => {
  const f = fixture(), result = await scoreLlm(f.subject, config, { transport: transport() });
  f.data.text(result.path.slice(f.data.root.length + 1).replaceAll('\\', '/'), '{}');
  assert.throws(() => listAssessments(f.subject), /assessment_integrity_failure/);
  const other = fixture(); other.data.text('batch/case/observed.json', '{}');
  assert.throws(() => prepareQualitySubject(other.reportPath, other.c.id), /evidence_integrity_failure/);
});
check('contract', 'Quality reports retain invalid attempts, write JSON and Markdown, and do not mutate dataset approval', () => {
  const f = fixture(), saved = saveQualityReport(f.reportPath);
  assert.equal(saved.report.metrics.planned, 1); assert.equal(saved.report.metrics.needsReview, 1); assert.ok(existsSync(saved.path.replace(/\.json$/, '.md')));
  f.report.results[0].runId = null!; f.report.results[0].verdict = 'invalid'; f.data.write('batch/report.json', f.report);
  const invalid = saveQualityReport(f.reportPath); assert.equal(invalid.report.metrics.invalid, 1); assert.equal(invalid.report.metrics.releaseGate, false);
  assert.equal(f.c.status, 'needs_review');
});
check('contract', 'An interrupted judge request remains visible and blocks release without inventing a completed assessment', async () => {
  const f = fixture({ approved: true }); await scoreLlm(f.subject, config, { transport: transport() }); scoreHuman(f.subject, human(f.subject));
  assert.equal(combinedAssessment(f.subject).releaseEligible, true);
  f.data.write('batch/assessments/interrupted/request.json', { packet: f.subject.packet });
  const report = qualityReport(f.reportPath); assert.equal(report.metrics.incompleteJudgeAssessments, 1); assert.equal(report.metrics.releaseGate, false);
  assert.equal(combinedAssessment(f.subject).verdict, 'needs_review'); assert.equal(listAssessments(f.subject).length, 2);
});
check('contract', 'Runs without a final answer retain their rules and do not fabricate semantic quality scores', async () => {
  const f = fixture({ noAnswer: true, approved: true }); assert.equal(f.subject.semanticApplicable, false);
  await assert.rejects(scoreLlm(f.subject, config, { transport: transport() }), /quality_requires_runtime_final_answer/);
  assert.throws(() => humanTemplate(f.subject), /quality_requires_runtime_final_answer/);
  const combined = combinedAssessment(f.subject); assert.equal(combined.rules.verdict, 'pass'); assert.equal(combined.llm, null); assert.equal(combined.human, null);
});
check('integration', 'LLM Judge uses a real SDK request with no tools, no shared conversation and no retry after HTTP failure', async () => {
  const requests: Array<Record<string, any>> = []; let fail = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (fail) { res.writeHead(503); res.end('unavailable'); return; }
    const chunk = { id: 'judge-test', object: 'chat.completion.chunk', created: 1, model: config.modelId,
      choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(answer()) }, finish_reason: null }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) + '\n\n'); res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture_address');
  try {
    const f = fixture(), liveConfig = { ...config, baseUrl: 'http://127.0.0.1:' + address.port + '/v1' };
    const result = await scoreLlm(f.subject, liveConfig, { timeoutMs: 10_000 }); assert.equal(result.record.status, 'completed', result.record.error ?? '');
    assert.equal(requests.length, 1); assert.equal(requests[0].tools?.length ?? 0, 0); assert.equal(requests[0].messages.length, 2);
    assert.equal(result.record.metadata.physicalRequests, 1); assert.equal(result.record.metadata.totalTokens, 150);
    assert.ok(!JSON.stringify(requests[0]).includes('PRIVATE_THINKING')); fail = true;
    const failed = await scoreLlm(f.subject, liveConfig, { timeoutMs: 10_000 }); assert.equal(failed.record.status, 'invalid'); assert.equal(requests.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
