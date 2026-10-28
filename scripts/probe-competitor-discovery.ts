import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { hash, id, parseTask, type RetrievalResult } from '@cwatch/core/types';
import { summarizeDiscovery, type DiscoveryQuery, type DiscoveryFetch } from '@cwatch/shared/intelligence/source-coverage';
import { SourceConfigsSchema, SourceServerBuilder } from '@cwatch/shared/sources/server-builder';
import { allowedUrl } from '@cwatch/shared/sources/web';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ToolExecutor } from '@cwatch/shared/tools/executor';
import { ActionPolicy, ApprovalManager } from '@cwatch/shared/agent/core/permission-manager';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Redactor, Trace, validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2), outIndex = args.indexOf('--out');
const out = outIndex < 0 ? 'artifacts/competitor-discovery-probe' : args[outIndex + 1];
if (!out) throw new Error('missing --out directory');
const plan = z.object({ version: z.literal(1), limit: z.number().int().min(1).max(10), purpose: z.string(), targets: z.array(z.object({ id: z.string(), queries: z.array(z.string().min(1).max(500)).length(3) }).strict()).length(3) }).strict()
  .parse(JSON.parse(readFileSync('examples/competitor-acceptance/discovery-queries.json', 'utf8')));
if (new Set(plan.targets.map(target => target.id)).size !== 3 || plan.targets.some(target => !['zcode', 'kimi-code', 'minimax-code'].includes(target.id))) throw new Error('invalid discovery targets');
const redactor = new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? ''));
const results = await Promise.allSettled(plan.targets.map(async target => {
  const task = parseTask(JSON.parse(readFileSync(`examples/competitor-acceptance/${target.id}.task.json`, 'utf8')));
  const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync(`examples/competitor-acceptance/${target.id}.sources.json`, 'utf8'))).filter(source => source.kind === 'web' && source.active);
  const source = configs[0];
  if (configs.length !== 1 || !source.allowedDomains?.length || source.urls?.length !== 3) throw new Error('probe needs original three configured reference entries');
  for (const url of source.urls) allowedUrl(url, source.allowedDomains);
  for (const query of target.queries) {
    const directive = /\bsite:([^\s)]+)/.exec(query)?.[1];
    if (!directive) throw new Error('official site directive required');
    allowedUrl('https://' + directive, source.allowedDomains);
    if (directive.startsWith('github.com/') && !source.urls.some(url => url.toLowerCase() === ('https://' + directive).toLowerCase())) throw new Error('query outside configured official repository');
  }
  const data = new FileStore(`${out}/${target.id}`), registry = new ToolRegistry(), builder = new SourceServerBuilder(process.cwd());
  const runId = id(), trace = new Trace(data, task.taskId, runId, redactor), signal = AbortSignal.timeout(240000);
  const queries: DiscoveryQuery[] = [], fetches: DiscoveryFetch[] = [], calls: Array<Record<string, unknown>> = [];
  trace.emit('run_started', { purpose: 'bounded official reference discovery; no model report', queryPlanHash: hash(plan), sourceConfigHash: hash(configs), referenceUrls: source.urls, allowedDomains: source.allowedDomains, toolTimeoutMs: 45000 });
  try {
    const gaps = await builder.register(configs, 'live', registry, signal);
    const executor = new ToolExecutor(registry, new ActionPolicy('explore'), new ApprovalManager(), data, trace, task, 45000);
    for (const query of target.queries) {
      const before = data.lines<TraceEvent>(trace.key).length, started = Date.now();
      const result = await executor.execute('web_search', { query, limit: plan.limit }, signal) as RetrievalResult;
      const events = data.lines<TraceEvent>(trace.key).slice(before);
      const returned = events.find(event => event.type === 'provider_tool_event' && typeof event.data.returned === 'number')?.data;
      queries.push({ query, limit: plan.limit, result, returned: returned?.returned as number | undefined, filteredOutsideScope: returned?.filteredOutsideScope as number | undefined });
      data.write(`results/search-${queries.length}.json`, redactor.clean(result));
      calls.push({ operation: 'search', query, durationMs: Date.now() - started, status: result.status, error: result.error, backend: result.backend });
    }
    // Seeds are an explicit collection path, even when every query is empty. No hidden fallback or new URL is used.
    for (const url of source.urls) {
      const started = Date.now();
      let result: RetrievalResult;
      try { result = await executor.execute('web_fetch', { url }, signal) as RetrievalResult; }
      catch (error) { result = { status: 'unknown', signals: [], raw: '', provenance: 'live', error: redactor.clean(String(error)) }; }
      fetches.push({ url, result }); data.write(`results/fetch-${fetches.length}.json`, redactor.clean(result));
      calls.push({ operation: 'fetch', url, durationMs: Date.now() - started, status: result.status, error: result.error, backend: result.backend,
        pages: result.pages?.map(page => ({ url: page.url, chars: page.text.length, preview: page.text.slice(0, 1000), truncated: page.truncated })) ?? [] });
    }
    const coverage = summarizeDiscovery(source.urls, source.allowedDomains, queries, fetches);
    trace.emit('run_completed', { purpose: 'reference probe finished; candidate and text counts are not facts', coverage, calls, gaps });
    const summary = redactor.clean({ target: target.id, runId, at: new Date().toISOString(), sourceConfigHash: hash(configs), queryPlanHash: hash(plan), allowedDomains: source.allowedDomains, coverage, calls, gaps, traceIssues: validateTrace(data.lines(trace.key)) });
    data.write('latest.json', summary);
    console.log(JSON.stringify({ target: target.id, runId, coverage, gaps, traceIssues: summary.traceIssues }));
    return summary;
  } finally { await registry.close(); await builder.mcpPool.close(); }
}));
new FileStore(out).write('summary.json', results.map((result, index) => result.status === 'fulfilled' ? result.value : redactor.clean({ target: plan.targets[index].id, error: String(result.reason) })));
if (results.some(result => result.status === 'rejected' || result.value.traceIssues.length || result.value.coverage.referenceTextAvailability.count < result.value.coverage.referenceCount)) process.exitCode = 1;
