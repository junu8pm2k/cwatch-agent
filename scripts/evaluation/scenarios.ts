import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { id, hash, type AgentSessionHooks, type SourceClient, type ToolDefinition, type ToolExecutionContext, type RetrievalResult, type ModelPort } from '@cwatch/core/types';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { ActionPolicy, ApprovalManager } from '@cwatch/shared/agent/core/permission-manager';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Trace, Redactor } from '@cwatch/shared/sessions/trace';
import { ApiMcpSource, PlatformApiAdapter, PlatformApiConfigSchema } from '@cwatch/shared/sources/api-tools';
import { PiSessionMemory } from '@cwatch/shared/agent/backend/pi/session-memory';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { runPiSession } from '@cwatch/shared/agent/backend/pi/session';
import { reportedTokens } from '@cwatch/shared/agent/core/budgets';
import type { ModelConfig } from '@cwatch/shared/config/models';
import { SessionMemoryPolicySchema } from '@cwatch/core/types/session-memory';
import { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { summarizeDiscovery } from '@cwatch/shared/intelligence/source-coverage';
import { InputSchema, type EvalInput, type WorkerObservation } from './contracts.ts';

type Scenario=EvalInput['scenario'];
const usage={input:100,output:20,cacheRead:0,cacheWrite:0,totalTokens:120,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const emptySchema={type:'object',properties:{},additionalProperties:false};

async function runtimeScenario(s:Extract<Scenario,{driver:'runtime'}>,store:FileStore,config?:ModelConfig):Promise<WorkerObservation>{
  const registry=new ToolRegistry(),controller=new AbortController();
  const fixtureCalls:Array<{tool:string;args:unknown;matched:boolean}>=[],approvalRequests:Array<{requestId:string;tool:string;argsHash:string;answer:boolean}>=[];
  const slug='fixture';let guideRead=false;
  if(s.source==='github_api'){
    const guide={path:'fixture/guide.md',check:()=>guideRead?undefined:'source_guide_required:fixture',
      read:async()=>{guideRead=true;return{sourceSlug:slug,path:'fixture/guide.md',hash:hash('GET releases'),text:'Read-only GET /repos/MoonshotAI/kimi-code/releases with per_page=10. HTTP failures are unavailable data, not evidence of no updates.'};},reset:()=>{guideRead=false;}};
    const fetcher:typeof fetch=async(input,init)=>{
      const url=new URL(String(input)),matched=url.origin==='https://api.github.com'&&url.pathname==='/repos/MoonshotAI/kimi-code/releases'&&url.search==='?per_page=10'&&(init?.method??'GET')==='GET';
      fixtureCalls.push({tool:'github_http',args:{url:url.toString(),method:init?.method??'GET'},matched});
      store.append('fixture-access.jsonl',fixtureCalls.at(-1));
      if(!matched||fixtureCalls.length>1)throw Error('fixture_unmatched_or_exhausted');
      const response=s.response!;return Response.json(response.body,{status:response.status,headers:response.headers});
    };
    const adapter=new PlatformApiAdapter(slug,PlatformApiConfigSchema.parse({baseUrl:'https://api.github.com',allowedPaths:['/repos/MoonshotAI/kimi-code/releases']}),undefined,undefined,fetcher,{}, {guide});
    const source=new ApiMcpSource(slug,adapter);
    const controlled:SourceClient={guide:source.guide,listTools:signal=>source.listTools(signal),
      callTool:async(name,args,signal,context)=>({...await source.callTool(name,args,signal,context),provenance:'fixture'}),
      resolveAction:source.resolveAction.bind(source),checkPrerequisites:source.checkPrerequisites.bind(source),
      validateScope:source.validateScope.bind(source),close:()=>source.close()};
    await registry.register(slug,'mcp',controlled,controller.signal);
  }else{
    const completed = new Set<string>();
    const client:SourceClient={listTools:async()=>s.tools.map(t=>({name:t.name,description:t.description ?? 'Controlled evaluation fixture '+t.name,action:t.action,inputSchema:t.inputSchema ?? emptySchema}) satisfies ToolDefinition),
      checkPrerequisites: name => { const required = s.tools.find(t => t.name === name)?.requires; return required && !completed.has(required) ? 'required_step_missing:' + required : undefined; },
      callTool:async(name,args,signal,context?:ToolExecutionContext)=>{
        const t=s.tools.find(t=>t.name===name);fixtureCalls.push({tool:name,args,matched:Boolean(t)});store.append('fixture-access.jsonl',fixtureCalls.at(-1));
        if(!t)throw Error('unmatched_fixture_tool');
        const execute=async()=>{
          if(t.behavior==='throw') throw Error('fixture_source_unavailable');
          if(t.behavior==='cancel'){controller.abort(new DOMException('fixture user cancelled','AbortError'));signal.throwIfAborted();}
          if(t.behavior==='hang')return await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
          completed.add(name); return structuredClone(t.value);
        };
        return context?context.stage('eval.fixture',execute):execute();
      },close:async()=>{}};
    await registry.register(slug,'mcp',client,controller.signal);
  }
  try{
    const real=s.modelMode==='pi_session';if(real&&!config)throw Error('explicit_model_credentials_required');
    const model:ModelPort=real?{traceModel:{provider:config!.provider,id:config!.modelId},tokenUsageRequired:true,decide:async()=>{throw Error('eval_session_entry_required');},
      runSession:async(input,hooks,signal)=>{const configured=await createPiRuntime(config!.provider,config!.modelId,config,signal);
        try{await runPiSession(configured.runtime,configured.model,input,hooks,signal);}catch(error){
          const e=error as Error&{code?:string;resource?:string};store.write('adapter.error.json',new Redactor([config!.apiKey]).clean({message:e.message,code:e.code,resource:e.resource,stack:e.stack}));throw error;}}}:new ReplayModel(s.steps);
    const result=await runAgent({kind:'agent',taskId:'eval-'+id(),instruction:s.instruction,allowedSources:[slug]},model,registry,store,real?'live':'replay',
      {builtinTools:false,skillPath:fileURLToPath(new URL('../../skills/general-agent/SKILL.md',import.meta.url)),timeoutMs:real?180000:15000,modelTimeoutMs:real?60000:5000,toolTimeoutMs:s.toolTimeoutMs,maxToolCalls:s.maxToolCalls,maxSameToolCalls:16,maxSteps:real?8:16,
        maxTokens:s.maxTokens,maxOutputTokens:s.maxOutputTokens,...(config?{secrets:[config.apiKey]}:{})},controller.signal,
      new ActionPolicy(s.permission),new ApprovalManager(async request=>{const answer=s.approvalAnswers[approvalRequests.length]??false;
        approvalRequests.push({requestId:request.requestId,tool:request.tool,argsHash:request.argsHash,answer});store.append('approvals.jsonl',approvalRequests.at(-1));return answer;}));
    store.write('run.result.json',result);
    const execution=store.executions();
    const events=store.lines<{type:string;data:Record<string,unknown>}>('traces/'+result.runId+'.jsonl');
    const apiResults=events.filter(e=>e.type==='execution_finished'&&e.data.result).map(e=>e.data.result as Record<string,unknown>);
    const usages=events.filter(e=>e.type==='model_usage');
    const main=usages.filter(e=>e.data.purpose!=='memory'),maintenance=usages.filter(e=>e.data.purpose==='memory');
    const total=(rows:typeof usages)=>{const values=rows.map(e=>reportedTokens(e.data.usage)).filter((v):v is number=>v!==undefined);return values.length?values.reduce((sum,n)=>sum+n,0):null;};
    const transcript=real?store.lines<{type:string;customType?:string}>('sessions/'+result.runId+'.jsonl'):[];
    const requests=transcript.filter(e=>e.type==='custom'&&['cwatch.model_request','cwatch.summary_request','cwatch.memory_request'].includes(e.customType??'')).length;
    return{runId:result.runId,status:result.status,tracePath:'traces/'+result.runId+'.jsonl',structuredTracePath:'traces/'+result.runId+'.json',facts:{driver:'runtime',fixtureCalls,fixtureCallCount:fixtureCalls.length,
      fixtureEscapes:fixtureCalls.filter(c=>!c.matched).length,guideRead,approvalRequests,approvalCount:approvalRequests.length,
      executionCount:execution.reduce((sum,e)=>sum+e.execute_count,0),executionStates:execution.map(e=>e.state),
      apiStatus:apiResults.find(r=>typeof r.status==='string')?.status??null,
      sdkExecutionIds:execution.flatMap(e=>e.sdkToolCallId?[e.sdkToolCallId]:[]),
      response:result.response??null,error:result.error??null,gaps:result.gaps,memoryEnabled:real,
      model:real?{provider:config!.provider,id:config!.modelId,adapter:'runPiSession inside permission-restricted eval worker'}:null,
    },usage:real?{mode:'live_model',mainTaskTokens:total(main),maintenanceTokens:maintenance.length?total(maintenance):0,physicalModelRequests:requests,completeness:requests===usages.length&&usages.every(e=>reportedTokens(e.data.usage)!==undefined)?'known':'partial'}:
      {mode:'fixture',mainTaskTokens:null,maintenanceTokens:null,physicalModelRequests:0,completeness:'not_applicable'}};
  }finally{await registry.close();}
}

async function memoryScenario(s:Extract<Scenario,{driver:'memory'}>,store:FileStore):Promise<WorkerObservation>{
  const startedAt=Date.now();
  const runId=id(),taskId='eval-memory-'+id(),trace=new Trace(store,taskId,runId),manager=SessionManager.inMemory(store.root,{id:runId}),controller=new AbortController();
  const transcript=new SessionTranscript(store,runId,new Redactor()),policy=SessionMemoryPolicySchema.parse({initializeTokens:100,growthTokens:50,toolCalls:2});
  const memory=new SessionMemoryStore(store,transcript,taskId,policy,new Redactor());
  let sent=0,header=false,requests=0,seeded=false,metered=0,allowances=0;
  const flush=()=>{transcript.append([...(!header?[manager.getHeader()!]:[]),...manager.getEntries().slice(sent)].map(e=>({...e})));header=true;sent=manager.getEntries().length;};
  const summaries:Array<{attempt:number;maxTokens:number;newMessageCount:number}>=[];
  const hooks:Pick<AgentSessionHooks,'sessionMemory'|'beforeRequest'|'onUsage'>={sessionMemory:request=>memory.handle(request),
    beforeRequest:()=>{allowances++;if(seeded&&s.denyRecoveryBudget&&allowances===2)throw Error('budget_tokens: fixture recovery allowance exhausted');return{maxOutputTokens:s.maxOutputTokens};},
    onUsage:()=>{metered++;if(seeded&&s.cancelAfterResponse)controller.abort(new DOMException('fixture cancelled maintenance','AbortError'));}};
  const archive=async(type:string,data:unknown)=>{
    const value=type==='cwatch.memory_response'?{stopReason:(data as {stopReason:string}).stopReason,usage:(data as {usage:unknown}).usage}:data;
    manager.appendCustomEntry(type,value);flush();store.append('auxiliary/memory.jsonl',{type,data:value});
  };
  const updater=new PiSessionMemory(manager,hooks,policy,80000,32000,archive);
  const {model}=await createPiRuntime('eval-memory','fixture',{apiKey:'fixture-only',baseUrl:'http://127.0.0.1/unused'},controller.signal);
  const content={userGoal:'Continue the supplied fixture task',completedWork:[],keyFiles:[],errorsAndFixes:[],unfinishedTasks:['collect evidence'],nextSteps:['read source'],references:[],sourceGaps:[]};
  const runtime={completeSimple:async(_model:unknown,context:{messages:Array<{content:string}>},options:{maxTokens:number;signal:AbortSignal})=>{
    options.signal.throwIfAborted();const response=seeded?s.responses[requests-(s.seedCheckpoint?1:0)]:'stop';
    requests++;summaries.push({attempt:requests,maxTokens:options.maxTokens,newMessageCount:JSON.parse(context.messages[0].content).newMessages.length});
    if(!response)throw Error('fixture_response_exhausted');
    return{role:'assistant',content:response==='length'?[{type:'thinking',thinking:'fixture reasoning must not become a checkpoint'}]:[{type:'text',text:response==='invalid'?'not-json':JSON.stringify(content)}],usage,stopReason:response==='length'?'length':'stop'};
  }} as unknown as ModelRuntime;
  manager.appendMessage({role:'user',content:'Fixture task; no grading criteria provided.',timestamp:Date.now()});
  function turn(n:number){manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'memory-call-'+n,name:'mcp__fixture__read',arguments:{}}],api:'openai-completions',provider:'fixture',model:'fixture',usage,stopReason:'toolUse',timestamp:Date.now()});
    manager.appendMessage({role:'toolResult',toolCallId:'memory-call-'+n,toolName:'mcp__fixture__read',content:[{type:'text',text:'fixture evidence '+n}],isError:false,timestamp:Date.now()});flush();}
  trace.emit('run_started',{purpose:'Actual PiSessionMemory component evaluation with fixture responses',mode:'replay'});
  if(s.seedCheckpoint){turn(1);await updater.prepare(100,runtime,model,s.maxOutputTokens,controller.signal);}
  const before=memory.load();seeded=true;allowances=0;turn(s.seedCheckpoint?2:1);if(!s.seedCheckpoint)turn(2);
  let error:string|null=null;
  try{await updater.prepare(200,runtime,model,s.maxOutputTokens,controller.signal);}catch(e){error=String(e);}
  const after=memory.load(),status=controller.signal.aborted?'cancelled':error?'failed':'complete';
  store.write('memory.state-diff.json',{before,after});store.write('memory.requests.json',summaries);
  trace.emit('usage_reported',{toolCalls:0,durationMs:Date.now()-startedAt,modelUsage:Array.from({length:metered},()=>({...usage,purpose:'memory',provenance:'fixture'})),usageAvailable:true,mode:'replay'});
  trace.emit(status==='complete'?'run_completed':status==='cancelled'?'run_cancelled':'run_failed',status==='complete'?{status:'complete'}:{error:error??'cancelled'});
  return{runId,status,tracePath:trace.key,structuredTracePath:trace.structuredKey,facts:{driver:'memory',physicalRequests:requests,requestsAfterSeed:requests-(s.seedCheckpoint?1:0),meteredRequests:metered,
    recoveryOutputCaps:summaries.slice(s.seedCheckpoint?1:0).map(s=>s.maxTokens),beforeRevision:before?.revision??0,afterRevision:after?.revision??0,
    checkpointUnchanged:hash(before)===hash(after),pendingMessages:after?.pendingMessages??false,error,
    recoveryActions:store.lines<{type:string;data:{action?:string}}>('auxiliary/memory.jsonl').filter(e=>e.type==='cwatch.memory_recovery').map(e=>e.data.action),
  },usage:{mode:'fixture',mainTaskTokens:0,maintenanceTokens:metered*120,physicalModelRequests:requests,completeness:'known_fixture'}};
}

