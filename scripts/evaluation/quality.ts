import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Redactor, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { sha256, within } from './dataset.ts';
import { readArchivedCase } from './operations.ts';
import { collectProjection, grade, inventory, verifyInventory, select, preserveControllerFailures, type EvalResult } from './grader.ts';
import { summarizePenalty, unavailablePenalty, type AgentType } from './penalty.ts';
import type { WorkerObservation } from './contracts.ts';

export const RUBRIC = {
  version: 'cwatch.quality-rubric.v1',
  dimensions: [
    { id: 'correctness', weight: 0.4, description: 'Answers the frozen task and satisfies its final requirements without contradictions.' },
    { id: 'groundedness', weight: 0.3, description: 'Factual claims and citations are supported by the supplied tool evidence; no invented facts.' },
    { id: 'uncertainty', weight: 0.2, description: 'Accurately states missing coverage, failures and uncertainty; absence of evidence is not evidence of absence.' },
    { id: 'clarity', weight: 0.1, description: 'The answer is clear, relevant and usable under the declared output contract.' },
  ],
  anchors: { 1: 'Major errors or unsupported conclusions', 2: 'Material deficiencies', 3: 'Meets the requirement', 4: 'Strong and precise', 5: 'Fully supported and exceptionally clear' },
  policy: 'Every dimension must score at least 3. Use null when evidence is insufficient. Safety or factual disputes require human review; quality cannot override rule failures.',
} as const;
const dimension = z.enum(['correctness', 'groundedness', 'uncertainty', 'clarity']);
export const JudgmentSchema = z.object({ dimension, score: z.number().int().min(1).max(5).nullable(), reason: z.string().trim().min(1).max(4000), evidence: z.array(z.string().min(1)).min(1).max(20) }).strict();
export const QualityAnswerSchema = z.object({ judgments: z.array(JudgmentSchema).length(4), concerns: z.array(z.enum(['factual_dispute', 'safety_concern'])).max(2) }).strict().superRefine((v, ctx) => {
  if (new Set(v.judgments.map(j => j.dimension)).size !== 4 || new Set(v.concerns).size !== v.concerns.length) ctx.addIssue({ code: 'custom', message: 'duplicate dimension or concern' });
});
export type QualityAnswer = z.infer<typeof QualityAnswerSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const HumanScoreSchema = z.object({ schemaVersion: z.literal('cwatch.human-score-input.v1'), subjectSha256: digest,
  rubricVersion: z.literal(RUBRIC.version), reviewer: z.string().trim().min(1).max(100).refine(s => !/[\x00-\x1f\x7f]/.test(s)),
  answer: QualityAnswerSchema, notes: z.string().max(8000).default(''),
}).strict();
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export const jsonHash = (value: unknown) => sha256(JSON.stringify(value));
export function qualityVerdict(answer: QualityAnswer): 'pass' | 'fail' | 'needs_review' {
  if (answer.judgments.some(j => j.score !== null && j.score < 3)) return 'fail';
  return answer.concerns.length || answer.judgments.some(j => j.score === null) ? 'needs_review' : 'pass';
}
export function qualityScore(answer: QualityAnswer): number | null {
  if (answer.judgments.some(j => j.score === null)) return null;
  return Math.round(RUBRIC.dimensions.reduce((sum, d) => sum + answer.judgments.find(j => j.dimension === d.id)!.score! * d.weight, 0) * 100) / 100;
}

