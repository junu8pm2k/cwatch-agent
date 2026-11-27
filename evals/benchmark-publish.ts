import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import {
  OtlpTraceArtifactSchema,
  enrichOtlpResourceSpans,
  langfusePayload,
  sendLangfuseTrace,
  sendOtlpResourceSpans,
} from '@cwatch/shared/sessions/langfuse';
import { StructuredTraceSchema, type StructuredTrace } from '@cwatch/shared/sessions/structured-trace';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from '../scripts/langfuse-client.ts';
import { digest, readJson } from './benchmark-contract.ts';
import config from './config.json' with { type: 'json' };

const runId = z.string().regex(/^[0-9a-zA-Z_-]{1,80}$/);
const caseStatus = z.enum(['pass', 'fail', 'error']);
const criterionFields = {
  name: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), dimension: z.enum(['result', 'process', 'evidence', 'safety']),
  required: z.boolean(), judge: z.enum(['code', 'llm']), status: z.enum(['pass', 'fail', 'error', 'skipped']),
  reason: z.string(), references: z.array(z.string()),
} as const;
const historicalScore = z.union([
  z.object({ name: z.string().regex(/^[a-z_]+$/), value: z.number().min(0).max(1), reason: z.string(), passed: z.boolean() }),
  z.object({
    ...criterionFields, value: z.int().min(0).max(3).nullable(), max: z.union([z.literal(1), z.literal(3)]),
    threshold: z.union([z.literal(1), z.literal(2)]),
  }).refine(score => score.value === null
    ? score.status === 'error' || score.status === 'skipped'
    : score.value <= score.max && score.status === (score.value >= score.threshold ? 'pass' : 'fail')),
]);
const passScore = config.scoring.passPoints / 100;
const trialCount = config.scoring.trialsPerCase;
const normalizedScore = z.number().min(0).max(1).multipleOf(0.01).nullable();
const criterionScore = z.object({
  ...criterionFields, value: normalizedScore, deduction: normalizedScore, max: z.literal(1), threshold: z.literal(passScore),
}).refine(score => score.value === null
  ? score.deduction === null && (score.status === 'error' || score.status === 'skipped')
  : score.deduction !== null && Math.round((score.value + score.deduction) * 100) === 100
    && score.status === (score.value >= score.threshold ? 'pass' : 'fail'));
const verdictFields = { passed: z.boolean(), error: z.string().optional() };
const agent = z.object({ runId, output: z.string().optional() }).optional();
const caseFields = { caseId: criterionFields.name, itemId: z.string().min(1) };
const historicalCase = z.object({
  ...caseFields, ...verdictFields, status: caseStatus.optional(), agent, scores: z.array(historicalScore),
}).refine(item => item.status === undefined || item.passed === (item.status === 'pass'));
const trial = z.object({
  ...verdictFields, trial: z.int().positive(), status: caseStatus, agent, scores: z.array(criterionScore), score: normalizedScore,
}).refine(item => item.passed === (item.status === 'pass') && (item.score === null
  ? item.status !== 'pass'
  : item.status === (item.score >= passScore ? 'pass' : 'fail')));
const caseWithTrials = z.object({
  ...caseFields, ...verdictFields, status: caseStatus, score: normalizedScore,
  trials: z.array(trial).min(1).max(trialCount),
}).refine(item => {
  const status = item.trials.some(trial => trial.status === 'fail') ? 'fail'
    : item.trials.some(trial => trial.status === 'error') ? 'error' : 'pass';
  return item.status === status && item.passed === (status === 'pass')
    && item.trials.every((trial, index) => trial.trial === index + 1);
});

function averageTrialScore(trials: Array<{ score: number | null }>) {
  const points = trials.flatMap(trial => trial.score === null ? [] : [Math.round(trial.score * 100)]);
  if (points.length !== trials.length) return null;
  return Math.round(points.reduce((total, value) => total + value, 0) / points.length) / 100;
}

const completeTrialCase = caseWithTrials.refine(item =>
  item.trials.length === trialCount && item.score === averageTrialScore(item.trials));
const scoredCase = caseWithTrials.refine(item => {
  if (item.status === 'fail') {
    return item.score === null && item.trials.findIndex(trial => trial.status === 'fail') === item.trials.length - 1;
  }
  return item.trials.length === trialCount
    && item.score === (item.status === 'pass' ? averageTrialScore(item.trials) : null);
});
const reportFields = {
  runId: z.uuid(),
  commitSha: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  suite: z.string().optional(),
  dataset: z.object({ name: z.string(), revision: z.string() }),
  judge: z.object({ version: z.string() }),
};
export const resultSchema = z.union([
  z.object({ ...reportFields, schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(), cases: z.array(historicalCase) }),
  z.object({ ...reportFields, schemaVersion: z.literal(3), cases: z.array(completeTrialCase) }),
  z.object({ ...reportFields, schemaVersion: z.literal(4), cases: z.array(scoredCase) }),
]);

