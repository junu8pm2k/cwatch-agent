import assert from 'node:assert/strict';
import { ContextPipeline } from "@cwatch/shared/agent/core/prompt-builder";
import { ActionPolicy, PERMISSION_MODES } from "@cwatch/shared/agent/core/permission-manager";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { SourceConfigsSchema, SourceServerBuilder } from "@cwatch/shared/sources/server-builder";
import { McpConnectionPool } from "@cwatch/shared/mcp/client-pool";
import { AgentEventSchema, Trace, TraceSchema, validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { type Action, type AgentState } from "@cwatch/core/types";
import { check, CountingClient, deferred, emptySchema, store, task } from './harness.ts';

const signal=new AbortController().signal;
const actions:Action[]=['collect','analyze','local_draft','modify','send','publish'];
for(const mode of PERMISSION_MODES)check('contract',mode+' exposes exactly its allowed tool surface across builtin and MCP source channels',async()=>{
  const registry=new ToolRegistry(),value=task();value.allowedSources=['builtin','platform','thirdparty'];
  try {
    for(const [slug,channel]of [['builtin','builtin'],['platform','mcp'],['thirdparty','mcp'],['outside','mcp']]as const)await registry.register(slug,channel,new CountingClient(actions.map(action=>({name:action,description:action,action,inputSchema:emptySchema}))),signal);
    const tools=new ActionPolicy(mode).visibleTools(value,registry);
    const expected=mode==='explore'?actions.slice(0,3):actions;
    assert.deepEqual(tools.map(t=>t.proxy_name).sort(),value.allowedSources.flatMap(slug=>expected.map(action=>(slug==='builtin'?'':'mcp__')+slug+'__'+action)).sort());
    assert.ok(tools.every(tool=>tool.proxy_name.startsWith('mcp__')===(tool.channel==='mcp')));
    registry.setActive('thirdparty',false);
    assert.ok(new ActionPolicy(mode).visibleTools(value,registry).every(t=>t.source_slug!=='thirdparty'));
  } finally {await registry.close();}
});
check('contract','Context template injects permission branches, entity, whitelist and time on every turn',async()=>{
  const registry=new ToolRegistry(),value=task(),policy=new ActionPolicy('ask');
  const source=new CountingClient();await registry.register('official','mcp',source,signal);
  const state:AgentState={task:value,observations:[],decisions:[],iteration:0};
  const pipeline=new ContextPipeline('Host-selected investigation skill.');
  try {
    const first=pipeline.prepareTurn(state,registry,policy);
    assert.match(first.stable,/PERMISSION MODE: ask/);assert.ok(first.stable.includes(value.competitor.id));assert.ok(first.stable.includes(value.window.start));assert.ok(first.stable.includes('SOURCE WHITELIST:'));
    policy.setMode('explore');registry.setActive('official',false);
    const second=pipeline.prepareTurn({...state,iteration:1},registry,policy);
    assert.match(second.stable,/PERMISSION MODE: explore/);assert.deepEqual(second.tools,[]);assert.notEqual(first.contextHash,second.contextHash);
    assert.throws(()=>new ContextPipeline(' ').prepareTurn(state,registry,policy),/empty skill/);
  } finally {await registry.close();}
});
check('contract','A running context never silently grants newly registered or replaced bindings',async()=>{
  const registry=new ToolRegistry(),value=task(),policy=new ActionPolicy(),state:AgentState={task:value,observations:[],decisions:[],iteration:0};
  const definition={name:'op',description:'read',action:'collect' as const,inputSchema:emptySchema};
  await registry.register('official','mcp',new CountingClient([definition]),signal);
  const pipeline=new ContextPipeline('Investigation');const first=pipeline.prepareTurn(state,registry,policy);
  await registry.register('official','mcp',new CountingClient([{...definition,description:'replacement'}]),signal);
  assert.deepEqual(pipeline.prepareTurn(state,registry,policy).tools,[]);
  assert.equal(pipeline.isDisclosed(registry.binding('mcp__official__op')),false);
  assert.equal(first.tools.length,1);await registry.close();
});
check('contract','AgentEvent validates permission payloads and Trace refuses malformed events before writing',()=>{
  const data=store(),trace=new Trace(data,task().taskId,'typed-events');
  trace.emit('run_started',{task:task()});
  assert.throws(()=>trace.emit('pre_tool_use_response',{action:'allow'}));
  assert.throws(()=>trace.emit('unknown_event',{secret:'must-not-be-written'}));
  trace.emit('model_requested',{iteration:0,contextChars:42});trace.emit('decision_made',{decision:{kind:'respond',text:'Done.'}});trace.emit('run_completed');
  const events=data.lines<TraceEvent>(trace.key);
  assert.deepEqual(events.map(e=>e.sequence),[1,2,3,4]);assert.ok(events.every(e=>e.schemaVersion===2&&TraceSchema.safeParse(e).success));
  assert.equal(AgentEventSchema.safeParse({type:'execution_finished',data:{requestId:'r',state:'successful'}}).success,false);
  assert.equal(AgentEventSchema.safeParse({type:'execution_finished',data:{requestId:'r',state:'completed'}}).success,true);
  assert.deepEqual(validateTrace(events),[]);
  const downgraded=structuredClone(events);delete downgraded[1].schemaVersion;
  assert.ok(validateTrace(downgraded).includes('trace schema downgrade'));
});
check('contract','Source builder classifies browser as builtin and wraps platform APIs as MCP',async()=>{
  const value=task(),builder=new SourceServerBuilder(process.cwd());
  const base={entityId:value.competitor.id,entityName:value.competitor.name,product:value.product,domain:value.competitor.domains[0]};
  const configs=SourceConfigsSchema.parse([
    {...base,slug:'official',kind:'web',allowedDomains:['example.com']},
    {...base,slug:'browser',kind:'browser',urls:['https://example.com/pricing'],allowedDomains:['example.com'],browser:{channel:'msedge'}},
    {...base,slug:'platform',kind:'github_releases',repo:'nodejs/node'},
    {...base,slug:'platform_api',kind:'api',api:{baseUrl:'https://platform.example'}},
    {...base,slug:'mcp',kind:'mcp',command:process.execPath,args:[],toolSemantics:{read:'collect'}},
  ]);
  const expected=['builtin','builtin','mcp','mcp','mcp'];
  try {for(let i=0;i<configs.length;i++){const built=await builder.build(configs[i],'live',signal);assert.equal(built.channel,expected[i]);await built.client.close();}}
  finally {await builder.mcpPool.close();}
});
check('contract','Disabled sources do not start processes, resolve credentials or disclose tools',async()=>{
  const registry=new ToolRegistry(),builder=new SourceServerBuilder(process.cwd());
  const configs=SourceConfigsSchema.parse([{slug:'disabled',active:false,kind:'api',api:{baseUrl:'https://platform.example',auth:{tokenEnv:'MISSING_DISABLED_SOURCE_SECRET'}}}]);
  try {assert.deepEqual(await builder.register(configs,'live',registry,signal),[]);assert.equal(registry.known('disabled'),true);assert.equal(registry.active('disabled'),false);assert.deepEqual(registry.list(),[]);}
  finally {await registry.close();await builder.mcpPool.close();}
});
check('contract','MCP pool deduplicates discovery, isolates caller cancellation and closes only the last lease',async()=>{
  const pool=new McpConnectionPool(),ready=deferred<Awaited<ReturnType<CountingClient['listTools']>>>(),source=new CountingClient();
  let discoveries=0;source.listTools=async()=>{discoveries++;return ready.promise;};
  const a=pool.acquire('same-config',()=>source),b=pool.acquire('same-config',()=>{throw Error('duplicate connection');});
  const controller=new AbortController(),first=a.listTools(controller.signal),second=b.listTools(signal);
  controller.abort(new Error('caller_cancelled'));await assert.rejects(first,/caller_cancelled/);
  ready.resolve(source.definitions);assert.equal((await second).length,1);assert.equal(discoveries,1);assert.equal(pool.size,1);
  await a.close();assert.equal(source.closed,0);await b.close();assert.equal(source.closed,1);assert.equal(pool.size,0);
  await b.close();assert.equal(source.closed,1);await assert.rejects(b.listTools(signal),/lease_closed/);await pool.close();
});
check('contract','MCP pool keeps different configurations separate and enforces its capacity',async()=>{
  const pool=new McpConnectionPool(2),a=new CountingClient(),b=new CountingClient();
  const first=pool.acquire('one',()=>a),second=pool.acquire('two',()=>b);
  assert.throws(()=>pool.acquire('three',()=>new CountingClient()),/capacity/);
  await pool.close();assert.equal(a.closed,1);assert.equal(b.closed,1);
  await first.close();await second.close();assert.equal(a.closed,1);assert.throws(()=>pool.acquire('one',()=>a),/pool_closed/);
});
