import { startWorkbenchProvider } from './web-provider-fixture.ts';
import { investigationDecisions, releaseUrl, resolveInvestigationDecision } from './tracked-investigation-fixture.ts';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { validateTrace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

check('integration','Web keeps the investigation demo available from the task composer and exports drafts in 5 formats',async()=>{
  const h=await browserHarness('unified-investigation',webSignalFixture());
  try{
    await h.page.goto(h.app.origin);await h.page.getByText('本地服务已连接',{exact:true}).waitFor();
    const editor=h.page.getByRole('region',{name:'确认调查'});
    assert.equal(await editor.isVisible(),false);
    await h.ui.showTaskSetup();
    const composer=h.page.getByRole('form',{name:'提交任务'});
    assert.equal(await h.page.getByRole('heading',{name:'今天想做什么？',exact:true}).isVisible(),true);
    assert.equal(await h.page.getByRole('heading',{name:'从示例开始',exact:true}).isVisible(),true);
    assert.equal(await composer.isVisible(),true);
    assert.equal(await h.page.locator('#task-profile').count(),0);
    assert.equal(await h.page.locator('.compose-hero').getByRole('button', { name: '新建任务', exact: true }).count(),0);
    await h.page.getByRole('button', { name: '新建任务', exact: true }).click();
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

check('integration', 'Web routes local tasks directly and requires scope confirmation before the complete investigation', async () => {
  const root = store().root;
  mkdirSync(resolve(root, 'examples'));
  for (const name of ['task.json', 'task-web.json', 'task-adapters.json', 'sources.json', 'sources-web.json', 'sources-adapters.json']) {
    copyFileSync(resolve('examples', name), resolve(root, 'examples', name));
  }
  writeFileSync(resolve(root, 'notes.txt'), 'local-only-routing-fixture\n');
  const localRequest = '帮我看看本地的 notes.txt';
  const researchRequest = '核对 Node.js 的 Node.js 版本发布记录，交叉核验并生成带引用的调研报告';
  const quickRequest = '查一下 Node.js 当前的 LTS 是哪个版本';
  const timedRequest = '调查一下kimi的codingplan';
  const planFeedback = '把官方发布日志放在首位';
  let releaseRevision!: () => void;
  const revisionGate = new Promise<void>(resolve => { releaseRevision = resolve; });
  const requests: string[] = [];
  const h = await browserHarness('task-intent', {
    root,
    ...webSignalFixture(),
    intentModelFactory: () => ({ decide: async input => {
      assert.deepEqual(input.tools, []);
      const { request } = JSON.parse(input.volatile);
      requests.push(request);
      if (request === localRequest) return { kind: 'respond', text: '{"kind":"agent","needsWeb":false}' };
      if (request === researchRequest) return { kind: 'respond', text: '{"kind":"investigation","competitor":"Node.js","product":"Node.js"}' };
      if (request === quickRequest || request === timedRequest) return { kind: 'respond', text: '{"kind":"agent","needsWeb":true}' };
      throw Error('unexpected intent request');
    } }),
    modelFactory: (_mode, task, configs) => {
      if (!isInvestigationTask(task)) {
        if (task.instruction === timedRequest) return { decide: (_input, signal) => abortable(new Promise<never>(() => {}), signal) };
        if (task.instruction === quickRequest) return new ReplayModel([{ kind: 'respond', text: '快速查询完成。' }]);
        assert.deepEqual(configs, []);
        return new ReplayModel([
          { kind: 'call_tool', name: 'read', args: { path: 'notes.txt' } },
          { kind: 'respond', text: '已检查工作区的 notes.txt。' },
        ]);
      }
      const steps = investigationDecisions(task);
      const model = new ReplayModel(steps);
      let revised = false;
      return { decide: async (input, signal) => {
        const latest = input.state.observations.at(-1);
        if (!revised && latest?.name === 'workflow__save_plan' && (latest.result as { feedback?: string }).feedback !== undefined) {
          assert.equal((latest.result as { feedback: string }).feedback, planFeedback);
          revised = true;
          await abortable(revisionGate, signal);
          const original = steps[0];
          assert.equal(original.kind, 'call_tool');
          return { ...original, args: { ...original.args, objective: '优先核验官方发布日志' } };
        }
        return resolveInvestigationDecision(await model.decide(input, signal), Boolean(task.evidencePolicy), name => input.state.observations.findLast(observation => observation.name === name)?.result);
      } };
    },
  });
  try {
    h.service.connections.addProvider({ provider: 'routing-fixture', baseUrl: 'https://routing.example.invalid/v1', apiKey: 'routing-fixture-key', modelIds: ['routing-fixture'] });
    await h.page.goto(h.app.origin);
    await h.page.getByText('本地服务已连接', { exact: true }).waitFor();
    await h.ui.sendTask(localRequest);
    await h.page.getByText('已检查工作区的 notes.txt。', { exact: true }).waitFor();
    assert.equal(await h.page.getByRole('region', { name: '确认调查' }).isVisible(), false);
    const [local] = h.service.list();
    assert.equal(local.profile, 'agent');
    assert.deepEqual(local.task.allowedSources, []);
    const localEvents = new FileStore(resolve(h.service.outputRoot, local.id)).lines<TraceEvent>('traces/' + local.traceRunId + '.jsonl');
    assert.ok(localEvents.some(event => event.type === 'observation_added' && event.data.name === 'read' && JSON.stringify(event.data.observation).includes('local-only-routing-fixture')));
    assert.equal(localEvents.some(event => event.type === 'plan_submitted'), false);

    await h.page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建任务', exact: true }).click();
    await h.ui.sendTask(researchRequest);
    const confirmation = h.page.getByRole('region', { name: '确认调查' });
    await confirmation.waitFor();
    assert.equal(await confirmation.getByLabel('公司或组织').inputValue(), 'Node.js');
    assert.equal(await confirmation.getByLabel('产品 / 主题').inputValue(), 'Node.js');
    assert.equal(await confirmation.getByLabel('调研重点（可选）').inputValue(), researchRequest);
    assert.equal(await confirmation.getByLabel('开始日期').inputValue(), '');
    assert.equal(h.service.list().length, 1);
    await confirmation.getByLabel('开始日期').fill('2025-05-01');
    await confirmation.getByLabel('结束日期（不含）').fill('2025-06-01');
    await h.ui.openSettings();
    await h.page.getByLabel('单次工具超时（秒）').fill('180');
    await h.ui.closeSettings();
    await h.ui.start();
    const phaseDetail = h.page.getByRole('region', { name: '阶段详情摘要' });
    const approvalCard = phaseDetail.getByRole('region', { name: '待处理审批' });
    const planStage = h.page.locator('#pipeline [data-pipeline-stage="0"]');
    const collectionStage = h.page.locator('#pipeline [data-pipeline-stage="1"]');
    const approvePlan = approvalCard.getByRole('button', { name: '批准计划并开始采集', exact: true });
    await approvePlan.waitFor();
    assert.equal(await h.page.locator('#pipeline .pipeline-step').count(), 5);
    assert.equal(await planStage.getAttribute('aria-current'), 'step');
    const pendingProcess = h.page.getByRole('tabpanel', { name: /执行轨迹/ });
    await pendingProcess.getByText('等待审批调查计划。', { exact: true }).waitFor();
    assert.equal(await pendingProcess.getByText(/读取网页/).count(), 0);
    await h.page.getByRole('tab', { name: '调查报告', exact: true }).click();
    await phaseDetail.getByRole('list', { name: '计划步骤' }).getByText('等待审批调查计划。', { exact: true }).waitFor();
    const initialRequest = h.service.list()[0].approvals[0];
    const feedback = approvalCard.getByLabel('计划修改意见');
    await feedback.fill(planFeedback);
    await collectionStage.click();
    await phaseDetail.getByRole('heading', { name: '采集', exact: true }).waitFor();
    assert.equal(await h.page.getByRole('region', { name: '待处理审批' }).count(), 0);
    assert.equal(await phaseDetail.getByText('等待审批调查计划。', { exact: true }).count(), 0);
    await planStage.click();
    assert.equal(await feedback.inputValue(), planFeedback);
    await approvalCard.getByRole('button', { name: '提交修改意见', exact: true }).click();
    await approvalCard.waitFor({ state: 'hidden' });
    await planStage.locator('.pipeline-spinner').waitFor();
    const reviewing = h.service.list()[0];
    assert.equal(reviewing.stage, 0);
    assert.equal(reviewing.planApproval?.status, 'revising');
    assert.throws(() => h.service.respondToApproval(reviewing.id, initialRequest.requestId, true, initialRequest.argsHash), /approval_not_pending/);
    assert.ok(!reviewing.activities.some(activity => activity.tool === 'web_fetch'));
    releaseRevision();
    await approvalCard.getByText('优先核验官方发布日志', { exact: true }).waitFor();
    assert.notEqual(h.service.list()[0].approvals[0].argsHash, initialRequest.argsHash);
    await approvePlan.click();
    await h.page.getByText('已完成 / 真实调查', { exact: true }).waitFor();
    const planSteps = phaseDetail.getByRole('list', { name: '计划步骤' });
    await planSteps.getByText('已批准调查计划。', { exact: true }).waitFor();
    assert.equal(await planSteps.getByText(/读取网页/).count(), 0);
    await collectionStage.click();
    const collectionSteps = phaseDetail.getByRole('list', { name: '采集步骤' });
    await collectionSteps.getByText(/读取网页/).waitFor();
    assert.equal(await collectionSteps.getByText(/审批调查计划|已提交计划修改意见/).count(), 0);
    const investigation = h.service.list().find(run => run.profile === 'web')!;
    assert.ok(investigation.plan && investigation.reportReady);
    assert.equal(investigation.review?.decision, 'accept');
    const investigationEvents = new FileStore(resolve(h.service.outputRoot, investigation.id)).lines<TraceEvent>('traces/' + investigation.traceRunId + '.jsonl');
    const investigationLimits = investigationEvents.find(event => event.type === 'run_started')!.data.limits as Record<string, number>;
    assert.equal(investigationLimits.timeoutMs, 0);
    assert.equal(investigationLimits.toolTimeoutMs, 180_000);
    await h.page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: '新建任务', exact: true }).click();
    await h.ui.sendTask(quickRequest);
    await h.page.getByText('快速查询完成。', { exact: true }).waitFor();
    const quick = h.service.list().find(run => !isInvestigationTask(run.task) && run.task.instruction === quickRequest)!;
    const quickEvents = new FileStore(resolve(h.service.outputRoot, quick.id)).lines<TraceEvent>('traces/' + quick.traceRunId + '.jsonl');
    const limits = quickEvents.find(event => event.type === 'run_started')!.data.limits as Record<string, number>;
    assert.equal(limits.timeoutMs, 0);
    assert.equal(limits.toolTimeoutMs, 120_000);
    assert.equal(limits.maxToolCalls, 5);
    assert.equal(limits.maxSameToolCalls, 3);

    const timed = h.service.start({ profile: 'agent', mode: 'live', permission: 'explore', task: { kind: 'agent', taskId: 'old-misrouted-lookup', instruction: timedRequest, allowedSources: ['web'] }, limits: { timeoutMs: 1000 } });
    assert.match((await h.service.wait(timed.id)).error ?? '', /^budget_timeout/);
    await h.page.reload();
    await h.page.locator(`[data-session-id="${timed.id}"]`).click();
    await h.page.locator('#retry-run').click();
    await confirmation.waitFor();
    assert.equal(await confirmation.getByLabel('公司或组织').inputValue(), 'kimi');
    assert.equal(await confirmation.getByLabel('产品 / 主题').inputValue(), 'codingplan');
    assert.equal(await confirmation.getByLabel('调研重点（可选）').inputValue(), timedRequest);
    assert.equal(h.service.list().length, 4);
    assert.deepEqual(requests, [localRequest, researchRequest, quickRequest, timedRequest]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

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

check('integration', 'Web reviews a draft in chat, moves the whole session into a project, and compares explicitly saved versions', async () => {
  const h = await browserHarness('research-workspace', webSignalFixture());
  const { page } = h;
  const history = page.getByRole('region', { name: '项目与历史会话' });
  const projectName = '版本追踪';
  const project = history.getByRole('region', { name: `项目 ${projectName}` });
  const archive = page.getByRole('button', { name: '我的调研', exact: true });
  const report = page.getByRole('region', { name: '报告标注与追问' });
  try {
    await h.ui.open('web');
    await h.ui.start(); await h.ui.completed();
    const first = h.service.list()[0];
    await history.getByRole('button', { name: '新建项目' }).click();
    await history.getByLabel('项目名称').fill(projectName);
    await history.getByRole('button', { name: '创建', exact: true }).click();
    await project.waitFor();
    const originalSession = history.locator(`[data-session-id="${first.id}"]`);
    await originalSession.dragTo(project);
    await project.locator(`[data-session-id="${first.id}"]`).waitFor();
    const projectId = h.service.projects()[0].id;
    assert.equal(h.service.get(first.id).projectId, projectId);
    assert.equal(await history.getByText('未归档会话', { exact: true }).count(), 0);
    assert.equal(await history.getByLabel('移动当前会话').count(), 0);
    assert.equal(await history.getByRole('region', { name: '历史会话', exact: true }).count(), 0);
    const renamedTitle = '发布追踪记录';
    await project.locator(`[data-session-actions="${first.id}"]`).click();
    page.once('dialog', dialog => { void dialog.accept(renamedTitle); });
    await project.locator(`[data-rename-session="${first.id}"]`).click();
    await project.getByRole('button', { name: renamedTitle, exact: true }).waitFor();
    await page.getByRole('heading', { name: renamedTitle, exact: true }).waitFor();
    await report.getByLabel('继续追问').fill('这份报告哪些地方还需要核对？');
    await report.getByRole('button', { name: '发送追问' }).click();
    await report.getByText('这份报告哪些地方还需要核对？', { exact: true }).waitFor();
    await report.getByText(/这是离线演示报告/).waitFor();
    await report.getByText('添加标注或校订', { exact: true }).click();
    await report.getByLabel('原文选段（可选）').fill('本报告来自明确标注的合成测试快照');
    await report.getByLabel('标注意见').fill('让报告更清楚地区分来源');
    await report.getByLabel('校订文字（可选）').fill('本报告已校订，材料来自合成测试快照');
    await report.getByRole('button', { name: '添加标注', exact: true }).click();
    await report.getByText('让报告更清楚地区分来源', { exact: true }).waitFor();
    await h.ui.saveReport();
    assert.match(h.service.report(first.id, true), /本报告已校订，材料来自合成测试快照/);
    await report.getByLabel('标注意见').fill('此标注尚未保存到我的调研');
    await report.getByRole('button', { name: '添加标注', exact: true }).click();
    await report.getByText('此标注尚未保存到我的调研', { exact: true }).waitFor();

    await project.getByRole('button', { name: `在 ${projectName} 中新建会话` }).click();
    await page.getByText(`新会话将加入 ${projectName}`).waitFor();
    await h.ui.start(); await h.ui.completed(); await h.ui.saveReport();
    const second = h.service.list().find(run => run.id !== first.id)!;
    assert.equal(second.projectId, projectId);
    await archive.click();
    await page.locator(`[data-compare-report="${first.id}"]`).check();
    await page.locator(`[data-compare-report="${second.id}"]`).check();
    await page.getByRole('button', { name: '对比所选报告' }).click();
    const comparison = page.getByRole('region', { name: '报告对比' });
    await comparison.getByText(/本报告已校订，材料来自合成测试快照/).waitFor();
    assert.equal(await comparison.getByRole('article').count(), 2);
    assert.equal(await comparison.getByText(/各报告共同列出的主张/).isVisible(), true);
    assert.equal(await comparison.getByText('此标注尚未保存到我的调研').count(), 0);
    await page.screenshot({ path: 'artifacts/web-eval/research-comparison.png', fullPage: true });
    await page.reload();
    await project.locator(`[data-session-id="${first.id}"]`).click();
    await project.getByRole('button', { name: renamedTitle, exact: true }).waitFor();
    await page.getByRole('heading', { name: renamedTitle, exact: true }).waitFor();
    await report.getByText('这份报告哪些地方还需要核对？', { exact: true }).waitFor();
    await report.getByText('此标注尚未保存到我的调研', { exact: true }).waitFor();
    const secondSession = project.locator(`[data-session-id="${second.id}"]`);
    const secondActions = project.locator(`[data-session-actions="${second.id}"]`);
    const deleteSecond = project.locator(`[data-delete-session="${second.id}"]`);
    await secondSession.click();
    await secondActions.click();
    page.once('dialog', dialog => { void dialog.dismiss(); });
    await deleteSecond.click();
    assert.equal(h.service.list().length, 2);
    await secondActions.click();
    let deleteMessage = '';
    page.once('dialog', dialog => {
      deleteMessage = dialog.message();
      void dialog.accept();
    });
    await deleteSecond.click();
    await secondSession.waitFor({ state: 'detached' });
    assert.match(deleteMessage, /我的调研.*已保存报告将一并删除/);
    await page.getByRole('heading', { name: renamedTitle, exact: true }).waitFor();
    assert.deepEqual(h.service.list().map(run => run.id), [first.id]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
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
    await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
    await h.ui.start();
    await h.ui.completed();
    const session = page.getByRole('region', { name: '历史会话', exact: true }).locator('[data-session-id]');
    await navigation.click();
    await page.getByRole('heading', { name: '还没有调查' }).waitFor();
    await session.click();
    await h.ui.saveReport();
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
    await h.page.getByRole('button',{name:'批准计划并开始采集',exact:true}).click();
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
    await h.page.getByRole('heading',{name:'审批调查计划'}).waitFor();
    await h.ui.cancel();
    assert.deepEqual(fixture.calls,[]);await h.page.reload();await h.page.getByText('已取消 / 离线演示',{exact:true}).waitFor();
    assert.equal(await h.page.locator('#approval-spotlight').isVisible(),false);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

check('integration', 'Web UI requires plan approval in full mode and blocks collection when rejected', async () => {
  const fixture = approvalFixture('web'), h = await browserHarness('full-mode-plan-approval', fixture);
  try {
    await h.ui.open('web'); await h.ui.setPermission('allow-all'); await h.ui.closeSettings();
    await h.ui.start();
    const card = h.page.getByRole('region', { name: '待处理审批' });
    await card.getByRole('heading', { name: '审批调查计划', exact: true }).waitFor();
    await card.getByText('计划查询 (1)', { exact: true }).waitFor();
    assert.deepEqual(fixture.calls, []);
    await card.getByRole('button', { name: '拒绝计划', exact: true }).click();
    await h.page.getByText('已取消 / 离线演示', { exact: true }).waitFor();
    const rejected = await h.service.wait(h.service.list()[0].id);
    assert.match(rejected.error ?? '', /调查计划未获批准/);
    assert.equal(rejected.reportReady, false);
    assert.deepEqual(fixture.calls, []);
    await h.page.getByRole('button', { name: '尝试重试', exact: true }).first().click();
    await card.getByRole('button', { name: '批准计划并开始采集', exact: true }).click();
    await h.ui.completed();
    assert.deepEqual(fixture.calls, ['request_publish', 'web_fetch']);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
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
    h.service.saveReport(created.id, { revision: 0 });
    await h.page.evaluate(()=>localStorage.removeItem('cwatch-selected-run'));await h.page.reload();
    await h.page.getByRole('form',{name:'提交任务'}).waitFor();
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
    await h.page.getByRole('button', { name: '添加来源网址' }).click();
    await h.page.getByLabel('指定来源网址', { exact: true }).fill(releaseUrl);
    await h.page.getByLabel('来源类型', { exact: true }).selectOption('changelog');
    await h.page.getByLabel('搜索范围', { exact: true }).selectOption('only');
    await h.page.setViewportSize({width:390,height:844});
    assert.equal(await h.page.locator('#task-editor').evaluate(editor=>editor.scrollWidth>editor.clientWidth),false);
    await h.page.screenshot({path:'artifacts/web-eval/new-task-details-mobile.png'});
    await h.ui.start();
    await h.page.getByRole('button', { name: '批准计划并开始采集', exact: true }).click();
    await h.page.getByText('已完成 / 真实调查',{exact:true}).waitFor({timeout:30000});await h.ui.report();
    const run=h.service.list()[0];assert.equal(run.mode,'live');assert.equal(run.claims.length,1);assert.equal(run.modelTurns,provider.modelRequests.length);assert.equal(run.totalTokens,120 * provider.modelRequests.length);
    assert.deepEqual(run.model,{id:'web-fixture-alternate',reasoningEffort:'high'});
    assert.deepEqual(provider.modelRequests[0],{model:'web-fixture-alternate',reasoningEffort:'high'});
    assert.deepEqual(provider.initialTask()?.researchBrief,{focus:'核对版本发布时间',deliverable:'用表格列出版本和发布日期'});
    assert.deepEqual(provider.initialTask()?.evidencePolicy,{ scope: 'only', sources: [{ url: releaseUrl, kind: 'changelog' }] });
    assert.deepEqual(run.assessment?.collection?.specifiedCoverage, { attempted: 1, total: 1 });
    assert.equal(run.assessment?.review?.[0].checks.length, 6);
    await h.page.getByRole('region', { name: '阶段结束依据' }).waitFor();
    const data=new FileStore(resolve(h.service.outputRoot,run.id)),events=data.lines<TraceEvent>('traces/'+run.traceRunId+'.jsonl');
    assert.ok(events.some(event=>event.type==='agent_process'&&event.data.state==='ready'));assert.ok(events.some(event=>event.type==='backend_started'&&event.data.backend==='test.web.fixture'));assert.deepEqual(validateTrace(events),[]);
    assert.equal(provider.turns(),8);assert.deepEqual(provider.errors,[]);assert.deepEqual(h.errors,[]);
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
    await h.ui.saveReport();
    await h.page.getByRole('button',{name:'我的调研',exact:true}).click();
    const search=h.page.getByRole('searchbox',{name:'搜索调查与报告'});
    await search.fill('不存在的关键词');
    await h.page.getByText('没有符合条件的调查',{exact:true}).waitFor();
    await search.fill('');
    h.page.once('dialog', dialog => { void dialog.accept(); });
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
    const modelIds=editor.getByRole('textbox',{name:'模型 ID',exact:true});
    const addModelId=editor.getByRole('button',{name:'添加模型 ID',exact:true});
    assert.equal(await modelIds.count(),1);
    await modelIds.fill('deepseek-chat');
    await addModelId.click();
    assert.equal(await modelIds.nth(1).evaluate(node=>node===document.activeElement),true);
    await modelIds.nth(1).fill('deepseek-reasoner');
    await addModelId.click();
    await modelIds.nth(2).fill('removed-model');
    await editor.getByRole('button',{name:'移除此模型 ID',exact:true}).last().click();
    assert.equal(await modelIds.count(),2);
    await editor.locator('input[name=reasoning]').check();
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    await editor.waitFor({state:'hidden'});
    await h.page.locator('.ext-provider-list').getByText('deepseek',{exact:true}).waitFor();
    assert.equal((await h.page.locator('#connections-overview').innerText()).includes('sk-workbench-provider-secret'),false);
    const savedModels=await h.page.locator('#task-model option').evaluateAll(nodes=>nodes.map(o=>o.textContent));
    assert.ok(savedModels.includes('deepseek-chat'));
    assert.ok(savedModels.includes('deepseek-reasoner'));
    assert.equal(savedModels.includes('removed-model'),false);

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
    const standard=h.page.getByRole('button',{name:'标准核验 750k',exact:true});
    const fast=h.page.getByRole('button',{name:'快速浏览 250k',exact:true});
    const deep=h.page.getByRole('button',{name:'深入调查 1.5M',exact:true});
    assert.equal(await fast.isVisible(),false);
    await h.ui.openSettings();
    const toolTimeout=h.page.getByLabel('单次工具超时（秒）');
    assert.equal(await toolTimeout.inputValue(),'120');
    assert.equal(await h.page.locator('#tokens').inputValue(),'750000');
    assert.equal(await standard.getAttribute('aria-pressed'),'true');
    await fast.click();
    assert.equal(await toolTimeout.inputValue(),'120');
    assert.equal(await h.page.locator('#tokens').inputValue(),'250000');
    assert.equal(await fast.getAttribute('aria-pressed'),'true');
    await toolTimeout.fill('75');
    assert.equal(await fast.getAttribute('aria-pressed'),'true');
    await deep.click();
    assert.equal(await toolTimeout.inputValue(),'75');
    assert.equal(await h.page.locator('#tokens').inputValue(),'1500000');
    assert.equal(await deep.getAttribute('aria-pressed'),'true');

    // A custom token budget clears the active depth preset.
    await h.page.locator('#tokens').fill('800000');
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
    assert.equal(await h.page.locator('#pipeline-detail').getByText('生成并提交调查计划', { exact: true }).count(), 1);
    assert.equal(await h.page.locator('#pipeline .pipeline-spinner').count(), 0);
    // Cycle through remaining stages and toggle plan closed
    const stages = ['采集', '分析', '审阅', '草稿'];
    for(const [i, stage] of stages.entries()){
      const idx = i + 1;
      await h.page.locator(`#pipeline button[data-pipeline-stage="${idx}"]`).click();
      assert.equal(await h.page.locator('#pipeline-detail').isVisible(),true);
      assert.deepEqual(await h.page.locator('#pipeline-detail ul[aria-label$="步骤"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), [stage + '步骤']);
      assert.equal(await h.page.locator('#pipeline-detail').getByText('生成并提交调查计划', { exact: true }).count(), 0);
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

check('integration','Web UI moves the spinner with the live stage and filters steps when selecting another stage',async()=>{
  let releasePlan!: () => void;
  const planGate = new Promise<void>(resolve => { releasePlan = resolve; });
  const modelFactory: RunServiceOptions['modelFactory'] = (_mode, task) => {
    assert.ok(isInvestigationTask(task));
    const model = new ReplayModel(investigationDecisions(task));
    return { decide: async (input, signal) => {
      if (!input.state.iteration) await abortable(planGate, signal);
      if (input.state.iteration >= 2) return abortable(new Promise<never>(() => {}), signal);
      return model.decide(input, signal);
    } };
  };
  const h=await browserHarness('live-report-progress',{...webSignalFixture(),modelFactory});
  try{
    await h.ui.open('web');
    await h.ui.start();
    await h.page.getByText('执行中 / 离线演示',{exact:true}).waitFor();
    await h.page.getByRole('tab',{name:'调查报告',exact:true}).click();
    await h.page.locator('.live-progress-card').waitFor({state:'visible'});
    assert.ok((await h.page.locator('.live-stage-pill').innerText()).includes('计划'));
    const activeStage = h.page.locator('#pipeline button[aria-current="step"]');
    await activeStage.locator('.pipeline-spinner').waitFor();
    assert.equal(await activeStage.getAttribute('data-pipeline-stage'), '0');
    releasePlan();
    await h.page.locator('#pipeline [data-pipeline-stage="1"] .pipeline-spinner').waitFor();
    await h.page.locator('.live-step-list').getByText(/读取网页/).waitFor();
    await h.page.locator('#pipeline [data-pipeline-stage="0"]').click();
    const selectedSteps = h.page.getByRole('list', { name: '计划步骤' });
    await selectedSteps.getByText('生成并提交调查计划', { exact: true }).waitFor();
    assert.equal(await selectedSteps.getByText(/读取网页/).count(), 0);
    assert.equal(await h.page.locator('.live-step-list').count(), 0);
    assert.equal(await activeStage.getAttribute('data-pipeline-stage'), '1');
    await h.page.locator('.live-progress-card').getByRole('button',{name:'查看实时执行轨迹',exact:true}).click();
    const process = h.page.getByRole('tabpanel', { name: /执行轨迹/ });
    await process.getByText('生成并提交调查计划', { exact: true }).waitFor();
    assert.equal(await process.getByText(/读取网页/).count(), 0);
    await h.page.locator('#pipeline [data-pipeline-stage="1"]').click();
    await process.getByText(/读取网页/).waitFor();
    assert.equal(await process.getByText('生成并提交调查计划', { exact: true }).count(), 0);
    await h.ui.cancel();
    await h.page.locator('#pipeline .pipeline-spinner').waitFor({ state: 'detached' });
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
