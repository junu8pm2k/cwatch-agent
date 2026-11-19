import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { readJson } from './benchmark-contract.ts';
import { publishBenchmark } from './benchmark-publish.ts';

const [mode, ...args] = process.argv.slice(2);

const reportSchema = z.object({
  summary: z.object({
    expected: z.int().positive(),
    executed: z.int().nonnegative(),
    passed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    complete: z.boolean(),
  }),
  cases: z.array(z.object({ caseId: z.string(), passed: z.boolean(), error: z.string().optional() })),
});

function run(command: string, parameters: string[], env = process.env) {
  const result = spawnSync(command, parameters, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === null) throw Error(command + ' terminated by ' + result.signal);
  return result.status;
}

function printBenchmarkSummary(reportPath: string) {
  if (!existsSync(reportPath)) {
    console.error('Benchmark case report was not generated. See the test runner output above.');
    return;
  }
  const { summary, cases } = reportSchema.parse(readJson(reportPath));
  const notRun = summary.expected - summary.executed;
  console.log(`Benchmark (all selected cases) passed ${summary.passed}/${summary.expected} (${summary.failed} failed, ${notRun} not run).`);
  const redactor = new Redactor(Object.entries(process.env)
    .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  for (const item of cases.filter(item => !item.passed)) {
    const reason = item.error && redactor.clean(item.error).split(/\r?\n/, 1)[0].trim().slice(0, 500);
    console.error(`FAIL ${item.caseId}${reason ? ' — ' + reason : ''}`);
  }
  return summary;
}

async function main() {
  if (mode === 'host' && args.length) {
    if (args.length !== 1 || args[0] !== '--help') {
      throw Error('eval:run reads the Benchmark snapshots. Use BENCHMARK_SUITE to choose all, smoke, or regression.');
    }
    console.log('npm run eval:run\nSet BENCHMARK_SUITE to all (default), smoke, or regression.');
    return;
  }
  if (mode === 'publish') {
    const id = z.uuid().parse(args[0]);
    await publishBenchmark(resolve('artifacts/benchmark', id), id);
    return;
  }
  if (!['host', 'ci', 'docker'].includes(mode) || args.length) throw Error('invalid benchmark command');
  const suite = z.enum(['all', 'smoke', 'regression']).parse(process.env.BENCHMARK_SUITE || 'all');
  if (mode === 'docker' && !readLangfuseConfig()) throw Error('eval:docker requires Langfuse project keys');
  const runId = randomUUID();
  const runDir = resolve('artifacts/benchmark', runId);
  mkdirSync(runDir, { recursive: true });
  const git = (arguments_: string[]) => spawnSync('git', arguments_, { encoding: 'utf8' });
  const dirty = git(['status', '--porcelain']);
  const commit = git(['rev-parse', 'HEAD']);
  const env = {
    // DeepEval treats API_KEY as a Confident AI credential. Give it a benchmark-specific name.
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_KEY$|LANGFUSE_|CWATCH_AGENT_PROMPT_SNAPSHOT$|CONFIDENT_|DEEPEVAL_)/i.test(key))),
    BENCHMARK_AGENT_API_KEY: process.env.BENCHMARK_AGENT_API_KEY ?? process.env.API_KEY,
    BENCHMARK_RUN_ID: runId,
    BENCHMARK_RUN_DIR: runDir,
    BENCHMARK_COMMIT: commit.status === 0 ? commit.stdout.trim() : process.env.GITHUB_SHA || 'unavailable',
    BENCHMARK_TREE_STATE: dirty.status === 0 ? dirty.stdout.trim() ? 'dirty' : 'clean' : 'unavailable',
    BENCHMARK_SUITE: suite,
    BENCHMARK_ENV: mode,
    DEEPEVAL_DISABLE_DOTENV: '1',
    DEEPEVAL_TELEMETRY_OPT_OUT: 'YES',
    DEEPEVAL_CACHE_FOLDER: resolve(runDir, '.deepeval'),
    CONFIDENT_METRIC_LOGGING_ENABLED: 'false',
    PYTHONUTF8: '1',
    PYTEST_ADDOPTS: '--junitxml="' + resolve(runDir, 'junit.xml') + '"',
  };
  console.log('Benchmark report directory: ' + runDir);
  const exit = mode === 'docker'
    ? run('docker', ['compose', '-f', 'compose.eval.yml', 'run', '--build', '--rm', '-T', 'eval'], env)
    : run('uv', ['run', '--locked', 'deepeval', 'test', 'run', 'evals/test_agent.py'], env);
  process.exitCode = exit;
  const summary = printBenchmarkSummary(resolve(runDir, 'report.json'));
  if (exit === 0 && (!summary?.complete || summary.passed !== summary.expected)) throw Error('incomplete or failed benchmark gate');
  if (mode === 'docker' && summary) await publishBenchmark(runDir, runId);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode ||= 1;
});
