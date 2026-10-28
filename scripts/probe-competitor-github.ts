import { existsSync, readFileSync } from 'node:fs';
import { parseTask, id, type RetrievalResult } from '@cwatch/core/types';
import { SourceConfigsSchema, SourceServerBuilder } from '@cwatch/shared/sources/server-builder';
import { SourceGuideTools } from '@cwatch/shared/sources/source-guides';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ToolExecutor } from '@cwatch/shared/tools/executor';
import { ActionPolicy, ApprovalManager } from '@cwatch/shared/agent/core/permission-manager';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Redactor, Trace, validateTrace } from '@cwatch/shared/sessions/trace';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2), outIndex = args.indexOf('--out');
const out = outIndex < 0 ? 'artifacts/competitor-github-probe' : args[outIndex + 1];
if (!out) throw new Error('missing --out directory');
const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''));
const results: Array<Record<string, unknown>> = [];
let stopped: { reason: string; retryAt?: string } | undefined;
// Public GitHub quota can be shared by this egress. Never fan out or keep probing after an explicit limit.
for (const target of ['zcode', 'kimi-code', 'minimax-code']) {
  if (stopped) { results.push({ target, attempted: false, reason: stopped.reason, retryAt: stopped.retryAt }); continue; }
  const task = parseTask(JSON.parse(readFileSync(`examples/competitor-acceptance/${target}.task.json`, 'utf8')));
  const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync(`examples/competitor-acceptance/${target}.sources.json`, 'utf8'))).filter(config => config.kind === 'github_releases' && config.active);
  if (configs.length !== 1 || !configs[0].repo) throw new Error('probe requires one configured GitHub source');
  const source = configs[0], data = new FileStore(`${out}/${target}`), registry = new ToolRegistry(), builder = new SourceServerBuilder(process.cwd());
  const runId = id(), trace = new Trace(data, task.taskId, runId, redactor), signal = AbortSignal.timeout(45000);
  trace.emit('run_started', { purpose: 'single-request GitHub quota acceptance, no model or report', authenticated: Boolean(process.env.GITHUB_TOKEN) });
  try {
    const gaps = await builder.register(configs, 'live', registry, signal);
    await registry.register('session', 'builtin', new SourceGuideTools(registry, task), signal);
    const executor = new ToolExecutor(registry, new ActionPolicy('explore'), new ApprovalManager(), data, trace, task, 30000);
    await executor.execute('session__read_source_guide', { source: source.slug }, signal);
    const started = Date.now();
    const result = await executor.execute(`mcp__${source.slug}__api_${source.slug}`, { path: `/repos/${source.repo}/releases`, method: 'GET', params: { per_page: 10 } }, signal) as RetrievalResult;
    data.write('result.json', redactor.clean(result));
    if (result.status === 'rate_limited') stopped = { reason: 'shared_github_quota_limited; no automatic retry', retryAt: result.http?.rateLimit?.retryAt };
    else if (!['success_with_data', 'success_empty'].includes(result.status)) stopped = { reason: 'github_source_unavailable; no automatic retry' };
    else if (result.http?.rateLimit?.remaining === 0) stopped = { reason: 'shared_github_quota_exhausted_after_response; no further request', retryAt: result.http.rateLimit.resetAt };
    const summary = { target, attempted: true, runId, repo: source.repo, at: new Date().toISOString(), durationMs: Date.now() - started,
      status: result.status, error: result.error, backend: result.backend, http: result.http, signalCount: result.signals.length, gaps,
      interpretation: result.status === 'rate_limited' ? 'collection unavailable; update status unknown' : 'one response only; not a complete investigation' };
    trace.emit('run_completed', { purpose: 'quota probe ended; no intelligence report', collection: summary });
    const saved = redactor.clean({ ...summary, traceIssues: validateTrace(data.lines(trace.key)) });
    data.write('latest.json', saved); results.push(saved); console.log(JSON.stringify(saved));
  } catch (error) {
    const summary = redactor.clean({ target, attempted: true, runId, error: String(error) });
    trace.emit('run_failed', summary); data.write('latest.json', summary); results.push(summary);
    stopped = { reason: 'probe_failed; no automatic retry' };
  } finally { await registry.close(); await builder.mcpPool.close(); }
}
const summary = { at: new Date().toISOString(), authenticated: Boolean(process.env.GITHUB_TOKEN), maxHttpAttempts: 3, automaticRetries: 0, stopped, results };
new FileStore(out).write('summary.json', summary);
console.log(JSON.stringify(redactor.clean(summary)));
if (stopped || results.some(result => result.error || (result.traceIssues as unknown[] | undefined)?.length)) process.exitCode = 1;
