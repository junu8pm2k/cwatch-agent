import fs from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaseSchema, DatasetSchema } from './contracts.ts';
import { loadDataset, readStructured, sha256, within } from './dataset.ts';

export interface ReviewOptions {
  dataset: string;
  caseIds: string[];
  reviewer: string;
  dryRun?: boolean;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const versionName = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw Error('unsupported_review_version: use letters, digits, dots, underscores or hyphens');
  }
  return value;
};
function nextVersion(current: string): string {
  versionName(current);
  const match = /^(.*\.)(\d+)$/.exec(current);
  if (!match) return versionName(current + '.1');
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) throw Error('dataset_version_overflow');
  return versionName(match[1] + (revision + 1));
}

/** Atomic for one file. Multi-file failures are rolled back; this is not a crash-safe database transaction. */
function replaceFile(path: string, bytes: Buffer): void {
  const temp = join(dirname(path), '.' + basename(path) + '.review-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, path);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

interface FileChange { path: string; before: Buffer; after: Buffer }

function rejectLinkedPath(path: string): void {
  let current = resolve(path);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('review_link_not_supported: ' + current);
    const parent = dirname(current);if (parent === current) break;current = parent;
  }
}

function planReview(options: ReviewOptions) {
  const reviewer = options.reviewer.trim();
  if (!reviewer || reviewer.length > 100 || /[\x00-\x1f\x7f]/.test(reviewer)) throw Error('provide_valid_reviewer');
  if (!options.caseIds.length) throw Error('provide_at_least_one_case');
  if (new Set(options.caseIds).size !== options.caseIds.length) throw Error('duplicate_review_case');
  const data = loadDataset(options.dataset);
  const manifestBefore = fs.readFileSync(data.file);
  if (sha256(manifestBefore) !== data.sha256) throw Error('review_input_changed: ' + data.file);
  const selected = options.caseIds.map(id => {
    const entry = data.entries.find(entry => entry.value.id === id);
    if (!entry) throw Error('review_case_not_found: ' + id);
    if (entry.value.status !== 'needs_review') throw Error('review_case_not_pending: ' + id);
    if (entry.value.split !== 'regression') throw Error('holdout_review_requires_custodian_workflow');
    return entry;
  });
  const base = dirname(data.file), version = nextVersion(data.manifest.version), reviewedAt = new Date().toISOString();
  for (const entry of data.manifest.cases) rejectLinkedPath(resolve(base, entry.file));
  const manifest = structuredClone(data.manifest), changes: FileChange[] = [];
  const cases = selected.map(entry => {
    const before = fs.readFileSync(entry.file);
    if (sha256(before) !== entry.sha256) throw Error('review_input_changed: ' + entry.file);
    // Keep original fields rather than serializing schema defaults into the material.
    const next = readStructured(entry.file) as Record<string, unknown> & { oracle: Record<string, unknown> };
    next.revision = entry.value.revision + 1;
    next.status = 'approved';
    next.oracle.review = { by: reviewer, kind: 'human', at: reviewedAt };
    CaseSchema.parse(next);
    const after = json(next), updated = manifest.cases.find(item => item.id === entry.value.id)!;
    updated.revision = Number(next.revision);updated.sha256 = sha256(after);
    changes.push({ path: entry.file, before, after });
    return { id: entry.value.id, revisionBefore: entry.value.revision, revisionAfter: Number(next.revision), sha256: updated.sha256 };
  });
  const catalogPath = join(base, 'catalog.json');
  let catalogChange: FileChange | undefined;
  if (fs.existsSync(catalogPath)) {
    if (fs.lstatSync(catalogPath).isSymbolicLink()) throw Error('review_catalog_link_not_supported');
    const before = fs.readFileSync(catalogPath), catalog = JSON.parse(before.toString('utf8'));
    if (catalog.datasetVersion !== data.manifest.version) throw Error('review_catalog_version_mismatch');
    catalog.datasetVersion = version;
    catalogChange = { path: catalogPath, before, after: json(catalog) };
    changes.push(catalogChange);
  }
  manifest.version = version;DatasetSchema.parse(manifest);
  changes.push({ path: data.file, before: manifestBefore, after: json(manifest) });
  const snapshot = join(base, '..', 'history', basename(base), versionName(data.manifest.version));
  if (within(base, snapshot)) throw Error('review_history_must_be_outside_case_directory');
  return { data, base, changes, catalogChange, snapshot, summary: {
    action: 'approve', dryRun: Boolean(options.dryRun), dataset: data.file, versionBefore: data.manifest.version,
    versionAfter: version, reviewer, reviewedAt, snapshot, cases,
  } };
}

function saveSnapshot(plan: ReturnType<typeof planReview>): void {
  rejectLinkedPath(plan.snapshot);
  const manifest = fs.readFileSync(plan.data.file);
  if (sha256(manifest) !== plan.data.sha256) throw Error('review_input_changed: ' + plan.data.file);
  const originals = [{ name: basename(plan.data.file), bytes: manifest },
    ...plan.data.entries.map(entry => {
      const bytes = fs.readFileSync(entry.file);
      if (sha256(bytes) !== entry.sha256) throw Error('review_input_changed: ' + entry.file);
      return { name: relative(plan.base, entry.file), bytes };
    }),
    ...(plan.catalogChange ? [{ name: 'catalog.json', bytes: plan.catalogChange.before }] : [])];
  // Reuse an existing, identical snapshot; never overwrite conflicting history.
  for (const original of originals) {
    const path = resolve(plan.snapshot, original.name);
    if (!within(resolve(plan.snapshot), path)) throw Error('review_history_path_escape');
    rejectLinkedPath(path);
    if (fs.existsSync(path) && !fs.readFileSync(path).equals(original.bytes)) throw Error('review_history_conflict: ' + path);
  }
  fs.mkdirSync(plan.snapshot, { recursive: true });
  for (const original of originals) {
    const path = join(plan.snapshot, original.name);
    fs.mkdirSync(dirname(path), { recursive: true });
    if (!fs.existsSync(path)) fs.writeFileSync(path, original.bytes, { flag: 'wx' });
  }
}

/** The caller explicitly declares that a human reviewed these Cases; this tool cannot authenticate their identity. */
export function approveCases(options: ReviewOptions) {
  if (options.dryRun) return planReview(options).summary;
  const dataset = fs.realpathSync(options.dataset), lock = join(dirname(dataset), '.review.lock');
  let descriptor: number;
  try { descriptor = fs.openSync(lock, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('review_locked: another review may be active; inspect .review.lock');
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, json({ pid: process.pid, startedAt: new Date().toISOString() }));
    const plan = planReview(options);
    saveSnapshot(plan);
    for (const change of plan.changes) {
      if (!fs.readFileSync(change.path).equals(change.before)) throw Error('review_input_changed: ' + change.path);
    }
    const written: FileChange[] = [];
    try {
      for (const change of plan.changes) { replaceFile(change.path, change.after);written.push(change); }
      const checked = loadDataset(plan.data.file);
      for (const item of plan.summary.cases) {
        const c = checked.entries.find(entry => entry.value.id === item.id)!;
        if (c.sha256 !== item.sha256 || c.value.status !== 'approved') throw Error('review_post_validation_failed');
      }
      return plan.summary;
    } catch (error) {
      const failures: string[] = [];
      for (const change of written.reverse()) {
        try { replaceFile(change.path, change.before); } catch { failures.push(change.path); }
      }
      if (failures.length) throw Error('review_rollback_incomplete: restore from ' + plan.snapshot + '; files: ' + failures.join(', '));
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);fs.unlinkSync(lock);
  }
}
