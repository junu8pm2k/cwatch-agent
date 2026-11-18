import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import { PiModel } from '@cwatch/shared/agent/models';
import { ActionPolicy } from '@cwatch/shared/agent/core/permission-manager';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Trace, Redactor } from '@cwatch/shared/sessions/trace';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { fixturePath, loadSnapshots } from './benchmark-contract.ts';
import config from './config.json' with { type: 'json' };

const redactor = new Redactor([process.env.API_KEY ?? '']);
const fileDigest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const requestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  input: z.string().trim().min(1).max(4000),
  fixture: z.string(),
  workDir: z.string().min(1),
  traceFile: z.string().min(1),
});

async function main() {
  const command = process.argv[2];
  if (command === 'manifest') {
    const { snapshots, cases } = loadSnapshots();
    const fixtures = [...new Set(cases.map(item => item.fixture))].sort();
    console.log(JSON.stringify({
      dataset: snapshots[0].dataset,
      suites: Object.fromEntries(snapshots.map(({ suite, sha256 }) => [suite, sha256])),
      cases,
      fixtureHashes: Object.fromEntries(fixtures.map(name => [name, fileDigest(fixturePath(name))])),
      nodeVersion: process.version,
    }));
    return;
  }
  if (command !== 'run') throw Error('expected manifest or run');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const workspace = join(input.workDir, 'workspace');
  const store = new FileStore(join(input.workDir, 'runtime'));
  mkdirSync(workspace);
  copyFileSync(fixturePath(input.fixture), join(workspace, input.fixture));
  process.env.LANGFUSE_ENABLED = 'false';
  const model = PiModel.fromEnvironment({
    MODEL_PROVIDER: config.agent.provider,
    MODEL_ID: config.agent.model,
    BASE_URL: config.agent.baseUrl,
    API_KEY: process.env.API_KEY,
  });
  const registry = new ToolRegistry();
  const since = performance.now();
  try {
    const result = await runAgent({ kind: 'agent', taskId: input.id, instruction: input.input, allowedSources: [] },
      model, registry, store, 'live', {
        ...config.limits, workspaceRoot: workspace, sessionMemory: false, promptCache: 'none',
        skillPath: resolve('skills/general-agent/SKILL.md'), secrets: [process.env.API_KEY ?? ''],
      }, AbortSignal.timeout(config.limits.timeoutMs), new ActionPolicy('explore'));
    const trace = new Trace(store, input.id, result.runId, redactor).exportStructured();
    if (!trace.integrity.valid || !trace.integrity.complete) throw Error('agent emitted an incomplete trace');
    writeFileSync(input.traceFile, JSON.stringify(trace) + '\n', { flag: 'wx' });
    const tools = trace.steps.filter(step => step.kind === 'tool' && step.correlation.requestId).map(step => ({
      name: step.name, arguments: step.input, status: step.status, hadError: Boolean(step.error),
    }));
    console.log(JSON.stringify(redactor.clean({
      runId: result.runId, status: result.status, output: result.response ?? '', tools,
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