function reviewTestMissingAnswerMessages(document: StructuredTrace, reason: string) {
  const task = z.object({ instruction: z.string() }).safeParse(document.input.task);
  const failedTurn = document.steps.findLast(step => step.kind === 'model' && step.status === 'failed');
  const outputTokensSchema = z.object({ output: z.number() });
  let outputTokens: number | undefined;
  for (const usage of failedTurn?.usage ?? []) {
    const tokens = outputTokensSchema.safeParse(usage.reported);
    if (tokens.success) outputTokens = tokens.data.output;
  }
  const details = ['## 评测结果 · 未通过', 'Agent 未生成最终回答，本次未进入 Judge 评分。', '## 失败原因'];
  if (reason.includes('truncated_response')) {
    details.push(outputTokens === undefined
      ? '模型达到输出 token 上限，生成被截断。'
      : `模型达到输出 token 上限（${outputTokens} token），生成被截断。`);
  }
  details.push(reason.replace(/^(?:Error:\s*)+/, '').split(/\r?\n/, 1)[0]);
  return {
    input: task.success ? [{ role: 'user', content: task.data.instruction }] : undefined,
    output: [{ role: 'assistant', name: 'Cwatch 评测说明', content: details.join('\n\n') }],
  };
}

export function reviewTestMissingAnswerView(document: StructuredTrace, reason: string): StructuredTrace {
  const view = reviewTestMissingAnswerMessages(document, reason);
  return {
    ...document,
    steps: document.steps.map(step => step.kind === 'run' ? {
      ...step,
      input: view.input ?? step.input,
      output: view.output,
    } : step),
  };
}

type TraceReceipt = { traceId?: string; scoreCount?: number; error?: string };
type CaseReceipt = TraceReceipt & {
  caseId: string; status: string; sessionId?: string; trials?: Array<TraceReceipt & { trial: number; status: string }>;
};

