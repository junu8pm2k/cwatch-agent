import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EvalCase, WorkerObservation } from './contracts.ts';
import { sha256, within } from './dataset.ts';
import { readArchivedCase } from './operations.ts';
import { combinedAssessment, prepareQualitySubject } from './quality.ts';
import { Redactor } from '@cwatch/shared/sessions/trace';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const localPath = z.string().min(1).refine(p => !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && !p.split('/').some(s => s === '..' || s === '.' || !s));
const artifact = z.object({ path: localPath, sha256: digest, bytes: z.number().int().nonnegative() }).strict();
const caseIdentity = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/), revision: z.number().int().positive(), sha256: digest }).strict();
const metrics = z.object({ durationMs: z.number().nonnegative().nullable(), totalTokens: z.number().nonnegative().nullable(),
  actualCost: z.number().nonnegative().nullable(), steps: z.number().int().nonnegative().nullable(), toolCalls: z.number().int().nonnegative().nullable() }).strict();
export const BaselineSnapshotSchema = z.object({
  schemaVersion: z.literal('cwatch.eval-baseline-snapshot.v1'), id: z.string().uuid(), createdAt: z.string().datetime(), case: caseIdentity,
  source: z.object({ batchId: z.string(), runId: z.string(), attempt: z.number().int().positive(), reportSha256: digest }).strict(),
  model: z.json(), sourceVersion: z.json(), metrics, evidenceRefs: z.array(z.string()).min(1),
  trace: localPath.nullable(), finalAnswer: localPath, files: z.array(artifact).min(1).max(1000),
}).strict().superRefine((v,ctx) => {
  const paths=new Set(v.files.map(f=>f.path));
  if(paths.size!==v.files.length||!paths.has(v.finalAnswer)||(v.trace&&!paths.has(v.trace)))ctx.addIssue({code:'custom',message:'Baseline file references must be unique and complete'});
});
const approvalFinding = z.object({ verdict: z.enum(['pass', 'fail', 'unknown']), reason: z.string().trim().min(1).max(4000) }).strict();
export const BaselineApprovalSchema = z.object({
  schemaVersion: z.literal('cwatch.baseline-approval-input.v1'), snapshotSha256: digest,
  reviewer: z.string().trim().min(1).max(100).refine(s => !/[\x00-\x1f\x7f]/.test(s)),
  process: approvalFinding, outcome: approvalFinding, evidence: z.array(z.string()).min(1).max(20), notes: z.string().max(8000).default(''),
}).strict();
const BindingSchema = z.object({ schemaVersion: z.literal('cwatch.eval-baseline-binding.v1'), case: caseIdentity,
  baselineId: z.string().uuid(), status: z.enum(['candidate', 'confirmed']), manifest: artifact,
  approval: artifact.nullable(),
}).strict().refine(b => (b.status === 'confirmed') === Boolean(b.approval), 'Confirmed baselines require human approval');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identity = (c: EvalCase) => ({ id: c.id, revision: c.revision, sha256: sha256(JSON.stringify(c)) });
const portable = (base: string, file: string) => relative(base, file).replaceAll('\\', '/');
export const defaultBaselineRoot = () => resolve('evals/baselines');

function safeFile(root: string, path: string) {
  localPath.parse(path);
  const target = realpathSync(resolve(root, path));
  if (!within(realpathSync(root), target)) throw Error('baseline_path_escape');
  return target;
}
function verifiedBytes(root: string, entry: z.infer<typeof artifact>) {
  const bytes = readFileSync(safeFile(root, entry.path));
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw Error('baseline_integrity_failure: ' + entry.path);
  return bytes;
}
function store(file: string, bytes: Buffer) {
  let current=resolve(file);
  while(true){
    if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('baseline_link_not_supported');
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    if (!readFileSync(file).equals(bytes)) throw Error('baseline_snapshot_conflict');
  } else writeFileSync(file, bytes, { flag: 'wx' });
}
function descriptor(root: string, file: string, bytes: Buffer = readFileSync(file)) {
  return { path: portable(root, file), sha256: sha256(bytes), bytes: bytes.length };
}
function readBinding(path: string) {
  const root = realpathSync(dirname(path));
  const binding = BindingSchema.parse(JSON.parse(readFileSync(safeFile(root, portable(root, resolve(path))), 'utf8')));
  const bytes = verifiedBytes(root, binding.manifest), manifest = BaselineSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (binding.baselineId !== manifest.id || JSON.stringify(binding.case) !== JSON.stringify(manifest.case)) throw Error('baseline_identity_mismatch');
  const snapshotRoot = dirname(safeFile(root, binding.manifest.path));
  for (const file of manifest.files) verifiedBytes(snapshotRoot, file);
  if (binding.approval) {
    const record = JSON.parse(verifiedBytes(root, binding.approval).toString('utf8'));
    const input = BaselineApprovalSchema.parse(record.input);
    if (record.schemaVersion !== 'cwatch.baseline-approval.v1' || input.snapshotSha256 !== binding.manifest.sha256 || !input.evidence.includes('final-answer') ||
      input.process.verdict !== 'pass' || input.outcome.verdict !== 'pass' || input.evidence.some(ref => !manifest.evidenceRefs.includes(ref))) throw Error('invalid_baseline_approval');
  }
  return { root, binding, manifest, snapshotRoot, bytes };
}

