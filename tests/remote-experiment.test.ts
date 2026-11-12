import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startExperimentServer, verifyExperimentSignature } from '../scripts/evaluation/experiment-server.ts';
import { RemoteConfigSchema, freezeRemoteDataset, runRemoteExperiment, publishTrialSummary } from '../scripts/evaluation/remote-experiment.ts';
import { LangfuseClient } from '../scripts/evaluation/langfuse-client.ts';
import { evaluationAssets } from '../scripts/evaluation/langfuse-suite.ts';
import { loadDataset } from '../scripts/evaluation/dataset.ts';
import { AGENT_PROMPT_SOURCES } from '@cwatch/shared/agent/core/managed-prompts';

const output = () => { const root = resolve('artifacts/test-remote-experiment'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'case-')); };
const trigger = (extra: Record<string, unknown> = {}) => ({ projectId: 'test-project', datasetId: 'dataset-activation', datasetName: 'cwatch/current/activation', payload: { scope: 'all', ...extra } });
function fixture() {
  const assets = evaluationAssets(), writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const datasets = ['activation', 'core_logic', 'resilience', 'artifact_quality'].map(s => ({ id: 'dataset-' + s, name: 'cwatch/current/' + s }));
  const client = new LangfuseClient({ baseUrl: 'http://localhost:3000', publicKey: 'test-pk', secretKey: 'test-sk', environment: 'test', timeoutMs: 1000 }, async (url, init) => {
    const u = new URL(String(url)), response = (value: unknown) => Response.json(value), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body) writes.push({ path: u.pathname, method: init?.method ?? 'POST', body });
    if (u.pathname === '/api/public/projects') return response({ data: [{ id: 'test-project' }] });
    if (u.pathname === '/api/public/v2/datasets') return response({ data: datasets });
    if (u.pathname === '/api/public/dataset-items') return response({ data: assets.filter(a => a.datasetName === u.searchParams.get('datasetName')).map(a => ({ ...a, status: 'ACTIVE', version: '2026-11-03T00:00:00Z' })) });
    if (u.pathname.startsWith('/api/public/v2/prompts/')) {
      const source = AGENT_PROMPT_SOURCES.find(source => source.name === decodeURIComponent(u.pathname.slice('/api/public/v2/prompts/'.length)))!; assert(source);
      return response({ name: source.name, type: 'text', prompt: readFileSync(source.file, 'utf8'), version: 1, labels: ['prompt-eval'], config: { purpose: 'agent_guidance', key: source.key, sourceFile: source.file } });
    }
    const evaluators = ['outcome', 'trajectory', 'evidence'].map(d => ({ id: 'eval-' + d, name: 'cwatch.judge.' + d, versionId: 'v1-' + d, type: 'llm_as_judge', prompt: 'Evaluate {{packet}}', modelConfig: { provider: 'fixture', model: 'fixture' },
      variableMapping: [{ variable: 'packet', source: 'metadata', jsonPath: '$.evalJudgePacket' }], outputDefinition: { dataType: 'CATEGORICAL', categories: ['fail', 'unknown', 'pass'], shouldAllowMultipleMatches: false } }));
    if (u.pathname === '/api/public/v2/evaluators') return response({ data: evaluators });
    if (u.pathname.startsWith('/api/public/v2/evaluators/')) return response(evaluators.find(e => u.pathname.endsWith(e.id)));
    if (u.pathname === '/api/public/v2/evaluation-rules') return response({ id: 'rule-' + writes.length });
    if (u.pathname.startsWith('/api/public/v2/evaluation-rules/')) return response({ id: u.pathname.split('/').at(-1), enabled: false });
    if (u.pathname === '/api/public/scores') return response({ errors: [] });
    throw Error('Unexpected request: ' + u.pathname);
  });
  return { client, writes };
}

