import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { canonical } from '@cwatch/core/types';

export const suites = ['smoke', 'regression'] as const;
const suiteSchema = z.enum(suites);
const safeId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const fixture = z.string().regex(/^[a-z][a-z0-9-]{0,63}\.txt$/);
const metric = z.enum(['tool_correctness', 'json_equals', 'evidence_review', 'grounded_answer', 'missing_information']);
const instruction = z.string().trim().min(1).max(4000);
const atLeastOneTag = z.array(suiteSchema).min(1).max(2).refine(tags => new Set(tags).size === tags.length);
export const reviewProfile = z.literal('competitor-review');
const legacyInput = z.strictObject({ instruction, fixture });
const reviewInput = legacyInput.extend({ profile: reviewProfile });
export const itemInput = z.union([legacyInput, reviewInput]);
const readExpected = z.strictObject({ tool: z.literal('read'), arguments: z.strictObject({ path: fixture }), answer: instruction });
const reviewExpected = z.strictObject({
  toolPolicy: z.enum(['review-checklist', 'no-tools']),
  answer: instruction,
  json: z.strictObject({ claim: instruction, material: instruction }).optional(),
});
export const itemExpected = z.union([readExpected, reviewExpected]);
const origin = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sop'), reference: instruction, stage: z.enum(['main', 'branch', 'stop', 'boundary', 'handoff']) }),
  z.strictObject({ type: z.literal('bad-case'), reference: instruction, runId: z.uuid(), failureMode: instruction }),
]);
export const itemMetadata = z.strictObject({
  caseId: safeId,
  category: safeId,
  metrics: z.array(metric).min(1).max(3).refine(values => new Set(values).size === values.length && values.includes('tool_correctness')),
  tags: atLeastOneTag,
  dataClass: z.literal('synthetic'),
  origin: origin.optional(),
});
const fields = {
  id: safeId, itemId: z.string().min(1), ...itemMetadata.omit({ caseId: true }).shape,
  input: instruction, fixture,
};
export const benchmarkCase = z.union([
  z.strictObject({ ...fields, origin: z.never().optional(), expected: readExpected })
    .refine(value => value.fixture === value.expected.arguments.path
      && value.metrics.every(metric => ['tool_correctness', 'grounded_answer', 'missing_information'].includes(metric)), 'invalid file-reading case'),
  z.strictObject({ ...fields, origin, profile: reviewProfile, expected: reviewExpected })
    .refine(value => value.metrics.includes('json_equals') === Boolean(value.expected.json)
      && value.metrics.every(metric => ['tool_correctness', 'json_equals', 'evidence_review'].includes(metric))
      && (value.origin.type !== 'bad-case' || value.tags.includes('regression')), 'invalid review case scoring or suite'),
]);
export type BenchmarkCase = z.infer<typeof benchmarkCase>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dataset: z.strictObject({ id: z.string().min(1), name: z.string().min(1), revision: sha256 }),
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

export function loadSnapshots() {
  const snapshots = suites.map(suite => {
    const snapshot = snapshotSchema.parse(readJson('evals/datasets/' + suite + '.json'));
    if (snapshot.suite !== suite || snapshot.sha256 !== digest(snapshot.cases)) throw Error('invalid snapshot checksum or suite: ' + suite);
    if (snapshot.cases.some(item => !item.tags.includes(suite))) throw Error('unexpected suite membership: ' + suite);
    return snapshot;
  });
  const [smoke, regression] = snapshots;
  if (canonical(smoke.dataset) !== canonical(regression.dataset)) throw Error('dataset snapshot revisions differ; run eval:sync');
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
      fixturePath(item.fixture);
    }
  }
  const all = [...cases.values()].sort(compareCases);
  for (const snapshot of snapshots) {
    if (digest(all.filter(item => item.tags.includes(snapshot.suite))) !== snapshot.sha256) throw Error('incomplete benchmark suite: ' + snapshot.suite);
  }
  if (digest(all) !== smoke.dataset.revision) throw Error('invalid dataset revision checksum');
  return { snapshots, cases: all };
}
