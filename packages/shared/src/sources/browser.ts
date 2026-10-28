import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright-core';
import { allowedUrl } from './web.ts';
import { processEnvironment } from "../utils/process-environment.ts";
import { parseOfficial, type SourceConfig } from "./server-builder.ts";
import { now, abortable, isInvestigationTask, type AgentTask, type RetrievalResult, type SourceClient, type ToolDefinition, type ToolExecutionContext } from "@cwatch/core/types";

import { BrowserConfigSchema, type BrowserConfig } from './browser-config.ts';
export { BrowserConfigSchema, type BrowserConfig } from './browser-config.ts';
export interface BrowserDependencies { launch?:(options:LaunchOptions)=>Promise<Browser>; configureContext?:(context:BrowserContext)=>Promise<void>; provenance?: 'fixture'; request?: typeof fetch }
/** Read-only renderer, fresh browser/context, fixed host capture code; never a model-supplied script. */
export class BrowserSource implements SourceClient {
  private readonly config:BrowserConfig;
  private readonly browsers=new Set<Browser>();
  private readonly pendingLaunches=new Set<Promise<void>>();
  private readonly lifetime=new AbortController();
  constructor(readonly source:SourceConfig,readonly dependencies:BrowserDependencies={}){this.config=BrowserConfigSchema.parse(source.browser??{});}
  async listTools(signal:AbortSignal):Promise<ToolDefinition[]> {
    signal.throwIfAborted();
    if(!this.source.urls?.length||!this.source.allowedDomains?.length)throw new Error('browser_urls_and_domains_required');
    for(const url of this.source.urls)allowedUrl(url,this.source.allowedDomains);
    return [{name:'browser_tool',namespace:'session',description:'Read an operator-configured public page in a fresh browser and capture rendered text. No click, form submission or model-supplied JavaScript.',action:'collect',inputSchema:{type:'object',properties:{url:{type:'string',enum:this.source.urls}},required:['url'],additionalProperties:false}}];
  }
  validateScope(_name:string,args:Record<string,unknown>,task:AgentTask):string|undefined {
    if(!this.source.urls?.includes(String(args.url))||isInvestigationTask(task)&&(this.source.entityId!==task.competitor.id||this.source.product!==task.product))return 'browser_scope_mismatch';
    try{allowedUrl(String(args.url),this.source.allowedDomains??[]);}catch{return 'browser_scope_mismatch';}
  }
  async callTool(name:string,args:Record<string,unknown>,signal:AbortSignal,context?:ToolExecutionContext):Promise<RetrievalResult> {
    if(!context)throw new Error('browser_executor_context_required');
    if(name!=='browser_tool'||!this.source.urls?.includes(String(args.url)))throw new Error('browser_url_not_configured');
    const requested=allowedUrl(String(args.url),this.source.allowedDomains??[]).toString();
    const combined=AbortSignal.any([signal,this.lifetime.signal]);combined.throwIfAborted();
    return context.stage('browser.render',async()=>{
      const launch=(this.dependencies.launch??(options=>chromium.launch(options)))({
        headless:true,chromiumSandbox:true,
        ...(this.config.executablePath?{executablePath:this.config.executablePath}:this.config.channel!=='chromium'?{channel:this.config.channel}:{}),
        env:processEnvironment().env,timeout:this.config.navigationTimeoutMs,
      });
      // Launch has no AbortSignal. If cancelled, a late browser is still immediately reaped.
      const pending=launch.then(async browser=>{this.browsers.add(browser);if(combined.aborted){await browser.close().catch(()=>{});this.browsers.delete(browser);}},()=>{});
      this.pendingLaunches.add(pending);void pending.finally(()=>this.pendingLaunches.delete(pending)).catch(()=>{});
      const browser=await abortable(launch,combined);
      const abort=()=>{void browser.close().catch(()=>{});};
      combined.addEventListener('abort',abort,{once:true});
      if(combined.aborted)abort();
      try {
        combined.throwIfAborted();
        const browserContext=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
        await this.dependencies.configureContext?.(browserContext);
        let page:Awaited<ReturnType<BrowserContext['newPage']>>|undefined,requests=0,totalBytes=0,navigationError:Error|undefined;
        browserContext.on('page',opened=>{if(page&&opened!==page)void opened.close().catch(()=>{});});
        await browserContext.routeWebSocket('**/*',socket=>socket.close());
        await browserContext.route('**/*',async route=>{
          const request=route.request();
          try {
            combined.throwIfAborted();
            if(++requests>this.config.maxRequests)throw new Error('browser_request_limit');
            const url=allowedUrl(request.url(),this.source.allowedDomains??[]);
            if(!['GET','HEAD'].includes(request.method()))throw new Error('browser_read_only_method');
            if(request.isNavigationRequest()&&(!page||request.frame()!==page.mainFrame()||url.toString()!==requested||request.redirectedFrom()))throw new Error('browser_navigation_changed');
            await context.stage('browser.request',async()=>{
              // Playwright routing does not re-intercept redirect hops. Fetch manually and never fulfill a redirect.
              const safeHeaders=Object.fromEntries(Object.entries(request.headers()).filter(([key])=>['accept','accept-language','user-agent','content-type','origin','referer'].includes(key.toLowerCase())));
              const response=await abortable((this.dependencies.request??fetch)(url.toString(),{method:request.method(),headers:safeHeaders,redirect:'manual',signal:combined}),combined);
              if(response.status>=300&&response.status<400) { await response.body?.cancel(); throw new Error('browser_redirect_forbidden'); }
              if(Number(response.headers.get('content-length'))>2_000_000){await response.body?.cancel();throw new Error('browser_resource_too_large');}
              const chunks:Uint8Array[]=[];let bytes=0;const reader=response.body?.getReader();
              if(reader)try{for(;;){const part=await abortable(reader.read(),combined);if(part.done)break;bytes+=part.value.length;totalBytes+=part.value.length;if(bytes>2_000_000||totalBytes>8_000_000){await reader.cancel();throw new Error('browser_resource_too_large');}chunks.push(part.value);}}finally{reader.releaseLock();}
              combined.throwIfAborted();
              const headers=Object.fromEntries([...response.headers.entries()].filter(([key])=>!['content-encoding','content-length','transfer-encoding','connection','keep-alive','set-cookie'].includes(key.toLowerCase())));
              await route.fulfill({status:response.status,headers,body:Buffer.concat(chunks)});
            });
          } catch(error) {
            if(request.isNavigationRequest()||requests>this.config.maxRequests)navigationError=error instanceof Error?error:new Error(String(error));
            if(requests>this.config.maxRequests)void browser.close().catch(()=>{});
            if(!combined.aborted&&requests<=this.config.maxRequests+1)context.event('provider_tool_event',{provider:'browser',operation:'request_blocked',reason:String(error)});
            await route.abort().catch(()=>{});
          }
        });
        page=await browserContext.newPage();page.setDefaultTimeout(this.config.navigationTimeoutMs);
        const response=await abortable(page.goto(requested,{waitUntil:'domcontentloaded',timeout:this.config.navigationTimeoutMs}),combined);
        if(navigationError)throw navigationError;
        if(!response?.ok())throw new Error('browser_http_status:'+(response?.status()??'missing'));
        if(this.config.readySelector)await abortable(page.locator(this.config.readySelector).waitFor({state:'attached'}),combined);
        const raw=await abortable(page.evaluate(()=>document.documentElement.outerHTML.slice(0,2_000_001)),combined);
        const text=await abortable(page.evaluate(()=>document.body?.innerText.slice(0,24_001)??''),combined);
        const title=(await abortable(page.title(),combined)).slice(0,512);
        if(raw.length>2_000_000)throw new Error('browser_snapshot_too_large');
        if(allowedUrl(page.url(),this.source.allowedDomains??[]).toString()!==requested)throw new Error('browser_final_url_changed');
        combined.throwIfAborted();
        const retrieved=now();let signals:RetrievalResult['signals']=[];
        try{signals=parseOfficial(this.source,requested,raw,retrieved);}catch{/* A page is raw material until structured signals are supported. */}
        return {status:'success_with_data',signals,raw,provenance:this.dependencies.provenance??'live',backend:'browser.render',pages:[{url:requested,title,text:text.slice(0,24_000),published_at:null,retrieved_at:retrieved,truncated:text.length>24_000}]};
      } finally { combined.removeEventListener('abort',abort);await browser.close().catch(()=>{});this.browsers.delete(browser); }
    });
  }
  async close():Promise<void>{this.lifetime.abort(new Error('browser_source_closed'));await Promise.allSettled([...this.pendingLaunches]);await Promise.allSettled([...this.browsers].map(browser=>browser.close()));}
}
