import { SourceGuideTools } from '@cwatch/shared/sources/source-guides';
import { existsSync, readFileSync } from 'node:fs';
import { SourceConfigsSchema, SourceServerBuilder } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
import { FileStore } from "@cwatch/shared/sessions/storage";
import { Trace, Redactor } from "@cwatch/shared/sessions/trace";
import { id, parseTask } from "@cwatch/core/types";

// Real network probes still pass through the same policy executor. No raw pool endpoint exists.
if (existsSync('.env')) process.loadEnvFile('.env');
const task = parseTask(JSON.parse(readFileSync('examples/task.json', 'utf8'))), registry = new ToolRegistry();
const store = new FileStore('artifacts/source-probe'), runId = id(), redactor = new Redactor(Object.entries(process.env).filter(([k]) => /KEY|TOKEN|SECRET/.test(k)).map(([, v]) => v ?? ''));
const trace = new Trace(store, task.taskId, runId, redactor); trace.emit('run_started', { purpose: 'actual source connectivity, independent of model' });
const signal = AbortSignal.timeout(35_000);
const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync('examples/sources.json', 'utf8')));
const results: unknown[] = [];
try {
  const gaps = await new SourceServerBuilder(process.cwd()).register(configs, 'live', registry, signal);
  await registry.register('workflow','workflow',new SourceGuideTools(registry,task),signal);
  const executor = new ToolExecutor(registry, new ActionPolicy(), new ApprovalManager(), store, trace, task, 10_000);
  for (const [name, args] of [['web_fetch', { url: configs[0].urls![0] }]] as const) {
    try { results.push({ tool: name, result: redactor.clean(await executor.execute(name, args, signal)) }); }
    catch (e) { results.push({ tool: name, error: String(e) }); }
  }
  store.write('latest.json', redactor.clean({ at: new Date().toISOString(), gaps, results }));
  trace.emit('run_completed', { results, gaps }); console.log(JSON.stringify(results.map(r => { const item = r as any; return { tool: item.tool, status: item.result?.status, provenance: item.result?.provenance, signals: item.result?.signals?.length, error: item.error ?? item.result?.error }; }), null, 2));
} finally { await registry.close(); }
