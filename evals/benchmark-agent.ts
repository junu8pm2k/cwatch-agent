import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import { PiModel } from '@cwatch/shared/agent/models';
import { ActionPolicy } from '@cwatch/shared/agent/core/permission-manager';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Trace, Redactor } from '@cwatch/shared/sessions/trace';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { SkillStore } from '@cwatch/shared/skills/storage';
import { digest, fixturePath, loadSnapshots, reviewProfile } from './benchmark-contract.ts';
import { loadReviewTestCases } from './review-tests.ts';
import config from './config.json' with { type: 'json' };

const redactor = new Redactor([process.env.API_KEY ?? '']);
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function requestedResponseLimit(instruction: string) {
  const limits = new Set([...instruction.matchAll(/(?:回答|答复|回复)[，,]?\s*(?:总共\s*)?(?:不超过|不得超过|最多)\s*([1-9]\d{0,4})\s*(?:个字符|字符|字)(?=$|[\s，。；,.!?！？])/gu)]
    .map(match => Number(match[1])));
  const [limit] = limits;
  return limits.size === 1 && limit <= 32_000 ? limit : undefined;
}
const requestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  input: z.string().trim().min(1).max(4000),
  fixture: z.string(),
  fixtureSha256: z.string().regex(/^[0-9a-f]{64}$/),
  profile: reviewProfile.optional(),
  workDir: z.string().min(1),
  traceFile: z.string().min(1),
});

function manifestSource(reviewTests: boolean) {
  if (reviewTests) {
    const cases = loadReviewTestCases();
    const revision = digest(cases);
    return {
      dataset: { id: 'local-review-tests', name: 'local/competitor-review-tests', revision },
      suites: { 'review-tests': revision },
      cases,
    };
  }
  const { snapshots, cases } = loadSnapshots();
  return {
    dataset: snapshots[0].dataset,
    suites: Object.fromEntries(snapshots.map(({ suite, sha256 }) => [suite, sha256])),
    cases,
  };
}

async function main() {
  const command = process.argv[2];
  if (command === 'manifest') {
    const { dataset, suites, cases } = manifestSource(process.argv[3] === 'review-tests');
    const fixtures = [...new Set(cases.map(item => item.fixture))].sort();
    const skillFiles = [
      'skills/general-agent/SKILL.md',
      'skills/competitor-review/SKILL.md',
      'skills/competitor-review/references/checklist.md',
    ];
    const materials = Object.fromEntries(fixtures.map(name => [name, readFileSync(fixturePath(name))]));
    console.log(JSON.stringify({
      dataset,
      suites,
      cases: cases.map(item => ({ ...item, material: materials[item.fixture].toString('utf8') })),
      fixtureHashes: Object.fromEntries(fixtures.map(name => [name, createHash('sha256').update(materials[name]).digest('hex')])),
      skillHashes: Object.fromEntries(skillFiles.map(path => [path, fileDigest(path)])),
      nodeVersion: process.version,
    }));
    return;
  }
  if (command !== 'run') throw Error('expected manifest or run');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const material = readFileSync(fixturePath(input.fixture));
  if (createHash('sha256').update(material).digest('hex') !== input.fixtureSha256) throw Error('benchmark fixture changed after manifest');
  const instruction = input.profile ? input.input + '\n\n【固定输入材料】\n' + material.toString('utf8').trim() : input.input;
  const responseCharacterLimit = requestedResponseLimit(input.input);
  if (instruction.length > 8000) throw Error('benchmark instruction and material exceed limit: ' + input.id);
  const workspace = join(input.workDir, 'workspace');
  const store = new FileStore(join(input.workDir, 'runtime'));
  mkdirSync(workspace);
  let userSkills;
  if (input.profile === 'competitor-review') {
    const skills = new SkillStore(workspace);
    skills.installDirectory(resolve('skills/competitor-review'));
    userSkills = skills.select(['competitor-review']);
  } else {
    writeFileSync(join(workspace, input.fixture), material, { flag: 'wx' });
  }
  // The benchmark runner publishes the trace with evaluation scores.
  process.env.LANGFUSE_ENABLED = 'false';
  const model = PiModel.fromEnvironment({
    MODEL_PROVIDER: config.agent.provider,
    MODEL_ID: config.agent.model,
    BASE_URL: config.agent.baseUrl,
    API_KEY: process.env.API_KEY,
  }, { reasoningEffort: z.enum(['low', 'medium', 'high']).optional().parse(config.agent.reasoningEffort) });
  const registry = new ToolRegistry();
  const since = performance.now();
  try {
    const result = await runAgent({ kind: 'agent', taskId: input.id, instruction, allowedSources: [], responseCharacterLimit },
      model, registry, store, 'live', {
        ...config.limits, workspaceRoot: workspace, sessionMemory: false, promptCache: 'none',
        userSkills, builtinTools: input.profile === undefined,
        skillPath: resolve('skills/general-agent/SKILL.md'), secrets: [process.env.API_KEY ?? ''],
      }, AbortSignal.timeout(config.limits.timeoutMs), new ActionPolicy('explore'));
    const trace = new Trace(store, input.id, result.runId, redactor).exportStructured();
    writeFileSync(input.traceFile, JSON.stringify(trace) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(redactor.clean({
      runId: result.runId, status: result.status, output: result.response ?? '',
      durationMs: Math.round(performance.now() - since), error: result.error ?? null,
    })));
  } finally {
    await registry.close();
  }
}

main().catch(error => {
  console.error(redactor.clean(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
