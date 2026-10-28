import { randomUUID } from 'node:crypto';
import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { abortable, RetrievalSchema, now, type Action, type SourceClient, type SourceGuidePort, type ToolDefinition, type ToolExecutionContext, isInvestigationTask, type AgentTask, type RetrievalResult } from '@cwatch/core/types';
import { Redactor } from '../sessions/trace.ts';
import { PrerequisiteManager } from '../agent/core/prerequisite-manager.ts';
import { classifyApiResponse } from './api-http.ts';

const Ajv = AjvModule as unknown as typeof import('ajv').default;
const tokenName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const safeHeader = z.string().regex(/^[A-Za-z0-9-]+$/);
const methods = ['GET','POST','PUT','PATCH','DELETE'] as const;
export function apiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('api_base_url_requires_https_without_credentials_query_or_fragment');
  return url;
}
export function apiToolUrl(base: string, path: string): URL {
  const root = apiBaseUrl(base);
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\%\u0000-\u0020]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw new Error('invalid_api_request_path');
  const url = new URL(root.pathname.replace(/\/$/, '') + path, root.origin);
  if (url.origin !== root.origin) throw new Error('api_origin_mismatch');
  return url;
}
function pattern(value: string): boolean {
  const path=value.endsWith('/**')?value.slice(0,-3)||'/':value;
  try { apiToolUrl('https://configured.example',path); return !path.includes('*'); } catch { return false; }
}
export function matchesApiPath(path: string, rule: string): boolean {
  return rule.endsWith('/**') ? rule==='/**'||path===rule.slice(0,-3)||path.startsWith(rule.slice(0,-2)) : path===rule;
}
const ruleSchema=z.object({
  path:z.string().refine(pattern,'invalid_api_rule_path'),method:z.enum(methods),action:z.enum(['collect','modify','send','publish']),
  paramsSchema:z.record(z.string(),z.unknown()).optional(),
}).strict();
export const PlatformApiConfigSchema=z.object({
  baseUrl:z.string().url(),
  headers:z.record(safeHeader,z.string().refine(value=>!/[\r\n]/.test(value))).default({}),
  auth:z.object({tokenEnv:tokenName,location:z.enum(['header','query']).default('header'),name:safeHeader.optional(),scheme:z.enum(['bearer','raw']).default('bearer'),required:z.boolean().default(true)}).strict().optional(),
  allowedPaths:z.array(z.string().refine(pattern,'invalid_api_allowed_path')).min(1).default(['/**']),
  blockedPaths:z.array(z.string().refine(pattern,'invalid_api_blocked_path')).default([]),
  requestRules:z.array(ruleSchema).max(64).default([]),
  fixedParams:z.record(z.string(),z.unknown()).default({}),
  resultFormat:z.enum(['json','retrieval']).default('json'),
}).strict().superRefine((config,ctx)=>{
  try { apiBaseUrl(config.baseUrl); } catch(error){ctx.addIssue({code:'custom',message:String(error)});}
  for(const key of Object.keys(config.headers))if(/authorization|cookie|key|token|secret|password/i.test(key))ctx.addIssue({code:'custom',message:'api_credentials_require_env_reference'});
  if(new Set(config.requestRules.map(r=>r.method+':'+r.path)).size!==config.requestRules.length)ctx.addIssue({code:'custom',message:'duplicate_api_request_rule'});
  for(const rule of config.requestRules){
    if(rule.action==='collect'&&!['GET','POST'].includes(rule.method))ctx.addIssue({code:'custom',message:'write_method_requires_write_action'});
    if(rule.paramsSchema&&(rule.paramsSchema.type!=='object'||rule.paramsSchema.$async))ctx.addIssue({code:'custom',message:'api_params_require_sync_object_schema'});
  }
});
export type PlatformApiConfig=z.infer<typeof PlatformApiConfigSchema>;
export const ApiRequestSchema=z.object({
  path:z.string().min(1).max(2048),method:z.enum(methods),
  params:z.record(z.string(),z.unknown()).default({}),
  _intent:z.string().max(2000).optional(),
}).strict();
export type ApiRequest=z.infer<typeof ApiRequestSchema>;
export function apiSecrets(config: PlatformApiConfig,env:NodeJS.ProcessEnv=process.env):string[]{const token=config.auth&&env[config.auth.tokenEnv];return token?[token]:[];}
function redactor(secrets:string[]):Redactor{return new Redactor(secrets.flatMap(v=>[v,encodeURIComponent(v),new URLSearchParams({v}).toString().slice(2),JSON.stringify(v).slice(1,-1)]));}
async function boundedText(response:Response,signal:AbortSignal):Promise<string>{
  if(Number(response.headers.get('content-length'))>2_000_000){await response.body?.cancel().catch(()=>{});throw Error('api_response_too_large');}
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)try{for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>2_000_000)throw Error('api_response_too_large');chunks.push(value);}}
  finally{if(signal.aborted||size>2_000_000)await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
export function buildToolDescription(slug:string,baseUrl:string,guidePath:string):string{
  return 'Make authenticated requests to '+slug+' API ('+baseUrl+'). Supply path, method and params; credentials are injected by the host. Before the first API call, use session__read_source_guide with source="'+slug+'" to read '+guidePath+'. The host enforces this prerequisite and independently authorizes every method/path/params. POST is a write unless a host rule explicitly classifies the endpoint as read-only.';
}
export function createApiTool(slug:string,config:PlatformApiConfig,guidePath:string):ToolDefinition{
  return {name:'api_'+slug,description:buildToolDescription(slug,config.baseUrl,guidePath),inputSchema:z.toJSONSchema(ApiRequestSchema,{target:'draft-7'}),action:'modify',dynamicAction:true,availableActions:[...new Set<Action>(['collect','modify',...config.requestRules.map(r=>r.action)])]};
}
interface AdapterOptions {
  guide?:SourceGuidePort;
  mapResult?:(request:ApiRequest,body:unknown,raw:string)=>RetrievalResult|undefined;
}
export class PlatformApiAdapter implements SourceClient{
  readonly guide:SourceGuidePort;
  private readonly validators=new Map<string,(value:unknown)=>boolean>();
  constructor(readonly slug:string,readonly config:PlatformApiConfig,readonly entityId?:string,readonly product?:string,readonly fetcher:typeof fetch=fetch,readonly env:NodeJS.ProcessEnv=process.env,readonly options:AdapterOptions={}){
    this.guide=options.guide??new PrerequisiteManager(process.cwd(),slug);
    for(const rule of config.requestRules)if(rule.paramsSchema){
      const Validator=/2020-12/.test(String(rule.paramsSchema.$schema??''))?Ajv2020Module as unknown as typeof import('ajv').default:Ajv;
      this.validators.set(rule.method+':'+rule.path,new Validator({strict:false,validateFormats:false}).compile(rule.paramsSchema));
    }
  }
  async listTools():Promise<ToolDefinition[]>{return[createApiTool(this.slug,this.config,this.guide.path)];}
  private request(name:string,args:Record<string,unknown>):ApiRequest{
    if(name!=='api_'+this.slug)throw Error('unknown_api_tool');
    const input=ApiRequestSchema.parse(args);apiToolUrl(this.config.baseUrl,input.path);
    if(!this.config.allowedPaths.some(p=>matchesApiPath(input.path,p))||this.config.blockedPaths.some(p=>matchesApiPath(input.path,p)))throw Error('api_path_not_allowed');
    const rule=this.rule(input);
    if(rule){const validate=this.validators.get(rule.method+':'+rule.path);if(validate&&!validate(input.params))throw Error('invalid_api_params');}
    for(const key of Object.keys(input.params))if(Object.hasOwn(this.config.fixedParams,key))throw Error('api_fixed_parameter_override');
    const auth=this.config.auth;
    if(auth?.location==='query'&&(Object.hasOwn(input.params,auth.name??'api_key')||Object.hasOwn(this.config.fixedParams,auth.name??'api_key')))throw Error('api_auth_parameter_override');
    if(input.method==='GET'&&(Object.hasOwn(input.params,'_rawBody')||Object.hasOwn(input.params,'_contentType')))throw Error('api_get_body_not_allowed');
    if(Object.hasOwn(input.params,'_rawBody')&&Object.keys(this.config.fixedParams).length)throw Error('api_raw_body_with_fixed_params');
    if(Object.hasOwn(input.params,'_rawBody')&&typeof input.params._rawBody!=='string')throw Error('invalid_api_raw_body');
    if(Object.hasOwn(input.params,'_contentType')&&(typeof input.params._contentType!=='string'||/[\r\n]/.test(input.params._contentType)||!Object.hasOwn(input.params,'_rawBody')))throw Error('invalid_api_content_type');
    return input;
  }
  private rule(input:ApiRequest){return this.config.requestRules.filter(rule=>rule.method===input.method&&matchesApiPath(input.path,rule.path)).sort((a,b)=>b.path.replace('/**','').length-a.path.replace('/**','').length || Number(a.path.endsWith('/**'))-Number(b.path.endsWith('/**')))[0];}
  resolveAction(name:string,args:Record<string,unknown>):Action{const input=this.request(name,args);return this.rule(input)?.action??(input.method==='GET'?'collect':'modify');}
  checkPrerequisites():string|undefined{return this.guide.check();}
  validateScope(name:string,args:Record<string,unknown>,task:AgentTask):string|undefined{
    if(isInvestigationTask(task)&&(this.entityId!==task.competitor.id||this.product!==task.product))return'api_entity_product_mismatch';
    try{this.request(name,args);return undefined;}catch(error){return'api_scope_invalid:'+String(error);}
  }
  async callTool(name:string,args:Record<string,unknown>,signal:AbortSignal,context?:ToolExecutionContext):Promise<RetrievalResult>{
    if(!context)throw Error('api_mcp_execution_context_required');
    signal.throwIfAborted();
    const input=this.request(name,args),prerequisite=this.guide.check();if(prerequisite)throw Error(prerequisite);
    const clean=redactor(apiSecrets(this.config,this.env)),url=apiToolUrl(this.config.baseUrl,input.path),headers=new Headers(this.config.headers);
    const params=Object.assign(Object.create(null),this.config.fixedParams,input.params) as Record<string,unknown>,auth=this.config.auth;
    if(auth){const token=this.env[auth.tokenEnv];if(!token&&auth.required)throw Error('api_credential_missing:'+auth.tokenEnv);if(token){const value=(auth.scheme==='bearer'?'Bearer ':'')+token;if(auth.location==='header')headers.set(auth.name??'Authorization',value);else url.searchParams.set(auth.name??'api_key',value);}}
    let body:string|undefined;
    if(input.method==='GET')for(const[key,value]of Object.entries(params))url.searchParams.set(key,typeof value==='object'?JSON.stringify(value):String(value));
    else if(typeof params._rawBody==='string'){body=params._rawBody;headers.set('Content-Type',typeof params._contentType==='string'?params._contentType:'text/plain');}
    else{body=JSON.stringify(params);headers.set('Content-Type','application/json');}
    context.event('provider_tool_event',{provider:'mcp',protocol:'mcp',bridge:'platform-api',phase:'http_request',sourceSlug:this.slug,path:input.path,httpMethod:input.method,effectiveAction:this.resolveAction(name,args),params:clean.clean(input.params)});
    try{
      const{response,raw}=await context.stage('mcp.api.http.'+input.method.toLowerCase(),async()=>{
        try{const prerequisite=this.guide.check();if(prerequisite)throw Error(prerequisite);const response=await this.fetcher(url,{method:input.method,headers,body,signal,redirect:'error'});return{response,raw:clean.clean(await boundedText(response,signal))};}
        catch(error){if(signal.aborted)throw signal.reason;throw Error(clean.clean(String(error)));}
      });
      const { status, http } = classifyApiResponse(this.config.baseUrl, response, raw);
      context.event('provider_tool_event',{provider:'mcp',protocol:'mcp',bridge:'platform-api',phase:'http_response',sourceSlug:this.slug,path:input.path,httpMethod:input.method,status,http});
      if(!response.ok)return{status,signals:[],raw,error:'HTTP '+response.status,provenance:'live',http};
      try{
        const parsed=JSON.parse(raw),mapped=this.options.mapResult?.(input,parsed,raw);if(mapped)return RetrievalSchema.parse({...mapped,http});
        if(this.config.resultFormat==='retrieval'){const result=RetrievalSchema.parse(parsed);if(result.signals.some(s=>s.sourceSlug!==this.slug))throw Error('api_source_mismatch');return {...result,http};}
        return{status:'success_with_data',signals:[],raw,provenance:'live',http,pages:[{url:apiToolUrl(this.config.baseUrl,input.path).href,title:'API '+this.slug+' '+input.path,text:raw,published_at:null,retrieved_at:now(),truncated:false}]};
      }catch(error){return{status:'parse_failed',signals:[],raw,error:clean.clean(String(error)),provenance:'live',http};}
    }catch(error){if(signal.aborted)throw signal.reason;if(error instanceof Error&&error.message==='backend_policy_block')throw error;return{status:'unknown',signals:[],raw:'',error:clean.clean(String(error)),provenance:'live'};}
  }
  async close():Promise<void>{}
}

interface Invocation {signal:AbortSignal;context:ToolExecutionContext;secrets:string[];failure?:unknown}
/** Craft-style API tool -> MCP server. Real initialize, tools/list and tools/call over an in-memory transport. */
export class ApiMcpSource implements SourceClient {
  private readonly client=new Client({name:'cwatch',version:'0.1.0'});
  private server?:Server;
  private connection?:Promise<void>;
  private readonly lifetime=new AbortController();
  private readonly invocations=new Map<string,Invocation>();
  private definitions:ToolDefinition[]=[];
  private closed=false;
  constructor(readonly slug:string,private readonly adapter:SourceClient,private readonly secrets:()=>string[]=()=>[]){}
  get guide():SourceGuidePort|undefined{return this.adapter.guide;}
  resolveAction(name:string,args:Record<string,unknown>,task:AgentTask):Action{return this.adapter.resolveAction?.(name,args,task)??this.definitions.find(t=>t.name===name)?.action??'modify';}
  checkPrerequisites(name:string,args:Record<string,unknown>):string|undefined{return this.adapter.checkPrerequisites?.(name,args);}
  private connect():Promise<void>{
    if(this.closed)throw new Error('api_mcp_closed');
    return this.connection??=this.initialize();
  }
  private async initialize():Promise<void>{
    const signal=this.lifetime.signal;this.definitions=await this.adapter.listTools(signal);signal.throwIfAborted();
    const validators=new Map(this.definitions.map(t=>{
      if(t.inputSchema.$async)throw new Error('async_api_schema_not_supported');
      const Validator=/2020-12/.test(String(t.inputSchema.$schema??''))?Ajv2020Module as unknown as typeof import('ajv').default:Ajv;
      return[t.name,new Validator({strict:false,validateFormats:false}).compile(t.inputSchema)] as const;
    }));
    const server=this.server=new Server({name:'api_'+this.slug,version:'0.1.0'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:this.definitions.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema as {type:'object'},annotations:{readOnlyHint:t.action==='collect',destructiveHint:t.action!=='collect'}}))}));
    server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
      const id=request.params._meta?.hostInvocation,invocation=typeof id==='string'?this.invocations.get(id):undefined;
      if(!invocation)throw new Error('api_mcp_host_invocation_required');
      const args=request.params.arguments??{},validate=validators.get(request.params.name);
      if(!validate||!validate(args))throw new Error('invalid_api_tool_arguments');
      const combined=AbortSignal.any([invocation.signal,extra.signal,signal]);
      try{
        combined.throwIfAborted();
        const result=RetrievalSchema.parse(await this.adapter.callTool(request.params.name,args,combined,invocation.context));
        combined.throwIfAborted();const clean=redactor([...invocation.secrets,...this.secrets()]).clean(result);
        return{content:[{type:'text',text:JSON.stringify(clean)}]};
      }catch(error){invocation.failure=error;throw new Error('api_mcp_handler_failed');}
    });
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    try{await server.connect(serverTransport);await this.client.connect(clientTransport,{signal,timeout:25000});}
    catch(error){await Promise.allSettled([this.client.close(),server.close()]);throw error;}
  }
  async listTools(signal:AbortSignal):Promise<ToolDefinition[]>{
    signal.throwIfAborted();await abortable(this.connect(),signal);
    const result=await this.client.listTools({},{signal,timeout:25000});
    return result.tools.map(tool=>{
      const definition=this.definitions.find(t=>t.name===tool.name);if(!definition)throw new Error('undeclared_api_mcp_tool');
      return{...definition,name:tool.name,description:tool.description??tool.name,inputSchema:tool.inputSchema};
    });
  }
  validateScope(name:string,args:Record<string,unknown>,task:AgentTask):string|undefined{return this.adapter.validateScope?.(name,args,task);}
  async callTool(name:string,args:Record<string,unknown>,signal:AbortSignal,context?:ToolExecutionContext):Promise<RetrievalResult>{
    if(!context)throw new Error('api_mcp_execution_context_required');
    signal.throwIfAborted();const combined=AbortSignal.any([signal,this.lifetime.signal]);
    await context.stage('mcp.api.connect',()=>abortable(this.connect(),combined));
    const id=randomUUID(),invocation:Invocation={signal:combined,context,secrets:[...this.secrets()]};this.invocations.set(id,invocation);
    context.event('provider_tool_event',{provider:'mcp',protocol:'mcp',transport:'in-memory',bridge:'platform-api',sourceSlug:this.slug,remoteTool:name,phase:'request'});
    try{
      let result;
      try{result=await context.stage('mcp.api.tools_call',()=>this.client.callTool({name,arguments:args,_meta:{hostInvocation:id}},undefined,{signal:combined,timeout:25000}));}
      catch(error){if(invocation.failure)throw invocation.failure;throw error;}
      combined.throwIfAborted();if(invocation.failure)throw invocation.failure;
      if(result.isError)throw new Error('api_mcp_tool_error');
      const content=result.content as Array<{type:string;text?:string}>;
      const parsed=RetrievalSchema.parse(JSON.parse(content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n')));
      if(parsed.signals.some(s=>s.sourceSlug!==this.slug))throw new Error('api_source_mismatch');
      return{...parsed,backend:'mcp.api'};
    }finally{this.invocations.delete(id);}
  }
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;this.lifetime.abort(new Error('api_mcp_closed'));
    await this.connection?.catch(()=>{});
    await Promise.allSettled([this.client.close(),this.server?.close(),this.adapter.close()]);
  }
}
