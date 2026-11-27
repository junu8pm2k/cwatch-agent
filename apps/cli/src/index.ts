import { existsSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseAgentTask, GenericTaskSchema, isInvestigationTask } from "@cwatch/core/types";
import { FileStore } from "@cwatch/shared/sessions/storage";
import { SourceServerBuilder, SourceConfigsSchema, readSourceConfigs } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ReplayModel, PiModel } from "@cwatch/shared/agent/models";
import { runAgent, type RunResult } from '@cwatch/server-core/runtime/agent';
import { runInvestigation, replayState } from "@cwatch/server-core/runtime/investigation";
import { ActionPolicy, ApprovalManager, parsePermissionMode } from "@cwatch/shared/agent/core/permission-manager";
import { handleExtensionCommand } from "./commands/extensions.ts";
import { UserMcpStore, mcpSecrets } from "@cwatch/shared/mcp/storage";
import { UserMcpSource } from "@cwatch/shared/mcp/source";
import { SkillStore } from "@cwatch/shared/skills/storage";
import { DEFAULT_LIMITS, resolveLimits, type RunLimits } from "@cwatch/shared/agent/core/budgets";
import { apiSecrets } from "@cwatch/shared/sources/api-tools";
import { hash } from "@cwatch/core/types";
import { Trace, Redactor } from '@cwatch/shared/sessions/trace';
import { exportToLangfuse } from '@cwatch/shared/sessions/langfuse';
const limitFlags: Record<keyof RunLimits, string> = { maxSteps: 'max-steps', maxToolCalls: 'max-tool-calls', maxSameToolCalls: 'max-same-tool-calls', maxConsecutiveToolFailures: 'max-consecutive-tool-failures', contextChars: 'context-chars', maxResponseChars: 'max-response-chars', maxOutputTokens: 'max-output-tokens', maxTokens: 'max-tokens', timeoutMs: 'timeout', modelTimeoutMs: 'model-timeout', toolTimeoutMs: 'tool-timeout' };
function readLimits(): Partial<RunLimits> {
  const supplied: Partial<RunLimits> = {};
  for (const [key, flag] of Object.entries(limitFlags)) {
    const index = args.indexOf('--' + flag);
    if (index >= 0) supplied[key as keyof RunLimits] = Number(args[index + 1] ?? NaN);
  }
  resolveLimits(supplied);
  return supplied;
}