async function discoveryScenario(s:Extract<Scenario,{driver:'discovery'}>,store:FileStore):Promise<WorkerObservation>{
  const startedAt=Date.now();
  const runId=id(),trace=new Trace(store,'eval-discovery-'+id(),runId),at='2026-10-24T14:00:00Z';
  const search:RetrievalResult={status:s.searchUrls.length?'success_with_data':'success_empty',signals:[],raw:'Frozen discovery fixture',provenance:'fixture',searchResults:s.searchUrls.map(url=>({url,title:'Fixture',snippet:'candidate only',published_at:null,retrieved_at:at}))};
  const fetches=s.readableUrls.map(url=>({url,result:{status:'success_with_data',signals:[],raw:'Frozen readable page',provenance:'fixture',pages:[{url,title:'Fixture',text:'Body text only; no structured release signal.',published_at:null,retrieved_at:at,truncated:false}]} satisfies RetrievalResult}));
  trace.emit('run_started',{purpose:'Actual summarizeDiscovery component evaluation',mode:'replay'});
  const metrics=summarizeDiscovery(s.referenceUrls,s.allowedDomains,[{query:'fixture site:'+s.allowedDomains[0],limit:10,result:search,returned:s.searchUrls.length,filteredOutsideScope:0}],fetches);
  store.write('discovery.inputs.json',{search,fetches});store.write('discovery.metrics.json',metrics);
  trace.emit('usage_reported',{toolCalls:0,durationMs:Date.now()-startedAt,modelUsage:[],usageAvailable:false,mode:'replay'});trace.emit('run_completed',{status:'complete'});
  return{runId,status:'complete',tracePath:trace.key,structuredTracePath:trace.structuredKey,facts:{driver:'discovery',...metrics},usage:{mode:'fixture',mainTaskTokens:null,maintenanceTokens:null,physicalModelRequests:0,completeness:'not_applicable'}};
}
export async function executeScenario(input:unknown,output:string,config?:ModelConfig):Promise<WorkerObservation>{
  const {scenario}=InputSchema.parse(input),store=new FileStore(output);
  if(scenario.driver==='runtime')return runtimeScenario(scenario,store,config);
  if(scenario.driver==='memory')return memoryScenario(scenario,store);
  return discoveryScenario(scenario,store);
}
