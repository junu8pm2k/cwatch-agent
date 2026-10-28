import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { approveCases } from '../scripts/evaluation/review.ts';
import { loadDataset, sha256 } from '../scripts/evaluation/dataset.ts';
import { check, store } from './harness.ts';

const reviewer = 'unit-fixture-not-a-real-reviewer';
function reviewFixture() {
  const data = store(), source = loadDataset('evals/regression/dataset.json');
  const entries = source.entries.slice(0, 2).map(entry => {
    const c = structuredClone(entry.value);c.status = 'needs_review';c.oracle.review = null;
    const file = 'cases/' + c.id + '.json', bytes = JSON.stringify(c, null, 2) + '\n';
    data.text('model-diagnostic/' + file, bytes);
    return { id: c.id, revision: c.revision, file, sha256: sha256(bytes) };
  });
  const manifest = { schemaVersion: 'cwatch.eval-dataset.v1', id: 'review-unit-fixture', version: '2026-10-25.4', cases: entries };
  data.write('model-diagnostic/dataset.json', manifest);
  data.write('model-diagnostic/catalog.json', { datasetVersion: manifest.version, groups: [{ caseIds: entries.map(e => e.id) }] });
  const dataset = data.path('model-diagnostic/dataset.json'), catalog = data.path('model-diagnostic/catalog.json');
  const paths = [dataset, catalog, ...entries.map(e => data.path('model-diagnostic/' + e.file))];
  const before = paths.map(path => ({ path, bytes: fs.readFileSync(path) }));
  return { data, dataset, catalog, ids: entries.map(e => e.id), entries, before,
    options: { dataset, caseIds: [entries[0].id], reviewer },
    assertUnchanged: () => { for (const item of before) assert.deepEqual(fs.readFileSync(item.path), item.bytes, item.path); },
    lock: data.path('model-diagnostic/.review.lock') };
}

check('contract', 'Review preview changes no files, approval records, history or locks', () => {
  const f = reviewFixture(), preview = approveCases({ ...f.options, dryRun: true });
  assert.equal(preview.dryRun, true);assert.equal(preview.versionAfter, '2026-10-25.5');
  assert.equal(preview.cases[0].revisionAfter, f.entries[0].revision + 1);
  f.assertUnchanged();assert.equal(fs.existsSync(preview.snapshot), false);assert.equal(fs.existsSync(f.lock), false);
});

check('semantic', 'An explicit review updates only selected metadata, hashes and catalog and archives the exact old dataset', () => {
  const f = reviewFixture(), old = loadDataset(f.dataset), result = approveCases(f.options), current = loadDataset(f.dataset);
  const selected = current.entries.find(e => e.value.id === f.ids[0])!, unselected = current.entries.find(e => e.value.id === f.ids[1])!;
  assert.equal(selected.value.status, 'approved');assert.equal(selected.value.oracle.review?.by, reviewer);
  assert.equal(selected.value.oracle.review?.kind, 'human');assert.ok(Number.isFinite(Date.parse(selected.value.oracle.review!.at)));
  assert.equal(selected.value.revision, f.entries[0].revision + 1);
  assert.deepEqual(selected.value.input, old.entries[0].value.input);
  assert.deepEqual(selected.value.scoring, old.entries[0].value.scoring);
  assert.equal(unselected.value.status, 'needs_review');assert.equal(unselected.sha256, old.entries[1].sha256);
  assert.equal(current.manifest.version, '2026-10-25.5');
  assert.equal(JSON.parse(fs.readFileSync(f.catalog, 'utf8')).datasetVersion, current.manifest.version);
  const archived = loadDataset(join(result.snapshot, 'dataset.json'));
  assert.equal(archived.sha256, old.sha256);assert.deepEqual(archived.entries.map(e => e.sha256), old.entries.map(e => e.sha256));
  assert.equal(fs.existsSync(f.lock), false);
});

