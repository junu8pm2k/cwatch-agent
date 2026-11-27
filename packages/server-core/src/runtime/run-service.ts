import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { id, now, parseTask, parseAgentTask, AgentTaskSchema, isInvestigationTask, hash, abortable, type AgentTask, type CompetitorTask, type ModelPort, type Decision, type Plan } from '@cwatch/core/types';
import type { RunSnapshot, RunProfile, RunActivity, RunStartInput, RunMessageInput, PendingRunApproval, WorkbenchExtensions, SkillDetail, McpTestResult, RunModelChoice, TaskIntent, WorkbenchProject, ReportReviewView, InvestigationAssessment } from '@cwatch/core/types/runs';
import { reasoningEfforts } from '@cwatch/core/types/runs';
import { ActionPolicy, ApprovalManager, type ApprovalRequest } from '@cwatch/shared/agent/core/permission-manager';
import { SourceServerBuilder, readSourceConfigs, type SourceConfig } from '@cwatch/shared/sources/server-builder';
import { allowedUrl } from '@cwatch/shared/sources/web';
import { ReplayModel, PiModel } from '@cwatch/shared/agent/models';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { proxyToolName, registeredToolName } from '@cwatch/shared/tools/tool-names';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Redactor, Trace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import type { StructuredTrace } from '@cwatch/shared/sessions/structured-trace';
import { UserMcpStore, mcpSecrets } from '@cwatch/shared/mcp/storage';
import { UserMcpSource } from '@cwatch/shared/mcp/source';
import { SkillStore, parseSkill } from '@cwatch/shared/skills/storage';
import { reportedTokens } from '@cwatch/shared/agent/core/budgets';
import { apiSecrets } from '@cwatch/shared/sources/api-tools';
import { runInvestigation, type RunResult } from './investigation.ts';
import { runAgent } from './agent.ts';
import { WorkbenchConnections, providerId } from './connections.ts';
import { acquireHostLock, HostLockError, type HostLock } from './host-lock.ts';
import type { Claim, Comparison, EventRecord, Evidence, FactVersion, Review } from '@cwatch/shared/intelligence/evidence';
import { decideTaskIntent } from './task-intent.ts';
import { addReportAnnotation, decideReportReply, readReview, reviewSummary, reviewView, saveReportSchema, saveReportVersion, writeReview, type ReportReviewRecord } from './report-review.ts';

export { HostLockError };

function safeHostname(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}
function verifySnapshot(store: FileStore, item: Evidence): boolean {
  try { const path = store.path(item.rawPath); return existsSync(path) && hash(readFileSync(path, 'utf8')) === item.snapshotHash; }
  catch { return false; }
}

