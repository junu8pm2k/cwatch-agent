import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from '../scripts/langfuse-client.ts';
import { benchmarkCase, datasetIdentity, itemExpected, itemInput, itemMetadata, loadSnapshots, makeSnapshots } from './benchmark-contract.ts';

const remoteDataset = datasetIdentity.loose();
const remoteItem = z.object({
  id: z.string().min(1), datasetId: z.string().min(1), datasetName: z.string().min(1),
  status: z.enum(['ACTIVE', 'ARCHIVED']), input: z.unknown(), expectedOutput: z.unknown(), metadata: z.unknown(),
});
const pageSchema = z.object({
  data: z.array(remoteItem),
  meta: z.object({ page: z.int().positive(), limit: z.int().positive(), totalPages: z.int().nonnegative(), totalItems: z.int().nonnegative() }),
});
const secretValues = Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? '');
const redactor = new Redactor(secretValues);
const redact = (error: unknown) => redactor.clean(error instanceof Error ? error.message : String(error));

async function fetchItems(client: LangfuseClient, dataset: z.infer<typeof datasetIdentity>, version: string) {
  const limit = 100;
  const items = new Map<string, z.infer<typeof remoteItem>>();
  let totalItems: number | undefined;
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({ datasetName: dataset.name, version, page: String(page), limit: String(limit) });
    const result = pageSchema.parse(await client.request('/api/public/dataset-items?' + query));
    totalItems ??= result.meta.totalItems;
    const expectedPages = Math.ceil(totalItems / limit);
    if (result.meta.page !== page || result.meta.limit !== limit || totalItems !== result.meta.totalItems
      || result.meta.totalPages !== expectedPages || result.data.length !== Math.max(0, Math.min(limit, totalItems - (page - 1) * limit))) {
      throw Error('incomplete Langfuse pagination at page ' + page);
    }
    for (const item of result.data) {
      if (item.datasetId !== dataset.id || item.datasetName !== dataset.name || items.has(item.id)) throw Error('unexpected dataset or duplicate Langfuse item');
      items.set(item.id, item);
    }
    if (page >= expectedPages) return [...items.values()];
  }
  throw Error('Langfuse dataset pagination limit exceeded');
}

async function importDataset(datasetName: string, version: string) {
  const connection = readLangfuseConfig();
  if (!connection) throw Error('eval:sync requires Langfuse project keys');
  const client = new LangfuseClient(connection);
  const { id, name } = remoteDataset.parse(await client.request('/api/public/v2/datasets/' + encodeURIComponent(datasetName)));
  const dataset = { id, name };
  if (dataset.name !== datasetName) throw Error('requested Langfuse dataset name differs from API response');
  const cases = (await fetchItems(client, dataset, version)).filter(item => item.status === 'ACTIVE').map(item => {
    try {
      const { caseId, ...metadata } = itemMetadata.parse(item.metadata);
      const { instruction, ...execution } = itemInput.parse(item.input);
      const value = benchmarkCase.parse({ id: caseId, itemId: item.id, ...metadata, ...execution, input: instruction, expected: itemExpected.parse(item.expectedOutput) });
      const serialized = JSON.stringify(value);
      if (redactor.clean(serialized) !== serialized) throw Error('sensitive value detected in snapshot candidate');
      return value;
    } catch (error) {
      throw Error('invalid Langfuse item ' + item.id + ': ' + redact(error));
    }
  });
  return makeSnapshots(dataset, cases);
}

async function writeSnapshots(snapshots: ReturnType<typeof makeSnapshots>, version: string | null) {
  const audit = { syncedAt: new Date().toISOString(), asOf: version, dataset: snapshots[0].dataset,
    suites: snapshots.map(({ suite, sha256 }) => ({ suite, sha256 })) };
  const outputs = [
    ...snapshots.map(snapshot => ({ path: 'evals/datasets/' + snapshot.suite + '.json', value: snapshot })),
    { path: 'artifacts/benchmark/sync.json', value: audit },
  ].map(output => ({ ...output, temp: output.path + '.' + randomUUID() + '.tmp' }));
  try {
    for (const { temp, value } of outputs) await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    for (const { temp, path } of outputs) await rename(temp, path);
  } finally {
    await Promise.all(outputs.map(({ temp }) => rm(temp, { force: true })));
  }
  console.log(JSON.stringify(audit));
}

async function main() {
  const { values } = parseArgs({ options: { dataset: { type: 'string' }, version: { type: 'string' } } });
  if (values.version && !values.dataset) throw Error('--version requires --dataset');
  const version = values.dataset ? z.iso.datetime().parse(values.version ?? new Date().toISOString()) : null;
  if (version && Date.parse(version) > Date.now()) throw Error('dataset version cannot be in the future');
  await mkdir('evals/datasets', { recursive: true });
  await mkdir('artifacts/benchmark', { recursive: true });
  const lockPath = 'artifacts/benchmark/sync.lock';
  const lock = await open(lockPath, 'wx');
  try {
    const snapshots = values.dataset && version ? await importDataset(values.dataset, version) : loadSnapshots(true).snapshots;
    await writeSnapshots(snapshots, version);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

main().catch(error => { console.error(redact(error)); process.exitCode = 1; });
