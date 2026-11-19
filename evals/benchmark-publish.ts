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
  dataset: z.object({ name: z.string(), revision: z.string() }),
  judge: z.object({ version: z.string() }),
  cases: z.array(z.object({
    caseId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    itemId: z.string().min(1),
    agent: z.object({ runId }).optional(),
    scores: z.array(z.object({
      name: z.string().regex(/^[a-z_]+$/), value: z.number().min(0).max(1), reason: z.string(), passed: z.boolean(),
    })),
  })),
});

export async function publishBenchmark(runDir: string, expectedRunId: string) {
  const connection = readLangfuseConfig();
  if (!connection) throw Error('benchmark upload requires Langfuse project keys');
  const report = resultSchema.parse(readJson(join(runDir, 'report.json')));
  if (report.runId !== expectedRunId) throw Error('benchmark report run identity mismatch');
  const timestamp = new Date(report.startedAt).toISOString();
  const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  const client = new LangfuseClient(connection, fetch, redactor);
  const results: Array<{ caseId: string; traceId?: string; scoreCount?: number; error?: string }> = [];
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
      const { traceId, spans } = langfusePayload(document, connection, metadata);
      await sendLangfuseTrace(connection, spans);
      result.traceId = traceId;
      await client.writeScores(item.scores.map(score => ({
        id: digest([traceId, score.name]).slice(0, 32),
        traceId, name: 'benchmark.' + score.name, value: score.value, dataType: 'NUMERIC',
        comment: redactor.clean(score.reason).slice(0, 2000), environment: connection.environment, timestamp,
        metadata: { ...metadata, passed: score.passed },
      })));
      result.scoreCount = item.scores.length;
    } catch (error) {
      result.error = redactor.clean(error instanceof Error ? error.message : String(error));
    }
  }
  writeFileSync(join(runDir, 'langfuse.json'), JSON.stringify({ runId: report.runId, cases: results }, null, 2) + '\n');
  if (results.some(result => result.error)) throw Error('benchmark upload failed; see ' + join(runDir, 'langfuse.json'));
}
