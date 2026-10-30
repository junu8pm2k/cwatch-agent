import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readModelConfig, type ModelConfig } from '@cwatch/shared/config/models';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { loadDataset, sha256, within } from './dataset.ts';
import { confirmedBaseline, defaultBaselineRoot } from './baseline.ts';
import { readJudgeConfig, type JudgeTransport } from './judge.ts';
import { runEvaluationPipeline } from './pipeline.ts';
import { REGRESSION_POLICY } from './regression-policy.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const pathRef = z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes(':'));
const model = z.object({ provider: z.string(), id: z.string(), endpointFingerprint: digest }).strict();
const entry = z.object({ id, revision: z.number().int().positive(), dataset: pathRef, caseSha256: digest,
  baselineRoot: pathRef, baselineId: z.string().uuid(), baselineManifestSha256: digest,
  model: model.nullable(), judge: model.nullable(), admission: z.object({ path: pathRef, sha256: digest }).strict(),
}).strict();
export const RegressionSuiteSchema = z.object({ schemaVersion: z.literal('cwatch.regression-suite.v1'), id,
  version: z.number().int().positive(), policy: z.object({ trials: z.literal(5), minimumScore: z.literal(100),
    requireAllRubricPass: z.literal(true), requireConfirmedBaseline: z.literal(true) }).strict(), cases: z.array(entry),
}).strict().refine(s => new Set(s.cases.map(c => c.id)).size === s.cases.length, 'Duplicate regression case');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const portable = (base: string, file: string) => relative(base, file).replaceAll('\\', '/');
const defaultSuite = () => resolve('evals/regression/suite.json');
const stamp = (config: ModelConfig) => ({ provider: config.provider, id: config.modelId, endpointFingerprint: sha256(config.baseUrl ?? 'sdk-default') });
function local(base: string, ref: string) {
  pathRef.parse(ref);
  const path = realpathSync(resolve(base, ref));
  if (!within(realpathSync(process.cwd()), path)) throw Error('regression_reference_escape');
  return path;
}
function suite(file: string, allowEmpty = false) {
  const path = realpathSync(file), root = dirname(path);
  if (!within(realpathSync(process.cwd()), path)) throw Error('regression_suite_escape');
  const value = RegressionSuiteSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!allowEmpty && !value.cases.length) throw Error('regression_suite_empty: no qualified cases; do not treat this as a pass');
  return { path, root, value, sha256: sha256(readFileSync(path)) };
}
interface RuntimeOptions { realModel?: boolean; signal?: AbortSignal; judgeConfig?: ModelConfig; judgeTransport?: JudgeTransport; onEvent?: (event: Record<string, unknown>) => void }
function validateEntry(data: ReturnType<typeof suite>, registered: z.infer<typeof entry>, options: RuntimeOptions) {
  const dataset = local(data.root, registered.dataset), loaded = loadDataset(dataset);
  const selected = loaded.entries.find(c => c.value.id === registered.id);
  if (!selected || selected.value.revision !== registered.revision || selected.sha256 !== registered.caseSha256 || selected.value.status === 'retired') throw Error('regression_case_changed: requalify ' + registered.id);
  const baselineRoot = local(data.root, registered.baselineRoot), baseline = confirmedBaseline(selected.value, baselineRoot);
  if (baseline.binding.baselineId !== registered.baselineId || baseline.binding.manifest.sha256 !== registered.baselineManifestSha256) throw Error('regression_baseline_changed: requalify ' + registered.id);
  const proofPath = local(data.root, registered.admission.path), proofBytes = readFileSync(proofPath);
  if (sha256(proofBytes) !== registered.admission.sha256) throw Error('regression_admission_integrity_failure');
  const proof = JSON.parse(proofBytes.toString('utf8')), row = proof.gate?.cases?.[0];
  if (proof.schemaVersion !== 'cwatch.regression-admission.v1' || proof.caseId !== registered.id || proof.caseRevision !== registered.revision || proof.caseSha256 !== registered.caseSha256 ||
    proof.baselineId !== registered.baselineId || proof.baselineManifestSha256 !== registered.baselineManifestSha256 ||
    !isDeepStrictEqual(proof.model,registered.model) || !isDeepStrictEqual(proof.judge,registered.judge) ||
    !isDeepStrictEqual(proof.gate?.policy, REGRESSION_POLICY) || proof.gate?.passed !== true || proof.gate.cases.length !== 1 || row?.score !== 100 ||
    row?.caseId !== registered.id || !row?.scheduled || !row?.baselineConfirmed || row?.passedTrials !== 5 || row?.trials?.length !== 5 || new Set(row.trials.map((t: { runId: string }) => t.runId)).size !== 5 ||
    !row.trials.every((t: { passed: boolean; score: number }) => t.passed && t.score === 100)) throw Error('invalid_regression_admission');
  if (options.realModel !== false) {
    if (!isDeepStrictEqual(stamp(readModelConfig()), registered.model)) throw Error('regression_model_changed: requalify ' + registered.id);
    if (selected.value.rubric && !isDeepStrictEqual(stamp(options.judgeConfig ?? readJudgeConfig()), registered.judge)) throw Error('regression_judge_changed: requalify ' + registered.id);
  }
  return { registered, dataset, baselineRoot };
}
export function checkRegressionSuite(file = defaultSuite(), options: RuntimeOptions = {}) {
  const data = suite(file);
  return { data, cases: data.value.cases.map(c => validateEntry(data, c, options)) };
}

