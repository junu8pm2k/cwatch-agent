import { mkdirSync, readdirSync, readFileSync, openSync, closeSync, unlinkSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { id, now, parseTask, parseAgentTask, AgentTaskSchema, isInvestigationTask, hash, type AgentTask, type CompetitorTask, type ModelPort, type Decision, type Plan } from '@cwatch/core/types';
import type { RunSnapshot, RunProfile, RunActivity, RunStartInput, RunMessageInput, PendingRunApproval, WorkbenchExtensions, SkillDetail, McpTestResult } from '@cwatch/core/types/runs';
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
import type { Claim, Comparison, EventRecord, Evidence, FactVersion, Review } from '@cwatch/shared/intelligence/evidence';

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
function defaultWebToolBudgets(timeoutMs: number, maxTokens: number) {
  if (timeoutMs >= 600_000 || maxTokens >= 1_000_000) return { maxSteps: 120, maxToolCalls: 300 };
  if (timeoutMs <= 180_000 && maxTokens <= 250_000) return { maxSteps: 40, maxToolCalls: 80 };
  return { maxSteps: 72, maxToolCalls: 160 };
}
const startSchema = z.object({
  profile: z.enum(['agent','standard','web','adapters']).default('agent'), mode: z.enum(['live','replay']).default('replay'),
  permission: z.enum(['explore','ask','allow-all']).default('explore'), task: AgentTaskSchema.optional(),
  skills: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(20).default([]),
  webDomains: z.array(domainItem).max(20).optional(),
  conversation: z.boolean().default(false),
  limits: z.object({
    timeoutMs: z.number().int().min(1000).max(1_200_000).optional(),
    toolTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    maxTokens: z.number().int().min(100).max(3_000_000).optional(),
    maxSteps: z.number().int().min(1).max(180).optional(),
    maxToolCalls: z.number().int().min(1).max(480).optional(),
    maxSameToolCalls: z.number().int().min(1).max(480).optional(),
    maxConsecutiveToolFailures: z.number().int().min(1).max(20).optional(),
  }).strict().default({}),
}).strict();
const active = (status: RunSnapshot['status']) => ['preparing','running','awaiting_approval','awaiting_user','cancelling'].includes(status);
const messageSchema = z.object({ messageId: z.string().uuid(), text: z.string().trim().min(1).max(24000) }).strict();
interface Pending { request: PendingRunApproval; resolve: (allowed:boolean)=>void; signal:AbortSignal }
interface Managed { view:RunSnapshot; data:FileStore; controller:AbortController; pending:Map<string,Pending>; listeners:Set<(view:RunSnapshot)=>void>; job?:Promise<void>; reportPath?:string; tools:Map<string,string>; redactor:Redactor; input?: { signal: AbortSignal; resolve: (message: string | null) => void }; acceptedMessages?: Map<string,string> }
export interface RunServiceOptions {
  root: string; outputRoot?:string;
  /** Trusted host seams for deterministic integration tests; never accepted through HTTP. */
  modelFactory?: (mode:'live'|'replay', task:AgentTask, configs:SourceConfig[])=>ModelPort;
  configureRegistry?: (registry:ToolRegistry, signal:AbortSignal)=>Promise<void>;
}
export class RunService {
  readonly root:string; readonly outputRoot:string;
  private readonly runs=new Map<string,Managed>();
  private readonly lock:number;
  private closed=false;
  constructor(readonly options:RunServiceOptions) {
    this.root=resolve(options.root);this.outputRoot=resolve(options.outputRoot??resolve(this.root,'.runtime','web'));
    mkdirSync(this.outputRoot,{recursive:true});
    this.lock=openSync(resolve(this.outputRoot,'.host.lock'),'wx');
    try {
      for(const entry of readdirSync(this.outputRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[a-f0-9-]{36}$/.test(e.name))) {
        const data=new FileStore(resolve(this.outputRoot,entry.name)),saved=data.read<{view:RunSnapshot;reportPath?:string}>('summary.json',null!);
        if(!saved)continue;
        const view=saved.view;
        if(active(view.status)){data.recover();view.status='unknown';view.error='服务重启，之前的运行已中断；未自动重放工具。';view.endedAt=now();view.updatedAt=now();}
        view.approvals=[];view.activities=data.lines<RunActivity>('activity.jsonl').slice(-150);
        const run:Managed={view,data,reportPath:saved.reportPath,controller:new AbortController(),pending:new Map(),listeners:new Set(),tools:new Map(),redactor:this.redactor()};
        this.runs.set(view.id,run);this.persist(run);
      }
    } catch(error){closeSync(this.lock);unlinkSync(resolve(this.outputRoot,'.host.lock'));throw error;}
  }
  private redactor():Redactor {return new Redactor(Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''));}
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
  get(runId:string):RunSnapshot {return this.snapshot(this.require(runId));}
  private require(runId:string):Managed {const run=this.runs.get(runId);if(!run)throw Error('run_not_found');return run;}
  private snapshot(run:Managed):RunSnapshot {return structuredClone({...run.view,approvals:[...run.pending.values()].map(p=>p.request)});}
  private persist(run:Managed):void {run.data.write('summary.json',{view:{...run.view,activities:[],approvals:[]},reportPath:run.reportPath});}
  private changed(run:Managed):void {
    run.view.updatedAt=now();run.view.revision=(run.view.revision??0)+1;this.persist(run);const snapshot=this.snapshot(run);
    for(const listener of run.listeners)try{listener(snapshot);}catch{/* A disconnected UI cannot stop the investigation. */}
  }
  private activity(run:Managed,kind:RunActivity['kind'],message:string,extra:Partial<RunActivity>={}):void {
    const event=run.redactor.clean({sequence:(run.view.activities.at(-1)?.sequence??0)+1,timestamp:now(),kind,message:message.slice(0,600),...extra});
    run.view.activities.push(event);run.view.activities=run.view.activities.slice(-150);run.data.append('activity.jsonl',event);this.changed(run);
  }
  subscribe(runId:string,listener:(snapshot:RunSnapshot)=>void):()=>void {const run=this.require(runId);run.listeners.add(listener);return()=>{run.listeners.delete(listener);};}
  start(raw:RunStartInput):RunSnapshot {
    if(this.closed)throw Error('service_closed');
    if([...this.runs.values()].filter(r=>active(r.view.status)).length>=2)throw Error('run_capacity:最多同时运行两项调查');
    const input=startSchema.parse(raw),profile=definitions.find(p=>p.id===input.profile)!;
    const task=parseAgentTask(input.task??(profile.id==='agent'?genericTask():JSON.parse(readFileSync(resolve(this.root,profile.task),'utf8'))));
    if((profile.id==='agent')===isInvestigationTask(task))throw Error('task_template_mismatch');
    if(input.conversation&&isInvestigationTask(task))throw Error('conversation_requires_generic_agent');
    const overrideDomains=input.mode==='live'
      ? [...new Set((input.webDomains?.length?input.webDomains:isInvestigationTask(task)?task.competitor.domains.map(d=>d.trim().toLowerCase()).filter(Boolean):[]))]
      : [];
    const rawConfigs=this.profileSourceConfigs(profile).filter(c=>task.allowedSources.includes(c.slug));
    const configs=rawConfigs.map(config=>{
      if(input.mode==='live'&&config.slug==='web'&&config.kind==='web'){
        const concrete=overrideDomains.filter(host=>host!=='*');
        if(concrete.length){
          for(const host of concrete)allowedUrl('https://'+host,[host]);
          return {...config,allowedDomains:concrete};
        }
        return {...config,allowedDomains:['*']};
      }
      return config;
    });
    const customStore=new UserMcpStore(this.root),custom=customStore.select(task.allowedSources.filter(slug=>customStore.list().some(c=>c.slug===slug)));
    if(custom.some(c=>configs.some(config=>config.slug===c.slug)))throw Error('mcp_source_slug_collision');
    if(input.mode==='replay'&&custom.length)throw Error('custom_mcp_requires_live_mode');
    for(const slug of task.allowedSources)if(!configs.some(c=>c.slug===slug)&&!custom.some(c=>c.slug===slug))throw Error('source_not_configured:'+slug);
    const userSkills=new SkillStore(this.root).select(input.skills);
    const model=this.options.modelFactory?.(input.mode,task,configs)??(input.mode==='live'?PiModel.fromEnvironment():this.replayModel(task,configs));
    const runId=id(),createdAt=now(),run:Managed={
      view:{id:runId,task,profile:input.profile,mode:input.mode,permission:input.permission,status:'preparing',createdAt,updatedAt:createdAt,activities:[],approvals:[],gaps:[],claims:[],toolCalls:0,modelTurns:0,totalTokens:0,reportReady:false,stage:0},
      data:new FileStore(resolve(this.outputRoot,runId)),controller:new AbortController(),pending:new Map(),listeners:new Set(),tools:new Map(),redactor:this.redactor(),
    };
    if(input.conversation&&!isInvestigationTask(task)){
      run.view.conversation=true;run.view.messages=[{id:id(),role:'user',content:run.redactor.clean(task.instruction),createdAt}];run.acceptedMessages=new Map();
    }
    this.runs.set(runId,run);this.activity(run,'system',input.mode==='replay'?'离线演示已启动，所有业务数据均为合成快照。':'调查已启动，正在准备来源。');
    run.job=(async()=>{
      const registry=new ToolRegistry(),builder=new SourceServerBuilder(this.root);
      const timeout=setTimeout(()=>run.controller.abort(new DOMException('run preparation timeout','TimeoutError')),input.limits.timeoutMs??180000);
      try {
        const signal=run.controller.signal,initialGaps=await builder.register(configs,input.mode,registry,AbortSignal.any([signal,AbortSignal.timeout(25000)]));
        const secrets=[...custom.flatMap(c=>mcpSecrets(c,process.env)),...configs.flatMap(c=>c.active&&c.api?apiSecrets(c.api):[]),...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??'')];
        for(const config of custom){const client=builder.mcpPool.acquire('custom:'+hash(config),()=>new UserMcpSource(config,this.root));try{await registry.register(config.slug,'mcp',client,signal);}catch(error){await client.close();initialGaps.push('source_unavailable:'+config.slug+':'+String(error));}}
        await this.options.configureRegistry?.(registry,signal);signal.throwIfAborted();
        clearTimeout(timeout); // Runtime owns active execution time; preparation must not time out an idle conversation.
        run.view.status='running';this.changed(run);
        const toolTimeoutMs = input.limits.toolTimeoutMs ?? 60_000;
        const approvals=new ApprovalManager((request,approvalSignal)=>this.awaitApproval(run,request,approvalSignal),Math.min(60_000, toolTimeoutMs));
        const timeoutMs=input.limits.timeoutMs??480_000,maxTokens=input.limits.maxTokens??750_000;
        const toolBudgets=defaultWebToolBudgets(timeoutMs,maxTokens);
        const result=await (isInvestigationTask(task)?runInvestigation:runAgent)(task,model,registry,run.data,input.mode,{
          timeoutMs,toolTimeoutMs,maxTokens,
          maxSteps:input.limits.maxSteps??toolBudgets.maxSteps,
          maxToolCalls:input.limits.maxToolCalls??toolBudgets.maxToolCalls,
          maxSameToolCalls:input.limits.maxSameToolCalls,
          maxConsecutiveToolFailures:input.limits.maxConsecutiveToolFailures,
          builtinTools:!isInvestigationTask(task),
          workspaceRoot:this.root,initialGaps,userSkills,secrets,onEvent:event=>this.onTrace(run,event),
          ...(input.conversation?{nextUserMessage:(answer:RunResult,turnSignal:AbortSignal)=>this.awaitUserMessage(run,answer,turnSignal)}:{}),
          onPlanSubmitted:async(plan,path)=>{run.data.append('plan-submissions.jsonl',{taskId:plan.taskId,path,submittedAt:now()});run.view.plan=run.redactor.clean(plan);this.changed(run);},
        },signal,new ActionPolicy(input.permission),approvals);
        this.finish(run,result);
      }catch(error){run.view.status=run.controller.signal.aborted?'cancelled':'failed';run.view.error=run.redactor.clean(String(error));this.activity(run,'error',run.view.error);}
      finally {
        clearTimeout(timeout);await registry.close();await builder.mcpPool.close();
        run.view.endedAt=now();this.activity(run,'system',run.view.status==='cancelled'?'调查已取消。':run.view.status==='complete'?'调查已完成，报告已保存。':run.view.status==='partial'?'调查已结束，报告保留了来源缺口。':'运行已结束，请检查错误或来源缺口。');
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
    const data=event.data,detail=(value:unknown)=>JSON.stringify(value).slice(0,2200);
    if(event.type==='pre_tool_use_request'){run.tools.set(String(data.requestId),String(data.toolName));return;}
    if(event.type==='model_usage'){run.view.modelTurns++;run.view.totalTokens+=reportedTokens(data.usage)??0;return;}
    if(event.type==='plan_submitted'){run.view.stage=1;this.activity(run,'plan','调查计划已保存并提交。');}
    else if(event.type==='decision_made'){
      const decision=data.decision as Decision;
      if(decision.kind!=='respond'){
        for(const call of decision.kind==='call_tools'?decision.calls:[decision]){
          if(call.name==='workflow__analyze')run.view.stage=2;
          if(call.name==='workflow__review')run.view.stage=3;
          if(call.name==='workflow__draft')run.view.stage=4;
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
      this.activity(run,data.state==='completed'?'tool':'error',tool+(data.state==='completed'?' 已完成':' 未完成'),{tool,state:String(data.state),...(errDetail?{detail:errDetail}:{})});
    }else if(event.type==='evidence_saved'&&typeof data.reworkRound==='number'){run.view.reworkCount=data.reworkRound;}
    else if(event.type==='agent_process')this.activity(run,'system',data.state==='ready'?'Agent 子进程已就绪。':data.state==='exited'?'Agent 子进程已退出。':'Agent 进程：'+String(data.state));
    else if(event.type==='run_failed'||event.type==='run_cancelled')this.activity(run,'error',String(data.error??event.type));
  }
  private finish(run:Managed,result:RunResult):void {
    run.view.status=result.status;run.view.gaps=run.redactor.clean(result.gaps);run.view.error=result.error?run.redactor.clean(result.error):undefined;run.reportPath=result.report;run.view.reportReady=Boolean(result.report);
    if(result.status==='complete'||result.status==='partial')run.view.stage=5;
    if(isInvestigationTask(run.view.task)){
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
  private awaitApproval(run:Managed,request:ApprovalRequest,signal:AbortSignal):Promise<boolean>{
    signal.throwIfAborted();
    return new Promise<boolean>((resolve,reject)=>{
      const abort=()=>{cleanup();reject(signal.reason??Error('approval_cancelled'));};
      const cleanup=()=>{signal.removeEventListener('abort',abort);run.pending.delete(request.requestId);if(run.view.status==='awaiting_approval')run.view.status='running';this.changed(run);};
      run.pending.set(request.requestId,{request:run.redactor.clean(request),signal,resolve:allowed=>{cleanup();resolve(allowed);}});
      run.view.status='awaiting_approval';signal.addEventListener('abort',abort,{once:true});this.activity(run,'approval','等待人工审批：'+request.tool,{tool:request.tool});
      if(signal.aborted)abort();
    });
  }
  respondToApproval(runId:string,requestId:string,allowed:boolean,argsHash:string):void {
    const run=this.require(runId),pending=run.pending.get(requestId);
    if(!pending||pending.signal.aborted||Date.parse(pending.request.expiresAt)<=Date.now())throw Error('approval_not_pending');
    if(pending.request.argsHash!==argsHash)throw Error('approval_hash_mismatch');
    pending.resolve(allowed);this.activity(run,'approval',allowed?'已批准这一次工具调用。':'已拒绝这一次工具调用。');
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
    if(active(run.view.status))throw Error('run_active:运行中的任务无法删除，请先取消或结束会话');
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
      const serverRedactor=new Redactor([...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''),...mcpSecrets(server,process.env)]);
      return serverRedactor.clean({
        slug:server.slug,enabled:server.enabled,transport:server.transport,
        ...(server.url?{endpoint:server.url}:server.command?{endpoint:server.command}:{}),
        defaultAction:server.defaultAction,resultFormat:server.resultFormat,
        toolSemanticsCount:Object.keys(server.toolSemantics).length,
        hasAuth:Boolean(server.tokenEnv||Object.keys(server.env).length>0),
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
    return redactor.clean({builtinSources:[...sourceMap.values()],mcpServers,builtinSkills,userSkills});
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
    const serverRedactor=new Redactor([...Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??''),...mcpSecrets(config,process.env)]);
    const started=Date.now(),source=new UserMcpSource(config,this.root);
    const timeout=AbortSignal.timeout(15_000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    try{
      const tools=await source.listTools(combined);
      return serverRedactor.clean({slug,ok:true,durationMs:Date.now()-started,tools:tools.map(t=>({name:t.name,description:t.description??'',action:t.action}))});
    }catch(error){
      return serverRedactor.clean({slug,ok:false,durationMs:Date.now()-started,tools:[],error:error instanceof Error?error.message:String(error)});
    }finally{await source.close();}
  }
  report(runId:string):string {const run=this.require(runId);if(!run.reportPath||!existsSync(run.data.path(run.reportPath)))throw Error('report_not_ready');return run.redactor.clean(readFileSync(run.data.path(run.reportPath),'utf8'));}
  trace(runId:string):StructuredTrace {const run=this.require(runId),traceId=run.view.traceRunId;if(!traceId)throw Error('trace_not_ready');
    return new Trace(run.data,run.view.task.taskId,traceId,run.redactor).exportStructured();}
  async wait(runId:string):Promise<RunSnapshot>{const run=this.require(runId);await run.job;return this.snapshot(run);}
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;
    for(const run of this.runs.values())if(active(run.view.status))this.cancel(run.view.id);
    try{await Promise.allSettled([...this.runs.values()].map(r=>r.job));}finally{closeSync(this.lock);unlinkSync(resolve(this.outputRoot,'.host.lock'));}
  }
}