check('contract', 'Review rejects missing reviewers, duplicate selection and unknown cases before changing the dataset', () => {
  const f = reviewFixture();
  assert.throws(() => approveCases({ ...f.options, reviewer: '  ' }), /provide_valid_reviewer/);
  assert.throws(() => approveCases({ ...f.options, caseIds: [] }), /provide_at_least_one_case/);
  assert.throws(() => approveCases({ ...f.options, caseIds: [f.ids[0], f.ids[0]] }), /duplicate_review_case/);
  assert.throws(() => approveCases({ ...f.options, caseIds: [f.ids[0], 'missing-case'] }), /review_case_not_found/);
  f.assertUnchanged();assert.equal(fs.existsSync(f.lock), false);
});

check('contract', 'A review cannot silently approve a case edited outside its frozen manifest hash', () => {
  const f = reviewFixture(), target = f.before[2].path;
  fs.appendFileSync(target, '\n');const changed = fs.readFileSync(target);
  assert.throws(() => approveCases(f.options), /case_hash_mismatch/);
  assert.deepEqual(fs.readFileSync(target), changed);assert.deepEqual(fs.readFileSync(f.dataset), f.before[0].bytes);
  assert.equal(fs.existsSync(f.lock), false);
});

check('contract', 'Review locks reject simultaneous writers without removing another writer lock', () => {
  const f = reviewFixture();fs.writeFileSync(f.lock, 'unit-fixture-active-lock');
  assert.throws(() => approveCases(f.options), /review_locked/);f.assertUnchanged();
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'unit-fixture-active-lock');
});

check('semantic', 'A dataset-write failure rolls back the case and catalog and leaves a readable recovery snapshot', () => {
  const f = reviewFixture(), originalRename = fs.renameSync;let failed = false;
  const renamed = mock.method(fs, 'renameSync', (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
    if (String(to) === f.dataset && !failed) { failed = true;throw Error('unit-injected-dataset-write-failure'); }
    return originalRename(from, to);
  });
  try { assert.throws(() => approveCases(f.options), /unit-injected-dataset-write-failure/); }
  finally { renamed.mock.restore(); }
  assert.equal(failed, true);f.assertUnchanged();assert.equal(fs.existsSync(f.lock), false);
  const snapshot = f.data.path('history/model-diagnostic/2026-10-25.4/dataset.json');
  assert.equal(loadDataset(snapshot).manifest.version, '2026-10-25.4');
  assert.equal(loadDataset(f.dataset).entries[0].value.status, 'needs_review');
});

check('contract', 'Conflicting history is never overwritten and a repeated approval does not replace the first review', () => {
  const f = reviewFixture(), preview = approveCases({ ...f.options, dryRun: true });
  f.data.text('history/model-diagnostic/2026-10-25.4/dataset.json', 'different historical content');
  assert.throws(() => approveCases(f.options), /review_history_conflict/);f.assertUnchanged();
  assert.equal(fs.readFileSync(join(preview.snapshot, 'dataset.json'), 'utf8'), 'different historical content');
  const second = reviewFixture();approveCases(second.options);const saved = fs.readFileSync(second.dataset);
  assert.throws(() => approveCases({ ...second.options, reviewer: 'another-unit-fixture' }), /review_case_not_pending/);
  assert.deepEqual(fs.readFileSync(second.dataset), saved);
});

check('semantic', 'A batch review increments the dataset once and accepts a second review against an identical prior snapshot', () => {
  const f = reviewFixture(), result = approveCases({ ...f.options, caseIds: f.ids });
  assert.equal(result.cases.length, 2);assert.equal(loadDataset(f.dataset).manifest.version, '2026-10-25.5');
  assert.ok(loadDataset(f.dataset).entries.every(e => e.value.status === 'approved'));
  const retry = reviewFixture(), preview = approveCases({ ...retry.options, dryRun: true });
  retry.data.text('history/model-diagnostic/2026-10-25.4/dataset.json', fs.readFileSync(retry.dataset, 'utf8'));
  approveCases(retry.options);assert.equal(loadDataset(join(preview.snapshot, 'dataset.json')).entries.length, 2);
});