const genericTask = () => ({ kind: 'agent' as const, taskId: 'general-agent-task', instruction: '读取 README.md，说明项目能力和运行方法，并说明依据。', allowedSources: [] as string[] });
const definitions = [
  { id: 'standard', name: '官网与发布', description: '通用网页读取', task: 'examples/task.json', sources: ['examples/sources.json'] },
  { id: 'web', name: '联网调研', description: '联网搜索 / 网页读取；真实模式使用配置的搜索服务', task: 'examples/task-web.json', sources: ['examples/sources-web.json'] },
  { id: 'adapters', name: '浏览器读取', description: '只读浏览器', task: 'examples/task-adapters.json', sources: ['examples/sources-adapters.json'] },
  { id: 'agent', name: '通用 Agent', description: '输入任务，选择 Skill 和工具，由 Agent 执行', task: 'examples/task-agent.json', sources: ['examples/sources-web.json'] },
];
const names: Record<string,string> = { official: '官方网站', browser: '浏览器读取', web: '联网搜索与读取' };
const domainItem = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
function defaultWebToolBudgets(maxTokens: number) {
  if (maxTokens >= 1_000_000) return { maxSteps: 120, maxToolCalls: 300 };
  if (maxTokens <= 250_000) return { maxSteps: 40, maxToolCalls: 80 };
  return { maxSteps: 72, maxToolCalls: 160 };
}
const modelChoiceSchema = z.object({ id: z.string().trim().min(1).max(256), provider: providerId.optional(), reasoningEffort: z.enum(reasoningEfforts).optional() }).strict();
const taskIntentInputSchema = z.object({ instruction: z.string().trim().min(1).max(2000), model: modelChoiceSchema.optional() }).strict();
const startSchema = z.object({
  profile: z.enum(['agent','standard','web','adapters']).default('agent'), mode: z.enum(['live','replay']).default('replay'),
  permission: z.enum(['explore','ask','allow-all']).default('explore'), task: AgentTaskSchema.optional(),
  projectId: z.string().uuid().optional(),
  skills: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(20).default([]),
  webDomains: z.array(domainItem).max(20).optional(),
  model: modelChoiceSchema.optional(),
  conversation: z.boolean().default(false),
  requirePlanApproval: z.boolean().optional(),
  limits: z.object({
    timeoutMs: z.number().int().min(1000).max(1_200_000).optional(),
    toolTimeoutMs: z.number().int().min(1000).max(300_000).optional(),
    maxTokens: z.number().int().min(100).max(3_000_000).optional(),
    maxSteps: z.number().int().min(1).max(180).optional(),
    maxToolCalls: z.number().int().min(1).max(480).optional(),
    maxSameToolCalls: z.number().int().min(1).max(480).optional(),
    maxConsecutiveToolFailures: z.number().int().min(1).max(20).optional(),
  }).strict().default({}),
}).strict();
const active = (status: RunSnapshot['status']) => ['preparing','running','awaiting_approval','awaiting_user','cancelling'].includes(status);
const investigationToolStages = new Map([
  ['workflow__save_plan', 0],
  ['web_search', 1], ['web_fetch', 1], ['workflow__collection_status', 1], ['workflow__assess_search', 1], ['workflow__extract_signal', 1],
  ['workflow__analyze', 2], ['workflow__submit_analysis', 2],
  ['workflow__review', 3], ['workflow__draft', 4],
]);
const messageSchema = z.object({ messageId: z.string().uuid(), text: z.string().trim().min(1).max(24000) }).strict();
const reportMessageSchema = messageSchema.extend({ text: z.string().trim().min(1).max(6000) });
const projectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const projectMoveSchema = z.object({ projectId: z.string().uuid().nullable() }).strict();
const runTitleSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict();
interface Pending { request: PendingRunApproval; resolve: (answer: boolean | string)=>void; signal:AbortSignal }
interface Managed { view:RunSnapshot; data:FileStore; controller:AbortController; pending:Map<string,Pending>; listeners:Set<(view:RunSnapshot)=>void>; job?:Promise<void>; reportPath?:string; tools:Map<string,string>; redactor:Redactor; input?: { signal: AbortSignal; resolve: (message: string | null) => void }; acceptedMessages?: Map<string,string> }
export interface RunServiceOptions {
  root: string; outputRoot?:string;
  /** Trusted host seams for deterministic integration tests; never accepted through HTTP. */
  modelFactory?: (mode:'live'|'replay', task:AgentTask, configs:SourceConfig[])=>ModelPort;
  intentModelFactory?: (choice?: RunModelChoice) => Pick<ModelPort, 'decide'>;
  reportModelFactory?: (task: CompetitorTask) => Pick<ModelPort, 'decide'>;
  configureRegistry?: (registry:ToolRegistry, signal:AbortSignal)=>Promise<void>;
}
export class RunService {
  readonly root:string; readonly outputRoot:string;
  readonly connections: WorkbenchConnections;
  private readonly runs=new Map<string,Managed>();
  private readonly reportReplies = new Map<string, AbortController>();
  private readonly workspaceData: FileStore;
  private readonly hostLock: HostLock;
  private closed=false;
  constructor(readonly options:RunServiceOptions) {
    this.root=resolve(options.root);this.outputRoot=resolve(options.outputRoot??resolve(this.root,'.runtime','web'));
    this.connections=new WorkbenchConnections(this.root);
    this.workspaceData = new FileStore(this.outputRoot);
    mkdirSync(this.outputRoot,{recursive:true});
    this.hostLock=acquireHostLock(this.outputRoot);
    try {
      for(const entry of readdirSync(this.outputRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[a-f0-9-]{36}$/.test(e.name))) {
        const data=new FileStore(resolve(this.outputRoot,entry.name)),saved=data.read<{view:RunSnapshot;reportPath?:string}>('summary.json',null!);
        if(!saved)continue;
        const view=saved.view;
        if(active(view.status)){data.recover();view.status='unknown';view.error='服务重启，之前的运行已中断；未自动重放工具。';view.endedAt=now();view.updatedAt=now();}
        view.approvals=[];view.activities=data.lines<RunActivity>('activity.jsonl').slice(-150);
        const run:Managed={view,data,reportPath:saved.reportPath,controller:new AbortController(),pending:new Map(),listeners:new Set(),tools:new Map(),redactor:this.redactor()};
        if (isInvestigationTask(view.task) && view.reportReady && run.reportPath && existsSync(data.path(run.reportPath))) {
          const review = readReview(data);
          if (!view.reportReview && !review.saved) {
            saveReportVersion(review, this.originalReport(run), view.endedAt ?? view.updatedAt);
            writeReview(data, review);
          }
          view.reportReview = reviewSummary(review);
        }
        this.runs.set(view.id,run);this.persist(run);
      }
    } catch(error){this.hostLock.release();throw error;}
  }
  setHostOrigin(origin: string): void {
    this.hostLock.setOrigin(origin);
  }
  private redactor(additional: string[] = []): Redactor {
    return new Redactor([...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''), ...this.connections.secrets(), ...additional]);
  }
  private profileSourceConfigs(profile: (typeof definitions)[number]): SourceConfig[] {
    const bySlug = new Map<string, SourceConfig>();
    for (const file of profile.sources) {
      const full = resolve(this.root, file);
      if (!existsSync(full)) continue;
      for (const source of readSourceConfigs(full)) {
        if (!bySlug.has(source.slug)) bySlug.set(source.slug, source);
      }
    }
    return [...bySlug.values()];
  }
  profiles():RunProfile[] {
    return definitions.map(profile=>({id:profile.id,name:profile.name,description:profile.description,
      task:profile.id==='agent'?genericTask():parseTask(JSON.parse(readFileSync(resolve(this.root,profile.task),'utf8'))),
      sources:[...this.profileSourceConfigs(profile).map(source=>({slug:source.slug,name:names[source.slug]??source.slug,channel:['api','mcp'].includes(source.kind)?'mcp':'builtin',active:source.active})),...new UserMcpStore(this.root).list().map(source=>({slug:source.slug,name:'自定义 · '+source.slug,channel:'mcp',active:source.enabled}))],
    }));
  }
  skills(){return new SkillStore(this.root).list().map(item=>({name:item.name,description:item.description,enabled:item.enabled}));}
  list():RunSnapshot[] {return [...this.runs.values()].sort((a,b)=>b.view.createdAt.localeCompare(a.view.createdAt)).map(run=>this.snapshot(run));}
  projects(): WorkbenchProject[] { return this.workspaceData.read('projects.json', []); }
  createProject(raw: unknown): WorkbenchProject {
    const { name } = projectSchema.parse(raw);
    const projects = this.projects();
    if (projects.some(project => project.name.toLowerCase() === name.toLowerCase())) throw Error('project_name_conflict: 已有同名项目。');
    const project = { id: id(), name, createdAt: now() };
    this.workspaceData.write('projects.json', [...projects, project]);
    return project;
  }
  private verifyProject(projectId?: string | null): void {
    if (projectId && !this.projects().some(project => project.id === projectId)) throw Error('project_not_found: 项目不存在。');
  }
  moveRun(runId: string, raw: unknown): RunSnapshot {
    const { projectId } = projectMoveSchema.parse(raw);
    const run = this.require(runId);
    this.verifyProject(projectId);
    if (run.view.projectId !== (projectId ?? undefined)) {
      run.view.projectId = projectId ?? undefined;
      this.changed(run);
    }
    return this.snapshot(run);
  }
  renameRun(runId: string, raw: unknown): RunSnapshot {
    const { title } = runTitleSchema.parse(raw);
    const run = this.require(runId);
    const cleaned = run.redactor.clean(title);
    if (run.view.title !== cleaned) {
      run.view.title = cleaned;
      this.changed(run);
    }
    return this.snapshot(run);
  }
  get(runId:string):RunSnapshot {return this.snapshot(this.require(runId));}
  private require(runId:string):Managed {const run=this.runs.get(runId);if(!run)throw Error('run_not_found');return run;}
  private snapshot(run:Managed):RunSnapshot {return structuredClone({...run.view,approvals:[...run.pending.values()].map(p=>p.request)});}
  private persist(run:Managed):void {run.data.write('summary.json',{view:{...run.view,activities:[],approvals:[]},reportPath:run.reportPath});}
  private changed(run:Managed):void {
    run.view.updatedAt=now();run.view.revision=(run.view.revision??0)+1;this.persist(run);const snapshot=this.snapshot(run);
    for(const listener of run.listeners)try{listener(snapshot);}catch{/* A disconnected UI cannot stop the investigation. */}
  }
  private activity(run:Managed,kind:RunActivity['kind'],message:string,extra:Partial<RunActivity>={}):void {
    const toolStage = extra.tool ? investigationToolStages.get(extra.tool) : undefined;
    const stage = isInvestigationTask(run.view.task) ? toolStage ?? Math.min(run.view.stage, 4) : undefined;
    const event=run.redactor.clean({sequence:(run.view.activities.at(-1)?.sequence??0)+1,timestamp:now(),kind,message:message.slice(0,600),stage,...extra});
    run.view.activities.push(event);run.view.activities=run.view.activities.slice(-150);run.data.append('activity.jsonl',event);this.changed(run);
  }
  subscribe(runId:string,listener:(snapshot:RunSnapshot)=>void):()=>void {const run=this.require(runId);run.listeners.add(listener);return()=>{run.listeners.delete(listener);};}
  async taskIntent(raw: unknown, callerSignal: AbortSignal): Promise<TaskIntent> {
    if (this.closed) throw Error('service_closed');
    const { instruction, model: choice } = taskIntentInputSchema.parse(raw);
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const model = this.options.intentModelFactory?.(choice) ?? PiModel.fromConfig(this.connections.resolveModel(choice));
    const request = this.redactor().clean(instruction);
    try {
      return await abortable(decideTaskIntent(model, request, signal), signal);
    } catch (error) {
      callerSignal.throwIfAborted();
      if (signal.aborted) throw Error('task_intent_timeout: 判断任务类型超时，请重试。');
      if (error instanceof Error && error.message === 'invalid_task_intent') throw Error('task_intent_unavailable: 模型未返回有效的任务类型，请重试或更换模型。');
      throw Error('task_intent_unavailable: 暂时无法判断任务类型，请检查模型连接后重试。');
    }
  }
  start(raw:RunStartInput):RunSnapshot {
    if(this.closed)throw Error('service_closed');
    if([...this.runs.values()].filter(r=>active(r.view.status)).length>=2)throw Error('run_capacity:最多同时运行两项调查');
    const input=startSchema.parse(raw),profile=definitions.find(p=>p.id===input.profile)!;
    this.verifyProject(input.projectId);
    const task=parseAgentTask(input.task??(profile.id==='agent'?genericTask():JSON.parse(readFileSync(resolve(this.root,profile.task),'utf8'))));
    if((profile.id==='agent')===isInvestigationTask(task))throw Error('task_template_mismatch');
    if(input.conversation&&isInvestigationTask(task))throw Error('conversation_requires_generic_agent');
    if(input.model&&input.mode!=='live')throw Error('离线演示使用预设脚本。');
    const selectedModel=input.model?this.connections.resolveModel(input.model):undefined;
    const overrideDomains=input.mode==='live'
      ? [...new Set((input.webDomains?.length?input.webDomains:isInvestigationTask(task)?task.competitor.domains.map(d=>d.trim().toLowerCase()).filter(Boolean):[]))]
      : [];
    const policy = isInvestigationTask(task) ? task.evidencePolicy : undefined;
    if (policy && input.mode === 'replay' && !this.options.modelFactory) throw Error('指定来源与阶段核验请使用真实运行。');
    const allowedDomains = overrideDomains.filter(host => host !== '*');
    const specifiedUrls = (policy?.sources ?? []).map(source => {
      try { return allowedUrl(source.url, policy?.scope === 'only' || !allowedDomains.length ? ['*'] : allowedDomains).href; }
      catch { throw Error('请填写可访问的公开 HTTPS 来源网址，并确认它属于限定域名。'); }
    });
    if (new Set(specifiedUrls).size !== specifiedUrls.length) throw Error('指定来源网址重复，请合并重复项。');
    if (policy && isInvestigationTask(task)) {
      task.evidencePolicy = { ...policy, sources: policy.sources.map((source, index) => ({ ...source, url: specifiedUrls[index] })) };
      if (policy.scope === 'only') task.competitor.domains = [...new Set(specifiedUrls.map(url => new URL(url).hostname))];
      else if (allowedDomains.length) task.competitor.domains = allowedDomains;
    }
    const rawConfigs=this.profileSourceConfigs(profile).filter(c=>task.allowedSources.includes(c.slug));
    const configs=rawConfigs.map(config=>{
      if(input.mode==='live'&&config.slug==='web'&&config.kind==='web'){
        if (policy?.scope === 'only') return { ...config, urls: specifiedUrls, allowedDomains: [...new Set(specifiedUrls.map(url => new URL(url).hostname))], restrictToUrls: true };
        const concrete=allowedDomains;
        const urls = specifiedUrls.length ? specifiedUrls : config.urls;
        if(concrete.length){
          for(const host of concrete)allowedUrl('https://'+host,[host]);
          return {...config,urls,allowedDomains:concrete};
        }
        return {...config,urls,allowedDomains:['*']};
      }
      return config;
    });
    const customStore=new UserMcpStore(this.root),custom=customStore.select(task.allowedSources.filter(slug=>customStore.list().some(c=>c.slug===slug)));
    if(custom.some(c=>configs.some(config=>config.slug===c.slug)))throw Error('mcp_source_slug_collision');
    if(input.mode==='replay'&&custom.length)throw Error('custom_mcp_requires_live_mode');
    for(const slug of task.allowedSources)if(!configs.some(c=>c.slug===slug)&&!custom.some(c=>c.slug===slug))throw Error('source_not_configured:'+slug);
    const userSkills=new SkillStore(this.root).select(input.skills);
    const model=this.options.modelFactory?.(input.mode,task,configs)??(input.mode==='live'
      ?PiModel.fromConfig(selectedModel??this.connections.resolveModel())
      :this.replayModel(task,configs));
    const searchOverride=input.mode==='live'?this.connections.searchOptions():undefined;
    const customSecrets=custom.flatMap(config=>mcpSecrets(config,process.env));
    const runId=id(),createdAt=now(),run:Managed={
      view:{id:runId,task,profile:input.profile,mode:input.mode,permission:input.permission,status:'preparing',createdAt,updatedAt:createdAt,activities:[],approvals:[],gaps:[],claims:[],toolCalls:0,modelTurns:0,totalTokens:0,reportReady:false,stage:0},
      data:new FileStore(resolve(this.outputRoot,runId)),controller:new AbortController(),pending:new Map(),listeners:new Set(),tools:new Map(),redactor:this.redactor(customSecrets),
    };
    if(input.model)run.view.model=input.model;
    if(input.projectId)run.view.projectId=input.projectId;
    if(isInvestigationTask(task))run.view.reportReview={revision:0};
    if (isInvestigationTask(task) && (input.permission !== 'explore' || input.requirePlanApproval)) run.view.planApproval = { status: 'preparing' };
    if(input.conversation&&!isInvestigationTask(task)){
      run.view.conversation=true;run.view.messages=[{id:id(),role:'user',content:run.redactor.clean(task.instruction),createdAt}];run.acceptedMessages=new Map();
    }
    this.runs.set(runId,run);this.activity(run,'system',input.mode==='replay'?'离线演示已启动，所有业务数据均为合成快照。':isInvestigationTask(task)?'调查已启动，正在准备来源。':'任务已启动。');
    run.job=(async()=>{
      const toolTimeoutMs = input.limits.toolTimeoutMs ?? 120_000;
      const registry=new ToolRegistry(),builder=new SourceServerBuilder(this.root,undefined,searchOverride,toolTimeoutMs);
      const timeout=setTimeout(()=>run.controller.abort(new DOMException('run preparation timeout','TimeoutError')),input.limits.timeoutMs??180000);
      try {
        const signal=run.controller.signal,initialGaps=await builder.register(configs,input.mode,registry,AbortSignal.any([signal,AbortSignal.timeout(25000)]));
        const secrets=[...customSecrets,...this.connections.secrets(),...configs.flatMap(c=>c.active&&c.api?apiSecrets(c.api):[]),...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??'')];
        for(const config of custom){const mcpToken=this.connections.mcpToken(config.slug);const client=builder.mcpPool.acquire('custom:'+hash({config,tokenHash:mcpToken?hash(mcpToken):''}),()=>new UserMcpSource(config,this.root,process.env,fetch,mcpToken));try{await registry.register(config.slug,'mcp',client,signal);}catch(error){await client.close();initialGaps.push('source_unavailable:'+config.slug+':'+String(error));}}
        await this.options.configureRegistry?.(registry,signal);signal.throwIfAborted();
        clearTimeout(timeout); // Runtime owns active execution time; preparation must not time out an idle conversation.
        run.view.status='running';this.changed(run);
        const approvalTimeoutMs = Math.min(60_000, toolTimeoutMs);
        const approvals = new ApprovalManager(async (request, approvalSignal) => await this.awaitApproval(run, request, approvalSignal) === true, approvalTimeoutMs);
        const timeoutMs=input.limits.timeoutMs??0,maxTokens=input.limits.maxTokens??750_000;
        const toolBudgets=defaultWebToolBudgets(maxTokens);
        const result=await (isInvestigationTask(task)?runInvestigation:runAgent)(task,model,registry,run.data,input.mode,{
          timeoutMs,toolTimeoutMs,maxTokens,
          maxSteps:input.limits.maxSteps??toolBudgets.maxSteps,
          maxToolCalls:input.limits.maxToolCalls??toolBudgets.maxToolCalls,
          maxSameToolCalls:input.limits.maxSameToolCalls,
          maxConsecutiveToolFailures:input.limits.maxConsecutiveToolFailures,
          builtinTools:!isInvestigationTask(task),
          workspaceRoot:this.root,initialGaps,userSkills,secrets,onEvent:event=>this.onTrace(run,event),
          ...(input.conversation?{nextUserMessage:(answer:RunResult,turnSignal:AbortSignal)=>this.awaitUserMessage(run,answer,turnSignal)}:{}),
          onPlanSubmitted: async (plan, path, planSignal) => {
            const planHash = hash(plan);
            run.view.plan = run.redactor.clean(plan);
            if (run.view.planApproval) {
              run.view.planApproval = { ...run.view.planApproval, status: 'pending' };
              const request: ApprovalRequest = {
                requestId: id(), taskId: plan.taskId, tool: 'workflow__save_plan', argsHash: planHash,
                argsSummary: JSON.stringify(run.view.plan), createdAt: now(), expiresAt: new Date(Date.now() + approvalTimeoutMs).toISOString(),
              };
              let answer: boolean | string;
              try {
                answer = await this.awaitApproval(run, request, AbortSignal.any([planSignal, AbortSignal.timeout(approvalTimeoutMs)]));
              } catch {
                signal.throwIfAborted();
                run.view.planApproval.status = 'stopped';
                run.controller.abort(Error('调查计划审批未完成，本次调查已结束。'));
                throw signal.reason;
              }
              if (typeof answer === 'string') return { feedback: answer };
              if (!answer) {
                run.controller.abort(Error('调查计划未获批准，本次调查已结束。'));
                throw signal.reason;
              }
            }
            planSignal.throwIfAborted();
            run.data.append('plan-submissions.jsonl', { taskId: plan.taskId, path, submittedAt: now() });
            this.changed(run);
          },
        },signal,new ActionPolicy(input.permission),approvals);
        this.finish(run,result);
      }catch(error){run.view.status=run.controller.signal.aborted?'cancelled':'failed';run.view.error=run.redactor.clean(String(error));this.activity(run,'error',run.view.error);}
      finally {
        clearTimeout(timeout);await registry.close();await builder.mcpPool.close();
        if (run.view.planApproval && run.view.planApproval.status !== 'approved') run.view.planApproval.status = 'stopped';
        run.view.endedAt=now();this.activity(run,'system',run.view.status==='cancelled'?'任务已取消。':run.view.status==='complete'?(isInvestigationTask(task)?'报告草稿已生成，确认后可保存到我的调研。':'任务已完成。'):run.view.status==='partial'?'任务已结束，结果保留了信息缺口。':'运行已结束，请检查错误或来源缺口。');
      }
    })();
    // Jobs never become unhandled rejections if filesystem cleanup itself fails.
    run.job=run.job.catch(error=>{run.view.status='failed';run.view.error=run.redactor.clean(String(error));run.view.endedAt=now();try{this.changed(run);}catch{}});
    return this.snapshot(run);
  }
  private replayModel(task:AgentTask,configs:SourceConfig[]):ModelPort {
    if(!isInvestigationTask(task))return new ReplayModel([{kind:'call_tool',name:'read',args:{path:'README.md',offset:1,limit:40}},{kind:'respond',text:'本次通用 Agent 演示通过 read 读取 README.md。执行由预设脚本驱动，展示通用任务入口和工具调用，不代表真实模型总结。真实模式将按你的任务和选中 Skill 执行。'}]);
    const steps:Decision[]=[{kind:'call_tool',name:'workflow__save_plan',args:{taskId:task.taskId,objective:'核验 '+task.competitor.name+' 的动态，保留来源与时间缺口',sources:task.allowedSources,queries:[task.competitor.name+' '+task.product+' releases'],evidenceRequirements:['source URL and snapshot','independent publication time','entity attribution'],window:{start:task.window.start,end:task.window.end}}}];
    for(const config of configs.filter(c=>c.active)){
      if(config.kind==='browser')steps.push({kind:'call_tool',name:registeredToolName(config.slug,'builtin',{name:'browser_tool',namespace:'session',description:'Replay source read',action:'collect',inputSchema:{}}),args:{url:config.urls![0]}});
      else if(config.kind==='web')steps.push(config.urls?.length?{kind:'call_tool',name:'web_fetch',args:{url:config.urls[0]}}:{kind:'call_tool',name:'web_search',args:{query:task.competitor.name+' releases',limit:5}});
      else if(config.kind==='mcp')steps.push({kind:'call_tool',name:proxyToolName(config.slug,'search.news'),args:{query:task.competitor.name+' releases'}});
    }
    steps.push({kind:'call_tool',name:'workflow__analyze',args:{}},{kind:'call_tool',name:'workflow__review',args:{}},{kind:'call_tool',name:'workflow__draft',args:{narrative:'本报告来自明确标注的合成测试快照，仅用于演示调查、证据引用与规则审查。不能据此判断现实市场情况。',claimIds:'$analyzed_claim_ids'}},{kind:'respond',text:'演示报告已保存。'});
    return new ReplayModel(steps);
  }
  private onTrace(run:Managed,event:TraceEvent):void {
    run.view.traceRunId=event.runId;
    const task = run.view.task;
    const investigation = isInvestigationTask(task);
    const tracked = investigation && Boolean(task.evidencePolicy);
    const data=event.data,detail=(value:unknown)=>JSON.stringify(value).slice(0,2200);
    if(event.type==='pre_tool_use_request'){run.tools.set(String(data.requestId),String(data.toolName));return;}
    if(event.type==='model_usage'){run.view.modelTurns++;run.view.totalTokens+=reportedTokens(data.usage)??0;return;}
    if(event.type==='plan_submitted'){run.view.stage=1;this.activity(run,'plan','调查计划已保存并提交。',{stage:0});}
    else if(event.type==='decision_made'){
      const decision=data.decision as Decision;
      if(decision.kind!=='respond'){
        for(const call of decision.kind==='call_tools'?decision.calls:[decision]){
          if (investigation && !tracked && call.name === 'workflow__analyze') run.view.stage = 2;
          if (investigation && !tracked && call.name === 'workflow__review') run.view.stage = 3;
          if (investigation && call.name === 'workflow__draft' && (!tracked || run.view.stage >= 3 || run.view.review)) run.view.stage = 4;
          this.activity(run,/^(workflow|session)__/.test(call.name)?'analysis':'tool','准备调用 '+call.name,{tool:call.name,detail:detail(call.args)});
        }
      }
    }else if(event.type==='budget_exceeded'&&data.outcome==='skipped'){
      const tool=String(data.tool);
      this.activity(run,'tool',tool+' 已跳过（工具额度受限）',{tool,state:'skipped'});
    }else if(event.type==='execution_finished'){
      const tool=run.tools.get(String(data.requestId))??'工具';
      if(data.state==='completed')run.view.toolCalls++;
      const softErr=data.state==='completed'&&data.result&&typeof data.result==='object'&&typeof (data.result as {error?:unknown}).error==='string'?String((data.result as {error:string}).error):undefined;
      const errDetail=data.error?String(data.error).slice(0,2200):softErr?softErr.slice(0,2200):undefined;
      if (tracked && data.state === 'completed' && !errDetail) {
        if (tool === 'workflow__submit_analysis') run.view.stage = 3;
      }
      if (investigation && tool === 'workflow__review' && data.state === 'completed' && !errDetail) {
        const review = data.result as NonNullable<RunSnapshot['review']> & { reworkAvailable?: boolean };
        run.view.review = { decision: review.decision, issues: review.issues, evidenceRefs: review.evidenceRefs };
        run.view.stage = review.reworkAvailable ? 1 : 4;
      }
      this.activity(run,data.state==='completed'?'tool':'error',tool+(data.state==='completed'?' 已完成':' 未完成'),{tool,state:String(data.state),...(errDetail?{detail:errDetail}:{})});
    }else if(event.type==='evidence_saved'&&typeof data.reworkRound==='number'){
      run.view.reworkCount=data.reworkRound;
      if (data.collection) {
        run.view.stage = 2;
        run.view.assessment = { ...run.view.assessment, collection: data.collection as InvestigationAssessment['collection'] };
        this.changed(run);
      }
    }
    else if(event.type==='agent_process')this.activity(run,'system',data.state==='ready'?'Agent 子进程已就绪。':data.state==='exited'?'Agent 子进程已退出。':'Agent 进程：'+String(data.state));
    else if(event.type==='run_failed'||event.type==='run_cancelled') {
      if (typeof data.stage === 'string') run.view.stoppedAtStage = data.stage;
      this.activity(run,'error',String(data.error??event.type));
    }
  }
  private finish(run:Managed,result:RunResult):void {
    run.view.status=result.status;run.view.gaps=run.redactor.clean(result.gaps);run.view.error=result.error?run.redactor.clean(result.error):undefined;run.reportPath=result.report;run.view.reportReady=Boolean(result.report);
    if(result.status==='complete'||result.status==='partial')run.view.stage=5;
    if(isInvestigationTask(run.view.task)){
      const assessment = run.data.read<InvestigationAssessment | null>('assessments/' + result.runId + '.json', null);
      if (assessment) run.view.assessment = run.redactor.clean(assessment);
      if(!run.view.plan){
        const savedPlan=run.data.read<Plan|null>('plans/'+result.runId+'.json',null);
        if(savedPlan)run.view.plan=run.redactor.clean(savedPlan);
      }
      if(result.report){
        const claims=run.data.read<Claim[]>('claims/'+result.runId+'.json',[]),evidence=run.data.read<Evidence[]>('evidence/index.json',[]);
        run.view.claims=run.redactor.clean(claims.map(claim=>({id:claim.id,text:claim.text,evidence:claim.evidenceIds.flatMap(key=>{
          const item=evidence.find(e=>e.id===key);
          if(!item)return [];
          const domain=item.signal.entity.domain??safeHostname(item.signal.url);
          return [{
            source:item.signal.sourceSlug,url:item.signal.url,title:item.signal.content.title,publishedAt:item.signal.published_at,provenance:item.provenance,
            retrievedAt:item.signal.retrieved_at,excerpt:item.excerpt??item.signal.content.value,
            ...(domain?{domain}:{}),snapshotHash:item.snapshotHash,snapshotVerified:verifySnapshot(run.data,item),
            attribution:item.attribution,timeStatus:item.timeStatus,
          }];
        })})));
      }
      const persistedReview=run.data.read<(Review&{reworkCount?:number})|null>('reviews/'+result.runId+'.json',null);
      if(persistedReview){
        run.view.review=run.redactor.clean({decision:persistedReview.decision,issues:persistedReview.issues,evidenceRefs:persistedReview.evidenceRefs});
        if(typeof persistedReview.reworkCount==='number')run.view.reworkCount=persistedReview.reworkCount;
      }
      const comparisons=run.data.read<Comparison[]|null>('comparisons/'+result.runId+'.json',null);
      if(comparisons){
        const events=run.data.read<EventRecord[]>('facts/events.json',[]),versions=run.data.read<FactVersion[]>('facts/versions.json',[]);
        run.view.comparisons=run.redactor.clean(comparisons.map(comp=>{
          const event=events.find(e=>e.id===comp.eventId);
          const versionId=comp.currentVersions.at(-1)??comp.previousVersions.at(-1);
          const version=(versionId?versions.find(v=>v.id===versionId):undefined)??versions.find(v=>v.eventId===comp.eventId);
          const title=version?.title??event?.eventKey;
          return {
            eventId:comp.eventId,status:comp.status,previousVersions:comp.previousVersions,currentVersions:comp.currentVersions,
            ...(title?{title}:{}),...(event?.signalType?{signalType:event.signalType}:{}),
          };
        }));
      }
    }
  }
  private awaitApproval(run:Managed,request:ApprovalRequest,signal:AbortSignal):Promise<boolean | string>{
    signal.throwIfAborted();
    return new Promise<boolean | string>((resolve,reject)=>{
      const abort=()=>{cleanup();reject(signal.reason??Error('approval_cancelled'));};
      const cleanup=()=>{signal.removeEventListener('abort',abort);run.pending.delete(request.requestId);if(run.view.status==='awaiting_approval')run.view.status='running';this.changed(run);};
      run.pending.set(request.requestId,{request:run.redactor.clean(request),signal,resolve:allowed=>{cleanup();resolve(allowed);}});
      run.view.status='awaiting_approval';signal.addEventListener('abort',abort,{once:true});
      const isPlan = request.tool === 'workflow__save_plan';
      this.activity(run, 'approval', isPlan ? '等待审批调查计划。' : '等待人工审批：' + request.tool, { tool: request.tool });
      if(signal.aborted)abort();
    });
  }
  respondToApproval(runId:string,requestId:string,answer:boolean | { feedback: string },argsHash:string):void {
    const run=this.require(runId),pending=run.pending.get(requestId);
    if(!pending||pending.signal.aborted||Date.parse(pending.request.expiresAt)<=Date.now())throw Error('approval_not_pending');
    if(pending.request.argsHash!==argsHash)throw Error('approval_hash_mismatch');
    const isPlan = pending.request.tool === 'workflow__save_plan';
    if (typeof answer !== 'boolean') {
      if (!isPlan || !run.view.planApproval) throw Error('approval_plan_required');
      const feedback = run.redactor.clean(z.string().trim().min(1).max(2000).parse(answer.feedback));
      run.view.planApproval = { status: 'revising', feedback };
      pending.resolve(feedback);
      this.activity(run, 'approval', '已提交计划修改意见。', { tool: pending.request.tool, detail: feedback });
      return;
    }
    if (isPlan && run.view.planApproval) run.view.planApproval.status = answer ? 'approved' : 'stopped';
    pending.resolve(answer);
    this.activity(run, 'approval', isPlan ? (answer ? '已批准调查计划。' : '已拒绝调查计划。') : (answer ? '已批准这一次工具调用。' : '已拒绝这一次工具调用。'), { tool: pending.request.tool });
  }
  private awaitUserMessage(run:Managed,answer:RunResult,signal:AbortSignal):Promise<string|null>{
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{signal.removeEventListener('abort',abort);run.input=undefined;};
      const abort=()=>{cleanup();reject(signal.reason??Error('conversation_cancelled'));};
      run.input={signal,resolve:message=>{cleanup();resolve(message);}};
      signal.addEventListener('abort',abort,{once:true});
      try{
        this.finish(run,answer);
        run.view.messages!.push({id:id(),role:'assistant',content:run.redactor.clean(answer.response??''),createdAt:now()});
        run.view.status='awaiting_user';
        this.activity(run,'system','本轮已完成，可以继续追问或结束会话。');
        if(signal.aborted)abort();
      }catch(error){cleanup();reject(error);}
    });
  }
  sendMessage(runId:string,raw:RunMessageInput):RunSnapshot{
    const run=this.require(runId),message=messageSchema.parse(raw),digest=hash(message.text),previous=run.acceptedMessages?.get(message.messageId);
    if(previous){if(previous!==digest)throw Error('message_id_conflict');return this.snapshot(run);}
    if(this.closed||!run.view.conversation||run.view.status!=='awaiting_user'||!run.input||run.input.signal.aborted)throw Error('conversation_not_waiting');
    if((run.view.messages?.length??0)>=256)throw Error('conversation_message_limit');
    const waiter=run.input;
    run.acceptedMessages!.set(message.messageId,digest);
    run.view.messages!.push({id:message.messageId,role:'user',content:run.redactor.clean(message.text),createdAt:now()});
    run.view.status='running';
    try{this.changed(run);}catch(error){run.view.status='awaiting_user';run.view.messages!.pop();run.acceptedMessages!.delete(message.messageId);throw error;}
    waiter.resolve(message.text);
    return this.snapshot(run);
  }
  endConversation(runId:string):RunSnapshot{
    const run=this.require(runId);
    if(run.view.conversation&&['complete','partial'].includes(run.view.status))return this.snapshot(run);
    if(!run.view.conversation||run.view.status!=='awaiting_user'||!run.input||run.input.signal.aborted)throw Error('conversation_not_waiting');
    const waiter=run.input;run.view.status='running';
    try{this.activity(run,'system','正在结束会话。');}catch(error){run.view.status='awaiting_user';throw error;}
    waiter.resolve(null);return this.snapshot(run);
  }
  cancel(runId:string):RunSnapshot {const run=this.require(runId);if(active(run.view.status)){run.view.status='cancelling';this.activity(run,'system','正在取消调查并回收资源。');run.controller.abort(Error('user_cancelled'));}return this.snapshot(run);}
  delete(runId:string):{deleted:string} {
    if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('run_not_found');
    const run=this.require(runId);
    if(active(run.view.status)||this.reportReplies.has(runId))throw Error('run_active:运行中的任务无法删除，请先取消或结束会话');
    const dir=resolve(this.outputRoot,runId);
    if(!dir.startsWith(this.outputRoot+sep))throw Error('invalid_run_path');
    this.runs.delete(runId);
    if(existsSync(dir))rmSync(dir,{recursive:true,force:true});
    return{deleted:runId};
  }
  private listBuiltinSkillResources(dir:string,prefix=''):string[] {
    if(!existsSync(dir))return [];
    const results:string[]=[];
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;
      const key=prefix?prefix+'/'+entry.name:entry.name;
      if(entry.isDirectory())results.push(...this.listBuiltinSkillResources(join(dir,entry.name),key));
      else if(entry.isFile()&&key!=='SKILL.md')results.push(key);
    }
    return results.sort();
  }
  extensions():WorkbenchExtensions {
    const redactor=this.redactor();
    const sourceMap=new Map<string,{slug:string;name:string;channel:string;active:boolean;profiles:string[]}>();
    for(const profile of definitions){
      for(const source of this.profileSourceConfigs(profile)){
        const existing=sourceMap.get(source.slug);
        if(existing){
          if(!existing.profiles.includes(profile.name))existing.profiles.push(profile.name);
          existing.active=existing.active||source.active;
        }else{
          sourceMap.set(source.slug,{slug:source.slug,name:names[source.slug]??source.slug,channel:['api','mcp'].includes(source.kind)?'mcp':'builtin',active:source.active,profiles:[profile.name]});
        }
      }
    }
    const mcpServers=new UserMcpStore(this.root).list().map(server=>{
      const mcpToken=this.connections.mcpToken(server.slug);
      const serverRedactor=new Redactor([...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''),...mcpSecrets(server,process.env),...(mcpToken?[mcpToken]:[])]);
      return serverRedactor.clean({
        slug:server.slug,enabled:server.enabled,transport:server.transport,
        ...(server.url?{endpoint:server.url}:server.command?{endpoint:server.command}:{}),
        defaultAction:server.defaultAction,resultFormat:server.resultFormat,
        toolSemanticsCount:Object.keys(server.toolSemantics).length,
        hasAuth:Boolean(mcpToken||server.tokenEnv||Object.keys(server.env).length>0),
      });
    });
    const builtinSkills:WorkbenchExtensions['builtinSkills']=[];
    const skillsRoot=resolve(this.root,'skills');
    if(existsSync(skillsRoot)){
      for(const entry of readdirSync(skillsRoot,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(!entry.isDirectory()||entry.isSymbolicLink())continue;
        const skillDir=resolve(skillsRoot,entry.name),skillFile=join(skillDir,'SKILL.md');
        if(!skillDir.startsWith(skillsRoot+sep)||!existsSync(skillFile)||lstatSync(skillFile).isSymbolicLink())continue;
        try{
          const parsed=parseSkill(readFileSync(skillFile,'utf8'));
          builtinSkills.push({name:parsed.name,description:parsed.description,resources:this.listBuiltinSkillResources(skillDir)});
        }catch{/* Skip malformed local draft directories. */}
      }
    }
    const userSkills=new SkillStore(this.root).list().map(item=>({
      name:item.name,description:item.description,enabled:item.enabled,
      originKind:item.origin.kind,installedAt:item.installedAt,fileCount:item.files.length,
    }));
    return redactor.clean({builtinSources:[...sourceMap.values()],mcpServers,builtinSkills,userSkills,search:this.connections.searchSummary()});
  }
  addMcp(raw: unknown): void {
    const input=z.object({
      slug:z.string().trim().regex(/^[a-zA-Z0-9_-]{1,40}$/), url:z.string().trim().max(2048).url(),
      transport:z.enum(['auto','streamable-http','sse']).default('auto'),
      token:z.string().trim().min(1).max(4096).optional(), defaultAction:z.enum(['modify','collect']).default('modify'),
    }).strict().parse(raw);
    if(definitions.some(profile=>this.profileSourceConfigs(profile).some(source=>source.slug===input.slug)))throw Error('该名称与内置来源重复。');
    const { token, ...config } = input;
    const store=new UserMcpStore(this.root);
    store.add(config);
    if(token){
      try{this.connections.setMcpToken(input.slug,token);}
      catch(error){try{store.change(input.slug,'remove');}catch{/* ignore rollback failure */}throw error;}
    }
  }
  removeMcp(slug:string):WorkbenchExtensions {
    if(!/^[a-zA-Z0-9_-]{1,40}$/.test(slug))throw Error('mcp_not_found');
    new UserMcpStore(this.root).change(slug,'remove');
    this.connections.deleteMcpToken(slug);
    return this.extensions();
  }
  addSkill(raw: unknown): void {
    const { content }=z.object({content:z.string().min(1).max(60000)}).strict().parse(raw);
    const { name }=parseSkill(content);
    if(existsSync(join(this.root,'skills',name,'SKILL.md')))throw Error('该 Skill 名称已用于内置技能。');
    new SkillStore(this.root).installDocument(content);
  }
  removeSkill(name:string):WorkbenchExtensions {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw Error('skill_not_found');
    new SkillStore(this.root).change(name,'remove');
    return this.extensions();
  }
  skillDetail(name:string):SkillDetail {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw Error('skill_not_found');
    const redactor=this.redactor(),store=new SkillStore(this.root);
    const installed=store.list().find(item=>item.name===name);
    if(installed){
      const doc=store.select([name],true).documents[0];
      return redactor.clean({name:doc.name,kind:'user',description:doc.description,enabled:installed.enabled,body:doc.body,resources:doc.resources,installedAt:installed.installedAt,origin:installed.origin});
    }
    const skillsRoot=resolve(this.root,'skills'),skillDir=resolve(skillsRoot,name),skillFile=join(skillDir,'SKILL.md');
    if(skillDir.startsWith(skillsRoot+sep)&&existsSync(skillFile)&&!lstatSync(skillFile).isSymbolicLink()){
      const parsed=parseSkill(readFileSync(skillFile,'utf8'));
      return redactor.clean({name:parsed.name,kind:'builtin',description:parsed.description,enabled:true,body:parsed.body,resources:this.listBuiltinSkillResources(skillDir)});
    }
    throw Error('skill_not_found');
  }
  toggleSkill(name:string,enabled:boolean):WorkbenchExtensions {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw Error('skill_not_found');
    new SkillStore(this.root).change(name,enabled);
    return this.extensions();
  }
  toggleMcp(slug:string,enabled:boolean):WorkbenchExtensions {
    if(!/^[a-zA-Z0-9_-]{1,40}$/.test(slug))throw Error('mcp_not_found');
    new UserMcpStore(this.root).change(slug,enabled);
    return this.extensions();
  }
  async testMcp(slug:string,signal?:AbortSignal):Promise<McpTestResult> {
    if(!/^[a-zA-Z0-9_-]{1,40}$/.test(slug))throw Error('mcp_not_found');
    const config=new UserMcpStore(this.root).list().find(item=>item.slug===slug);
    if(!config)throw Error('mcp_not_found');
    const mcpToken=this.connections.mcpToken(slug);
    const serverRedactor=new Redactor([...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''),...mcpSecrets(config,process.env),...(mcpToken?[mcpToken]:[])]);
    const started=Date.now(),source=new UserMcpSource(config,this.root,process.env,fetch,mcpToken);
    const timeout=AbortSignal.timeout(15_000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    try{
      const tools=await source.listTools(combined);
      return serverRedactor.clean({slug,ok:true,durationMs:Date.now()-started,tools:tools.map(t=>({name:t.name,description:t.description??'',action:t.action}))});
    }catch(error){
      return serverRedactor.clean({slug,ok:false,durationMs:Date.now()-started,tools:[],error:error instanceof Error?error.message:String(error)});
    }finally{await source.close();}
  }
  private originalReport(run: Managed): string {
    if (!run.reportPath || !existsSync(run.data.path(run.reportPath))) throw Error('report_not_ready');
    return run.redactor.clean(readFileSync(run.data.path(run.reportPath), 'utf8'));
  }
  private reportContext(runId: string) {
    const run = this.require(runId), task = run.view.task;
    if (!isInvestigationTask(task)) throw Error('report_review_not_found');
    return { run, task, original: this.originalReport(run), record: readReview(run.data) };
  }
  private persistReportRevision(run: Managed, record: ReportReviewRecord): void {
    writeReview(run.data, record);
    run.view.reportReview = reviewSummary(record);
    this.changed(run);
  }
  reportReview(runId: string, saved = false): ReportReviewView {
    const { original, record } = this.reportContext(runId);
    return reviewView(record, original, saved);
  }
  annotateReport(runId: string, raw: unknown): ReportReviewView {
    const { run, original, record } = this.reportContext(runId);
    addReportAnnotation(record, original, run.redactor.clean(raw));
    this.persistReportRevision(run, record);
    return reviewView(record, original, false);
  }
  saveReport(runId: string, raw: unknown): ReportReviewView {
    const { revision } = saveReportSchema.parse(raw);
    const { run, original, record } = this.reportContext(runId);
    if (record.revision !== revision) throw Error('report_revision_conflict: 草稿已更新，请刷新后再保存。');
    if (record.saved?.revision !== revision) {
      saveReportVersion(record, original);
      this.persistReportRevision(run, record);
    }
    return reviewView(record, original, false);
  }
  async replyToReport(runId: string, raw: unknown, callerSignal: AbortSignal): Promise<ReportReviewView> {
    const { run, task, original, record } = this.reportContext(runId);
    const { messageId, text } = reportMessageSchema.parse(raw);
    const question = run.redactor.clean(text);
    const previous = record.messages.find(message => message.id === messageId);
    if (previous) {
      if (previous.content !== question) throw Error('message_id_conflict');
      return reviewView(record, original, false);
    }
    if (this.closed || this.reportReplies.has(runId)) throw Error('run_active: 上一条追问正在处理。');
    if (record.messages.length >= 128) throw Error('conversation_message_limit');
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    this.reportReplies.set(runId, controller);
    try {
      const model = this.options.reportModelFactory?.(task) ?? (run.view.mode === 'live' ? PiModel.fromConfig(this.connections.resolveModel(run.view.model)) : undefined);
      const answer = model ? await abortable(decideReportReply(model, task, reviewView(record, original, false), question, signal), signal)
        : '这是离线演示报告。你可以选中文字添加标注或提交校订，再保存报告。连接真实模型后可继续讨论证据与结论。';
      signal.throwIfAborted();
      const latest = readReview(run.data);
      const at = now();
      latest.messages.push({ id: messageId, role: 'user', content: question, createdAt: at }, { id: id(), role: 'assistant', content: run.redactor.clean(answer), createdAt: at });
      writeReview(run.data, latest);
      return reviewView(latest, original, false);
    } finally { this.reportReplies.delete(runId); }
  }
  report(runId: string, saved = false): string {
    const run = this.require(runId);
    if (saved || isInvestigationTask(run.view.task)) return this.reportReview(runId, saved).markdown;
    return this.originalReport(run);
  }
  trace(runId:string):StructuredTrace {const run=this.require(runId),traceId=run.view.traceRunId;if(!traceId)throw Error('trace_not_ready');
    return new Trace(run.data,run.view.task.taskId,traceId,run.redactor).exportStructured();}
  async wait(runId:string):Promise<RunSnapshot>{const run=this.require(runId);await run.job;return this.snapshot(run);}
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;
    for (const controller of this.reportReplies.values()) controller.abort();
    for(const run of this.runs.values())if(active(run.view.status))this.cancel(run.view.id);
    try{await Promise.allSettled([...this.runs.values()].map(r=>r.job));}finally{this.hostLock.release();}
  }
}
