import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore } from "@cwatch/shared/sessions/storage";

const materialRoot = process.argv[2] ?? 'C:/Users/Swing/Desktop/竞品情报agent-resume/resume-package';
const sourceRoot = process.argv[3] ?? 'C:/Users/Swing/Desktop/craft-agents-oss-main';
const scenario = 'scenario-competitor-intel-2026-10-12/';
const names = [scenario + 'resume-draft.md', scenario + 'scenario-design.md', scenario + 'alignment-audit.md', scenario + 'agent-project-model.json', scenario + 'claim-ledger.json', scenario + 'evidence-navigation.md', scenario + 'source-verification.json', 'resume-paste-ready.md', 'reviewed/resume-draft-reviewed.md', 'tool-unification-flow.md'];
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const materials = names.map(name => { const file = resolve(materialRoot, name), buffer = readFileSync(file), text = buffer.toString('utf8'); return { file, bytes: buffer.length, sha256: digest(buffer), headings: text.match(/^#{1,3} .+$/gm) ?? [], originalClaims: name.endsWith('/resume-draft.md') ? text.split('\n').filter(line => line.startsWith('- **')) : undefined, jsonTopLevelKeys: name.endsWith('.json') ? Object.keys(JSON.parse(text)) : undefined }; });
const historical = JSON.parse(readFileSync(resolve(materialRoot, scenario + 'source-verification.json'), 'utf8'));
const compared = historical.records.map((record: { path: string; sha256: string }) => { const file = resolve(sourceRoot, record.path); return { path: record.path, exists: existsSync(file), historicalSha256: record.sha256, currentSha256: existsSync(file) ? digest(readFileSync(file)) : null, matchesHistoricalSnapshot: existsSync(file) && digest(readFileSync(file)) === record.sha256 }; });
const excerpts: Array<{ path: string; bytes: number; sha256: string }> = [];
const excerptRoot = resolve(materialRoot, 'audit-evidence/source');
function visit(dir: string): void { for (const name of readdirSync(dir)) { const file = join(dir, name); if (statSync(file).isDirectory()) visit(file); else { const buffer = readFileSync(file); excerpts.push({ path: relative(excerptRoot, file), bytes: buffer.length, sha256: digest(buffer) }); } } }
if (existsSync(excerptRoot)) visit(excerptRoot);
const ledger = JSON.parse(readFileSync(resolve(materialRoot, scenario + 'claim-ledger.json'), 'utf8'));
const project = JSON.parse(readFileSync(resolve(materialRoot, scenario + 'agent-project-model.json'), 'utf8'));
new FileStore('artifacts/audit').write('materials.json', { at: new Date().toISOString(), materials, historicalSource: { commit: historical.source_commit, date: historical.snapshot_date, compared }, excerpts, claims: ledger.claims.map((claim: any) => ({ id: claim.id, basis: claim.claim_basis, wording: claim.candidate_wording, status: claim.status ?? claim.validation_status })), artifacts: project.artifacts.map((artifact: any) => ({ id: artifact.id, status: artifact.artifact_status, ownership: artifact.ownership, scenario: artifact.scenario })) });
console.log(JSON.stringify({ materials: materials.length, excerpts: excerpts.length, sourceRecords: compared.length, matchingHistoricalFiles: compared.filter((c: any) => c.matchesHistoricalSnapshot).length, output: 'artifacts/audit/materials.json' }));
