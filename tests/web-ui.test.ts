import { startWorkbenchProvider } from './web-provider-fixture.ts';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunService, type RunServiceOptions } from '@cwatch/server-core/runtime/run-service';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { UserMcpStore } from '@cwatch/shared/mcp/storage';
import { abortable, type ModelPort } from '@cwatch/core/types';
import { startWebServer } from '../apps/web/src/server.ts';
import { WorkbenchPage } from './web-ui-page.ts';
import { browserExecutable } from './browser-fixture.ts';
import { approvalFixture } from './run-service-fixture.ts';
import { check, store, fixture } from './harness.ts';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import type { RunSnapshot } from '@cwatch/core/types/runs';
import { conversationProvider } from './conversation-fixture.ts';
import { deferred } from './harness.ts';

check('integration','Web defaults to generic Agent, runs without investigation fields and restores its result',async()=>{
  const h=await browserHarness('generic-agent');
  try{
    await h.page.goto(h.app.origin);await h.page.getByText('本地服务已连接',{exact:true}).waitFor();
    assert.equal(await h.page.getByLabel('任务模板',{exact:true}).inputValue(),'agent');
    assert.deepEqual(await h.page.locator('#profile option').evaluateAll(nodes=>nodes.map(o=>({value:o.getAttribute('value'),text:o.textContent}))),[
      {value:'agent',text:'通用 Agent'},
      {value:'web',text:'竞品调查'},
    ]);
    assert.equal(await h.page.getByLabel('任务描述',{exact:true}).isVisible(),true);
    assert.equal(await h.page.locator('#investigation-fields').isVisible(),false);
    assert.equal(await h.page.locator('#pipeline').isVisible(),false);
    await h.ui.start();await h.ui.completed();await h.ui.report();
    assert.equal(h.service.list()[0].claims.length,0);assert.equal(h.service.list()[0].toolCalls,1);
    const downloading=h.page.waitForEvent('download');await h.page.getByRole('link',{name:'下载 Markdown 结果'}).click();
    const path=await(await downloading).path();assert.ok(path);assert.match(readFileSync(path,'utf8'),/通用 Agent/);
    await h.page.screenshot({path:'artifacts/web-eval/generic-agent.png',fullPage:true});
    await h.page.reload();await h.ui.completed();await h.ui.report();
    assert.equal(await h.page.getByLabel('任务模板',{exact:true}).inputValue(),'agent');
    await h.page.getByLabel('任务模板',{exact:true}).selectOption('web');
    await h.page.locator('#new-run').click();
    assert.equal(await h.page.getByLabel('任务模板',{exact:true}).inputValue(),'agent');
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web conversation sends real user follow-ups through one Pi worker and survives browser refresh',async()=>{
  const gate=deferred<void>(),entered=deferred<void>();
  const provider=await conversationProvider(async(request,turn)=>{
    if(turn===2){assert.match(JSON.stringify(request.messages),/BROWSER-BLUE-17/);assert.match(JSON.stringify(request.messages),/First answer/);entered.resolve();await gate.promise;}
    if(turn===3)assert.match(JSON.stringify(request.messages),/Second answer/);
    return{kind:'respond',text:turn===1?'First answer: BROWSER-BLUE-17.':turn===2?'Second answer: still BROWSER-BLUE-17.':'Third answer after refresh: BROWSER-BLUE-17.'};
  });
  const variables={MODEL_PROVIDER:'conversation-ui-fixture',MODEL_ID:'conversation-fixture',API_KEY:'conversation-ui-key'},before=Object.fromEntries(Object.keys(variables).map(key=>[key,process.env[key]]));
  Object.assign(process.env,variables);let h:Awaited<ReturnType<typeof browserHarness>>|undefined;
  try{
    h=await browserHarness('conversation',{modelFactory:()=>provider.model()});await h.ui.open('agent');
    assert.equal(await h.page.getByRole('radio',{name:'真实运行',exact:true}).isChecked(),true);
    assert.equal(await h.page.getByLabel('任务描述',{exact:true}).inputValue(),'');
    await h.page.getByLabel('任务描述',{exact:true}).fill('Remember BROWSER-BLUE-17 for our conversation.');
    await h.page.getByRole('radio',{name:'离线演示',exact:true}).check();
    assert.equal(await h.page.getByLabel('任务描述',{exact:true}).getAttribute('readonly'),'');
    await h.page.getByRole('radio',{name:'真实运行',exact:true}).check();
    assert.equal(await h.page.getByLabel('任务描述',{exact:true}).inputValue(),'Remember BROWSER-BLUE-17 for our conversation.');
    assert.equal(h.service.list().length,0);
    await h.page.getByLabel('任务描述',{exact:true}).focus();await h.page.keyboard.press('Control+Enter');await h.ui.awaitingInput();
    const runId=h.service.list()[0].id;
    await h.ui.followUp('What was the code? <img src=x onerror="window.__xss=1">');await entered.promise;
    assert.equal(await h.page.getByRole('button',{name:'发送追问',exact:true}).isEnabled(),false);
    gate.resolve();await h.page.getByLabel('对话记录',{exact:true}).getByText('Second answer: still BROWSER-BLUE-17.',{exact:true}).waitFor();await h.ui.awaitingInput();
    assert.equal(await h.page.locator('img[src=x]').count(),0);assert.equal(await h.page.evaluate(()=>Reflect.get(window,'__xss')),undefined);
    await h.page.reload();await h.ui.awaitingInput();assert.equal(h.service.list().length,1);assert.equal(h.service.get(runId).messages?.length,4);
    await h.ui.followUp('Continue after refresh.');await h.page.getByLabel('对话记录',{exact:true}).getByText('Third answer after refresh: BROWSER-BLUE-17.',{exact:true}).waitFor();await h.ui.awaitingInput();
    assert.match(await h.page.getByLabel('对话记录',{exact:true}).innerText(),/Third answer after refresh/);
    await h.page.setViewportSize({width:390,height:844});assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.page.screenshot({path:'artifacts/web-eval/conversation.png',fullPage:true});
    await h.page.getByRole('button',{name:'结束会话',exact:true}).click();await h.page.getByText('已完成 / 真实会话',{exact:true}).waitFor();
    assert.equal(provider.business.length,3);assert.deepEqual(provider.errors,[]);assert.deepEqual(h.errors,[]);
    const run=h.service.get(runId),data=new FileStore(resolve(h.service.outputRoot,run.id)),events=data.lines<TraceEvent>('traces/'+run.traceRunId+'.jsonl');
    assert.equal(events.filter(event=>event.type==='agent_process'&&event.data.state==='started').length,1);assert.deepEqual(validateTrace(events),[]);
  }finally{gate.resolve();await h?.close();await provider.close();for(const key of Object.keys(variables)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
});

async function browserHarness(name:string,options:Partial<RunServiceOptions>={}){
  const data=store(),root=options.root??process.cwd(),service=new RunService({root,outputRoot:data.root,...options});
  const app=await startWebServer({root,port:0,service});let browser:Browser|undefined,context:BrowserContext|undefined,page:Page;
  const errors:string[]=[];mkdirSync('artifacts/web-eval',{recursive:true});
  try{browser=await chromium.launch({executablePath:browserExecutable(),headless:true});context=await browser.newContext({viewport:{width:1440,height:1080}});await context.tracing.start({screenshots:true,snapshots:true});page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));}catch(error){await browser?.close();await app.close();throw error;}
  return{app,service,page,ui:new WorkbenchPage(page,app.origin),errors,
    close:async()=>{
      try{await context!.tracing.stop({path:resolve('artifacts/web-eval/trace-'+name+'.zip')});}
      finally{try{await browser!.close();}finally{await app.close();}}
    },
  };
}
function webSignalFixture(){
  return {configureRegistry:async(registry:import('@cwatch/shared/tools/registry').ToolRegistry,signal:AbortSignal)=>{
    await registry.register('web','builtin',{
      listTools:async()=>createWebToolDefinitions(),
      callTool:async()=>{const data=fixture();data.signals.forEach(s=>{s.sourceSlug='web';});return data;},
      close:async()=>{},
    },signal);
  }};
}
check('integration','Web UI starts a real offline investigation, shows citations, downloads its report and restores after refresh',async()=>{
  const h=await browserHarness('replay',webSignalFixture());
  try{
    await h.ui.open();await h.page.screenshot({path:'artifacts/web-eval/desktop-empty.png',fullPage:true});await h.ui.start();await h.ui.completed();await h.ui.report();
    const expected=fixture().signals[0];
    await h.ui.reportCitations().waitFor({state:'visible'});
    assert.equal(await h.ui.reportClaims().count(),1);assert.equal(await h.ui.reportCitations().count(),1);
    assert.ok((await h.ui.reportClaims().innerText()).includes(expected.content.title+': '+expected.content.value));
    assert.equal(await h.ui.reportCitations().getAttribute('href'),expected.url);
    assert.equal(await h.ui.reportCitations().textContent(),'web · '+expected.content.title);
    assert.deepEqual(h.service.list()[0].claims.map(claim=>claim.evidence.map(evidence=>evidence.url)),[[expected.url]]);
    const downloading=h.page.waitForEvent('download');await h.page.getByRole('link',{name:'下载 Markdown 报告'}).click();const download=await downloading;const path=await download.path();assert.ok(path);assert.match(readFileSync(path,'utf8'),/合成测试快照/);
    assert.ok(readFileSync(path,'utf8').includes(expected.url));
    await h.page.screenshot({path:'artifacts/web-eval/desktop-report.png',fullPage:true});await h.page.reload();await h.ui.completed();await h.ui.report();assert.equal(h.service.list().length,1);
    await h.ui.reportCitations().waitFor({state:'visible'});assert.equal(await h.ui.reportClaims().count(),1);assert.equal(await h.ui.reportCitations().getAttribute('href'),expected.url);
    await h.page.getByRole('button',{name:'来源与连接',exact:false}).click();await h.page.getByRole('heading',{name:'来源与连接',exact:true}).waitFor();assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
for(const allowed of [true,false])check('integration','Web UI '+(allowed?'approves':'rejects')+' a real host permission request without bypassing the tool gate',async()=>{
  const fixture=approvalFixture('web'),h=await browserHarness(allowed?'approve':'deny',fixture);
  try{
    await h.ui.open();await h.page.getByLabel('工具权限',{exact:true}).selectOption('ask');await h.ui.start();await h.page.getByText('等待审批 / 离线演示',{exact:true}).waitFor();await h.ui.approvals();
    await h.page.getByRole('heading',{name:'这次操作需要你的确认'}).waitFor();assert.equal(fixture.calls.includes('request_publish'),false);
    await h.page.screenshot({path:'artifacts/web-eval/approval.png',fullPage:true});
    await h.page.getByRole('button',{name:allowed?'批准这一次':'拒绝操作',exact:true}).click();
    await h.page.getByText((allowed?'已完成':'部分完成')+' / 离线演示',{exact:true}).waitFor();
    assert.equal(fixture.calls.filter(name=>name==='request_publish').length,allowed?1:0);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
check('integration','Web UI cancels a pending approval and restores the cancelled state with zero writes',async()=>{
  const fixture=approvalFixture('web'),h=await browserHarness('cancel-approval',fixture);
  try{
    await h.ui.open();await h.page.getByLabel('工具权限',{exact:true}).selectOption('ask');await h.ui.start();await h.page.getByText('等待审批 / 离线演示',{exact:true}).waitFor();await h.ui.approvals();await h.ui.cancel();
    assert.equal(fixture.calls.includes('request_publish'),false);await h.page.reload();await h.page.getByText('已取消 / 离线演示',{exact:true}).waitFor();await h.ui.approvals();await h.page.getByRole('heading',{name:'当前没有待处理审批'}).waitFor();assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
check('integration','Web UI cancels a running investigation and releases its execution capacity',async()=>{
  const modelFactory=():ModelPort=>({decide:async(_input,signal)=>abortable(new Promise<never>(()=>{}),signal)}),h=await browserHarness('cancel-running',{modelFactory});
  try{await h.ui.open();await h.ui.start();await h.page.getByText('调查中 / 离线演示',{exact:true}).waitFor();await h.ui.cancel();assert.equal(h.service.list()[0].status,'cancelled');assert.deepEqual(h.errors,[]);}
  finally{await h.close();}
});
check('contract','Web UI remains usable on mobile, supports keyboard tabs and renders untrusted task text without HTML execution',async()=>{
  const h=await browserHarness('mobile-xss',webSignalFixture());
  try{
    await h.ui.open();await h.page.setViewportSize({width:390,height:844});assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await h.ui.start();await h.ui.completed();await h.ui.report();
    await h.page.screenshot({path:'artifacts/web-eval/mobile-report.png',fullPage:true});
    await h.page.getByRole('tab',{name:'调查报告',exact:true}).focus();await h.page.keyboard.press('ArrowRight');assert.equal(await h.page.getByRole('tab',{name:/待处理审批/}).getAttribute('aria-selected'),'true');
    const bootstrap=await(await fetch(h.app.origin+'/api/bootstrap')).json(),task=bootstrap.profiles.find((p:{id:string})=>p.id==='web').task;task.competitor.name='<img src=x onerror="window.__xss=1">';
    const response=await fetch(h.app.origin+'/api/runs',{method:'POST',headers:{Origin:h.app.origin,'Content-Type':'application/json','X-Cwatch-Token':bootstrap.csrfToken},body:JSON.stringify({profile:'web',mode:'replay',permission:'explore',task})});assert.equal(response.status,202);const created=await response.json() as RunSnapshot;await h.service.wait(created.id);
    await h.page.evaluate(()=>localStorage.removeItem('cwatch-selected-run'));await h.page.reload();await h.ui.completed();
    assert.ok((await h.page.locator('#run-title').textContent())!.includes('<img'));assert.equal(await h.page.locator('img[src=x]').count(),0);assert.equal(await h.page.evaluate(()=>Reflect.get(window,'__xss')),undefined);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web live mode runs a real Pi worker and the unified Web tool through explicit local fixtures',async()=>{
  const provider=await startWorkbenchProvider();
  const variables={MODEL_PROVIDER:'web-fixture-provider',MODEL_ID:'web-fixture-model',API_KEY:'web-fixture-provider-key',BASE_URL:provider.url};
  const before=Object.fromEntries(Object.keys(variables).map(key=>[key,process.env[key]]));Object.assign(process.env,variables);
  let h:Awaited<ReturnType<typeof browserHarness>>|undefined;
  try{
    h=await browserHarness('live-sdk',{configureRegistry:async(registry,signal)=>{
      await registry.register('web','builtin',{
        listTools:async()=>createWebToolDefinitions(),
        callTool:async(_name,_args,_signal,context)=>{if(!context)throw Error('test_context_required');return context.stage('test.web.fixture',async()=>{const data=fixture();data.signals.forEach(s=>{s.sourceSlug='web';});return data;});},
        close:async()=>{},
      },signal);
    }});await h.ui.open();await h.page.getByRole('radio',{name:'真实运行',exact:true}).check();
    assert.deepEqual(await h.ui.sourceOptions().evaluateAll(nodes=>nodes.map(node=>(node as HTMLInputElement).value)),['web']);
    await h.page.getByRole('checkbox',{name:/^联网搜索与读取/}).check();assert.deepEqual(await h.ui.selectedSources(),['web']);
    await h.ui.start();await h.page.getByText('已完成 / 真实调查',{exact:true}).waitFor({timeout:30000});await h.ui.report();
    const run=h.service.list()[0];assert.equal(run.mode,'live');assert.equal(run.claims.length,1);assert.equal(run.modelTurns,6);assert.equal(run.totalTokens,720);
    const data=new FileStore(resolve(h.service.outputRoot,run.id)),events=data.lines<TraceEvent>('traces/'+run.traceRunId+'.jsonl');
    assert.ok(events.some(event=>event.type==='agent_process'&&event.data.state==='ready'));assert.ok(events.some(event=>event.type==='backend_started'&&event.data.backend==='test.web.fixture'));assert.deepEqual(validateTrace(events),[]);
    assert.equal(provider.turns(),6);assert.deepEqual(provider.errors,[]);assert.deepEqual(h.errors,[]);
  }finally{
    await h?.close();await provider.close();for(const key of Object.keys(variables)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  }
});

check('integration','Web UI renders safe Markdown (code blocks, tables, safe links), toggles dark theme and collapses inspector',async()=>{
  const md=[
    '## 结论摘要',
    '',
    '支持 **加粗**、`inline_code`、[安全链接](https://example.com/docs) 与 [拦截链接](javascript:alert(1))。',
    '',
    '| 项目 | 状态 |',
    '| --- | --- |',
    '| Trace | 已接入 |',
    '',
    '```ts',
    'const ok = "<img src=x onerror=window.__mdXss=1>";',
    '```',
  ].join('\n');
  const h=await browserHarness('dark-markdown',{modelFactory:()=>new ReplayModel([{kind:'respond',text:md}])});
  try{
    await h.ui.open('agent');
    await h.ui.start();await h.ui.completed();await h.ui.report();
    assert.equal(await h.page.locator('.md-code-block pre code').count(),1);
    assert.equal(await h.page.locator('.md-table tbody tr').count(),1);
    assert.equal(await h.page.locator('.report-document a[href="https://example.com/docs"]').count(),1);
    assert.equal(await h.page.locator('.report-document a[href^="javascript:"]').count(),0);
    assert.equal(await h.page.evaluate(()=>Reflect.get(window,'__mdXss')),undefined);
    await h.page.locator('#theme-toggle').click();
    assert.equal(await h.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await h.page.screenshot({path:'artifacts/web-eval/dark-markdown.png',fullPage:true});
    await h.page.reload();await h.ui.completed();
    assert.equal(await h.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await h.page.locator('#toggle-inspector').click();
    assert.equal(await h.page.locator('.workbench').getAttribute('data-inspector'),'false');
    assert.equal(await h.page.locator('#right-rail').isVisible(),false);
    await h.page.locator('#toggle-inspector').click();
    assert.equal(await h.page.locator('#right-rail').isVisible(),true);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI inspects structured Trace steps, filters history and deletes completed runs',async()=>{
  const h=await browserHarness('trace-and-history');
  try{
    await h.ui.open('web');
    await h.ui.start();await h.page.getByText(/^(已完成|部分完成) \/ 离线演示$/).waitFor({timeout:20000});
    await h.page.getByRole('tab',{name:'Trace 检查',exact:true}).click();
    await h.page.locator('.trace-tree .trace-row').first().waitFor({state:'visible'});
    assert.ok(await h.page.locator('.trace-tree .trace-row').count()>=3);
    await h.page.getByRole('button',{name:/工具/}).click();
    await h.page.locator('.trace-tree .trace-row').first().click();
    await h.page.locator('.trace-detail').waitFor({state:'visible'});
    await h.page.screenshot({path:'artifacts/web-eval/trace-inspector.png',fullPage:true});
    await h.page.locator('#history-search').fill('不存在的关键词');
    await h.page.getByText('没有匹配的任务记录',{exact:true}).waitFor();
    await h.page.locator('#history-search').fill('');
    await h.page.locator('.history-delete').first().click();
    await h.page.getByText('还没有任务记录',{exact:true}).waitFor();
    assert.equal(h.service.list().length,0);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI Extensions view inspects Skill markdown and runs live MCP connectivity test',async()=>{
  const temp=store(),root=resolve(temp.root,'workspace');
  mkdirSync(resolve(root,'examples'),{recursive:true});
  mkdirSync(resolve(root,'skills','general-agent'),{recursive:true});
  for(const name of ['task.json','task-web.json','task-adapters.json','sources.json','sources-web.json','sources-adapters.json'])copyFileSync(resolve('examples',name),resolve(root,'examples',name));
  copyFileSync(resolve('skills','general-agent','SKILL.md'),resolve(root,'skills','general-agent','SKILL.md'));
  new UserMcpStore(root).add({
    slug:'custom-demo',transport:'stdio',command:'node',
    args:['--experimental-transform-types',resolve('examples/user-mcp-server.ts')],
    defaultAction:'modify',toolSemantics:{get_release:'collect'},enabled:true,
  });
  const h=await browserHarness('extensions-view',{root});
  try{
    await h.page.goto(h.app.origin);await h.page.getByText('本地服务已连接',{exact:true}).waitFor();
    await h.page.locator('#nav-sources').click();
    await h.page.getByRole('heading',{name:'来源与连接',exact:true}).waitFor();
    await h.page.locator('[data-inspect-skill="general-agent"]').click();
    await h.page.locator('.skill-drawer .md-body').waitFor({state:'visible'});
    await h.page.locator('[data-test-mcp="custom-demo"]').click();
    await h.page.getByText(/连通正常 · 发现 2 个工具/).waitFor({timeout:15000});
    await h.page.screenshot({path:'artifacts/web-eval/extensions-view.png',fullPage:true});
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
