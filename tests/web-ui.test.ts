import { startWorkbenchProvider } from './web-provider-fixture.ts';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunService, type RunServiceOptions } from '@cwatch/server-core/runtime/run-service';
import { ReplayModel } from '@cwatch/shared/agent/models';
import { UserMcpStore } from '@cwatch/shared/mcp/storage';
import { abortable, isInvestigationTask, type ModelPort } from '@cwatch/core/types';
import { startWebServer } from '../apps/web/src/server.ts';
import { WorkbenchPage } from './web-ui-page.ts';
import { browserExecutable } from './browser-fixture.ts';
import { approvalFixture } from './run-service-fixture.ts';
import { check, store, fixture } from './harness.ts';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import type { RunSnapshot } from '@cwatch/core/types/runs';

check('integration','Web unifies onto Investigation mode, hides mode switcher, exports draft in 5 formats and restores result after refresh',async()=>{
  const h=await browserHarness('unified-investigation',webSignalFixture());
  try{
    await h.page.goto(h.app.origin);await h.page.getByText('本地服务已连接',{exact:true}).waitFor();
    const editor=h.page.getByRole('region',{name:'确认调查'});
    assert.equal(await editor.isVisible(),false);
    await h.ui.showTaskSetup();
    const composer=h.page.getByRole('form',{name:'发起调查'});
    assert.equal(await h.page.getByRole('heading',{name:'今天想调查什么？',exact:true}).isVisible(),true);
    assert.equal(await h.page.getByRole('heading',{name:'从示例开始',exact:true}).isVisible(),true);
    assert.equal(await composer.isVisible(),true);
    assert.equal(await h.page.locator('#task-profile').count(),0);
    assert.equal(await h.page.locator('.compose-hero').getByRole('button', { name: '新建调查', exact: true }).count(),0);
    await h.page.getByRole('button', { name: '新建调查', exact: true }).click();
    assert.equal(await composer.getByRole('textbox').evaluate(node=>node===document.activeElement),true);
    assert.equal(await h.page.getByRole('dialog').count(),0);
    assert.equal(await h.page.getByRole('button',{name:'我的调研',exact:true}).isVisible(),true);
    assert.equal(await composer.getByLabel('模型',{exact:true}).isDisabled(),true);
    await h.ui.showTaskDetails();
    assert.equal(await composer.isVisible(),false);
    await editor.getByRole('heading',{name:'示例调查设置',exact:true}).waitFor();
    assert.equal(await editor.locator('#task-selected-profile').textContent(),'调查模式');
    assert.equal(await h.page.locator('#investigation-fields').isVisible(),true);
    assert.equal(await h.page.locator('#pipeline').isVisible(),false);
    const settings=h.page.getByRole('button',{name:'运行设置',exact:true});
    await settings.click();
    await h.page.getByRole('region',{name:'运行设置',exact:true}).waitFor();
    await h.page.keyboard.press('Escape');
    assert.equal(await settings.getAttribute('aria-expanded'),'false');
    assert.equal(await settings.evaluate(node=>node===document.activeElement),true);
    await h.page.keyboard.press('Escape');
    await editor.waitFor({state:'hidden'});
    await h.page.getByRole('button',{name:/演示完整调查流程/}).click();
    assert.equal(await h.page.locator('#investigation-fields').isVisible(),true);
    assert.equal(h.service.list().length,0);
    await h.ui.start();await h.ui.completed();await h.ui.report();
    assert.equal(await h.page.locator('#compose-view').isVisible(),false);
    assert.equal(await h.page.locator('#evidence-rail').isVisible(),true);
    assert.equal(h.service.list()[0].claims.length,1);

    // Export Draft pop modal exposes all 5 formats and downloads valid files
    const exportTrigger=h.page.locator('#export-run');
    await exportTrigger.click();
    const exportModal=h.page.locator('#export-modal');
    await exportModal.waitFor({state:'visible'});
    assert.equal(await exportModal.getAttribute('role'),'dialog');
    assert.equal(await exportModal.getAttribute('aria-modal'),'true');
    await h.page.screenshot({path:'artifacts/web-eval/export-modal.png',fullPage:true});

    for(const [fmt,pattern] of [
      ['md',/调研概要[\s\S]*合成测试快照/],
      ['html',/<!doctype html>[\s\S]*完整调查报告正文/i],
      ['doc',/urn:schemas-microsoft-com:office:word/],
      ['csv',/主张编号,主张内容/],
      ['json',/"schemaVersion": "cwatch\.draft-export\.v1"/],
    ] as const){
      const downloading=h.page.waitForEvent('download');
      await exportModal.locator(`[data-export-format="${fmt}"]`).click();
      const dl=await downloading;
      const filePath=await dl.path();
      assert.ok(filePath,`expected download for ${fmt}`);
      assert.match(readFileSync(filePath,'utf8'),pattern);
    }

    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.page.setViewportSize({width:1440,height:1080});
    await h.page.keyboard.press('Escape');
    await exportModal.waitFor({state:'hidden'});
    assert.equal(await exportTrigger.evaluate(node=>node===document.activeElement),true);

    await h.page.reload();await h.ui.completed();await h.ui.report();
    await h.page.locator('#new-run').click();
    assert.equal(await h.page.locator('#compose-view').isVisible(),true);
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
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

check('integration','Web UI starts a real offline investigation, highlights evidence rail on claim click, downloads report and restores after refresh',async()=>{
  const h=await browserHarness('replay',webSignalFixture());
  try{
    await h.page.goto(h.app.origin);await h.page.getByText('本地服务已连接',{exact:true}).waitFor();
    await h.page.screenshot({path:'artifacts/web-eval/desktop-empty.png',fullPage:true});
    await h.ui.selectProfile('web');
    await h.ui.start();await h.ui.completed();await h.ui.report();
    const expected=fixture().signals[0];
    await h.ui.reportCitations().waitFor({state:'visible'});
    assert.equal(await h.ui.reportClaims().count(),1);assert.equal(await h.ui.reportCitations().count(),1);
    assert.ok((await h.ui.reportClaims().innerText()).includes(expected.content.title+': '+expected.content.value));
    assert.equal(await h.ui.reportCitations().getAttribute('href'),expected.url);
    assert.equal(await h.ui.reportCitations().textContent(),'web · '+expected.content.title);
    // Companion evidence rail is visible for Competitor Investigations and syncs highlight on claim click
    assert.equal(await h.page.locator('#evidence-rail .evidence-card').count(),1);
    await h.ui.reportClaims().first().click();
    assert.equal(await h.page.locator('#evidence-rail .evidence-card.highlighted').count(),1);
    assert.deepEqual(h.service.list()[0].claims.map(claim=>claim.evidence.map(evidence=>evidence.url)),[[expected.url]]);
    const downloading=h.page.waitForEvent('download');await h.page.getByRole('link',{name:'下载 Markdown 报告'}).click();const download=await downloading;const path=await download.path();assert.ok(path);assert.match(readFileSync(path,'utf8'),/合成测试快照/);
    assert.ok(readFileSync(path,'utf8').includes(expected.url));
    await h.page.screenshot({path:'artifacts/web-eval/desktop-report.png',fullPage:true});await h.page.reload();await h.ui.completed();await h.ui.report();assert.equal(h.service.list().length,1);
    await h.ui.reportCitations().waitFor({state:'visible'});assert.equal(await h.ui.reportClaims().count(),1);assert.equal(await h.ui.reportCitations().getAttribute('href'),expected.url);
    await h.page.getByRole('button',{name:'来源与连接',exact:false}).click();await h.page.getByRole('heading',{name:'来源与连接',exact:true}).waitFor();assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration', 'My research is the single archive for investigations and reports, with search, mode filter and original evidence', async () => {
  const h = await browserHarness('my-research', webSignalFixture());
  const { page } = h;
  const navigation = page.getByRole('button', { name: '我的调研', exact: true });
  const reportList = page.getByRole('list', { name: '调查与报告列表' });
  const search = page.getByRole('searchbox', { name: '搜索调查与报告' });
  const mode = page.getByRole('combobox', { name: '按运行方式筛选' });
  try {
    await page.goto(h.app.origin);
    await navigation.click();
    await page.getByRole('heading', { name: '还没有调查' }).waitFor();
    assert.equal(await page.locator('#research-kind').count(), 0);
    await page.getByRole('button', { name: '新建调查', exact: true }).first().click();
    await h.ui.start();
    await h.ui.completed();
    await navigation.click();
    await reportList.waitFor();
    assert.equal(await page.getByRole('navigation', { name: '历史记录' }).count(), 0);
    const report = reportList.getByRole('button', { name: /打开报告$/ });
    assert.equal(await report.count(), 1);
    assert.equal(await reportList.getByRole('listitem').count(), 1);

    await mode.selectOption('live');
    await page.getByRole('heading', { name: '没有符合条件的调查' }).waitFor();
    await mode.selectOption('replay');
    assert.equal(await reportList.getByRole('listitem').count(), 1);
    await search.fill('不存在的调研对象');
    await page.getByRole('heading', { name: '没有符合条件的调查' }).waitFor();
    const product = await page.locator('#product').inputValue();
    await search.fill(product.toUpperCase());
    await report.waitFor();
    await page.screenshot({ path: 'artifacts/web-eval/my-research.png' });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await report.click();
    await h.ui.reportCitations().waitFor();
    await page.getByRole('button', { name: '返回我的调研', exact: true }).click();
    await report.waitFor();
    assert.equal(await search.inputValue(), product.toUpperCase());
    assert.equal(await mode.inputValue(), 'replay');

    await page.reload();
    await navigation.click();
    await report.waitFor();
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

for(const allowed of [true,false])check('integration','Web UI '+(allowed?'approves':'rejects')+' a real host permission request inline without tab hunting',async()=>{
  const fixture=approvalFixture('web'),h=await browserHarness(allowed?'approve':'deny',fixture);
  try{
    await h.ui.open('web');await h.ui.setPermission('ask');await h.ui.closeSettings();
    await h.ui.start();await h.page.getByText('等待审批 / 离线演示',{exact:true}).waitFor();
    // Inline Approval Spotlight appears immediately at top of run view — no tab switching needed
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
    await h.ui.open('web');await h.ui.setPermission('ask');await h.ui.closeSettings();
    await h.ui.start();await h.page.getByText('等待审批 / 离线演示',{exact:true}).waitFor();
    await h.page.getByRole('heading',{name:'这次操作需要你的确认'}).waitFor();
    await h.ui.cancel();
    assert.equal(fixture.calls.includes('request_publish'),false);await h.page.reload();await h.page.getByText('已取消 / 离线演示',{exact:true}).waitFor();
    assert.equal(await h.page.locator('#approval-spotlight').isVisible(),false);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI cancels a running investigation, releases capacity and retries in one click via retry button',async()=>{
  let attempts=0;
  const modelFactory=():ModelPort=>({decide:async(_input,signal)=>{
    attempts++;
    if(attempts===1)return abortable(new Promise<never>(()=>{}),signal);
    throw Error('simulated_provider_failure');
  }}),h=await browserHarness('cancel-running',{modelFactory});
  try{
    await h.ui.open('web');await h.ui.start();await h.page.getByText('执行中 / 离线演示',{exact:true}).waitFor();await h.ui.cancel();
    assert.equal(h.service.list()[0].status,'cancelled');
    assert.equal(await h.page.locator('#retry-run').isVisible(),true);
    await h.page.locator('#retry-run').click();
    await h.page.getByText('运行失败 / 离线演示',{exact:true}).waitFor();
    assert.equal(h.service.list().length,2);
    assert.equal(h.service.list()[0].status,'failed');
    assert.equal(await h.page.locator('#retry-run').isVisible(),true);
    assert.deepEqual(h.errors,[]);
  }
  finally{await h.close();}
});

check('contract','Web UI remains usable on mobile, supports keyboard tabs and renders untrusted task text without HTML execution',async()=>{
  const h=await browserHarness('mobile-xss',webSignalFixture());
  try{
    await h.ui.open('web');await h.page.setViewportSize({width:390,height:844});assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.ui.start();await h.ui.completed();await h.ui.report();
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.page.screenshot({path:'artifacts/web-eval/mobile-report.png',fullPage:true});
    await h.page.getByRole('tab',{name:'调查报告',exact:true}).focus();await h.page.keyboard.press('ArrowRight');assert.equal(await h.page.getByRole('tab',{name:/执行轨迹/}).getAttribute('aria-selected'),'true');
    const bootstrap=await(await fetch(h.app.origin+'/api/bootstrap')).json(),task=bootstrap.profiles.find((p:{id:string})=>p.id==='web').task;task.competitor.name='<img src=x onerror="window.__xss=1">';
    const response=await fetch(h.app.origin+'/api/runs',{method:'POST',headers:{Origin:h.app.origin,'Content-Type':'application/json','X-Cwatch-Token':bootstrap.csrfToken},body:JSON.stringify({profile:'web',mode:'replay',permission:'explore',task})});assert.equal(response.status,202);const created=await response.json() as RunSnapshot;await h.service.wait(created.id);
    await h.page.evaluate(()=>localStorage.removeItem('cwatch-selected-run'));await h.page.reload();
    await h.page.getByRole('form',{name:'发起调查'}).waitFor();
    await h.ui.openSavedRun(created.id);await h.ui.completed();
    assert.ok((await h.page.locator('#run-title').textContent())!.includes('<img'));assert.equal(await h.page.locator('img[src=x]').count(),0);assert.equal(await h.page.evaluate(()=>Reflect.get(window,'__xss')),undefined);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web live research submits the chosen model, reasoning effort and brief through the real Pi worker',async()=>{
  const provider=await startWorkbenchProvider();
  const variables={MODEL_PROVIDER:'web-fixture-provider',MODEL_ID:'web-fixture-model',WEB_MODEL_IDS:'web-fixture-alternate',API_KEY:'web-fixture-provider-key',BASE_URL:provider.url};
  const before=Object.fromEntries(Object.keys(variables).map(key=>[key,process.env[key]]));Object.assign(process.env,variables);
  let h:Awaited<ReturnType<typeof browserHarness>>|undefined;
  try{
    h=await browserHarness('live-sdk',{configureRegistry:async(registry,signal)=>{
      await registry.register('web','builtin',{
        listTools:async()=>createWebToolDefinitions(),
        callTool:async(_name,_args,_signal,context)=>{if(!context)throw Error('test_context_required');return context.stage('test.web.fixture',async()=>{const data=fixture();data.signals.forEach(s=>{s.sourceSlug='web';});return data;});},
        close:async()=>{},
      },signal);
    }});await h.ui.open('web');
    // Live mode defaults web search ON and domains blank (open public HTTPS)
    assert.equal(await h.page.locator('#toggle-web-search').isChecked(),true);
    assert.equal(await h.page.locator('#domains').inputValue(),'');
    assert.throws(()=>h!.service.start({profile:'web',mode:'live',permission:'explore',model:{id:'not-configured'}}),/所选模型未在本机配置/);
    await h.page.getByLabel('调研重点（可选）',{exact:true}).fill('核对版本发布时间');
    await h.page.getByLabel('交付要求（可选）',{exact:true}).fill('用表格列出版本和发布日期');
    await h.ui.showTaskSetup();
    await h.page.getByLabel('模型',{exact:true}).selectOption('web-fixture-alternate');
    await h.page.getByLabel('思考强度',{exact:true}).selectOption('high');
    await h.page.screenshot({path:'artifacts/web-eval/new-task-setup.png'});
    await h.ui.showTaskDetails();
    await h.page.getByRole('heading',{name:'调研范围',exact:true}).waitFor();
    assert.match(await h.page.locator('#task-selection-summary').innerText(),/web-fixture-alternate · 思考强度 高/);
    assert.equal(await h.page.getByLabel('调研重点（可选）',{exact:true}).inputValue(),'核对版本发布时间');
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.locator('#task-editor').evaluate(editor=>editor.scrollWidth>editor.clientWidth),false);
    await h.page.screenshot({path:'artifacts/web-eval/new-task-details-mobile.png'});
    await h.ui.start();await h.page.getByText('已完成 / 真实调查',{exact:true}).waitFor({timeout:30000});await h.ui.report();
    const run=h.service.list()[0];assert.equal(run.mode,'live');assert.equal(run.claims.length,1);assert.equal(run.modelTurns,6);assert.equal(run.totalTokens,720);
    assert.deepEqual(run.model,{id:'web-fixture-alternate',reasoningEffort:'high'});
    assert.deepEqual(provider.modelRequests[0],{model:'web-fixture-alternate',reasoningEffort:'high'});
    assert.deepEqual(provider.initialTask()?.researchBrief,{focus:'核对版本发布时间',deliverable:'用表格列出版本和发布日期'});
    const data=new FileStore(resolve(h.service.outputRoot,run.id)),events=data.lines<TraceEvent>('traces/'+run.traceRunId+'.jsonl');
    assert.ok(events.some(event=>event.type==='agent_process'&&event.data.state==='ready'));assert.ok(events.some(event=>event.type==='backend_started'&&event.data.backend==='test.web.fixture'));assert.deepEqual(validateTrace(events),[]);
    assert.equal(provider.turns(),6);assert.deepEqual(provider.errors,[]);assert.deepEqual(h.errors,[]);
  }finally{
    await h?.close();await provider.close();for(const key of Object.keys(variables)){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  }
});

check('integration','Web UI renders safe Markdown (code blocks, tables, safe links), toggles dark theme and opens/closes slide-over Trace drawer via Escape',async()=>{
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
  const h=await browserHarness('dark-markdown',{
    ...webSignalFixture(),
    modelFactory:(_mode,task)=>new ReplayModel([
      {kind:'call_tool',name:'workflow__save_plan',args:{taskId:task.taskId,objective:'Markdown safety check',sources:['web'],queries:['Node.js'],evidenceRequirements:['URL'],window:isInvestigationTask(task)?{start:task.window.start,end:task.window.end}:{start:'2025-05-01T00:00:00+08:00',end:'2026-11-01T00:00:00+08:00'}}},
      {kind:'call_tool',name:'web_search',args:{query:'Node.js releases',limit:5}},
      {kind:'call_tool',name:'workflow__analyze',args:{}},
      {kind:'call_tool',name:'workflow__review',args:{}},
      {kind:'call_tool',name:'workflow__draft',args:{narrative:md,claimIds:'$analyzed_claim_ids'}},
      {kind:'respond',text:'Saved.'},
    ]),
  });
  try{
    await h.ui.open('web');
    await h.ui.start();await h.ui.completed();await h.ui.report();
    await h.page.locator('.md-code-block pre code').first().waitFor({state:'visible'});
    assert.equal(await h.page.locator('.md-code-block pre code').count(),1);
    assert.ok(await h.page.locator('.md-table tbody tr').count()>=1);
    assert.equal(await h.page.locator('.report-document a[href="https://example.com/docs"]').count(),1);
    assert.equal(await h.page.locator('.report-document a[href^="javascript:"]').count(),0);
    assert.equal(await h.page.evaluate(()=>Reflect.get(window,'__mdXss')),undefined);
    await h.page.locator('#theme-toggle').click();
    assert.equal(await h.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await h.page.screenshot({path:'artifacts/web-eval/dark-markdown.png',fullPage:true});
    await h.page.reload();await h.ui.completed();
    assert.equal(await h.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await h.ui.openTrace();
    await h.page.keyboard.press('Escape');
    await h.page.locator('#trace-drawer').waitFor({state:'hidden'});
    await h.page.locator('#new-run').click();
    await h.page.locator('#compose-view').waitFor({state:'visible'});
    await h.page.screenshot({path:'artifacts/web-eval/dark-compose.png',fullPage:true});
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI inspects structured Trace inside slide-over drawer, filters history and deletes completed runs',async()=>{
  const h=await browserHarness('trace-and-history');
  try{
    await h.ui.open('web');
    await h.ui.start();await h.page.getByText(/^(已完成|部分完成) \/ 离线演示$/).waitFor({timeout:20000});
    await h.ui.openTrace();
    await h.page.locator('.trace-tree .trace-row').first().waitFor({state:'visible'});
    assert.ok(await h.page.locator('.trace-tree .trace-row').count()>=3);
    await h.page.locator('#trace-drawer').getByRole('button',{name:/工具/}).click();
    await h.page.locator('.trace-tree .trace-row').first().click();
    await h.page.locator('.trace-detail').waitFor({state:'visible'});
    await h.page.screenshot({path:'artifacts/web-eval/trace-inspector.png',fullPage:true});
    await h.ui.closeTrace();
    await h.page.getByRole('button',{name:'我的调研',exact:true}).click();
    const search=h.page.getByRole('searchbox',{name:'搜索调查与报告'});
    await search.fill('不存在的关键词');
    await h.page.getByText('没有符合条件的调查',{exact:true}).waitFor();
    await search.fill('');
    await h.page.getByRole('button',{name:/^删除调查 /}).click();
    await h.page.getByText('还没有调查',{exact:true}).waitFor();
    assert.equal(h.service.list().length,0);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI Extensions view inspects Skill markdown in pop modal and runs live MCP connectivity test',async()=>{
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
    const inspectBtn=h.page.locator('[data-inspect-skill="general-agent"]');
    await inspectBtn.click();
    const skillModal=h.page.locator('#skill-modal');
    await skillModal.waitFor({state:'visible'});
    assert.equal(await skillModal.getAttribute('role'),'dialog');
    assert.equal(await skillModal.getAttribute('aria-modal'),'true');
    await skillModal.locator('.md-body').waitFor({state:'visible'});
    assert.equal(await h.page.locator('.skill-drawer').count(),0);
    await h.page.screenshot({path:'artifacts/web-eval/skill-modal.png',fullPage:true});
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.page.setViewportSize({width:1440,height:1080});
    await h.page.keyboard.press('Escape');
    await skillModal.waitFor({state:'hidden'});
    assert.equal(await inspectBtn.evaluate(node=>node===document.activeElement),true);
    await h.page.locator('[data-test-mcp="custom-demo"]').click();
    await h.page.getByText(/连通正常 · 发现 2 个工具/).waitFor({timeout:15000});
    await h.page.evaluate(()=>window.scrollTo(0,0));
    await h.page.screenshot({path:'artifacts/web-eval/extensions-view.png',fullPage:true});
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI Connections adds provider via bottom-right plus button, configures search, adds MCP and Skill in webpage, views Skill in pop modal and cleans up',async()=>{
  const temp=store(),root=resolve(temp.root,'workspace');
  mkdirSync(resolve(root,'examples'),{recursive:true});
  mkdirSync(resolve(root,'skills','general-agent'),{recursive:true});
  for(const name of ['task.json','task-web.json','task-adapters.json','sources.json','sources-web.json','sources-adapters.json'])copyFileSync(resolve('examples',name),resolve(root,'examples',name));
  copyFileSync(resolve('skills','general-agent','SKILL.md'),resolve(root,'skills','general-agent','SKILL.md'));
  const seenAuth:string[]=[];
  const mcpServer=createServer(async(req,res)=>{
    if(req.method==='GET'){res.writeHead(405);res.end();return;}
    if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
    seenAuth.push(String(req.headers.authorization??''));
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const msg=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(msg.id===undefined){res.writeHead(202);res.end();return;}
    const result=msg.method==='initialize'
      ?{protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'web-added-mcp',version:'1'}}
      :{tools:[{name:'fetch_docs',description:'Read docs',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
  });
  mcpServer.listen(0,'127.0.0.1');await once(mcpServer,'listening');
  const mcpAddress=mcpServer.address();assert.ok(mcpAddress&&typeof mcpAddress!=='string');
  const mcpUrl='http://127.0.0.1:'+mcpAddress.port+'/mcp';
  const h=await browserHarness('connections-workbench',{root});
  try{
    await h.page.goto(h.app.origin);await h.page.getByText('本地服务已连接',{exact:true}).waitFor();
    await h.page.locator('#nav-sources').click();
    await h.page.getByRole('heading',{name:'来源与连接',exact:true}).waitFor();

    // Verify bottom-right plus button placement inside the Model Providers card
    const modelCardBox=await h.page.locator('.ext-card-model').boundingBox();
    const plusBtn=h.page.locator('[data-edit-connection="providers"]');
    const plusBox=await plusBtn.boundingBox();
    assert.ok(modelCardBox&&plusBox);
    assert.ok(plusBox.x>=modelCardBox.x+modelCardBox.width/2,'plus button should sit on the right side of model card');
    assert.ok(plusBox.y>=modelCardBox.y+modelCardBox.height/2,'plus button should sit in the lower half of model card');

    // Add model provider via plus button pop modal
    await plusBtn.click();
    const editor=h.page.locator('#connection-editor');
    await editor.waitFor({state:'visible'});
    assert.equal(await editor.getAttribute('role'),'dialog');
    await editor.locator('input[name=provider]').fill('deepseek');
    await editor.locator('input[name=baseUrl]').fill('https://api.deepseek.com/v1');
    await editor.locator('input[name=apiKey]').fill('sk-workbench-provider-secret');
    await editor.locator('textarea[name=modelIds]').fill('deepseek-chat\ndeepseek-reasoner');
    await editor.locator('input[name=reasoning]').check();
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    await editor.waitFor({state:'hidden'});
    await h.page.locator('.ext-provider-list').getByText('deepseek',{exact:true}).waitFor();
    assert.equal((await h.page.locator('#connections-overview').innerText()).includes('sk-workbench-provider-secret'),false);
    assert.ok((await h.page.locator('#task-model option').evaluateAll(nodes=>nodes.map(o=>o.textContent))).includes('deepseek-reasoner'));

    // Configure search tool via pop modal
    await h.page.locator('[data-edit-connection="search"]').click();
    await editor.waitFor({state:'visible'});
    await editor.locator('input[name=url]').fill('https://api.tavily.com/search');
    await editor.locator('select[name=protocol]').selectOption('rest');
    await editor.locator('input[name=token]').fill('tvly-workbench-search-secret');
    await editor.locator('input[name=fetchUrl]').fill('https://api.tavily.com/extract');
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    await editor.waitFor({state:'hidden'});
    await h.page.locator('.ext-card-search').getByText('https://api.tavily.com/search',{exact:true}).waitFor();
    await h.page.locator('.ext-card-search').getByText('已设置密钥',{exact:true}).waitFor();
    assert.equal((await h.page.locator('#connections-overview').innerText()).includes('tvly-workbench-search-secret'),false);

    // Add remote MCP with Bearer token (kept outside mcp.json) and test live connectivity
    await h.page.locator('[data-edit-connection="mcp"]').click();
    await editor.waitFor({state:'visible'});
    await editor.locator('input[name=slug]').fill('docs-reader');
    await editor.locator('input[name=url]').fill(mcpUrl);
    await editor.locator('input[name=token]').fill('mcp-workbench-bearer-secret');
    await editor.locator('select[name=defaultAction]').selectOption('collect');
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    await editor.waitFor({state:'hidden'});
    assert.equal(readFileSync(resolve(root,'.cwatch','mcp.json'),'utf8').includes('mcp-workbench-bearer-secret'),false);
    await h.page.locator('[data-test-mcp="docs-reader"]').click();
    await h.page.getByText(/连通正常 · 发现 1 个工具/).waitFor({timeout:15000});
    assert.ok(seenAuth.includes('Bearer mcp-workbench-bearer-secret'));

    // Add custom Skill directly in webpage and inspect its markdown in pop modal
    await h.page.locator('[data-edit-connection="skills"]').click();
    await editor.waitFor({state:'visible'});
    await editor.locator('textarea[name=content]').fill('---\nname: pricing-audit\ndescription: 核对产品套餐价格变化\n---\n## 执行步骤\n\n1. 先检索官方定价页。\n2. 用表格汇总差异。');
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    await editor.waitFor({state:'hidden'});
    const skillInspect=h.page.locator('[data-inspect-skill="pricing-audit"]');
    await skillInspect.waitFor({state:'visible'});
    await h.page.screenshot({path:'artifacts/web-eval/connections-populated.png',fullPage:true});

    await skillInspect.click();
    const skillModal=h.page.locator('#skill-modal');
    await skillModal.waitFor({state:'visible'});
    assert.match(await skillModal.innerText(),/pricing-audit[\s\S]*核对产品套餐价格变化[\s\S]*先检索官方定价页/);
    await h.page.screenshot({path:'artifacts/web-eval/connections-skill-modal.png',fullPage:true});
    // Close via backdrop click
    await h.page.locator('#skill-modal-backdrop').click({position:{x:10,y:10}});
    await skillModal.waitFor({state:'hidden'});

    // Dark theme + 390px mobile zero overflow
    await h.page.locator('#theme-toggle').click();
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.page.screenshot({path:'artifacts/web-eval/connections-mobile-dark.png',fullPage:true});
    await h.page.setViewportSize({width:1440,height:1080});

    // Cleanly remove added provider, search override, MCP and Skill
    await h.page.locator('[data-delete-provider="deepseek"]').click();
    await h.page.locator('[data-delete-provider="deepseek"]').waitFor({state:'detached'});
    await h.page.locator('[data-delete-search]').click();
    await h.page.locator('[data-delete-search]').waitFor({state:'detached'});
    await h.page.locator('[data-delete-mcp="docs-reader"]').click();
    await h.page.locator('[data-delete-mcp="docs-reader"]').waitFor({state:'detached'});
    await h.page.locator('[data-delete-skill="pricing-audit"]').click();
    await h.page.locator('[data-delete-skill="pricing-audit"]').waitFor({state:'detached'});
    assert.deepEqual(h.errors,[]);
  }finally{
    await h.close();
    mcpServer.closeAllConnections();
    await new Promise<void>(resolveClosed=>mcpServer.close(()=>resolveClosed()));
  }
});


check('integration','Web UI investigation form quick date presets and 3-tier depth limits sync cleanly across replay, live and mobile',async()=>{
  const h=await browserHarness('form-presets');
  try{
    await h.ui.open('web');
    // Replay mode keeps quick date presets disabled (read-only snapshot)
    for(const days of ['7','30','90']){
      assert.equal(await h.page.locator(`[data-window-days="${days}"]`).isDisabled(),true);
    }
    // Each depth preset's visible budget matches the form values when selected.
    const standard=h.page.getByRole('button',{name:'标准核验 480s · 750k',exact:true});
    const fast=h.page.getByRole('button',{name:'快速浏览 180s · 250k',exact:true});
    const deep=h.page.getByRole('button',{name:'深入调查 900s · 1.5M',exact:true});
    assert.equal(await fast.isVisible(),false);
    await h.ui.openSettings();
    assert.equal(await h.page.locator('#timeout').inputValue(),'480');
    assert.equal(await h.page.locator('#tokens').inputValue(),'750000');
    assert.equal(await standard.getAttribute('aria-pressed'),'true');
    await fast.click();
    assert.equal(await h.page.locator('#timeout').inputValue(),'180');
    assert.equal(await h.page.locator('#tokens').inputValue(),'250000');
    assert.equal(await fast.getAttribute('aria-pressed'),'true');
    await deep.click();
    assert.equal(await h.page.locator('#timeout').inputValue(),'900');
    assert.equal(await h.page.locator('#tokens').inputValue(),'1500000');
    assert.equal(await deep.getAttribute('aria-pressed'),'true');

    // Manual limits clear the active depth preset.
    await h.page.locator('#timeout').fill('240');
    assert.equal(await h.page.locator('#timeout').inputValue(),'240');
    for(const key of ['fast','standard','deep']){
      assert.equal(await h.page.locator(`[data-depth-preset="${key}"]`).getAttribute('aria-pressed'),'false');
    }

    // Live mode enables quick date window capsules and fills local [start, tomorrow)
    await h.ui.setMode('live');
    await h.ui.closeSettings();
    const expectedTomorrow=await h.page.evaluate(()=>{
      const now=new Date(),end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
      return `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
    });
    for(const days of [7,30,90]){
      const btn=h.page.locator(`[data-window-days="${days}"]`);
      assert.equal(await btn.isDisabled(),false);
      await btn.click();
      const start=await h.page.locator('#start-date').inputValue();
      const end=await h.page.locator('#end-date').inputValue();
      assert.equal(end,expectedTomorrow);
      assert.ok(start<end);
      const diffDays=Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000);
      assert.equal(diffDays,days);
      assert.equal(await btn.getAttribute('aria-pressed'),'true');
    }

    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI investigation report renders 4-metric ribbon, TOC jump, print trigger, interactive pipeline stages, dark mode and mobile layout',async()=>{
  const h=await browserHarness('report-upgrade',webSignalFixture());
  try{
    await h.ui.open('web');
    await h.ui.start();await h.ui.completed();await h.ui.report();

    // 4-dimension metrics ribbon & review gate card without breaking claim article selector
    assert.equal(await h.ui.reportClaims().count(),1);
    assert.equal(await h.page.locator('.report-metrics-ribbon .metric-tile').count(),4);
    const ribbonText=await h.page.locator('.report-metrics-ribbon').innerText();
    for(const label of ['核验主张','证据快照','独立域名','审阅与缺口'])assert.ok(ribbonText.includes(label));
    assert.equal(await h.page.locator('.report-gate-card').isVisible(),true);

    // Chapter TOC renders >= 2 h2/h3 headings and smoothly jumps to heading id
    await h.page.locator('.report-toc .toc-link').first().waitFor({state:'visible'});
    const tocLinks=h.page.locator('.report-toc .toc-link');
    assert.ok(await tocLinks.count()>=2);
    const targetId=await tocLinks.nth(1).getAttribute('data-toc-target');
    assert.ok(targetId&&/^sec-\d+$/.test(targetId));
    assert.equal(await h.page.locator(`.report-document #${targetId}`).count(),1);
    await tocLinks.nth(1).click();
    assert.equal(await tocLinks.nth(1).evaluate(el=>el.classList.contains('is-active')),true);

    // Print / Export PDF button triggers window.print()
    const printBtn=h.page.getByRole('button',{name:'打印 / 导出 PDF',exact:true});
    assert.equal(await printBtn.isVisible(),true);
    await h.page.evaluate(()=>{Reflect.set(window,'__printCount',0);window.print=()=>{Reflect.set(window,'__printCount',(Reflect.get(window,'__printCount') as number)+1);};});
    await printBtn.click();
    assert.equal(await h.page.evaluate(()=>Reflect.get(window,'__printCount')),1);

    // Interactive 5-stage pipeline expands locked plan summary and collapses on second click
    assert.equal(await h.page.locator('#pipeline button[data-pipeline-stage]').count(),5);
    assert.equal(await h.page.locator('#pipeline-detail').isVisible(),false);
    const planBtn=h.page.locator('#pipeline button[data-pipeline-stage="0"]');
    await planBtn.click();
    assert.equal(await planBtn.getAttribute('aria-pressed'),'true');
    await h.page.locator('#pipeline-detail').waitFor({state:'visible'});
    const planText=await h.page.locator('#pipeline-detail').innerText();
    assert.ok(planText.includes('调查目标')&&planText.includes('计划查询')&&planText.includes('releases'));
    // Cycle through remaining stages and toggle plan closed
    for(const idx of [1,2,3,4]){
      await h.page.locator(`#pipeline button[data-pipeline-stage="${idx}"]`).click();
      assert.equal(await h.page.locator('#pipeline-detail').isVisible(),true);
    }
    await planBtn.click();
    assert.equal(await h.page.locator('#pipeline-detail').isVisible(),true);
    await planBtn.click();
    assert.equal(await h.page.locator('#pipeline-detail').isVisible(),false);
    assert.equal(await planBtn.getAttribute('aria-pressed'),'false');

    // Dark mode & 390px narrow mobile zero horizontal overflow (with expanded plan card + full report)
    await h.page.locator('#theme-toggle').click();
    assert.equal(await h.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await planBtn.click();
    await h.page.locator('#pipeline-detail').waitFor({state:'visible'});
    await h.page.screenshot({path:'artifacts/web-eval/report-upgrade-dark.png',fullPage:true});
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await h.page.screenshot({path:'artifacts/web-eval/report-upgrade-mobile-dark.png',fullPage:true});
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration','Web UI shows live running stage and recent merged steps inline in report tab before draft is ready',async()=>{
  const modelFactory=():ModelPort=>({decide:async(_input,signal)=>abortable(new Promise<never>(()=>{}),signal)});
  const h=await browserHarness('live-report-progress',{modelFactory});
  try{
    await h.ui.open('web');
    await h.ui.start();
    await h.page.getByText('执行中 / 离线演示',{exact:true}).waitFor();
    await h.page.getByRole('tab',{name:'调查报告',exact:true}).click();
    await h.page.locator('.live-progress-card').waitFor({state:'visible'});
    assert.ok((await h.page.locator('.live-stage-pill').innerText()).includes('计划'));
    assert.equal(await h.page.locator('.live-progress-card').getByRole('button',{name:'查看实时执行轨迹',exact:true}).isVisible(),true);
    await h.ui.cancel();
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
