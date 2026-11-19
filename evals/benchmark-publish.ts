import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { langfusePayload, sendLangfuseTrace } from '@cwatch/shared/sessions/langfuse';
import type { StructuredTrace } from '@cwatch/shared/sessions/structured-trace';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from '../scripts/langfuse-client.ts';
import { digest, readJson } from './benchmark-contract.ts';

const runId = z.string().regex(/^[0-9a-zA-Z_-]{1,80}$/);
const resultSchema = z.object({
  runId: z.uuid(),
  commitSha: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  suite: z.string().optional(),
  dataset: z.object({ name: z.string(), revision: z.string() }),
  judge: z.object({ version: z.string() }),
  cases: z.array(z.object({
    caseId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    itemId: z.string().min(1),
    passed: z.boolean(),
    error: z.string().optional(),
    agent: z.object({ runId, output: z.string().optional() }).optional(),
    scores: z.array(z.object({
      name: z.string().regex(/^[a-z_]+$/), value: z.number().min(0).max(1), reason: z.string(), passed: z.boolean(),
    })),
  })),
});

export function reviewTestMissingAnswerView(document: StructuredTrace, reason: string): StructuredTrace {
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
    ...document,
    steps: document.steps.map(step => step.kind === 'run' ? {
      ...step,
      input: task.success ? [{ role: 'user', content: task.data.instruction }] : step.input,
      output: [{ role: 'assistant', name: 'Cwatch 评测说明', content: details.join('\n\n') }],
    } : step),
  };
}

export async function publishBenchmark(runDir: string, expectedRunId: string) {
  const connection = readLangfuseConfig();
  if (!connection) throw Error('benchmark upload requires Langfuse project keys');
  const report = resultSchema.parse(readJson(join(runDir, 'report.json')));
  if (report.runId !== expectedRunId) throw Error('benchmark report run identity mismatch');
  const reviewTests = report.suite === 'review-tests';
  const timestamp = new Date(report.startedAt).toISOString();
  const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  const client = new LangfuseClient(connection, fetch, redactor);
  const results: Array<{ caseId: string; sessionId?: string; traceId?: string; scoreCount?: number; error?: string }> = [];
  for (const item of report.cases) {
    const result: typeof results[number] = { caseId: item.caseId };
    results.push(result);
    if (!item.agent) continue; // A failed launch has no Agent trace.
    try {
      const document = redactor.clean(readJson(join(runDir, 'cases', item.caseId, 'trace.json'))) as StructuredTrace;
      if (document.runId !== item.agent.runId || document.taskId !== item.caseId) throw Error('benchmark trace identity mismatch');
      const metadata = {
        agent_name: 'cwatch', case_id: item.caseId, run_id: report.runId, commit_sha: report.commitSha,
        judge_version: report.judge.version, dataset_name: report.dataset.name,
        dataset_revision: report.dataset.revision, dataset_item_id: item.itemId,
      };
      // Keep each local test run's Session verdict independent of reruns of the same case.
      const sessionId = reviewTests ? item.caseId + '-' + report.runId : document.taskId;
      const runtimeError = document.steps.find(step => step.kind === 'run')?.error?.message;
      const failure = runtimeError ?? item.error ?? 'The case failed. Inspect the trace and metric scores.';
      const traceView = reviewTests && !item.passed && item.agent.output?.trim() === ''
        ? reviewTestMissingAnswerView(document, redactor.clean(failure))
        : document;
      const { traceId, spans } = langfusePayload(traceView, connection, metadata, sessionId);
      await sendLangfuseTrace(connection, spans);
      result.traceId = traceId;
      const scores = item.scores.map(score => ({
        id: digest([traceId, score.name]).slice(0, 32),
        traceId, name: 'benchmark.' + score.name, value: score.value, dataType: 'NUMERIC',
        comment: redactor.clean(score.reason).slice(0, 2000), environment: connection.environment, timestamp,
        metadata: { ...metadata, passed: score.passed },
      }));
      const verdictScores = [];
      if (reviewTests) {
        result.sessionId = sessionId;
        const reason = item.passed ? 'All required benchmark checks passed.' : failure;
        const verdict = {
          name: 'benchmark.case_passed', value: Number(item.passed), dataType: 'BOOLEAN',
          comment: redactor.clean(reason).split(/\r?\n/, 1)[0].slice(0, 2000),
          environment: connection.environment, timestamp, metadata: { ...metadata, passed: item.passed },
        };
        verdictScores.push(
          { ...verdict, id: digest([traceId, verdict.name]).slice(0, 32), traceId },
          { ...verdict, id: digest([sessionId, verdict.name]).slice(0, 32), sessionId },
        );
      }
      const publishedScores = [...scores, ...verdictScores];
      await client.writeScores(publishedScores);
      result.scoreCount = publishedScores.length;
    } catch (error) {
      result.error = redactor.clean(error instanceof Error ? error.message : String(error));
    }
  }
  writeFileSync(join(runDir, 'langfuse.json'), JSON.stringify({ runId: report.runId, cases: results }, null, 2) + '\n');
  if (results.some(result => result.error)) throw Error('benchmark upload failed; see ' + join(runDir, 'langfuse.json'));
}
