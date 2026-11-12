import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { LangfuseClient } from './langfuse-client.ts';
import { DATASET_PREFIX, caseFromDatasetItem } from './langfuse-suite.ts';
import { EVAL_SCENARIOS, ensureDimensionJudge } from './langfuse-judges.ts';
import { pullAgentPrompts, saveAgentPromptSnapshot } from './agent-prompts.ts';
import { runBatch } from './runner.ts';
import { sha256 } from './dataset.ts';
import { prepareQualitySubject, listAssessments } from './quality.ts';
import { prepareLangfuseEvaluation, syncLangfuseEvaluation, LangfuseBindingSchema, type ExperimentLink } from './langfuse-eval.ts';

export const RemoteConfigSchema = z.object({ scope: z.enum(['dataset', 'all']).default('dataset'), name: z.string().trim().min(1).max(120).optional(),
  repeat: z.number().int().min(1).max(5).default(1), promptLabel: z.string().trim().min(1).max(80).default('prompt-eval'),
  promptVersions: z.record(z.string(), z.number().int().positive()).default({}), caseIds: z.array(z.string().regex(/^[a-z]+-[0-9]{3}$/)).min(1).max(14).optional(),
  queueHuman: z.boolean().default(true), judgeTimeoutMinutes: z.number().int().min(1).max(60).default(20), requestId: z.string().uuid().optional(),
}).strict();
export const RemoteTriggerSchema = z.object({ projectId: z.string().min(1), datasetId: z.string().min(1), datasetName: z.string().min(1),
  payload: z.union([z.string().max(16000), z.record(z.string(), z.unknown())]).optional(),
}).strict();
export type RemoteTrigger = z.infer<typeof RemoteTriggerSchema>;
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;
export function parseRemoteConfig(trigger: RemoteTrigger): RemoteConfig {
  return RemoteConfigSchema.parse(typeof trigger.payload === 'string' ? JSON.parse(trigger.payload) : trigger.payload ?? {});
}
const datasetSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const itemSchema = z.object({ id: z.string(), status: z.string(), version: z.string().optional(), metadata: z.unknown() }).passthrough();
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export interface RemoteProgress { stage: string; report?: string; experiments?: Array<{ name: string; url: string }>; cases?: unknown[]; error?: string; automaticPassed?: boolean; pendingHuman?: number }
export interface RemoteDependencies {
  run?: typeof runBatch;
  prepare?: typeof prepareLangfuseEvaluation;
  sync?: typeof syncLangfuseEvaluation;
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((done, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const stop = () => { clearTimeout(timer); reject(signal?.reason ?? Error('cancelled')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); done(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});

/** One current score per Trial for UI comparison; intermediate sync history must not bias averages. */
export async function publishTrialSummary(client: LangfuseClient, file: string, result: {
  version: string; automatic: { score: number | null; verdict: string };
}) {
  const binding = LangfuseBindingSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const score = (name: string, value: number | string, dataType: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL') => ({
    id: sha256(JSON.stringify(['cwatch.remote.trial.v1', binding.subjectSha256, name])), name, value, dataType,
    traceId: binding.traceId, observationId: binding.observationId, environment: binding.environment,
    comment: '本次 Trial 自动评分汇总。复用原扣分结果；人工确认另见 final.*。',
    metadata: { subjectSha256: binding.subjectSha256, aggregationVersion: result.version, penaltyVersion: 'cwatch.penalty.v5', scope: 'automatic_only' },
  });
  const rows = [score('trial.status', result.automatic.verdict, 'CATEGORICAL'), score('trial.score_available', result.automatic.score === null ? 0 : 1, 'BOOLEAN')];
  if (result.automatic.score !== null) rows.push(score('trial.total', result.automatic.score, 'NUMERIC'));
  await client.writeScores(rows);
}

/** Optional platform adapter. The Agent, Case schema, grader and CI pipeline remain shared/local. */
export async function freezeRemoteDataset(client: LangfuseClient, raw: RemoteTrigger, jobDirectory: string) {
  const trigger = RemoteTriggerSchema.parse(raw), config = parseRemoteConfig(trigger), projectId = await client.projectId();
  if (trigger.projectId !== projectId) throw Error('remote_experiment_project_mismatch');
  const datasets = z.array(datasetSchema).parse(await client.pages('/api/public/v2/datasets'));
  const selected = datasets.find(d => d.id === trigger.datasetId && d.name === trigger.datasetName);
  if (!selected || !EVAL_SCENARIOS.some(s => selected.name === DATASET_PREFIX + s)) throw Error('remote_experiment_dataset_not_allowed');
  const names = config.scope === 'all' ? EVAL_SCENARIOS.map(s => DATASET_PREFIX + s) : [selected.name];
  const cases = [], links = new Map<string, { datasetId: string; datasetName: string; itemId: string; version?: string }>();
  for (const name of names) {
    const dataset = datasets.find(d => d.name === name); if (!dataset) throw Error('remote_dataset_missing: ' + name);
    const items = z.array(itemSchema).parse(await client.pages('/api/public/dataset-items?datasetName=' + encodeURIComponent(name)));
    for (const item of items.filter(item => item.status === 'ACTIVE')) {
      const c = caseFromDatasetItem(item);
      if (config.caseIds && !config.caseIds.includes(c.id)) continue;
      if (c.status === 'retired' || c.split !== 'regression' || c.scope.executionMode !== 'frozen_tools_live_model' || c.input.scenario.driver !== 'runtime') throw Error('remote_case_not_executable: ' + c.id);
      if (links.has(c.id)) throw Error('remote_case_duplicate');
      cases.push(c); links.set(c.id, { datasetId: dataset.id, datasetName: dataset.name, itemId: item.id, version: item.version });
    }
  }
  if (!cases.length || cases.length > 14 || config.caseIds?.some(id => !links.has(id))) throw Error('remote_case_selection_invalid');
  cases.sort((a, b) => a.id.localeCompare(b.id));
  const inputDirectory = join(jobDirectory, 'dataset'); mkdirSync(join(inputDirectory, 'cases'), { recursive: true });
  const entries = cases.map(c => { const file = 'cases/' + c.id + '.r' + c.revision + '.json', body = JSON.stringify(c, null, 2) + '\n';
    writeFileSync(join(inputDirectory, file), body, { flag: 'wx' }); return { id: c.id, revision: c.revision, file, sha256: sha256(body) }; });
  const datasetFile = join(inputDirectory, 'dataset.json');
  save(datasetFile, { schemaVersion: 'cwatch.eval-dataset.v5', id: 'cwatch-langfuse-remote', version: sha256(JSON.stringify(entries)), cases: entries });
  save(join(jobDirectory, 'platform-items.json'), Object.fromEntries(links));
  return { config, projectId, names, cases, links, datasetFile };
}
export async function runRemoteExperiment(client: LangfuseClient, raw: RemoteTrigger, jobDirectory: string,
  progress: (value: RemoteProgress) => void, signal?: AbortSignal, dependencies: RemoteDependencies = {}) {
  const { config, projectId, names, cases, links, datasetFile } = await freezeRemoteDataset(client, raw, jobDirectory);
  const prompts = await pullAgentPrompts(client, { label: config.promptLabel, pins: config.promptVersions });
  const promptFile = saveAgentPromptSnapshot(prompts, jobDirectory);
  save(join(jobDirectory, 'agent-prompts.json'), prompts);
  progress({ stage: 'executing', cases: cases.map(c => ({ caseId: c.id, revision: c.revision } )) });
  const batch = await (dependencies.run ?? runBatch)({ dataset: datasetFile, out: join(jobDirectory, 'runs'), repeat: config.repeat,
    realModel: true, agentPrompts: promptFile, signal });
  const report = batch.path, reportHash = sha256(readFileSync(report));
  const run = JSON.parse(readFileSync(report, 'utf8')) as { results: Array<{ caseId: string; attempt: number; verdict: string; runId: string | null }> };
  if (run.results.some(r => !r.runId || r.verdict === 'invalid')) throw Error('remote_execution_invalid: inspect local report ' + report);
  progress({ stage: 'publishing', report });
  const experiments = new Map<string, { id: string; name: string; url: string }>();
  const name = config.name ?? 'cwatch-' + new Date().toISOString().replaceAll(':', '-') + '-' + reportHash.slice(0, 8);
  for (const datasetName of names) if ([...links.values()].some(link => link.datasetName === datasetName)) {
    // Each trial needs its own experiment: repeated item IDs in one experiment would otherwise collapse.
    for (let attempt = 1; attempt <= config.repeat; attempt++) {
      const id = randomUUID(), experimentName = name + (config.repeat > 1 ? ' · Trial ' + attempt : '');
      experiments.set(datasetName + '#' + attempt, { id, name: experimentName, url: client.config.baseUrl + '/project/' + projectId + '/experiments/results?baseline=' + id });
    }
  }
  save(join(jobDirectory, 'experiments.json'), Object.fromEntries(experiments));
  const dimensions = [...new Set(cases.flatMap(c => c.rubric?.criteria.map(c => c.dimension) ?? []))];
  const rules: Array<{ id: string; enabled: boolean }> = [];
  const bindings: Array<{ caseId: string; attempt: number; path: string; native: boolean; human: boolean }> = [];
  save(join(jobDirectory, 'rules.json'), rules);
  let finished = false;
  try {
    for (const dimension of dimensions) {
      const evaluator = await ensureDimensionJudge(client, dimension);
      const rule = z.object({ id: z.string() }).parse(await client.request('/api/public/v2/evaluation-rules', {
        name: 'cwatch.remote.' + reportHash.slice(0, 20) + '.' + dimension, enabled: true, sampling: 1,
        filter: [{ type: 'stringObject', column: 'metadata', key: 'evalBatchSha256', operator: '=', value: reportHash },
          { type: 'stringObject', column: 'metadata', key: 'evalJudgeDimensions', operator: 'contains', value: '|' + dimension + '|' }],
        evaluatorAssignments: [{ evaluatorId: evaluator.id }],
      })); rules.push({ id: rule.id, enabled: true }); save(join(jobDirectory, 'rules.json'), rules);
    }
    // Allow the worker's rule cache to observe the narrowly scoped rules before ingesting observations.
    if (rules.length) await (dependencies.pause ?? pause)(12000, signal);
    for (const row of run.results) {
      signal?.throwIfAborted();
      const link = links.get(row.caseId)!, experiment = experiments.get(link.datasetName + '#' + row.attempt)!;
      const prepared = await (dependencies.prepare ?? prepareLangfuseEvaluation)(client, { report, caseId: row.caseId, attempt: row.attempt,
        native: true, queueHuman: config.queueHuman, experiment: { id: experiment.id, name: experiment.name, datasetId: link.datasetId, itemId: link.itemId,
          ...(link.version ? { itemVersion: link.version } : {}) } satisfies ExperimentLink });
      bindings.push({ caseId: row.caseId, attempt: row.attempt, path: prepared.path, native: prepared.binding.native.length > 0, human: prepared.binding.humanSlots.length > 0 });
      save(join(jobDirectory, 'bindings.json'), bindings);
    }
    const urls = [...experiments.values()].map(({ name, url }) => ({ name, url }));
    progress({ stage: 'judging', report, experiments: urls });
    const deadline = Date.now() + config.judgeTimeoutMinutes * 60000;
    while (!signal?.aborted && Date.now() < deadline) {
      const status: Array<{ caseId: string; attempt: number; judged: boolean; automaticScore?: number | null; automaticPassed?: boolean;
        status?: string; pending?: string[]; queueUrl?: string | null; error?: string }> = [];
      for (const binding of bindings) {
        try {
          const result = await (dependencies.sync ?? syncLangfuseEvaluation)(client, binding.path, { archive: false });
          const subject = prepareQualitySubject(report, binding.caseId, binding.attempt, client.redactor);
          const llm = listAssessments(subject).filter(record => record.kind === 'llm').at(-1);
          if (!binding.native || llm?.status === 'completed') await publishTrialSummary(client, binding.path, result);
          status.push({ caseId: binding.caseId, attempt: binding.attempt, judged: !binding.native || llm?.status === 'completed',
            automaticScore: result.automatic.score, automaticPassed: result.automatic.passed, status: result.status, pending: result.pending, queueUrl: result.queueUrl });
        } catch (error) {
          status.push({ caseId: binding.caseId, attempt: binding.attempt, judged: false, error: client.redactor.clean(String(error)) });
        }
      }
      save(join(jobDirectory, 'scores.json'), status);
      progress({ stage: 'judging', report, experiments: urls, cases: status });
      if (status.every(row => row.judged)) {
        const pendingHuman = bindings.filter(b => b.human && status.find(row => row.caseId === b.caseId && row.attempt === b.attempt)?.status !== 'completed').length;
        progress({ stage: pendingHuman ? 'awaiting_human' : 'completed', report, experiments: urls, cases: status,
          automaticPassed: status.every(row => row.automaticPassed === true), pendingHuman }); finished = true; break;
      }
      await (dependencies.pause ?? pause)(10000, signal);
    }
    if (!finished) throw Error(signal?.aborted ? 'remote_experiment_cancelled' : 'remote_judge_timeout: original scores and bindings preserved; resume with sync');
  } finally {
    const cleanupErrors = [];
    for (const rule of rules.filter(rule => rule.enabled)) {
      try { await client.request('/api/public/v2/evaluation-rules/' + encodeURIComponent(rule.id), { enabled: false }, {}, 'PATCH'); rule.enabled = false; }
      catch { cleanupErrors.push(rule.id); }
    }
    save(join(jobDirectory, 'rules.json'), rules);
    if (cleanupErrors.length) throw Error('remote_rule_cleanup_required: ' + cleanupErrors.join(','));
  }
  return { report, experiments: [...experiments.values()], bindings };
}

/** Reconcile real human annotations later, without rerunning Agent/Judge or inventing approval. */
export async function syncRemoteExperiment(client: LangfuseClient, jobDirectory: string) {
  const file = join(jobDirectory, 'bindings.json'); if (!existsSync(file)) throw Error('remote_bindings_not_ready');
  const bindings = z.array(z.object({ path: z.string() }).passthrough()).parse(JSON.parse(readFileSync(file, 'utf8')));
  const results = [];
  for (const binding of bindings) {
    const path = resolve(binding.path); if (!path.startsWith(resolve(jobDirectory) + (process.platform === 'win32' ? '\\' : '/'))) throw Error('remote_binding_path_escape');
    const result = await syncLangfuseEvaluation(client, path, { archive: false });
    await publishTrialSummary(client, path, result); results.push(result);
  }
  return results;
}
