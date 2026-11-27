import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { check, store } from './harness.ts';
import { Trace, Redactor, validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { StructuredTraceSchema, type StructuredTrace } from '@cwatch/shared/sessions/structured-trace';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { ActionPolicy, ApprovalManager } from '@cwatch/shared/agent/core/permission-manager';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import { type Decision, type SourceClient } from '@cwatch/core/types';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { startWebServer } from '../apps/web/src/server.ts';

async function fixture(options:{batch?:boolean;blocked?:boolean;fail?:boolean;rateLimited?:boolean}={}){
  const data=store(),registry=new ToolRegistry(),secret='structured-fixture-secret';
  const source:SourceClient={listTools:async()=>[{name:'lookup',description:'Local structured trace fixture',action:options.blocked?'modify':'collect',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}],
    callTool:async(_name,args,_signal,context)=>context!.stage('fixture.backend',async()=>{if(options.fail)throw Error('fixture_failed: '+secret);return{query:args.query,password:secret,status:options.rateLimited?'rate_limited':'success_with_data'};}),close:async()=>{}};
  await registry.register('fixture','mcp',source,new AbortController().signal);
  const calls=[{sdkToolCallId:'sdk-first',name:'mcp__fixture__lookup',args:{query:'first'}},{sdkToolCallId:'sdk-second',name:'mcp__fixture__lookup',args:{query:'second'}}];
  const steps:Decision[]=[options.batch?{kind:'call_tools',calls}:{kind:'call_tool',name:'mcp__fixture__lookup',args:{query:'first'}},{kind:'respond',text:'Finished '+secret}];
  try{
    const result=await runAgent({kind:'agent',taskId:'structured-task',instruction:'Local fixture only',allowedSources:['fixture']},new ReplayModel(steps),registry,data,'replay',
      {builtinTools:false,secrets:[secret]},new AbortController().signal,new ActionPolicy(options.blocked?'ask':'allow-all'),new ApprovalManager(async()=>false));
    assert.equal(result.traceArtifacts?.available,true,result.traceArtifacts?.error);
    const doc=StructuredTraceSchema.parse(data.read(result.traceArtifacts!.structuredPath,null));return{data,result,doc,secret};
  }finally{await registry.close();}
}
check('integration','Structured traces automatically correlate model rounds, batch tool IDs, policies and backend stages',async()=>{
  const f=await fixture({batch:true}),raw=f.data.lines<TraceEvent>(f.result.traceArtifacts!.eventsPath);
  assert.deepEqual(validateTrace(raw),[]);assert.equal(f.doc.integrity.valid,true);assert.equal(f.doc.status,'complete');assert.equal(f.doc.traceId,f.result.runId);
  const models=f.doc.steps.filter(s=>s.kind==='model'),tools=f.doc.steps.filter(s=>s.kind==='tool'),backends=f.doc.steps.filter(s=>s.kind==='backend');
  assert.equal(models.length,2);assert.equal(tools.length,2);assert.equal(backends.length,2);assert.deepEqual(tools.map(s=>s.correlation.sdkToolCallId),['sdk-first','sdk-second']);
  for(const tool of tools){assert.equal(tool.parentStepId,models[0].stepId);assert.ok(tool.correlation.requestId);assert.equal((tool.attributes.permission as {mode:string}).mode,'allow-all');assert.equal((tool.attributes.permission as {decision:string}).decision,'ALLOW');assert.equal(tool.status,'completed');assert.ok(tool.timing.startedAt);}
  for(const backend of backends)assert.ok(tools.some(tool=>tool.stepId===backend.parentStepId&&tool.correlation.requestId===backend.correlation.requestId));
  assert.equal(f.doc.summary.toolExecutions,2);assert.equal(f.doc.summary.modelRounds,2);assert.equal(f.doc.source.eventCount,raw.length);
  assert.equal(f.doc.source.sha256,createHash('sha256').update(readFileSync(f.data.path(f.result.traceArtifacts!.eventsPath))).digest('hex'));
  assert.ok(!JSON.stringify(f.doc).includes(f.secret));assert.match(f.doc.output.response!,/\[REDACTED\]/);
});
check('contract','Blocked requests have structured permission errors and no invented execution timestamps or backend calls',async()=>{
  const f=await fixture({blocked:true}),tool=f.doc.steps.find(s=>s.kind==='tool')!;
  assert.equal(tool.status,'blocked');assert.equal(tool.timing.startedAt,null);assert.equal(tool.timing.executionDurationMs,null);assert.equal(tool.error?.category,'permission');
  assert.equal(f.doc.summary.toolExecutions,0);assert.equal(f.doc.summary.backendExecutions,0);assert.equal(f.doc.status,'partial');
});
check('contract','Tool exceptions and unavailable source results retain different execution outcomes and normalized errors',async()=>{
  const failed=await fixture({fail:true}),tool=failed.doc.steps.find(s=>s.kind==='tool')!;
  assert.equal(tool.status,'failed');assert.ok(tool.error);assert.ok(!JSON.stringify(failed.doc).includes(failed.secret));
  const limited=await fixture({rateLimited:true}),read=limited.doc.steps.find(s=>s.kind==='tool')!;
  assert.equal(read.status,'completed');assert.equal(read.resultStatus,'rate_limited');assert.equal(read.error?.category,'source');assert.equal(limited.doc.status,'partial');
});
check('contract','A failed model request is closed by its run terminal with an explicit correlated error',async()=>{
  const data=store(),trace=new Trace(data,'model-task','model-failed');trace.emit('run_started');trace.emit('model_requested',{iteration:1,contextChars:10});
  trace.emit('run_failed',{status:'failed',error:'provider_unavailable: connection_lost'});
  const doc=StructuredTraceSchema.parse(data.read(trace.structuredKey,null)),model=doc.steps.find(s=>s.kind==='model')!;
  assert.equal(model.status,'failed');assert.equal(model.error?.code,'provider_unavailable');assert.equal(model.attributes.closedByRunTerminal,true);assert.equal(doc.integrity.valid,true);
});
check('contract','Auxiliary usage does not invent request timing, success or zero monetary cost',()=>{
  const data=store(),trace=new Trace(data,'usage-task','usage-run');trace.emit('run_started');trace.emit('model_requested',{iteration:1,contextChars:10});
  trace.emit('model_usage',{iteration:1,purpose:'memory',usage:{input:20,output:3,totalTokens:23}});trace.emit('model_usage',{iteration:1,purpose:'turn',usage:{input:10,output:2,totalTokens:12}});
  trace.emit('decision_made',{decision:{kind:'respond',text:'Done'}});trace.emit('run_completed');
  const doc=StructuredTraceSchema.parse(data.read(trace.structuredKey,null)),memory=doc.steps.find(s=>s.name==='model.memory')!;
  assert.equal(memory.status,'unknown');assert.equal(memory.timing.durationMs,null);assert.equal(memory.timing.startedAt,null);assert.equal(doc.summary.totalTokens,35);
  assert.equal(doc.summary.physicalModelRequests,null);assert.equal(doc.summary.actualCost,null);
});
check('contract','Memory delta_too_large degradation links to the continuing model turn without blocking it',()=>{
  const data=store(),trace=new Trace(data,'degrade-task','degrade-run');trace.emit('run_started');trace.emit('model_requested',{iteration:1,contextChars:10});
  trace.emit('session_memory_attempt',{iteration:1,attemptDetails:{phase:'degraded',reason:'delta_too_large',checkpointRevision:2,pendingRounds:3,consecutiveFailures:1,circuitOpen:false}});
  trace.emit('decision_made',{decision:{kind:'respond',text:'Continued'}});trace.emit('run_completed',{status:'complete',response:'Continued',gaps:[]});
  const doc=StructuredTraceSchema.parse(data.read(trace.structuredKey,null));
  const memory=doc.steps.find(s=>s.name==='model.memory')!,turn=doc.steps.find(s=>s.name==='model.turn')!;
  assert.equal(memory.status,'failed');assert.equal(memory.error?.code,'delta_too_large');
  assert.deepEqual(memory.output,{reason:'delta_too_large',action:'degrade',checkpointStatus:'unchanged',pendingRounds:3,consecutiveFailures:1,circuitOpen:false});
  assert.equal(turn.status,'completed');assert.deepEqual(turn.attributes.memoryDegraded,{stepId:memory.stepId,reason:'delta_too_large',checkpointRevision:2,pendingRounds:3,consecutiveFailures:1,circuitOpen:false});
});
check('contract','Historical JSONL exports are deterministic and leave the original event bytes unchanged',()=>{
  const data=store(),timestamp='2026-10-27T00:00:00Z';
  for(const [i,event]of [{type:'run_started',data:{}},{type:'model_requested',data:{iteration:1,contextChars:10}},{type:'decision_made',data:{decision:{kind:'respond',text:'Legacy response'}}},{type:'run_completed',data:{status:'complete',response:'Legacy response'}}].entries())data.append('traces/legacy.jsonl',{...event,taskId:'legacy-task',runId:'legacy',sequence:i+1,timestamp});
  const before=readFileSync(data.path('traces/legacy.jsonl'),'utf8'),trace=new Trace(data,'legacy-task','legacy'),first=trace.exportStructured();
  assert.deepEqual(first.source.schemaVersions,[1]);assert.equal(first.integrity.valid,true);assert.deepEqual(trace.exportStructured(),first);assert.equal(readFileSync(data.path(trace.key),'utf8'),before);
});
check('contract','Incomplete snapshots stay incomplete and exporting never replays tools or appends audit events',()=>{
  const data=store(),trace=new Trace(data,'partial-task','partial-run');trace.emit('run_started');trace.emit('model_requested',{iteration:1,contextChars:10});
  const before=readFileSync(data.path(trace.key),'utf8'),snapshot=trace.exportStructured();assert.equal(snapshot.status,'incomplete');assert.equal(snapshot.integrity.complete,false);assert.equal(snapshot.integrity.valid,false);assert.equal(snapshot.timing.endedAt,null);
  assert.equal(readFileSync(data.path(trace.key),'utf8'),before);trace.emit('run_cancelled',{status:'cancelled',error:'user_cancelled'});assert.equal(data.read<StructuredTrace>(trace.structuredKey,null!).status,'cancelled');
});
check('contract','Projection write failures are surfaced without losing the durable terminal event or observer notification',()=>{
  const data=store(),observed:string[]=[],trace=new Trace(data,'failure-task','failure-run',new Redactor(['private-fixture']),event=>{observed.push(event.type);});
  const write=data.write.bind(data);data.write=(name,value)=>{if(name===trace.structuredKey)throw Error('projection_failed private-fixture');write(name,value);};
  trace.emit('run_started');trace.emit('run_completed');assert.deepEqual(observed,['run_started','run_completed']);assert.deepEqual(validateTrace(data.lines(trace.key)),[]);
  assert.match(trace.structuredError!,/projection_failed/);assert.ok(!trace.structuredError!.includes('private-fixture'));assert.equal(existsSync(data.path(trace.structuredKey)),false);
});
check('contract','Structured Trace export rebuilds the projection and the schema rejects orphaned parent IDs',async()=>{
  const f=await fixture(),trace=new Trace(f.data,f.result.taskId,f.result.runId);
  const altered=structuredClone(f.doc);altered.summary.toolExecutions++;f.data.write(trace.structuredKey,altered);
  assert.deepEqual(trace.exportStructured(),f.doc);
  assert.deepEqual(f.data.read(trace.structuredKey,null),f.doc);
  const orphan=structuredClone(f.doc);orphan.steps.find(s=>s.kind==='tool')!.parentStepId='nonexistent';assert.equal(StructuredTraceSchema.safeParse(orphan).success,false);
});
check('integration','Workbench serves structured traces through the existing local-origin HTTP boundary',async()=>{
  const data=store(),service=new RunService({root:process.cwd(),outputRoot:data.root}),app=await startWebServer({root:process.cwd(),port:0,service});
  try{
    const run=service.start({profile:'standard',mode:'replay',permission:'explore'}),finished=await service.wait(run.id);
    const response=await fetch(app.origin+'/api/runs/'+run.id+'/trace');assert.equal(response.status,200);const doc=StructuredTraceSchema.parse(await response.json());
    assert.equal(doc.runId,finished.traceRunId);assert.equal(doc.integrity.valid,true);assert.equal(doc.summary.toolExecutions,finished.toolCalls);
    assert.equal((await fetch(app.origin+'/api/runs/00000000-0000-0000-0000-000000000000/trace')).status,404);
  }finally{await app.close();}
});
