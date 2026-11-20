import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { canonical } from '@cwatch/core/types';

export const suites = ['smoke', 'regression'] as const;
const suiteSchema = z.enum(suites);
const safeId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const fixture = z.string().regex(/^[a-z][a-z0-9-]{0,63}\.txt$/);
const instruction = z.string().trim().min(1).max(4000);
const check = { id: safeId, dimension: z.enum(['result', 'process', 'evidence', 'safety']), required: z.boolean() };
const tool = z.strictObject({ name: z.string().min(1), arguments: z.record(z.string(), z.json()).optional() });
const stage = z.enum(['request', 'execution']);
const rule = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('json_equals'), value: z.record(z.string(), z.json()) }),
  z.strictObject({ type: z.literal('tool_succeeded'), tool, allowFailedAttempts: z.boolean().optional() }),
  z.strictObject({ type: z.literal('tool_policy'), stage, policy: z.enum(['allow', 'deny']), tools: z.array(tool) }),
  z.strictObject({ type: z.literal('tool_dependency'), before: tool, after: tool, afterStage: stage }),
  z.strictObject({ type: z.literal('max_characters'), limit: z.int().positive() }),
]);
const criterion = z.discriminatedUnion('judge', [
  z.strictObject({ ...check, judge: z.literal('code'), rule }),
  z.strictObject({ ...check, judge: z.literal('llm'), must: z.array(instruction).min(1),
    fatal: z.array(instruction).optional(), minor: z.array(instruction).optional(),
    equivalents: z.array(instruction).optional(), evidence: z.array(instruction).optional(), useTrace: z.boolean().optional() }),
]);
export const itemExpected = z.strictObject({ criteria: z.array(criterion).min(1).refine(items =>
  new Set(items.map(item => item.id)).size === items.length && items.some(item => item.required),
  'criteria require unique IDs and at least one required check') });
const atLeastOneTag = z.array(suiteSchema).min(1).max(2).refine(tags => new Set(tags).size === tags.length);
export const reviewProfile = z.literal('competitor-review');
export const itemInput = z.strictObject({ instruction, fixture, profile: reviewProfile.optional() });
const origin = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sop'), reference: instruction, stage: z.enum(['main', 'branch', 'stop', 'boundary', 'handoff']) }),
  z.strictObject({ type: z.literal('bad-case'), reference: instruction, revision: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    runId: z.uuid(), failureMode: instruction }),
]);
export const itemMetadata = z.strictObject({
  caseId: safeId,
  category: safeId,
  tags: atLeastOneTag,
  dataClass: z.literal('synthetic'),
  origin: origin.optional(),
});
export const benchmarkCase = z.strictObject({
  id: safeId, itemId: z.string().min(1), ...itemMetadata.omit({ caseId: true }).shape,
  input: instruction, fixture, profile: reviewProfile.optional(), expected: itemExpected,
}).refine(value => (!value.profile || value.origin)
  && (value.origin?.type !== 'bad-case' || value.tags.includes('regression')), 'invalid case provenance or suite');
export type BenchmarkCase = z.infer<typeof benchmarkCase>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const datasetIdentity = z.strictObject({ id: z.string().min(1), name: z.string().min(1) });
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(2),
  dataset: datasetIdentity.extend({ revision: sha256 }),
  suite: suiteSchema,
  sha256,
  cases: z.array(benchmarkCase).min(1),
});
export const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;
export const digest = (input: unknown) => createHash('sha256').update(canonical(input)).digest('hex');
export const compareCases = (a: BenchmarkCase, b: BenchmarkCase) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function fixturePath(name: string) {
  const directory = realpathSync('evals/fixtures');
  const source = realpathSync(resolve(directory, fixture.parse(name)));
  if (dirname(source) !== directory) throw Error('fixture must resolve inside evals/fixtures');
  return source;
}

export function makeSnapshots(dataset: z.infer<typeof datasetIdentity>, entries: BenchmarkCase[]) {
  const cases = [...entries].sort(compareCases);
  const itemIds = new Set<string>();
  for (const [index, item] of cases.entries()) {
    if (item.id === cases[index - 1]?.id || itemIds.has(item.itemId)) throw Error('duplicate case or item: ' + item.id);
    itemIds.add(item.itemId);
    fixturePath(item.fixture);
  }
  const identity = { ...dataset, revision: digest(cases) };
  return suites.map(suite => {
    const members = cases.filter(item => item.tags.includes(suite));
    return snapshotSchema.parse({ schemaVersion: 2, dataset: identity, suite, sha256: digest(members), cases: members });
  });
}

export function loadSnapshots(refresh = false) {
  const snapshots = suites.map(suite => {
    const snapshot = snapshotSchema.parse(readJson('evals/datasets/' + suite + '.json'));
    if (snapshot.suite !== suite || (!refresh && snapshot.sha256 !== digest(snapshot.cases))) throw Error('invalid snapshot checksum or suite: ' + suite);
    if (snapshot.cases.some(item => !item.tags.includes(suite))) throw Error('unexpected suite membership: ' + suite);
    return snapshot;
  });
  const [smoke, regression] = snapshots;
  if (smoke.dataset.id !== regression.dataset.id || smoke.dataset.name !== regression.dataset.name
    || (!refresh && smoke.dataset.revision !== regression.dataset.revision)) throw Error('dataset snapshot revisions differ; run eval:sync');
  const cases = new Map<string, BenchmarkCase>();
  const seenItems = new Map<string, string>();
  for (const snapshot of snapshots) {
    const seen = new Set<string>();
    for (const item of snapshot.cases) {
      const previous = cases.get(item.id);
      if (seen.has(item.id) || (previous && canonical(previous) !== canonical(item))
        || (seenItems.has(item.itemId) && seenItems.get(item.itemId) !== item.id)) throw Error('duplicate or conflicting benchmark case: ' + item.id);
      seen.add(item.id);
      cases.set(item.id, item);
      seenItems.set(item.itemId, item.id);
    }
  }
  const all = [...cases.values()].sort(compareCases);
  const rebuilt = makeSnapshots({ id: smoke.dataset.id, name: smoke.dataset.name }, all);
  for (const [index, snapshot] of snapshots.entries()) {
    if (rebuilt[index].cases.length !== snapshot.cases.length) throw Error('incomplete benchmark suite: ' + snapshot.suite);
    if (!refresh && rebuilt[index].sha256 !== snapshot.sha256) throw Error('invalid suite checksum: ' + snapshot.suite);
  }
  if (!refresh && digest(all) !== smoke.dataset.revision) throw Error('invalid dataset revision checksum');
  return { snapshots: refresh ? rebuilt : snapshots, cases: all };
}
