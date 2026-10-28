import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { check } from './harness.ts';
import { browserHarness, fixtureOrigin, fixtureUrl } from './browser-fixture.ts';
const signal=new AbortController().signal;
check('integration','Real browser renders JavaScript pricing, blocks POST and external requests, and saves auditable HTML',async()=>{
  const h=await browserHarness();
  try {
    const result=await h.executor.execute('session__browser_tool',{url:fixtureUrl},signal) as any;
    assert.equal(result.provenance,'fixture');assert.equal(result.backend,'browser.render');
    assert.ok(result.pages[0].text.includes('Pro 29 USD'));assert.equal(result.signals[0].signalType,'price');assert.equal(result.signals[0].content.value,'29 USD');
    assert.ok(result.raw.includes('data-ready="true"'));assert.ok(result.snapshot?.hash);assert.equal(h.isClosed(),true);
    assert.deepEqual(h.reached.sort(),[fixtureUrl,fixtureOrigin+'/app.js',fixtureOrigin+'/data'].sort());
    const events=h.finish();assert.ok(events.filter(e=>e.type==='provider_tool_event'&&e.data.operation==='request_blocked').length>=2);
    assert.ok(events.some(e=>e.type==='backend_started'&&e.data.backend==='browser.render'));
  } finally {await h.registry.close();}
});
check('contract','Real browser redirects cannot contact an unapproved origin or become facts',async()=>{
  const h=await browserHarness('redirect');
  try {await assert.rejects(h.executor.execute('session__browser_tool',{url:fixtureUrl},signal));assert.deepEqual(h.reached,[fixtureUrl]);assert.equal(h.isClosed(),true);const events=h.finish();assert.ok(events.some(e=>e.type==='provider_tool_event'&&String(e.data.reason).includes('browser_redirect_forbidden')));}
  finally {await h.registry.close();}
});
check('contract','Real browser cancellation closes its process and produces no late trace events',async()=>{
  const h=await browserHarness('hold'),controller=new AbortController();
  const running=h.executor.execute('session__browser_tool',{url:fixtureUrl},controller.signal);
  try {
    await h.seen.promise;controller.abort(new Error('browser_operator_cancelled'));await assert.rejects(running,/browser_operator_cancelled/);
    await h.registry.close();assert.equal(h.isClosed(),true);const events=h.finish();h.release.resolve();
    await Promise.resolve();assert.deepEqual(h.data.lines(h.trace.key),events);
  } finally {controller.abort();h.release.resolve();await running.catch(()=>{});await h.registry.close();}
});