if (existsSync('.env')) process.loadEnvFile('.env');
const [command, ...args] = process.argv.slice(2);
function option(name: string, fallback: string): string { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1] ?? fallback; }
const out = resolve(option('out', '.runtime'));
const json = (path: string) => JSON.parse(readFileSync(resolve(path), 'utf8'));
async function main(): Promise<void> {
  if (!command || command === 'help') {
    const defaults = (Object.keys(limitFlags) as Array<keyof RunLimits>).map(key =>
      '--' + limitFlags[key] + ' ' + (key === 'maxSameToolCalls' ? '(follows --max-tool-calls)' : DEFAULT_LIMITS[key]));
    console.log('run --mode replay|live [--instruction TEXT --source slug1,slug2] [--chat] --task examples/task-agent.json --sources examples/sources.json --out artifacts/demo [--permission explore|ask|allow-all]\n--chat: 通用 Agent 真实模式多轮对话，输入 /exit 结束\nlimits: ' + defaults.join(' ') + '\nrun extensions: [--workspace DIR] [--mcp slug1,slug2] [--skills skill1,skill2]\nmcp add|list|test|enable|disable|remove (project MCP configuration)\nskills install|list|show|enable|disable|remove (local directory or GitHub)\npermission: explore (default), ask (approve writes), allow-all (no approval)\ninspect --out DIR\nrecover --out DIR\nreplay --out DIR --run RUN_ID\ntrace --out DIR --run RUN_ID (export structured JSON)');
    return;
  }
  if (await handleExtensionCommand(command, args)) return;
  const permission = command === 'run' ? parsePermissionMode(option('permission', 'explore')) : 'explore';
  const limits = command === 'run' ? readLimits() : undefined;
  const store = new FileStore(out);
  if(command==='trace'){
    const runId=option('run','');if(!/^[a-zA-Z0-9_-]+$/.test(runId))throw Error('provide_valid_trace_run_id');
    const secrets=Object.entries(process.env).filter(([name])=>/KEY|TOKEN|SECRET|PASSWORD/.test(name)).map(([,value])=>value??'');
    const source=store.lines<import('@cwatch/shared/sessions/trace').TraceEvent>('traces/'+runId+'.jsonl');if(!source.length)throw Error('trace_not_found');
    if(source.some(event=>event.runId!==runId||event.taskId!==source[0].taskId))throw Error('trace_identity_mismatch');
    const trace=new Trace(store,source[0].taskId,runId,new Redactor(secrets)),document=trace.exportStructured();
    if (args.includes('--langfuse')) {
      const result = await exportToLangfuse(trace);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'exported') process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(document,null,2));if(!document.integrity.valid)process.exitCode=1;return;
  }
  if (command === 'inspect') { console.log(JSON.stringify({ executions: store.executions() }, null, 2)); return; }
  if (command === 'replay') { console.log(JSON.stringify(replayState(store, option('run', '')), null, 2)); return; }
  if (command !== 'run' && command !== 'recover') throw new Error('unknown command');
  // Exclusive single-writer lock. After an abnormal process exit, remove .lock after confirming no process uses this output directory.
  const lock = resolve(out, '.lock'); const fd = openSync(lock, 'wx');
  try {
    if (command === 'recover') { console.log(JSON.stringify({ interruptedExecutions: store.recover(), policy: 'unknown; no automatic tool replay' })); return; }
    store.recover();
    const task = args.includes('--instruction') ? GenericTaskSchema.parse({kind:'agent',taskId:'task-'+Date.now(),instruction:option('instruction',''),allowedSources:option('source','').split(',').filter(Boolean)}) : parseAgentTask(json(option('task', 'examples/task-agent.json')));
    const workspace = resolve(option('workspace', process.cwd())), custom = new UserMcpStore(workspace);
    const selectedNames = option('mcp', '').split(',').map(name => name.trim()).filter(Boolean);
    custom.select(selectedNames); // Explicit operator selection expands only this task's allowed sources.
    task.allowedSources = [...new Set([...task.allowedSources, ...selectedNames])];
    const configured = custom.list();
    const userMcp = custom.select(task.allowedSources.filter(name => configured.some(server => server.slug === name)));
    const userSkills = new SkillStore(workspace).select(option('skills', '').split(',').map(name => name.trim()).filter(Boolean));
    const configs = readSourceConfigs(option('sources', 'examples/sources.json')).filter(config => task.allowedSources.includes(config.slug));
    if (userMcp.some(server => configs.some(config => config.slug === server.slug))) throw new Error('mcp_source_slug_collision');
    const mode = option('mode', 'replay'); if (mode !== 'live' && mode !== 'replay') throw new Error('mode must be replay or live');
    const chat = args.includes('--chat');
    if (chat && (mode !== 'live' || isInvestigationTask(task))) throw new Error('chat_requires_live_generic_agent');
    if (chat && !process.stdin.isTTY) throw new Error('chat_requires_interactive_terminal');
    if (mode === 'replay' && userMcp.length) throw new Error('custom_mcp_requires_live_mode: use mcp test for discovery without a model');
    const controller = new AbortController(); const stop = () => controller.abort(new Error('user_cancelled')); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const registry = new ToolRegistry(), builder = new SourceServerBuilder(process.cwd());
    try {
      const initialGaps = await builder.register(configs, mode, registry, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
      const configuredSecrets = [...userMcp.flatMap(config => mcpSecrets(config, process.env)), ...configs.flatMap(config => config.active && config.api ? apiSecrets(config.api) : [])];
      for (const config of userMcp) {
        const source = builder.mcpPool.acquire('custom:' + hash(config), () => new UserMcpSource(config, workspace));
        try { await registry.register(config.slug, 'mcp', source, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])); }
        catch (error) { await source.close(); initialGaps.push('source_unavailable:' + config.slug + ':' + String(error)); }
      }
      const model = mode === 'replay' ? ReplayModel.fromFile(resolve(option('script', isInvestigationTask(task)?'fixtures/model-script.json':'fixtures/model-script-agent.json'))) : PiModel.fromEnvironment();
      const approvals = new ApprovalManager(async (request, signal) => {
        if (!process.stdin.isTTY) throw new Error('approval_requires_interactive_terminal');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { const answer = await rl.question(`审批 ${request.requestId}\n任务 ${request.taskId} 工具 ${request.tool}\n参数 ${request.argsSummary}\n哈希 ${request.argsHash}${request.expiresAt ? ' 到期 ' + request.expiresAt : ''}\n输入完整 requestId 以批准，其他输入拒绝：`, { signal }); return answer.trim() === request.requestId; }
        finally { rl.close(); }
      });
      const nextUserMessage = async (answer: RunResult, signal: AbortSignal): Promise<string | null> => {
        console.log('\n' + answer.response + '\n');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const closed = new Promise<null>(resolve => rl.once('close', () => resolve(null)));
          while (true) {
            const text = await Promise.race([rl.question('继续追问（/exit 结束）：', { signal }).then(value => value.trim()), closed]);
            if (text === null || text === '/exit') return null;
            if (text) return text;
          }
        } finally { rl.close(); }
      };
      const result = await (isInvestigationTask(task)?runInvestigation:runAgent)(task, model, registry, store, mode, { ...limits, ...(chat ? { nextUserMessage } : {}), workspaceRoot: workspace, initialGaps, userSkills, secrets: [...configuredSecrets, ...Object.entries(process.env).filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD/.test(name)).map(([, value]) => value ?? '')], onPlanSubmitted: async (plan, path) => { store.append('plan-submissions.jsonl', { taskId: plan.taskId, path, submittedAt: new Date().toISOString() }); console.error('计划已保存并提交：' + path); } }, controller.signal, new ActionPolicy(permission), approvals);
      console.log(JSON.stringify({ ...result, report: result.report ? store.path(result.report) : undefined, trace: result.traceArtifacts?.available?store.path(result.traceArtifacts.structuredPath):undefined,traceEvents:store.path('traces/'+result.runId+'.jsonl') }, null, 2));
      if (result.status === 'failed' || result.status === 'cancelled') process.exitCode = 1;
    } finally { await registry.close(); await builder.mcpPool.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally { closeSync(fd); unlinkSync(lock); }
}
main().catch(e => { console.error(String(e)); process.exitCode = 1; });
