import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { readJson } from './benchmark-contract.ts';
import { publishBenchmark } from './benchmark-publish.ts';
import { loadReviewTestCases } from './review-tests.ts';

const [mode, ...args] = process.argv.slice(2);

const reportSchema = z.object({
  scoring: z.object({ trialsPerCase: z.int().positive() }),
  summary: z.object({
    expected: z.int().positive(),
    executed: z.int().nonnegative(),
    passed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    errors: z.int().nonnegative(),
    complete: z.boolean(),
  }),
  cases: z.array(z.object({
    caseId: z.string(), status: z.enum(['pass', 'fail', 'error']), error: z.string().optional(),
    score: z.number().nullable(), trials: z.array(z.object({ status: z.enum(['pass', 'fail', 'error']), score: z.number().nullable() })),
  })),
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
  const { scoring, summary, cases } = reportSchema.parse(readJson(reportPath));
  const notRun = summary.expected - summary.executed;
  console.log(`Benchmark (all selected cases) passed ${summary.passed}/${summary.expected} (${summary.failed} failed, ${summary.errors} evaluation errors, ${notRun} not run).`);
  const redactor = new Redactor(Object.entries(process.env)
    .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? ''));
  for (const item of cases) {
    const reason = item.error && redactor.clean(item.error).split(/\r?\n/, 1)[0].trim().slice(0, 500);
    const passedTrials = item.trials.filter(trial => trial.status === 'pass').length;
    const failedScore = item.trials.find(trial => trial.status === 'fail')?.score;
    const details = [`${passedTrials}/${scoring.trialsPerCase} trials passed`];
    if (item.score !== null) details.unshift(`average ${item.score.toFixed(2)}`);
    if (failedScore != null) details.push(`failed trial scored ${failedScore.toFixed(2)}`);
    if (item.trials.length < scoring.trialsPerCase) details.push(`${item.trials.length} run`);
    const detail = `${item.status.toUpperCase()} ${item.caseId} (${details.join(', ')})`;
    if (item.status === 'pass') console.log(detail);
    else console.error(`${detail}${reason ? ' — ' + reason : ''}`);
  }
  return summary;
}

async function publishRun(runDir: string, runId: string) {
  await publishBenchmark(runDir, runId);
  console.log('Langfuse upload receipt: ' + resolve(runDir, 'langfuse.json'));
}

function evaluationEnvironment() {
  // DeepEval treats API_KEY as a Confident AI credential.
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_KEY$|LANGFUSE_|CWATCH_AGENT_PROMPT_SNAPSHOT$|CONFIDENT_|DEEPEVAL_)/i.test(key))),
    DEEPEVAL_DISABLE_DOTENV: '1', DEEPEVAL_TELEMETRY_OPT_OUT: 'YES',
    CONFIDENT_METRIC_LOGGING_ENABLED: 'false', PYTHONUTF8: '1',
  };
}

async function main() {
  if (['check', 'calibrate'].includes(mode) && args.length === 0) {
    const env = { ...evaluationEnvironment(), BENCHMARK_LIVE_CALIBRATION: mode === 'calibrate' ? '1' : '0' };
    process.exitCode = run('uv', ['run', '--locked', 'pytest', '-p', 'no:deepeval', '-q', 'evals/test_scoring.py'], env);
    return;
  }
  const reviewTests = mode === 'host' && args[0] === '--review-tests';
  let reviewCaseId = '';
  if (reviewTests && args.length > 1) {
    if (args.length !== 3 || args[1] !== '--case') {
      throw Error('Usage: npm run eval:run -- --review-tests [--case <case-id>]');
    }
    reviewCaseId = args[2];
    if (!loadReviewTestCases().some(item => item.id === reviewCaseId)) {
      throw Error('Unknown review test case: ' + reviewCaseId);
    }
  }
  if (mode === 'host' && args.length && !reviewTests) {
    if (args.length !== 1 || args[0] !== '--help') {
      throw Error('eval:run reads the Benchmark snapshots. Use BENCHMARK_SUITE to choose smoke, regression, or all.');
    }
    console.log('npm run eval:run\nSet BENCHMARK_SUITE to smoke (default), regression, or all.\nnpm run eval:run -- --review-tests [--case <case-id>] runs the local review tests.');
    return;
  }
  if (mode === 'publish') {
    const id = z.uuid().parse(args[0]);
    if (args.length > 2 || (args.length === 2 && args[1] !== '--review-tests')) {
      throw Error('Usage: npm run eval:publish -- <run-id> [--review-tests]');
    }
    const directory = args[1] === '--review-tests' ? 'artifacts/review-tests' : 'artifacts/benchmark';
    await publishRun(resolve(directory, id), id);
    return;
  }
  if (!['host', 'ci', 'docker'].includes(mode) || (args.length && !reviewTests)) throw Error('invalid benchmark command');
  const suite = reviewTests ? 'review-tests' : z.enum(['all', 'smoke', 'regression']).parse(process.env.BENCHMARK_SUITE || 'smoke');
  const runId = randomUUID();
  const runDir = resolve(reviewTests ? 'artifacts/review-tests' : 'artifacts/benchmark', runId);
  mkdirSync(runDir, { recursive: true });
  const git = (arguments_: string[]) => spawnSync('git', arguments_, { encoding: 'utf8' });
  const dirty = git(['status', '--porcelain']);
  const commit = git(['rev-parse', 'HEAD']);
  const env = {
    ...evaluationEnvironment(),
    BENCHMARK_AGENT_API_KEY: process.env.BENCHMARK_AGENT_API_KEY ?? process.env.API_KEY,
    BENCHMARK_RUN_ID: runId,
    BENCHMARK_RUN_DIR: runDir,
    BENCHMARK_COMMIT: commit.status === 0 ? commit.stdout.trim() : process.env.GITHUB_SHA || 'unavailable',
    BENCHMARK_TREE_STATE: dirty.status === 0 ? dirty.stdout.trim() ? 'dirty' : 'clean' : 'unavailable',
    BENCHMARK_SUITE: suite,
    BENCHMARK_REVIEW_CASE_ID: reviewCaseId,
    BENCHMARK_ENV: mode,
    DEEPEVAL_CACHE_FOLDER: resolve(runDir, '.deepeval'),
    PYTEST_ADDOPTS: '--junitxml="' + resolve(runDir, 'junit.xml') + '"',
  };
  console.log('Benchmark report directory: ' + runDir);
  const exit = mode === 'docker'
    ? run('docker', ['compose', '-f', 'compose.eval.yml', 'run', '--build', '--rm', '-T', 'eval'], env)
    : run('uv', ['run', '--locked', 'pytest', '-p', 'no:deepeval', '-q', '--durations=10', 'evals/test_agent.py'], env);
  process.exitCode = exit;
  const summary = printBenchmarkSummary(resolve(runDir, 'report.json'));
  if (mode !== 'ci' && summary && process.env.BENCHMARK_PUBLISH !== '0') {
    try {
      if (readLangfuseConfig()) await publishRun(runDir, runId);
    } catch (error) {
      console.warn('Langfuse upload warning: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (exit === 0 && (!summary?.complete || summary.passed !== summary.expected)) throw Error('incomplete or failed benchmark gate');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode ||= 1;
});
