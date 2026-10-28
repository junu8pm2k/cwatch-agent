import { existsSync, readFileSync } from 'node:fs';
import { parseTask, id } from "@cwatch/core/types";
import { SourceConfigsSchema, SourceServerBuilder } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { FileStore } from "@cwatch/shared/sessions/storage";
import { Trace, Redactor, validateTrace } from "@cwatch/shared/sessions/trace";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2), option = (name: string, fallback: string) => { const index = args.indexOf('--' + name); return index < 0 ? fallback : args[index + 1] ?? fallback; };
const task = parseTask(JSON.parse(readFileSync('examples/task-web.json', 'utf8'))), runId = id(), registry = new ToolRegistry(), store = new FileStore(option('out', 'artifacts/web-probe'));
const trace = new Trace(store, task.taskId, runId, new Redactor(Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET/.test(key)).map(([, value]) => value ?? '')));
trace.emit('run_started', { purpose: 'real web backend connectivity independent from planner model' });
const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync(option('sources', 'examples/sources-web.json'), 'utf8'))).filter(c => c.kind === 'web');
const signal = AbortSignal.timeout(110_000), results: unknown[] = [];
try {
  const gaps = await new SourceServerBuilder(process.cwd()).register(configs, 'live', registry, signal);
  const executor = new ToolExecutor(registry, new ActionPolicy(), new ApprovalManager(), store, trace, task, 50_000);
  const calls: Array<[string, Record<string, unknown>]> = [['web_search', { query: option('query', 'Node.js'), limit: 3 }]];
  if (!args.includes('--search-only')) calls.push(['web_fetch', { url: 'https://nodejs.org/en' }]);
  for (const [tool, args] of calls) {
    try { const result = await executor.execute(tool, args, signal) as any; results.push({ tool, status: result.status, backend: result.backend, searchResults: result.searchResults?.length ?? 0, pages: result.pages?.length ?? 0, error: result.error }); }
    catch (e) { results.push({ tool, error: String(e) }); }
  }
  trace.emit('run_completed', { gaps, results });
  const issues = validateTrace(store.lines(trace.key)); store.write('latest.json', trace.redactor.clean({ at: new Date().toISOString(), runId, gaps, results, traceIssues: issues })); console.log(JSON.stringify({ runId, gaps, results, traceIssues: issues }, null, 2));
  if (issues.length || results.some((r: any) => r.error || !['success_with_data', 'success_empty'].includes(r.status))) process.exitCode = 1;
} finally { await registry.close(); }
