import assert from 'node:assert/strict';
import { BrowserSource } from "@cwatch/shared/sources/browser";
import { SourceConfigsSchema } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
import { Trace } from "@cwatch/shared/sessions/trace";
import { check, store, task } from './harness.ts';
import { id } from "@cwatch/core/types";
const signal=new AbortController().signal;
check('contract','Browser source URL, entity and schema boundaries reject before browser launch',async()=>{
  const value=task(),registry=new ToolRegistry(),data=store();let launches=0;
  const source=new BrowserSource(SourceConfigsSchema.parse([{slug:'official',kind:'browser',entityId:value.competitor.id,product:value.product,urls:['https://example.com/pricing'],allowedDomains:['example.com']}])[0],{launch:async()=>{launches++;throw Error('must not launch');}});
  try {
    await registry.register('official','builtin',source,signal);
    const executor=new ToolExecutor(registry,new ActionPolicy(),new ApprovalManager(),data,new Trace(data,value.taskId,id()),value);
    for(const args of [{url:'https://outside.example/'},{url:'https://example.com/pricing',script:'arbitrary JS'}])await assert.rejects(executor.execute('session__browser_tool',args,signal));
    await assert.rejects(source.callTool('browser_tool',{url:'https://example.com/pricing'},signal),/executor_context/);
    assert.equal(source.validateScope('browser_tool',{url:'https://example.com/pricing'},{...value,product:'different'}),'browser_scope_mismatch');assert.equal(launches,0);
  } finally {await registry.close();}
});
check('contract','Browser registration rejects private, credential and unlisted URLs without launching',async()=>{
  for(const url of ['http://127.0.0.1/private','https://example.com/?api_key=secret','https://outside.example/']){
    const source=new BrowserSource(SourceConfigsSchema.parse([{slug:'browser',kind:'browser',urls:[url],allowedDomains:['example.com']}])[0],{launch:async()=>{throw Error('must not launch');}});
    await assert.rejects(source.listTools(signal),/web_scope/);await source.close();
  }
});

check('contract','Cancelling during browser startup still waits for a late browser to close',async()=>{
  const {deferred,waitTick}=await import('./harness.ts');
  const launch=deferred<import('playwright-core').Browser>(),closed=deferred<void>();
  let closeCalls=0,settled=false;
  const source=new BrowserSource(SourceConfigsSchema.parse([{slug:'browser',kind:'browser',urls:['https://example.com/pricing'],allowedDomains:['example.com']}])[0],{launch:async()=>launch.promise});
  const controller=new AbortController();
  const running=source.callTool('browser_tool',{url:'https://example.com/pricing'},controller.signal,{stage:async(_name,operation)=>operation(),event:()=>{}});
  controller.abort(new Error('startup_cancelled'));await assert.rejects(running,/startup_cancelled/);
  const cleanup=source.close().then(()=>{settled=true;});
  launch.resolve({close:async()=>{closeCalls++;await closed.promise;}} as unknown as import('playwright-core').Browser);
  await waitTick();assert.ok(closeCalls>=1);assert.equal(settled,false);
  closed.resolve();await cleanup;assert.equal(settled,true);
});