/** Admission is conditional on a new five-trial run, not an old success or a conversational score. */
export async function qualifyRegressionCase(options: RuntimeOptions & { dataset: string; caseId: string; suite?: string; baselineRoot?: string; out?: string }) {
  const data = suite(options.suite ?? defaultSuite(), true), loaded = loadDataset(options.dataset);
  const selected = loaded.entries.find(c => c.value.id === options.caseId);
  if (!selected || selected.value.status === 'retired' || selected.value.split !== 'regression') throw Error('qualification_case_not_available');
  const baselineRoot = resolve(options.baselineRoot ?? defaultBaselineRoot()), baseline = confirmedBaseline(selected.value, baselineRoot);
  const main = options.realModel !== false ? stamp(readModelConfig()) : null;
  const judge = selected.value.rubric ? stamp(options.judgeConfig ?? readJudgeConfig()) : null;
  if (main && !isDeepStrictEqual(main, baseline.manifest.model)) throw Error('qualification_model_must_match_confirmed_baseline');
  const result = await runEvaluationPipeline({ dataset: options.dataset, caseId: options.caseId, repeat: 5, gate: 'regression', out: options.out,
    baselineRoot, realModel: options.realModel, signal: options.signal, judgeConfig: options.judgeConfig, judgeTransport: options.judgeTransport, onEvent: options.onEvent });
  if (!result.regression?.passed || result.exitCode !== 0) return { admitted: false, suite: data.path, result };
  const after = loadDataset(options.dataset).entries.find(c => c.value.id === options.caseId);
  if (!after || after.sha256 !== selected.sha256 || confirmedBaseline(after.value, baselineRoot).binding.manifest.sha256 !== baseline.binding.manifest.sha256) throw Error('qualification_inputs_changed');
  const lock = join(data.root, '.regression.lock'), fd = openSync(lock, 'wx');
  try {
    if (sha256(readFileSync(data.path)) !== data.sha256) throw Error('regression_suite_changed_during_qualification');
    const admissionDir = join(data.root, 'admissions'); mkdirSync(admissionDir, { recursive: true });
    if (!within(realpathSync(data.root), realpathSync(admissionDir))) throw Error('regression_admission_escape');
    const proofPath = join(admissionDir, `${selected.value.id}.r${selected.value.revision}.${result.id}.json`);
    const proof = { schemaVersion: 'cwatch.regression-admission.v1', qualifiedAt: new Date().toISOString(), caseId: selected.value.id,
      caseRevision: selected.value.revision, caseSha256: selected.sha256, baselineId: baseline.binding.baselineId,
      baselineManifestSha256: baseline.binding.manifest.sha256, gate: result.regression, model: main, judge,
      sourceReport: portable(realpathSync(process.cwd()), result.sourceReport), sourceReportSha256: sha256(readFileSync(result.sourceReport)),
      qualificationReport: portable(realpathSync(process.cwd()), result.report.json), qualificationReportSha256: sha256(readFileSync(result.report.json)),
      note: 'Qualified for automatic CI regression under the project owner instruction. This is not a human approval for these new trials.' };
    const proofBytes = json(proof); writeFileSync(proofPath, proofBytes, { flag: 'wx' });
    const nextEntry = entry.parse({ id: selected.value.id, revision: selected.value.revision, dataset: portable(data.root, loaded.file),
      caseSha256: selected.sha256, baselineRoot: portable(data.root, baselineRoot), baselineId: baseline.binding.baselineId,
      baselineManifestSha256: baseline.binding.manifest.sha256, model: main, judge, admission: { path: portable(data.root, proofPath), sha256: sha256(proofBytes) } });
    const next = RegressionSuiteSchema.parse({ ...data.value, version: data.value.version + 1,
      cases: [...data.value.cases.filter(c => c.id !== nextEntry.id), nextEntry].sort((a, b) => a.id.localeCompare(b.id)) });
    const temp = join(data.root, '.' + randomUUID() + '.tmp'); writeFileSync(temp, json(next), { flag: 'wx' }); renameSync(temp, data.path);
    return { admitted: true, suite: data.path, admission: proofPath, result };
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** Execute every registered case. A missing configuration, empty suite or unknown score cannot turn CI green. */
export async function runRegressionSuite(options: RuntimeOptions & { suite?: string; out?: string } = {}) {
  const checked = checkRegressionSuite(options.suite ?? defaultSuite(), options), root = resolve(options.out ?? 'artifacts/agent-eval');
  const workspace = realpathSync(process.cwd());
  if (!within(workspace, root) || root === workspace) throw Error('regression_output_must_be_inside_workspace');
  mkdirSync(root, { recursive: true });
  if (!within(workspace, realpathSync(root))) throw Error('regression_output_escape');
  const directory = join(root, 'regression-' + randomUUID()); mkdirSync(directory);
  writeFileSync(join(directory, 'suite.snapshot.json'), json(checked.data.value), { flag: 'wx' });
  const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key) && value).map(([, value]) => value!);
  const redactor = new Redactor(secrets), results = [];
  for (const item of checked.cases) {
    if (options.signal?.aborted) break;
    try {
      const run = await runEvaluationPipeline({ dataset: item.dataset, caseId: item.registered.id, repeat: 5, gate: 'regression', out: directory,
        baselineRoot: item.baselineRoot, realModel: options.realModel, signal: options.signal, judgeConfig: options.judgeConfig, judgeTransport: options.judgeTransport, onEvent: options.onEvent });
      results.push({ caseId: item.registered.id, passed: run.regression?.passed === true && run.exitCode === 0, score: run.regression?.score ?? null,
        exitCode: run.exitCode, report: run.report.markdown, structuredReport: run.report.json, archive: run.archive.path, error: null });
    } catch (error) { results.push({ caseId: item.registered.id, passed: false, score: null, exitCode: 3, report: null, structuredReport: null, archive: null,
      error: redactor.clean(error instanceof Error ? error.message : 'regression_failed') }); }
  }
  const passed = results.length === checked.cases.length && results.every(r => r.passed), exitCode = passed ? 0 : results.some(r => r.exitCode === 3) ? 3 : 1;
  const summary = { schemaVersion: 'cwatch.regression-suite-result.v1', createdAt: new Date().toISOString(), suite: checked.data.path,
    suiteVersion: checked.data.value.version, scope: 'automatic_regression', policy: REGRESSION_POLICY, plannedCases: checked.cases.length, passed, exitCode, results };
  const path = join(directory, 'report.json'), markdown = join(directory, 'report.md'); writeFileSync(path, json(summary), { flag: 'wx' });
  writeFileSync(markdown, ['# 自动回归集报告', '', `每例独立运行 5 次，全部 100 分且代码及 Rubric 全通过才通过；任一次失败该例为 0。整体：${passed ? 'PASS' : 'FAIL'}。`,
    '', '| Case | 自动回归 | 得分 | 详细报告 |', '|---|---|---:|---|', ...results.map(r => `| ${r.caseId} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.score ?? '待确认'} | ${r.report ? `[查看](${portable(directory, r.report)})` : r.error} |`),
    '', '本轮自动评测不创建人工待办；历史人工记录保留在详细报告中。'].join('\n') + '\n', { flag: 'wx' });
  writeFileSync(join(root, 'latest-regression.json'), json({ ...summary, report: path, markdown }));
  return { ...summary, report: path, markdown };
}