/** Freeze observable execution evidence in the repository; this does not invent human approval. */
export function prepareBaseline(options: { report: string; caseId: string; attempt?: number; root?: string; secrets?: string[] }) {
  const root = resolve(options.root ?? defaultBaselineRoot()), workspace = realpathSync(process.cwd());
  if (!within(workspace, root) || root === workspace) throw Error('baseline_root_must_be_inside_workspace');
  mkdirSync(root, { recursive: true });
  if (!within(workspace, realpathSync(root))) throw Error('baseline_root_escape');
  const archive = readArchivedCase(options.report, options.caseId, options.attempt ?? 1);
  const subject = prepareQualitySubject(options.report, options.caseId, options.attempt ?? 1, new Redactor(options.secrets ?? []));
  const assessment = combinedAssessment(subject);
  const observed = JSON.parse(readFileSync(join(archive.directory, 'observed.json'), 'utf8')) as WorkerObservation;
  if (observed.status !== 'complete' || !assessment.rules.executionPassed || !assessment.penalty.complete || !assessment.penalty.passed) throw Error('baseline_requires_a_completed_passing_run');
  const c = identity(archive.value), bindingPath = join(root, `${c.id}.r${c.revision}.json`);
  if (existsSync(bindingPath)) throw Error('baseline_already_registered: ' + bindingPath);
  const id = randomUUID(), directory = join(root, c.id, 'r' + c.revision, id);
  mkdirSync(directory, { recursive: true });
  if (!within(realpathSync(root), realpathSync(directory))) throw Error('baseline_output_escape');
  const originalManifest = JSON.parse(readFileSync(join(archive.directory, 'manifest.json'), 'utf8'));
  const projection = JSON.parse(readFileSync(join(archive.directory, 'projection.json'), 'utf8'));
  const rawReport = JSON.parse(readFileSync(archive.reportPath, 'utf8'));
  const files: z.infer<typeof artifact>[] = [];
  let total = 0;
  const save = (path: string, bytes: Buffer) => {
    localPath.parse(path); total += bytes.length;
    if (total > 100_000_000 || files.length >= 1000) throw Error('baseline_snapshot_budget_exceeded');
    if (options.secrets?.some(secret => secret && bytes.includes(Buffer.from(secret)))) throw Error('baseline_contains_credentials');
    const target = join(directory, path); store(target, bytes); files.push(descriptor(directory, target, bytes));
  };
  // The execution manifest lists public evidence. Restricted SDK sessions remain in the local run archive.
  for (const file of originalManifest.evidence as z.infer<typeof artifact>[]) save('execution/' + file.path, verifiedBytes(archive.directory, file));
  save('case.json', encode(archive.value));
  save('rubric.json', encode(archive.value.rubric));
  save('assessment.json', encode(assessment));
  save('source-report.json', readFileSync(archive.reportPath));
  save('final-answer.md', Buffer.from(String(observed.facts.response ?? '')));
  const manifest = BaselineSnapshotSchema.parse({ schemaVersion: 'cwatch.eval-baseline-snapshot.v1', id, createdAt: new Date().toISOString(), case: c,
    source: { batchId: rawReport.batchId, runId: observed.runId, attempt: options.attempt ?? 1, reportSha256: sha256(readFileSync(archive.reportPath)) },
    model: originalManifest.model ?? null, sourceVersion: originalManifest.version ?? null,
    metrics: { durationMs: projection.durationMs ?? null, totalTokens: projection.cost?.totalTokens ?? null, actualCost: projection.cost?.actualCost ?? null,
      steps: projection.structuredTrace?.stepCount ?? (observed.structuredTracePath ? JSON.parse(readFileSync(join(archive.directory, observed.structuredTracePath), 'utf8')).steps.length : null), toolCalls: projection.cost?.toolCalls ?? null },
    evidenceRefs: subject.packet.allowedEvidenceRefs, trace: observed.structuredTracePath ? 'execution/' + observed.structuredTracePath : null,
    finalAnswer: 'final-answer.md', files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
  const manifestPath = join(directory, 'baseline.json'), manifestBytes = encode(manifest); store(manifestPath, manifestBytes);
  const binding = BindingSchema.parse({ schemaVersion: 'cwatch.eval-baseline-binding.v1', case: c, baselineId: id, status: 'candidate', manifest: descriptor(root, manifestPath), approval: null });
  writeFileSync(bindingPath, encode(binding), { flag: 'wx' });
  const templatePath = join(directory, 'approval-input.json');
  store(templatePath, encode({ schemaVersion: 'cwatch.baseline-approval-input.v1', snapshotSha256: sha256(manifestBytes), reviewer: '',
    process: { verdict: 'unknown', reason: '' }, outcome: { verdict: 'unknown', reason: '' }, evidence: [], notes: '' }));
  readBinding(bindingPath);
  return { binding: bindingPath, snapshot: manifestPath, finalAnswer: join(directory, manifest.finalAnswer), trace: manifest.trace ? join(directory, manifest.trace) : null,
    approvalInput: templatePath, status: binding.status, runId: observed.runId, metrics: manifest.metrics };
}

export function approveBaseline(bindingPath: string, rawInput: unknown) {
  const { root, binding, manifest } = readBinding(bindingPath), input = BaselineApprovalSchema.parse(rawInput);
  if (binding.status !== 'candidate') throw Error('baseline_not_pending');
  if (input.snapshotSha256 !== binding.manifest.sha256) throw Error('baseline_approval_subject_mismatch');
  if (input.process.verdict !== 'pass' || input.outcome.verdict !== 'pass') throw Error('baseline_approval_requires_process_and_outcome_pass');
  if (!input.evidence.includes('final-answer')) throw Error('baseline_approval_requires_final_answer_evidence');
  if (input.evidence.some(ref => !manifest.evidenceRefs.includes(ref))) throw Error('unknown_baseline_evidence_reference');
  const path = join(dirname(safeFile(root, binding.manifest.path)), 'approval-' + randomUUID() + '.json');
  const bytes = encode({ schemaVersion: 'cwatch.baseline-approval.v1', approvedAt: new Date().toISOString(), identity: 'self_declared_human', input });
  store(path, bytes);
  const next = BindingSchema.parse({ ...binding, status: 'confirmed', approval: descriptor(root, path, bytes) });
  const temp = join(root, '.' + randomUUID() + '.tmp');
  writeFileSync(temp, encode(next), { flag: 'wx' }); renameSync(temp, bindingPath);
  return { binding: resolve(bindingPath), status: next.status, approval: path, runId: manifest.source.runId };
}

/** Read a confirmed, compatible baseline without generating a report or changing the snapshot. */
export function confirmedBaseline(c: EvalCase, root = defaultBaselineRoot()) {
  const path = join(root, `${c.id}.r${c.revision}.json`), loaded = readBinding(path);
  if (loaded.binding.status !== 'confirmed') throw Error('regression_requires_confirmed_baseline');
  if (loaded.binding.case.sha256 !== identity(c).sha256) throw Error('regression_baseline_case_mismatch');
  return { path, binding: loaded.binding, manifest: loaded.manifest };
}

/** Materialize the selected reference in the report batch so its ZIP is self-contained. */
export function baselineForCase(c: EvalCase, batch: string, root = defaultBaselineRoot()) {
  const empty = { durationMs: null, totalTokens: null, actualCost: null, steps: null, toolCalls: null, reference: null as string | null, runId: null as string | null };
  const path = join(root, `${c.id}.r${c.revision}.json`);
  if (!existsSync(path)) return { ...empty, status: 'not_established', reason: null as string | null };
  try {
    const loaded = readBinding(path), { binding, manifest } = loaded;
    if (binding.case.sha256 !== identity(c).sha256) return { ...empty, status: 'incompatible', reason: 'Case content differs from the frozen baseline' };
    const target = join(batch, 'baseline-references', binding.baselineId + '-' + sha256(readFileSync(path)).slice(0, 12));
    mkdirSync(target, { recursive: true });
    if (!within(realpathSync(batch), realpathSync(target))) throw Error('baseline_reference_escape');
    store(join(target, 'binding.json'), encode({...binding,manifest:{...binding.manifest,path:'baseline.json'},approval:binding.approval?{...binding.approval,path:'approval.json'}:null}));
    store(join(target, 'baseline.json'), loaded.bytes);
    for (const file of manifest.files) store(join(target, file.path), verifiedBytes(loaded.snapshotRoot, file));
    if (binding.approval) store(join(target, 'approval.json'), verifiedBytes(loaded.root, binding.approval));
    return { ...manifest.metrics, reference: portable(batch, join(target, 'baseline.json')), runId: manifest.source.runId, status: binding.status, reason: null };
  } catch (error) { return { ...empty, status: 'invalid', reason: error instanceof Error ? error.message : 'baseline_read_failed' }; }
}