check('integration','Real Pi worker drives browser and API MCP through the same host permission and evidence pipeline',async()=>{
  const {ApiMcpSource,PlatformApiAdapter,PlatformApiConfigSchema}=await import("@cwatch/shared/sources/api-tools");
  const {PiModel}=await import("@cwatch/shared/agent/models");
  const {runInvestigation}=await import("@cwatch/server-core/runtime/investigation");
  const {task,json}=await import('./harness.ts');
  const {validateTrace}=await import("@cwatch/shared/sessions/trace");
  const h=await browserHarness(),value={...task(),allowedSources:['official','github'],signalTypes:['release','price'] as Array<'release'|'price'>},requests:any[]=[];
  const api=new ApiMcpSource('github',new PlatformApiAdapter('github',PlatformApiConfigSchema.parse({baseUrl:'https://api-fixture.example',resultFormat:'retrieval'}),value.competitor.id,value.product,async()=>new Response(JSON.stringify(json('fixtures/github.json')))));
  await h.registry.register('github','mcp',api,signal);
  const plan=json<any[]>('fixtures/model-script.json')[0];plan.args.sources=value.allowedSources;
  const steps:any[]=[plan,{kind:'call_tool',name:'session__browser_tool',args:{url:fixtureUrl}},{kind:'call_tool',name:'session__read_source_guide',args:{source:'github'}},{kind:'call_tool',name:'mcp__github__api_github',args:{path:'/releases',method:'GET',params:{}}},{kind:'call_tool',name:'workflow__analyze',args:{}},{kind:'call_tool',name:'workflow__review',args:{}},{kind:'call_tool',name:'workflow__draft',args:{narrative:'Synthetic browser and API MCP fixture report.',claimIds:[]}},{kind:'respond',text:'Saved fixture report.'}];
  const errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push(body);
      assert.equal(req.headers.authorization,'Bearer fixture-browser-api-mcp-model-key');
      const step=structuredClone(steps[requests.length-1]);assert.ok(step,'unexpected extra provider request');
      if(step.name==='workflow__draft'){
        const analysis=body.messages.flatMap((message:any)=>message.tool_calls??[]).find((call:any)=>call.function.name==='workflow__analyze');
        step.args.claimIds=JSON.parse(body.messages.find((message:any)=>message.role==='tool'&&message.tool_call_id===analysis.id).content).claims.map((claim:any)=>claim.id);
      }
      const delta=step.kind==='call_tool'?{role:'assistant',tool_calls:[{index:0,id:'adapter-call-'+requests.length,type:'function',function:{name:step.name,arguments:JSON.stringify(step.args)}}]}:{role:'assistant',content:step.text};
      const chunk={id:'adapter-response-'+requests.length,object:'chat.completion.chunk',created:1,model:'fixture-adapters',choices:[{index:0,delta,finish_reason:null}]};
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk)+'\n\n');
      res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:step.kind==='call_tool'?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');res.end('data: [DONE]\n\n');
    } catch(error){errors.push(error);if(!res.headersSent)res.writeHead(500);res.end('fixture failure');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const model=PiModel.fromEnvironment({MODEL_PROVIDER:'fixture-browser-api-mcp',MODEL_ID:'fixture-adapters',API_KEY:'fixture-browser-api-mcp-model-key',BASE_URL:'http://127.0.0.1:'+address.port+'/v1'});
    const result=await runInvestigation(value,model,h.registry,h.data,'replay',{timeoutMs:45000,toolTimeoutMs:15000,secrets:['fixture-browser-api-mcp-model-key']});
    assert.equal(result.status,'complete',result.error);assert.deepEqual(result.gaps,[]);assert.equal(requests.length,8);assert.deepEqual(errors,[]);
    const events=h.data.lines<any>('traces/'+result.runId+'.jsonl');assert.deepEqual(validateTrace(events,['fixture-browser-api-mcp-model-key']),[]);
    assert.equal(events.filter(e=>e.type==='pre_tool_use_request').length,7);
    assert.ok(events.some(e=>e.type==='backend_started'&&e.data.backend==='browser.render'));assert.ok(events.some(e=>e.type==='backend_started'&&e.data.backend==='mcp.api.tools_call'));
    assert.ok(events.some(e=>e.type==='agent_process'&&e.data.state==='exited'));assert.equal(h.data.read<any[]>('claims/'+result.runId+'.json',[]).length,2);
    h.finish();
  } finally {await h.registry.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});

check('contract','Browser request budget counts denied attempts and closes the renderer on exhaustion',async()=>{
  const h=await browserHarness('limit');
  try {await assert.rejects(h.executor.execute('session__browser_tool',{url:fixtureUrl},signal));assert.equal(h.isClosed(),true);assert.ok(h.reached.length<=2);const events=h.finish();assert.ok(events.some(e=>e.type==='provider_tool_event'&&String(e.data.reason).includes('browser_request_limit')));}
  finally {await h.registry.close();}
});
check('contract','Browser response byte cap rejects oversized content before fulfilling it to the page',async()=>{
  const h=await browserHarness('oversized');
  try {await assert.rejects(h.executor.execute('session__browser_tool',{url:fixtureUrl},signal));assert.equal(h.isClosed(),true);assert.deepEqual(h.reached,[fixtureUrl]);const events=h.finish();assert.ok(events.some(e=>e.type==='provider_tool_event'&&String(e.data.reason).includes('browser_resource_too_large')));}
  finally {await h.registry.close();}
});