export async function publishBenchmark(runDir: string, expectedRunId: string) {
  const connection = readLangfuseConfig();
  if (!connection) throw Error('benchmark upload requires Langfuse project keys');
  const report = resultSchema.parse(readJson(join(runDir, 'report.json')));
  if (report.runId !== expectedRunId) throw Error('benchmark report run identity mismatch');
  const reviewTests = report.suite === 'review-tests';
  const timestamp = new Date(report.startedAt).toISOString();
  const { environment } = connection;
  const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  const client = new LangfuseClient(connection, fetch, redactor);
  const runtimeFailure = 'The case failed. Inspect the trace and metric scores.';
  function verdictScores(scope: { traceId: string } | { sessionId: string }, prefix: 'case' | 'trial', verdict: {
    passed: boolean; score?: number | null;
  }, metadata: Record<string, string>, reason: string) {
    const scopeId = 'traceId' in scope ? scope.traceId : scope.sessionId;
    const common = { ...scope, environment, timestamp, metadata: { ...metadata, passed: verdict.passed } };
    const passedName = `benchmark.${prefix}_passed`;
    const scores = [{ ...common, id: digest([scopeId, passedName]).slice(0, 32), name: passedName, value: Number(verdict.passed),
      dataType: 'BOOLEAN', comment: redactor.clean(reason).split(/\r?\n/, 1)[0].slice(0, 2000) }];
    if (verdict.score != null) {
      const name = `benchmark.${prefix}_score`;
      scores.push({ ...common, id: digest([scopeId, name]).slice(0, 32), name, value: verdict.score,
        dataType: 'NUMERIC', comment: verdict.score.toFixed(2) });
    }
    return scores;
  }

  const results: CaseReceipt[] = [];
  for (const item of report.cases) {
    const result: CaseReceipt = { caseId: item.caseId, status: item.status ?? (item.passed ? 'pass' : 'fail') };
    results.push(result);
    const trials = 'trials' in item ? item.trials : [item];
    const metadata = {
      agent_name: 'cwatch', case_id: item.caseId, run_id: report.runId, commit_sha: report.commitSha,
      judge_version: report.judge.version, dataset_name: report.dataset.name,
      dataset_revision: report.dataset.revision, dataset_item_id: item.itemId, case_status: result.status,
    };
    const sessionId = 'trials' in item || reviewTests ? item.caseId + '-' + report.runId : item.caseId;
    if ('trials' in item) result.trials = [];
    let tracePublished = false;
    for (const attempt of trials) {
      const trialNumber = 'trial' in attempt ? attempt.trial : undefined;
      const receipt: CaseReceipt | NonNullable<CaseReceipt['trials']>[number] = trialNumber === undefined
        ? result : { trial: trialNumber, status: attempt.status ?? result.status };
      if ('trial' in receipt) result.trials?.push(receipt);
      if (!attempt.agent) continue;
      try {
        const traceDir = join(runDir, 'cases', item.caseId, ...(trialNumber === undefined ? [] : [`trial-${trialNumber}`]));
        const document = StructuredTraceSchema.parse(redactor.clean(readJson(join(traceDir, 'trace.json'))));
        if (document.runId !== attempt.agent.runId || document.taskId !== item.caseId) throw Error('benchmark trace identity mismatch');
        const traceMetadata = trialNumber === undefined ? metadata : { ...metadata, trial: String(trialNumber), trial_status: receipt.status };
        const runtimeError = document.steps.find(step => step.kind === 'run')?.error?.message;
        const failure = runtimeError ?? attempt.error ?? runtimeFailure;
        const missingAnswer = reviewTests && !attempt.passed && attempt.agent.output?.trim() === ''
          ? reviewTestMissingAnswerMessages(document, redactor.clean(failure))
          : undefined;
        const otelFile = join(traceDir, 'trace.otel.json');
        let traceId: string;
        const runScores: Array<Record<string, unknown>> = [];
        if (existsSync(otelFile)) {
          const artifact = OtlpTraceArtifactSchema.parse(redactor.clean(readJson(otelFile)));
          if (artifact.runId !== attempt.agent.runId || artifact.taskId !== item.caseId) {
            throw Error('benchmark otel trace identity mismatch');
          }
          const enriched = enrichOtlpResourceSpans(artifact.resourceSpans, {
            sessionId,
            environment,
            metadata: traceMetadata,
            ...(missingAnswer?.input ? { rootInputOverride: missingAnswer.input } : {}),
            ...(missingAnswer?.output ? { rootOutputOverride: missingAnswer.output } : {}),
          });
          await sendOtlpResourceSpans(connection, enriched, fetch, redactor);
          traceId = artifact.traceId;
          for (const runScore of artifact.scores) {
            runScores.push({
              id: runScore.id,
              traceId,
              name: runScore.name,
              value: runScore.value,
              dataType: runScore.dataType,
              environment,
              timestamp,
              ...(runScore.comment ? { comment: redactor.clean(runScore.comment).slice(0, 2000) } : {}),
              ...(runScore.metadata ? { metadata: redactor.clean(runScore.metadata) } : {}),
            });
          }
        } else {
          const traceView = missingAnswer ? reviewTestMissingAnswerView(document, redactor.clean(failure)) : document;
          const legacy = langfusePayload(traceView, connection, traceMetadata, sessionId);
          await sendLangfuseTrace(connection, legacy.spans);
          traceId = legacy.traceId;
        }
        tracePublished = true;
        receipt.traceId = traceId;
        const scores = attempt.scores.flatMap(score => score.value === null ? [] : [{
          id: digest([traceId, score.name]).slice(0, 32),
          traceId, name: 'benchmark.' + score.name, value: score.value, dataType: 'NUMERIC',
          comment: redactor.clean(score.reason).slice(0, 2000), environment, timestamp,
          metadata: 'passed' in score ? { ...traceMetadata, passed: score.passed } : {
            ...traceMetadata, passed: score.status === 'pass', score_status: score.status, dimension: score.dimension,
            judge: score.judge, required: score.required, max: score.max, threshold: score.threshold,
            ...('deduction' in score ? { deduction: score.deduction } : {}), references: redactor.clean(score.references),
          },
        }]);
        const reason = attempt.passed ? 'Benchmark checks passed.' : failure;
        const verdicts = trialNumber === undefined
          ? (reviewTests || attempt.status ? verdictScores({ traceId }, 'case', attempt, traceMetadata, reason) : [])
          : verdictScores({ traceId }, 'trial', attempt, traceMetadata, reason);
        if (trialNumber === undefined && reviewTests) verdicts.push(...verdictScores({ sessionId }, 'case', attempt, metadata, reason));
        const allScores = [...runScores, ...scores, ...verdicts];
        await client.writeScores(allScores);
        receipt.scoreCount = allScores.length;
      } catch (error) {
        receipt.error = redactor.clean(error instanceof Error ? error.message : String(error));
      }
    }
    if (tracePublished && ('trials' in item || reviewTests)) result.sessionId = sessionId;
    if (tracePublished && 'trials' in item) {
      try {
        const reason = item.passed ? 'All benchmark trials passed.' : item.error ?? runtimeFailure;
        const scores = verdictScores({ sessionId }, 'case', item, metadata, reason);
        await client.writeScores(scores);
        result.scoreCount = scores.length;
      } catch (error) {
        result.error = redactor.clean(error instanceof Error ? error.message : String(error));
      }
    }
  }
  writeFileSync(join(runDir, 'langfuse.json'), JSON.stringify({ runId: report.runId, cases: results }, null, 2) + '\n');
  if (results.some(result => result.error || result.trials?.some(trial => trial.error))) {
    throw Error('benchmark upload failed; see ' + join(runDir, 'langfuse.json'));
  }
}
