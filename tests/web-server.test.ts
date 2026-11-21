import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import { startWebServer } from '../apps/web/src/server.ts';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { check, store } from './harness.ts';
import type { WorkbenchBootstrap, RunSnapshot } from '@cwatch/core/types/runs';

async function harness(){
  const data=store(),service=new RunService({root:process.cwd(),outputRoot:data.root});
  const app=await startWebServer({root:process.cwd(),port:0,service});
  const bootstrap=await(await fetch(app.origin+'/api/bootstrap')).json() as WorkbenchBootstrap;
  const post=(path:string,value:unknown,headers:Record<string,string>={})=>fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Cwatch-Token':bootstrap.csrfToken,...headers},body:JSON.stringify(value)});
  return{...app,bootstrap,post};
}
check('contract','Workbench HTTP serves local assets with a restrictive CSP and never serves workspace files',async()=>{
  const h=await harness();
  try{
    const rawStatus=(headers:Record<string,string>)=>new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(h.origin+'/api/bootstrap',{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    const home=await fetch(h.origin);assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.match(await home.text(),/Agent 工作台/);
    assert.equal((await fetch(h.origin+'/client.js')).status,200);
    for(const mod of ['/client/state.js','/client/api.js','/client/markdown.js','/client/trace.js','/client/conversation.js','/client/inspector.js','/client/sidebar.js','/client/extensions.js']){
      const res=await fetch(h.origin+mod);assert.equal(res.status,200);assert.match(res.headers.get('content-type')!,/javascript/);
    }
    for(const path of ['/.env','/package.json','/api/runs/../../.env','/client/../server.js','/client/missing.js','/api/extensions/skills/../../.env'])assert.equal((await fetch(h.origin+path)).status,404);
    assert.equal(await rawStatus({Host:'evil.example'}),403);
    assert.equal(await rawStatus({'Sec-Fetch-Site':'cross-site'}),403);
    assert.equal('apiKey' in h.bootstrap.model,false);assert.ok(h.bootstrap.profiles.length>=3);assert.equal(h.bootstrap.maxConcurrentRuns,2);
    const ext=await(await fetch(h.origin+'/api/extensions')).json();assert.ok(Array.isArray(ext.builtinSources));assert.ok(Array.isArray(ext.builtinSkills));
    const skill=await(await fetch(h.origin+'/api/extensions/skills/general-agent')).json();assert.equal(skill.name,'general-agent');assert.equal(skill.kind,'builtin');assert.ok(skill.body.length>0);
  }finally{await h.close();}
});
check('contract','Workbench mutations require exact origin, CSRF token and bounded JSON, before starting runs',async()=>{
  const h=await harness();
  try{
    const input={profile:'standard',mode:'replay',permission:'explore'};
    assert.equal((await h.post('/api/runs',input,{'X-Cwatch-Token':'wrong'})).status,403);
    assert.equal((await h.post('/api/runs',input,{Origin:'https://evil.example'})).status,403);
    assert.equal((await h.post('/api/runs',input,{'Content-Type':'text/plain'})).status,400);
    assert.equal((await h.post('/api/runs',{...input,padding:'x'.repeat(66000)})).status,413);
    assert.equal((await h.post('/api/runs',{...input,sourcePath:'.env'})).status,400);
    assert.equal(h.service.list().length,0);
  }finally{await h.close();}
});
check('integration','Workbench HTTP starts a real replay, streams its state, downloads the report and isolates run IDs',async()=>{
  const h=await harness();const controller=new AbortController();
  try{
    const response=await h.post('/api/runs',{profile:'standard',mode:'replay',permission:'explore'});assert.equal(response.status,202);const run=await response.json() as RunSnapshot;
    const stream=await fetch(h.origin+'/api/runs/'+run.id+'/events',{signal:controller.signal});assert.equal(stream.headers.get('content-type'),'text/event-stream; charset=utf-8');const reader=stream.body!.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: snapshot/);controller.abort();
    const result=await h.service.wait(run.id);assert.equal(result.status,'complete');const get=await(await fetch(h.origin+'/api/runs/'+run.id)).json() as RunSnapshot;assert.equal(get.claims.length,1);
    const report=await fetch(h.origin+'/api/runs/'+run.id+'/report');assert.match(report.headers.get('content-disposition')!,/attachment/);assert.match(await report.text(),/合成测试快照/);
    assert.equal((await fetch(h.origin+'/api/runs/00000000-0000-0000-0000-000000000000')).status,404);
    assert.equal((await h.post('/api/runs/'+run.id+'/approvals/00000000-0000-0000-0000-000000000000',{allowed:true,argsHash:'0'.repeat(64)})).status,409);
    assert.equal((await h.post('/api/runs/'+run.id+'/delete',{},{'X-Cwatch-Token':'wrong'})).status,403);
    const deleted=await h.post('/api/runs/'+run.id+'/delete',{});assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{deleted:run.id});
    assert.equal((await fetch(h.origin+'/api/runs/'+run.id)).status,404);
  }finally{controller.abort();await h.close();}
});