test('UI webhook requires authentication, isolates project/config, acknowledges asynchronously and deduplicates active requests', async () => {
  let release!: () => void, calls = 0; const held = new Promise<void>(done => { release = done; });
  const app = await startExperimentServer({ directory: output(), token: 'f'.repeat(64), projectId: 'test-project', port: 0,
    execute: async (_request, _directory, progress) => { calls++; progress({ stage: 'executing' }); await held; progress({ stage: 'completed', automaticPassed: true }); } });
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'f'.repeat(64) };
  try {
    const body = JSON.stringify(trigger({ requestId: randomUUID() }));
    assert.equal((await fetch(app.origin + '/langfuse/experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(app.origin + '/langfuse/experiments', { method: 'POST', headers, body: JSON.stringify({ ...trigger(), projectId: 'another-project' }) })).status, 403);
    assert.equal((await fetch(app.origin + '/langfuse/experiments', { method: 'POST', headers, body: JSON.stringify(trigger({ command: 'arbitrary shell' })) })).status, 400);
    const first = await fetch(app.origin + '/langfuse/experiments', { method: 'POST', headers, body }); assert.equal(first.status, 202);
    const firstJob = await first.json() as { jobId: string };
    const second = await fetch(app.origin + '/langfuse/experiments', { method: 'POST', headers, body }); assert.equal(second.status, 202);
    assert.equal((await second.json() as { jobId: string }).jobId, firstJob.jobId); assert.equal(calls, 1);
    const status = await (await fetch(app.origin + '/jobs/' + firstJob.jobId)).json();
    assert(!JSON.stringify(status).includes('requestId')); assert(!JSON.stringify(status).includes('fingerprint')); assert(!JSON.stringify(status).includes('Bearer'));
  } finally { release(); await app.close(); }
});

test('signed webhook validation binds exact bytes and rejects tampering or old signatures; config cannot select files or commands', () => {
  const body = Buffer.from('{"a":1}'), secret = 'fixture-secret', now = Date.now(), timestamp = Math.floor(now / 1000);
  const signature = 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
  assert(verifyExperimentSignature(body, signature, secret, now)); assert(!verifyExperimentSignature(Buffer.from('{"a":2}'), signature, secret, now));
  assert(!verifyExperimentSignature(body, signature, secret, now + 301000));
  assert(!RemoteConfigSchema.safeParse({ dataset: '../../private', repeat: 1 }).success);
  assert(!RemoteConfigSchema.safeParse({ scope: 'all', repeat: 100 }).success);
});

test('Dataset webhook freezes all 14 complete Cases or only the selected scene without changing rubric, inputs or CI source files', async () => {
  const f = fixture(), all = await freezeRemoteDataset(f.client, trigger(), output()), loaded = loadDataset(all.datasetFile);
  assert.equal(loaded.entries.length, 14); assert.deepEqual(['activation', 'core_logic', 'resilience', 'artifact_quality'].map(s => [...all.links.values()].filter(l => l.datasetName.endsWith('/' + s)).length), [2, 8, 2, 2]);
  const originals = loadDataset('evals/cwatch/dataset.json').entries;
  for (const entry of loaded.entries) assert.deepEqual(entry.value, originals.find(e => e.value.id === entry.value.id)!.value);
  const selected = await freezeRemoteDataset(f.client, trigger({ scope: 'dataset' }), output()); assert.equal(selected.cases.length, 2);
  await assert.rejects(freezeRemoteDataset(f.client, trigger({ scope: 'dataset', caseIds: ['core-001'] }), output()), /selection_invalid/);
  await assert.rejects(freezeRemoteDataset(f.client, { ...trigger(), datasetId: 'wrong-id' }, output()), /not_allowed/);
  assert.equal(f.writes.length, 0);
});

test('native Judge rules are scoped to one report and are disabled when publication is cancelled', async () => {
  const f = fixture(), root = output();
  const fakeRun = (async () => {
    const report = join(root, 'fixture-report.json');
    const { writeFileSync } = await import('node:fs'); writeFileSync(report, JSON.stringify({ results: [{ caseId: 'core-001', attempt: 1, verdict: 'needs_review', runId: randomUUID() }] }));
    return { path: report };
  }) as unknown as NonNullable<Parameters<typeof runRemoteExperiment>[5]>['run'];
  await assert.rejects(runRemoteExperiment(f.client, trigger(), root, () => {}, undefined, { run: fakeRun, pause: async () => { throw Error('fixture_cancelled'); } }), /fixture_cancelled/);
  const created = f.writes.filter(w => w.method === 'POST' && w.path.endsWith('evaluation-rules'));
  assert.equal(created.length, 3);
  for (const rule of created) {
    const filters = rule.body.filter as Array<{ key: string; value: string }>;
    assert(filters.some(filter => filter.key === 'evalBatchSha256' && /^[a-f0-9]{64}$/.test(filter.value)));
    assert(filters.some(filter => filter.key === 'evalJudgeDimensions'));
  }
  assert.equal(f.writes.filter(w => w.method === 'PATCH' && w.body.enabled === false).length, 3);
});

test('Trial comparison publishes one stable current metric instead of averaging synchronization history', async () => {
  const f = fixture(), file = join(output(), 'binding.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 'cwatch.langfuse-eval-binding.v1', report: 'fixture-report.json', caseId: 'core-001', caseRevision: 2,
    attempt: 1, runId: randomUUID(), subjectSha256: 'a'.repeat(64), baseUrl: 'http://localhost:3000', projectId: 'test-project', traceId: 'b'.repeat(32), observationId: 'c'.repeat(16),
    environment: 'test', createdAt: new Date().toISOString(), traceState: 'uploaded', adopted: false, native: [], humanSlots: [], queueId: null, queueItemId: null }));
  await publishTrialSummary(f.client, file, { version: 'v1', automatic: { score: 100, verdict: 'pass' } });
  await publishTrialSummary(f.client, file, { version: 'v2', automatic: { score: 90, verdict: 'pass' } });
  const batches = f.writes.filter(w => w.path === '/api/public/scores').map(w => w.body as unknown as Array<{ id: string; name: string; value: number; metadata: { aggregationVersion: string } }>);
  assert.equal(batches.length, 2); assert.deepEqual(batches[0].map(s => s.id), batches[1].map(s => s.id));
  assert.equal(batches[1].find(s => s.name === 'trial.total')!.value, 90);
  assert.equal(batches[1].find(s => s.name === 'trial.total')!.metadata.aggregationVersion, 'v2');
});
