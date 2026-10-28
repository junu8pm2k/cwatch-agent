import { existsSync, readFileSync } from 'node:fs';
import { parseTask, id, hash, type RetrievalResult } from '@cwatch/core/types';
import { SourceConfigsSchema, SourceServerBuilder } from '@cwatch/shared/sources/server-builder';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ToolExecutor } from '@cwatch/shared/tools/executor';
import { ActionPolicy, ApprovalManager } from '@cwatch/shared/agent/core/permission-manager';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Redactor, Trace, validateTrace } from '@cwatch/shared/sessions/trace';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf('--' + name); return index < 0 ? fallback : args[index + 1] ?? fallback; };
const out = option('out', 'artifacts/competitor-fetch-probe'), toolTimeoutMs = Number(option('tool-timeout', '120000'));
if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs < 1000 || toolTimeoutMs > 180000) throw new Error('invalid probe tool timeout');
const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''));
const targets = ['zcode', 'kimi-code', 'minimax-code'];
const results = await Promise.allSettled(targets.map(async target => {
  const task = parseTask(JSON.parse(readFileSync(`examples/competitor-acceptance/${target}.task.json`, 'utf8')));
  const sourcePath = `examples/competitor-acceptance/${target}.sources.json`;
  const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync(sourcePath, 'utf8'))).filter(config => config.kind === 'web' && config.active !== false);
  const source = configs[0];
  if (configs.length !== 1 || !source.urls?.length) throw new Error('probe needs one configured web source with starting URLs');
  const data = new FileStore(`${out}/${target}`), registry = new ToolRegistry(), builder = new SourceServerBuilder(process.cwd());
  const runId = id(), trace = new Trace(data, task.taskId, runId, redactor);
  const urls = args.includes('--all-urls') ? source.urls : source.urls.slice(0, 1);
  const signal = AbortSignal.timeout(toolTimeoutMs * urls.length + 10000);
  const calls: Array<Record<string, unknown>> = [];
  trace.emit('run_started', { purpose: 'independent configured fetch probe; no model or intelligence report', sourcePath, sourceConfigHash: hash(configs), toolTimeoutMs });
  try {
    const gaps = await builder.register(configs, 'live', registry, signal);
    const executor = new ToolExecutor(registry, new ActionPolicy('explore'), new ApprovalManager(), data, trace, task, toolTimeoutMs);
    for (const url of urls) {
      const started = Date.now();
      try {
        const result = await executor.execute('web_fetch', { url }, signal) as RetrievalResult;
        data.write(`results/${calls.length}.json`, redactor.clean(result));
        calls.push({ url, durationMs: Date.now() - started, status: result.status, backend: result.backend, error: result.error,
          pages: result.pages?.map(page => ({ url: page.url, title: page.title, textChars: page.text.length, textHash: hash(page.text), preview: page.text.slice(0, 1800), truncated: page.truncated })) ?? [],
          hasPageText: result.status === 'success_with_data' && result.pages?.some(page => page.url === url && page.text.trim().length >= 300) === true });
      } catch (error) { calls.push({ url, durationMs: Date.now() - started, status: 'failed', error: redactor.clean(String(error)), hasPageText: false }); }
    }
    trace.emit('run_completed', { purpose: 'probe finished; inspect body content before accepting', gaps, calls });
    const result = redactor.clean({ target, runId, at: new Date().toISOString(), sourcePath, sourceConfigHash: hash(configs), allowedDomains: source.allowedDomains,
      configuredRoute: source.webApi ? 'api' : 'configured MCP/native policy', gaps, calls, traceIssues: validateTrace(data.lines(trace.key)) });
    data.write('latest.json', result);
    console.log(JSON.stringify(result));
    return result;
  } finally { await registry.close(); await builder.mcpPool.close(); }
}));
const summary = results.map((result, index) => result.status === 'fulfilled' ? result.value : { target: targets[index], error: redactor.clean(String(result.reason)) });
new FileStore(out).write('summary.json', summary);
if (results.some(result => result.status === 'rejected' || result.value.traceIssues.length || result.value.calls.some(call => !call.hasPageText))) process.exitCode = 1;