/** No private SDK transcript, chain of thought, arbitrary reference files or provider credentials enter this packet. */
export function prepareQualitySubject(reportFile: string, caseId: string, attempt = 1, redactor = new Redactor()) {
  if (!Number.isInteger(attempt) || attempt < 1) throw Error('invalid_attempt');
  const archive = readArchivedCase(reportFile, caseId, attempt);
  const manifest = JSON.parse(readFileSync(join(archive.directory, 'manifest.json'), 'utf8')) as { model?: unknown };
  const original = archive.report.results.find(r => r.caseId === caseId && r.attempt === attempt);
  if (!original?.runId || original.verdict === 'invalid') throw Error('assessment_requires_observed_run');
  const observed = JSON.parse(readFileSync(join(archive.directory, 'observed.json'), 'utf8')) as WorkerObservation;
  if (observed.runId !== original.runId || original.caseRevision !== archive.value.revision) throw Error('assessment_identity_mismatch');
  const projection = collectProjection(archive.directory, observed, archive.value.expected_final.outputContract,archive.value.expected_final.reportContract);
  const rules = grade(archive.value, projection, attempt);
  // A regrade must not erase a controller-detected crash or collection failure.
  if (original.verdict === 'fail') { rules.verdict = 'fail'; rules.executionPassed = false; rules.releaseEligible = false; rules.failures = [...new Set([...rules.failures, ...original.failures])]; }
  preserveControllerFailures(rules,original.failures);
  const events = readFileSync(join(archive.directory, observed.tracePath), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as TraceEvent);
  const final = events.filter(e => e.type === 'decision_made').map(e => e.data.decision as { kind: string; text?: string }).filter(d => d.kind === 'respond').at(-1)?.text ?? null;
  const visible = events.filter(e => ['pre_tool_use_request', 'pre_tool_use_response', 'observation_added', 'execution_finished', 'run_failed', 'run_cancelled'].includes(e.type))
    .map(e => ({ ref: 'trace:' + e.sequence, type: e.type, data: e.data }));
  const scenario = archive.value.input.scenario;
  const task = scenario.driver === 'runtime' ? { materialProvenance: archive.value.input.materialProvenance,
    instruction: scenario.instruction, source: scenario.source, response: scenario.response, tools: scenario.tools, permission: scenario.permission } : archive.value.input;
  const packet = redactor.clean({ rubric: RUBRIC, caseId, caseRevision: archive.value.revision, runId: original.runId, attempt,
    reportSha256: sha256(readFileSync(archive.reportPath)), caseSha256: jsonHash(archive.value), subjectModel: manifest.model ?? null,
    task, requirements: { final: archive.value.expected_final, process: archive.value.expected_process, safety: archive.value.safety_boundaries },
    oracleLimits: archive.value.oracle.knownLimits, finalAnswer: final, artifact:select(projection,'facts.report')??null, evidence: visible, rules,
  });
  return { archive, packet, subjectSha256: jsonHash(packet), references: new Set(['task', 'requirements', 'final-answer', 'rules', ...visible.map(e => e.ref)]), semanticApplicable: archive.value.input.scenario.driver === 'runtime' && final !== null };
}
export type QualitySubject = ReturnType<typeof prepareQualitySubject>;
export function validateQualityAnswer(raw: unknown, subject: QualitySubject): QualityAnswer {
  const answer = QualityAnswerSchema.parse(raw);
  if (answer.judgments.some(j => j.evidence.some(ref => !subject.references.has(ref)))) throw Error('unknown_quality_evidence_reference');
  return answer;
}
export function assessmentDirectory(subject: QualitySubject) {
  const root = join(subject.archive.batch, 'assessments');
  mkdirSync(root, { recursive: true });
  if (!within(realpathSync(subject.archive.batch), realpathSync(root))) throw Error('assessment_output_escape');
  const id = randomUUID(), directory = join(root, id); mkdirSync(directory);
  return { id, directory };
}
const recordBase = { schemaVersion: z.literal('cwatch.assessment.v1'), id: z.string().uuid(), kind: z.enum(['rules', 'llm', 'human']), subjectSha256: digest,
  rubricVersion: z.literal(RUBRIC.version), caseId: z.string(), caseRevision: z.number().int(), runId: z.string(), attempt: z.number().int().positive(),
  completedAt: z.string().datetime(), status: z.enum(['completed', 'invalid']), answer: QualityAnswerSchema.nullable(), verdict: z.enum(['pass', 'fail', 'needs_review', 'invalid']), qualityScore: z.number().min(1).max(5).nullable(),
  reviewer: z.string().nullable(), error: z.string().nullable(), metadata: z.record(z.string(), z.unknown()),
};
export const AssessmentSchema = z.object(recordBase).strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export function finishAssessment(subject: QualitySubject, target: { id: string; directory: string }, value: Pick<Assessment, 'kind' | 'status' | 'answer' | 'reviewer' | 'error' | 'metadata'>) {
  const record = AssessmentSchema.parse({ schemaVersion: 'cwatch.assessment.v1', id: target.id, subjectSha256: subject.subjectSha256,
    rubricVersion: RUBRIC.version, caseId: subject.packet.caseId, caseRevision: subject.packet.caseRevision, runId: subject.packet.runId,
    attempt: subject.packet.attempt, completedAt: new Date().toISOString(), ...value,
    verdict: value.status === 'invalid' ? 'invalid' : value.kind === 'rules' ? subject.packet.rules.verdict : qualityVerdict(value.answer!),
    qualityScore: value.answer ? qualityScore(value.answer) : null,
  });
  save(join(target.directory, 'subject.json'), subject.packet); save(join(target.directory, 'record.json'), record);
  save(join(target.directory, 'manifest.json'), { evidence: inventory(target.directory) });
  return { path: join(target.directory, 'record.json'), record };
}
export function scoreRules(subject: QualitySubject) {
  return finishAssessment(subject, assessmentDirectory(subject), { kind: 'rules', status: 'completed', answer: null, reviewer: null, error: null, metadata: { deterministic: subject.packet.rules } });
}
export function humanTemplate(subject: QualitySubject) {
  if (!subject.semanticApplicable) throw Error('quality_requires_runtime_final_answer');
  const target = assessmentDirectory(subject);
  save(join(target.directory, 'subject.json'), subject.packet);
  const path = join(target.directory, 'human-input.json');
  save(path, { schemaVersion: 'cwatch.human-score-input.v1', subjectSha256: subject.subjectSha256, rubricVersion: RUBRIC.version, reviewer: '',
    answer: { judgments: RUBRIC.dimensions.map(d => ({ dimension: d.id, score: null, reason: '', evidence: [] })), concerns: [] }, notes: '' });
  return { path, packet: join(target.directory, 'subject.json') };
}
export function scoreHuman(subject: QualitySubject, input: unknown, redactor = new Redactor()) {
  if (!subject.semanticApplicable) throw Error('quality_requires_runtime_final_answer');
  const human = HumanScoreSchema.parse(input);
  if (human.subjectSha256 !== subject.subjectSha256) throw Error('human_subject_mismatch');
  const answer = validateQualityAnswer(human.answer, subject);
  return finishAssessment(subject, assessmentDirectory(subject), { kind: 'human', status: 'completed', answer: redactor.clean(answer), reviewer: redactor.clean(human.reviewer), error: null,
    metadata: { notes: redactor.clean(human.notes), identity: 'self_declared_human', inputSha256: jsonHash(input) } });
}
export function listAssessments(subject: QualitySubject): Assessment[] {
  const root = join(subject.archive.batch, 'assessments'); if (!existsSync(root)) return [];
  if (!within(realpathSync(subject.archive.batch), realpathSync(root))) throw Error('assessment_output_escape');
  const records: Assessment[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name); if (!within(realpathSync(root), realpathSync(dir))) throw Error('assessment_path_escape');
    if (!existsSync(join(dir, 'record.json'))) continue; // Editable templates and interrupted requests are not scores.
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.evidence) || !['record.json', 'subject.json'].every(path => manifest.evidence.some((e: { path: string }) => e.path === path))
      || verifyInventory(dir, manifest.evidence).length) throw Error('assessment_integrity_failure');
    const record = AssessmentSchema.parse(JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')));
    if (record.id !== name) throw Error('assessment_id_mismatch');
    const packet = JSON.parse(readFileSync(join(dir, 'subject.json'), 'utf8'));
    if (jsonHash(packet) !== record.subjectSha256) throw Error('assessment_subject_integrity_failure');
    if (record.subjectSha256 !== subject.subjectSha256) continue;
    if (record.answer) {
      validateQualityAnswer(record.answer, subject);
      if (record.verdict !== qualityVerdict(record.answer) || record.qualityScore !== qualityScore(record.answer)) throw Error('assessment_verdict_mismatch');
    }
    records.push(record);
  }
  return records.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id));
}
export function combinedAssessment(subject: QualitySubject, records = listAssessments(subject)) {
  const root = join(subject.archive.batch, 'assessments');
  const pending = existsSync(root) ? readdirSync(root).filter(name => {
    const dir = join(root, name), request = join(dir, 'request.json');
    if (existsSync(join(dir, 'record.json')) || !existsSync(request)) return false;
    if (!within(realpathSync(root), realpathSync(request))) throw Error('assessment_path_escape');
    const data = JSON.parse(readFileSync(request, 'utf8')); return jsonHash(data.packet) === subject.subjectSha256;
  }).length : 0;
  const llm = records.filter(r => r.kind === 'llm').at(-1) ?? null, human = records.filter(r => r.kind === 'human').at(-1) ?? null;
  const rules = subject.packet.rules;
  const disagreement = Boolean(llm && human && llm.status === 'completed' && human.status === 'completed' && llm.verdict !== human.verdict);
  const verdict = rules.verdict === 'fail' || human?.verdict === 'fail' ? 'fail'
    : !subject.semanticApplicable ? rules.verdict
    : rules.verdict !== 'pass' || pending > 0 || !llm || !human || llm.verdict !== 'pass' || human.verdict !== 'pass' || disagreement ? 'needs_review' : 'pass';
  return { caseId: subject.packet.caseId, caseRevision: subject.packet.caseRevision, runId: subject.packet.runId, attempt: subject.packet.attempt,
    verdict, releaseEligible: verdict === 'pass' && rules.releaseEligible, semanticApplicable: subject.semanticApplicable, disagreement, incompleteJudgeAssessments: pending,
    rules, llm, human, history: records.map(r => ({ id: r.id, kind: r.kind, verdict: r.verdict, completedAt: r.completedAt,
      physicalRequests: r.kind === 'llm' ? Number(r.metadata.physicalRequests ?? 0) : 0,
      totalTokens: r.kind === 'llm' && typeof r.metadata.totalTokens === 'number' ? r.metadata.totalTokens : null })),
  };
}
export function qualityReport(reportFile: string, redactor = new Redactor()) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { results:EvalResult[];plannedTrialsPerCase?:number;scorePolicy?:{agentType?:AgentType} };
  const results = report.results.map(r => !r.runId || r.verdict === 'invalid'
    ? { caseId: r.caseId, attempt: r.attempt, verdict: 'invalid', releaseEligible: false, llm: null, human: null }
    : combinedAssessment(prepareQualitySubject(reportFile, r.caseId, r.attempt, redactor)));
  const llm = results.flatMap(r => 'history' in r ? r.history.filter(h => h.kind === 'llm') : []);
  return { schemaVersion: 'cwatch.quality-report.v1', rubric: RUBRIC, originalReportSha256: sha256(readFileSync(reportFile)), results,
    metrics: { planned: results.length, pass: results.filter(r => r.verdict === 'pass').length, fail: results.filter(r => r.verdict === 'fail').length,
      needsReview: results.filter(r => r.verdict === 'needs_review').length, invalid: results.filter(r => r.verdict === 'invalid').length,
      releaseGate: results.length > 0 && results.every(r => r.releaseEligible), judgeAttempts: llm.reduce((sum, r) => sum + r.physicalRequests, 0),
      knownJudgeTokens: llm.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0), judgeUnknownUsageAttempts: llm.filter(r => r.physicalRequests > 0 && r.totalTokens === null).length,
      incompleteJudgeAssessments: results.reduce((sum, r) => sum + ('incompleteJudgeAssessments' in r ? r.incompleteJudgeAssessments : 0), 0),
      // Selected scores and full history are both exposed; no best-of selection.
      actualJudgeCost: null,penalty:summarizePenalty(results.map((r,i)=>'rules' in r?r.rules:{...report.results[i],penalty:unavailablePenalty()}),{expectedTrials:report.plannedTrialsPerCase,agentType:report.scorePolicy?.agentType}) },
  };
}
export function saveQualityReport(reportFile: string, redactor = new Redactor()) {
  const report = qualityReport(reportFile, redactor);
  if (!report.results.length) throw Error('empty_quality_report');
  const path = join(dirname(realpathSync(reportFile)), 'quality-report-' + randomUUID() + '.json'); save(path, report);
  const scoreLink = (record: Assessment | null) => record ? `[${record.verdict}${record.qualityScore === null ? '' : ' (' + record.qualityScore + '/5)'}](assessments/${record.id}/record.json)` : '未评分';
  const markdown = ['# 三类评分报告', '', `量表：${RUBRIC.version}`, '', '| Case | Attempt | 规则 | LLM | 人工 | 综合 |', '|---|---:|---|---|---|---|',
    ...report.results.map(r => `| ${r.caseId} | ${r.attempt} | ${'rules' in r ? r.rules.verdict : 'invalid'} | ${scoreLink(r.llm)} | ${scoreLink(r.human)} | ${r.verdict} |`),
    '', '缺失评分保留为待复核；硬失败不能由质量分抵消。每类选取最后完成的一次评分，JSON 同时保存完整历史，失败请求计入用量。人工署名为本机声明，不认证身份。',
    '', '```json', JSON.stringify(report.metrics, null, 2), '```'].join('\n');
  writeFileSync(path.replace(/\.json$/, '.md'), markdown + '\n', { flag: 'wx' }); return { path, report };
}
