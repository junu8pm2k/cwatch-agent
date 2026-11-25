import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { startWebServer } from '../apps/web/src/server.ts';
import { RunService } from '@cwatch/server-core/runtime/run-service';
import { check, store } from './harness.ts';
import type { WorkbenchBootstrap, RunSnapshot } from '@cwatch/core/types/runs';

async function harness(root = process.cwd()){
  const data=store(),service=new RunService({root,outputRoot:resolve(data.root,'runs')});
  const app=await startWebServer({root,port:0,service});
  const bootstrap=await(await fetch(app.origin+'/api/bootstrap')).json() as WorkbenchBootstrap;
  const post=(path:string,value:unknown,headers:Record<string,string>={})=>fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Cwatch-Token':bootstrap.csrfToken,...headers},body:JSON.stringify(value)});
  return{...app,bootstrap,post};
}
check('contract','Workbench HTTP serves local assets with a restrictive CSP and never serves workspace files',async()=>{
  const h=await harness();
  try{
    const rawStatus=(headers:Record<string,string>)=>new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(h.origin+'/api/bootstrap',{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    const home=await fetch(h.origin);assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.match(await home.text(),/调查工作台/);
    assert.equal((await fetch(h.origin+'/client.js')).status,200);
    for(const mod of ['/client/state.js','/client/api.js','/client/markdown.js','/client/trace.js','/client/activity-merger.js','/client/conversation.js','/client/evidence-rail.js','/client/sidebar.js','/client/extensions.js']){
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

check('contract','Workbench connections API manages providers, search, MCP and skills with CSRF protection and secret isolation',async()=>{
  const temp=store(),root=resolve(temp.root,'workspace');
  mkdirSync(resolve(root,'examples'),{recursive:true});
  for(const name of ['task.json','task-web.json','task-adapters.json','sources.json','sources-web.json','sources-adapters.json'])copyFileSync(resolve('examples',name),resolve(root,'examples',name));
  const h=await harness(root);
  try{
    assert.equal((await h.post('/api/extensions/providers',{provider:'acme',baseUrl:'https://api.acme.example/v1',apiKey:'secret-provider',modelIds:['acme-1']},{'X-Cwatch-Token':'wrong'})).status,403);
    const addedProvider=await h.post('/api/extensions/providers',{provider:'acme',baseUrl:'https://api.acme.example/v1',apiKey:'secret-provider',modelIds:['acme-1'],supportsReasoningEffort:true});
    assert.equal(addedProvider.status,201);
    const bootstrapAfter=await(await fetch(h.origin+'/api/bootstrap')).json() as WorkbenchBootstrap;
    assert.ok(bootstrapAfter.model.providers.some(p=>p.provider==='acme'&&p.modelIds.includes('acme-1')&&p.supportsReasoningEffort));
    assert.equal(JSON.stringify(bootstrapAfter).includes('secret-provider'),false);

    const savedSearch=await h.post('/api/extensions/search',{url:'https://api.tavily.com/search',protocol:'rest',token:'secret-search',fetchUrl:'https://api.tavily.com/extract'});
    assert.equal(savedSearch.status,200);
    const searchExt=await savedSearch.json();
    assert.equal(searchExt.search.source,'workbench');assert.equal(searchExt.search.hasToken,true);
    assert.equal(JSON.stringify(searchExt).includes('secret-search'),false);

    const addedMcp=await h.post('/api/extensions/mcp',{slug:'docs',url:'https://mcp.acme.example/mcp',transport:'auto',token:'secret-mcp',defaultAction:'collect'});
    assert.equal(addedMcp.status,201);
    const mcpExt=await addedMcp.json();
    assert.equal(mcpExt.mcpServers.some((s:{slug:string;hasAuth:boolean})=>s.slug==='docs'&&s.hasAuth),true);
    assert.equal(JSON.stringify(mcpExt).includes('secret-mcp'),false);
    assert.equal(readFileSync(resolve(root,'.cwatch','mcp.json'),'utf8').includes('secret-mcp'),false);

    const addedSkill=await h.post('/api/extensions/skills',{content:'---\nname: web-skill\ndescription: Web added skill\n---\nFollow checklist.\n'});
    assert.equal(addedSkill.status,201);
    const skillDetail=await(await fetch(h.origin+'/api/extensions/skills/web-skill')).json();
    assert.equal(skillDetail.name,'web-skill');assert.match(skillDetail.body,/Follow checklist/);

    assert.equal((await h.post('/api/extensions/providers/acme/delete',{})).status,200);
    assert.equal((await h.post('/api/extensions/search/delete',{})).status,200);
    assert.equal((await h.post('/api/extensions/mcp/docs/delete',{})).status,200);
    assert.equal((await h.post('/api/extensions/skills/web-skill/delete',{})).status,200);
    const finalExt=await(await fetch(h.origin+'/api/extensions')).json();
    assert.equal(finalExt.mcpServers.length,0);
    assert.equal(finalExt.userSkills.length,0);
  }finally{await h.close();}
});

check('contract','Workbench export API produces md, html, doc, csv and json drafts safely with XSS and CSV formula defense',async()=>{
  const h=await harness();
  try{
    const task=h.bootstrap.profiles.find(p=>p.id==='standard')!.task;
    if(!('kind' in task))task.competitor.name='=CMD("evil") <img src=x onerror=alert(1)>';
    const response=await h.post('/api/runs',{profile:'standard',mode:'replay',permission:'explore',task});
    assert.equal(response.status,202);const run=await response.json() as RunSnapshot;
    await h.service.wait(run.id);

    assert.equal((await fetch(h.origin+'/api/runs/'+run.id+'/export?format=exe')).status,400);

    const mdRes=await fetch(h.origin+'/api/runs/'+run.id+'/export?format=md');
    assert.equal(mdRes.status,200);
    assert.match(mdRes.headers.get('content-type')!,/text\/markdown/);
    assert.match(mdRes.headers.get('content-disposition')!,/attachment;.*\.md/);
    const mdText=await mdRes.text();
    assert.match(mdText,/调研概要/);assert.match(mdText,/合成测试快照/);

    const htmlRes=await fetch(h.origin+'/api/runs/'+run.id+'/export?format=html');
    assert.equal(htmlRes.status,200);
    assert.match(htmlRes.headers.get('content-type')!,/text\/html/);
    assert.match(htmlRes.headers.get('content-disposition')!,/attachment;.*\.html/);
    const htmlText=await htmlRes.text();
    assert.match(htmlText,/<!doctype html>/i);
    assert.equal(htmlText.includes('<img src=x'),false);
    assert.ok(htmlText.includes('&lt;img src=x'));

    const docRes=await fetch(h.origin+'/api/runs/'+run.id+'/export?format=doc');
    assert.equal(docRes.status,200);
    assert.match(docRes.headers.get('content-type')!,/application\/msword/);
    assert.match(docRes.headers.get('content-disposition')!,/attachment;.*\.doc/);
    const docBuf=Buffer.from(await docRes.arrayBuffer());
    assert.deepEqual([...docBuf.subarray(0,3)],[0xef,0xbb,0xbf]);
    const docText=docBuf.toString('utf8');
    assert.match(docText,/urn:schemas-microsoft-com:office:word/);
    assert.equal(docText.includes('<img src=x'),false);

    const csvRes=await fetch(h.origin+'/api/runs/'+run.id+'/export?format=csv');
    assert.equal(csvRes.status,200);
    assert.match(csvRes.headers.get('content-type')!,/text\/csv/);
    assert.match(csvRes.headers.get('content-disposition')!,/attachment;.*\.csv/);
    const csvBuf=Buffer.from(await csvRes.arrayBuffer());
    assert.deepEqual([...csvBuf.subarray(0,3)],[0xef,0xbb,0xbf]);
    const csvText=csvBuf.toString('utf8');
    assert.ok(csvText.startsWith('\uFEFF主张编号,主张内容'));
    assert.equal(csvText.includes('\n=CMD'),false);

    const jsonRes=await fetch(h.origin+'/api/runs/'+run.id+'/export?format=json');
    assert.equal(jsonRes.status,200);
    assert.match(jsonRes.headers.get('content-type')!,/application\/json/);
    const jsonObj=await jsonRes.json();
    assert.equal(jsonObj.schemaVersion,'cwatch.draft-export.v1');
    assert.equal(jsonObj.claims.length,1);
    assert.match(jsonObj.reportMarkdown,/合成测试快照/);
  }finally{await h.close();}
});
