import { chromium, type BrowserContext } from 'playwright-core';
import { existsSync } from 'node:fs';
import { BrowserSource, type BrowserDependencies } from "@cwatch/shared/sources/browser";
import { SourceConfigsSchema } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
import { Trace, validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { id } from "@cwatch/core/types";
import { store, task, deferred } from './harness.ts';
export const browserVersions:string[]=[];
export const fixtureOrigin='https://browser-fixture.example';
export const fixtureUrl=fixtureOrigin+'/pricing';
export function browserExecutable():string|undefined {
  if(process.env.EVAL_BROWSER_EXECUTABLE){if(!existsSync(process.env.EVAL_BROWSER_EXECUTABLE))throw new Error('EVAL_BROWSER_EXECUTABLE does not exist');return process.env.EVAL_BROWSER_EXECUTABLE;}
  const candidates=[chromium.executablePath(),'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'];
  const found=candidates.find(path=>existsSync(path));
  if(!found)throw new Error('browser_eval_requires_browser: npm run browser:install or set EVAL_BROWSER_EXECUTABLE');
  return found;
}
const html='<!doctype html><html><head><title>Synthetic pricing fixture</title></head><body><main id="price">Loading</main><script src="/app.js"></script></body></html>';
const js="Promise.allSettled([\nfetch('/write',{method:'POST',body:'must be blocked'}),\nfetch('https://outside.example/exfiltrate'),\nfetch('/data').then(r=>r.json()).then(data=>{\n document.getElementById('price').textContent='Pro '+data.price+' USD';\n const ld=document.createElement('script');ld.type='application/ld+json';ld.textContent=JSON.stringify({name:'Pro plan',identifier:'pro',datePublished:'2026-10-17T00:00:00Z',offers:{price:data.price,priceCurrency:'USD'}});document.head.appendChild(ld);\n})\n]).then(()=>{document.body.dataset.ready='true';});";

export async function browserHarness(mode:'render'|'redirect'|'hold'|'limit'|'oversized'='render') {
  const value=task(),data=store(),registry=new ToolRegistry(),trace=new Trace(data,value.taskId,id()),reached:string[]=[],seen=deferred<void>(),release=deferred<void>();
  let browserContext:BrowserContext|undefined,closed=false;
  const executablePath=browserExecutable();
  const dependencies:BrowserDependencies={
    provenance:'fixture',
    request:async input=>{
      const url=String(input);reached.push(url);
      if(mode==='hold'){seen.resolve();await release.promise;}
      if(mode==='oversized'&&url===fixtureUrl)return new Response('x'.repeat(2_000_001),{headers:{'content-type':'text/html'}});
      if(mode==='redirect'&&url===fixtureUrl)return new Response(null,{status:302,headers:{location:'https://outside.example/redirected'}});
      if(url===fixtureUrl)return new Response(html,{headers:{'content-type':'text/html'}});
      if(url===fixtureOrigin+'/app.js')return new Response(js,{headers:{'content-type':'application/javascript'}});
      if(url===fixtureOrigin+'/data')return new Response('{"price":"29"}',{headers:{'content-type':'application/json'}});
      return new Response('unexpected fixture request',{status:500});
    },

    launch:async options=>{
      const browser=await chromium.launch({...options,executablePath});
      browserVersions.push(browser.version());
      const close=browser.close.bind(browser);let closing:Promise<void>|undefined;
      browser.close=()=>closing??=(async()=>{await browserContext?.tracing.stop({path:data.path('browser-trace.zip')}).catch(()=>{});await close();closed=true;})();
      return browser;
    },
    configureContext:async context=>{
      browserContext=context;await context.tracing.start({screenshots:true,snapshots:true});

    },
  };
  const config=SourceConfigsSchema.parse([{slug:'official',kind:'browser',entityId:value.competitor.id,entityName:value.competitor.name,product:value.product,domain:value.competitor.domains[0],urls:[fixtureUrl],allowedDomains:['browser-fixture.example'],browser:{readySelector:'body[data-ready="true"]',navigationTimeoutMs:8000,maxRequests:mode==='limit'?2:40}}])[0];
  const source=new BrowserSource(config,dependencies);await registry.register('official','builtin',source,new AbortController().signal);
  const executor=new ToolExecutor(registry,new ActionPolicy(),new ApprovalManager(),data,trace,value,12000);
  trace.emit('run_started',{task:value,toolPipeline:'pre-tool-use-v1'});
  const finish=()=>{trace.emit('run_completed');const events=data.lines<TraceEvent>(trace.key);const errors=validateTrace(events);if(errors.length)throw new Error(errors.join(','));return events;};
  return {data,registry,trace,source,executor,reached,seen,release,finish,isClosed:()=>closed};
}
