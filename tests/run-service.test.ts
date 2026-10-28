import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { UserMcpStore } from '@cwatch/shared/mcp/storage';
import { resolve } from 'node:path';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { validateTrace, Trace } from '@cwatch/shared/sessions/trace';
import { isInvestigationTask, id, abortable, type ModelPort, type SourceClient } from '@cwatch/core/types';
import type { RunSnapshot } from '@cwatch/core/types/runs';
import { check, store, fixture } from './harness.ts';

import { waitForRun, approvalFixture } from './run-service-fixture.ts';

const start={profile:'standard',mode:'replay',permission:'explore'} as const;
check('integration','RunService streams the real replay pipeline, persists its report and restores history',async()=>{
  const data=store(),service=new RunService({root:process.cwd(),outputRoot:resolve(data.root,'runs')});let runId='';
  try{
    const run=service.start(start);runId=run.id;const updates:RunSnapshot[]=[];const off=service.subscribe(run.id,value=>updates.push(value));
    const finished=await service.wait(run.id);off();assert.equal(finished.status,'complete');assert.equal(finished.claims.length,2);assert.equal(finished.toolCalls,7);assert.equal(finished.approvals.length,0);assert.match(service.report(run.id),/合成测试快照/);
    assert.ok(updates.some(r=>r.activities.some(a=>a.kind==='plan')));const trace=new FileStore(resolve(data.root,'runs',run.id)).lines<import('@cwatch/shared/sessions/trace').TraceEvent>('traces/'+finished.traceRunId+'.jsonl');assert.deepEqual(validateTrace(trace),[]);
    assert.ok(finished.activities.some(a=>a.kind==='analysis'&&a.tool==='workflow__analyze'));
    assert.ok(finished.activities.some(a=>a.kind==='tool'&&a.tool==='web_fetch'));
    assert.ok(isInvestigationTask(finished.task));finished.task.competitor.name='mutated';const restoredTask=service.get(run.id).task;assert.ok(isInvestigationTask(restoredTask));assert.equal(restoredTask.competitor.name,'Node.js');
  }finally{await service.close();}
  const restored=new RunService({root:process.cwd(),outputRoot:resolve(data.root,'runs')});
  try{assert.equal(restored.get(runId).status,'complete');assert.equal(restored.get(runId).claims.length,2);assert.ok(restored.get(runId).activities.length>0);assert.match(restored.report(runId),/合成测试快照/);}finally{await restored.close();}
});
for(const allowed of [true,false])check('integration','RunService '+(allowed?'approves':'denies')+' exactly one host write with its immutable argument hash',async()=>{
  const data=store(),fixture=approvalFixture(),service=new RunService({root:process.cwd(),outputRoot:data.root,...fixture});
  try{
    const run=service.start({...start,permission:'ask'}),pending=await waitForRun(service,run.id,r=>r.approvals.length>0),request=pending.approvals[0];
    assert.equal(fixture.calls.includes('request_publish'),false);
    assert.throws(()=>service.respondToApproval(run.id,request.requestId,true,'0'.repeat(64)),/hash_mismatch/);
    service.respondToApproval(run.id,request.requestId,allowed,request.argsHash);
    assert.throws(()=>service.respondToApproval(run.id,request.requestId,allowed,request.argsHash),/not_pending/);
    const finished=await service.wait(run.id);assert.ok(['complete','partial'].includes(finished.status));
    assert.equal(fixture.calls.filter(name=>name==='request_publish').length,allowed?1:0);assert.equal(finished.approvals.length,0);
    const records=new FileStore(resolve(data.root,run.id)).executions().filter(r=>r.toolBinding.original_name==='request_publish');assert.equal(records.length,1);assert.equal(records[0].execute_count,allowed?1:0);
  }finally{await service.close();}
});
check('contract','Cancelling a web approval clears it and never executes a late approval',async()=>{
  const data=store(),fixture=approvalFixture(),service=new RunService({root:process.cwd(),outputRoot:data.root,...fixture});
  try{const run=service.start({...start,permission:'ask'}),pending=await waitForRun(service,run.id,r=>r.approvals.length>0),request=pending.approvals[0];service.cancel(run.id);const finished=await service.wait(run.id);assert.equal(finished.status,'cancelled');assert.equal(finished.approvals.length,0);assert.throws(()=>service.respondToApproval(run.id,request.requestId,true,request.argsHash),/not_pending/);assert.equal(fixture.calls.includes('request_publish'),false);}
  finally{await service.close();}
});
check('contract','RunService capacity and cancellation bound concurrent investigations without mixing their state',async()=>{
  const data=store(),modelFactory=():ModelPort=>({decide:async(_input,signal)=>abortable(new Promise<never>(()=>{}),signal)});
  const service=new RunService({root:process.cwd(),outputRoot:data.root,modelFactory});
  try{const first=service.start(start),second=service.start(start);assert.notEqual(first.id,second.id);assert.throws(()=>service.start(start),/run_capacity/);service.cancel(first.id);assert.equal((await service.wait(first.id)).status,'cancelled');assert.notEqual(service.get(second.id).status,'cancelled');service.cancel(second.id);assert.equal((await service.wait(second.id)).status,'cancelled');}
  finally{await service.close();}
});
check('contract','RunService rejects arbitrary source configuration, unselected sources and unsafe limits',async()=>{
  const data=store(),service=new RunService({root:process.cwd(),outputRoot:data.root});
  try{
    assert.throws(()=>service.start({...start,command:'anything'} as never));assert.throws(()=>service.start({...start,limits:{timeoutMs:99999999}}));
    const task=service.profiles()[0].task;task.allowedSources=['unconfigured'];assert.throws(()=>service.start({...start,task}),/source_not_configured/);assert.equal(service.list().length,0);
    assert.throws(()=>service.report(id()),/run_not_found/);
  }finally{await service.close();}
});
check('contract','RunService enforces an exclusive output lease and marks interrupted persisted runs unknown',async()=>{
  const data=store(),service=new RunService({root:process.cwd(),outputRoot:data.root});
  assert.throws(()=>new RunService({root:process.cwd(),outputRoot:data.root}),/EEXIST/);
  const run=service.start(start);await service.wait(run.id);await service.close();
  const persisted=new FileStore(resolve(data.root,run.id)),summary=persisted.read<{view:RunSnapshot;reportPath?:string}>('summary.json',null!);summary.view.status='running';persisted.write('summary.json',summary);
  let modelCalls=0;const restored=new RunService({root:process.cwd(),outputRoot:data.root,modelFactory:()=>{modelCalls++;throw Error('must_not_restart');}});
  try{assert.equal(restored.get(run.id).status,'unknown');assert.equal(restored.get(run.id).approvals.length,0);assert.equal(modelCalls,0);}finally{await restored.close();}
});
check('contract','A UI Trace observer receives a copy only after durable append and cannot corrupt the audit',()=>{
  const data=store();let observed=0;const trace=new Trace(data,'web-task',id(),undefined,event=>{observed++;assert.equal(data.lines(trace.key).length,observed);event.sequence=999;throw Error('broken_ui');});
  trace.emit('run_started');trace.emit('run_completed');assert.equal(observed,2);assert.deepEqual(validateTrace(data.lines(trace.key)),[]);
});

check('contract','RunService exposes enabled custom MCP sources as metadata without resolving or disclosing credentials',async()=>{
  const data=store(),root=resolve(data.root,'workspace');mkdirSync(resolve(root,'examples'),{recursive:true});
  for(const name of ['task.json','task-web.json','task-adapters.json','sources.json','sources-web.json','sources-adapters.json'])copyFileSync(resolve('examples',name),resolve(root,'examples',name));
  new UserMcpStore(root).add({slug:'custom-fixture',transport:'streamable-http',url:'https://mcp-fixture.example/mcp',tokenEnv:'UNRESOLVED_WEB_TEST_SECRET',enabled:true});
  const service=new RunService({root,outputRoot:resolve(data.root,'runs')});
  try{const profiles=service.profiles();assert.ok(profiles.every(profile=>profile.sources.some(source=>source.slug==='custom-fixture'&&source.channel==='mcp'&&source.active)));assert.ok(!JSON.stringify(profiles).includes('UNRESOLVED_WEB_TEST_SECRET'));const task=profiles[0].task;task.allowedSources=['custom-fixture'];assert.throws(()=>service.start({...start,task}),/custom_mcp_requires_live_mode/);assert.equal(service.list().length,0);}
  finally{await service.close();}
});
