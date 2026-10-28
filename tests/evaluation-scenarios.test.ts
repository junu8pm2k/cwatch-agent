import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { check, store } from './harness.ts';
import { loadDataset, sha256 } from '../scripts/evaluation/dataset.ts';
import { collectProjection, grade, select } from '../scripts/evaluation/grader.ts';
import { buildExecutionInput } from '../scripts/evaluation/execution-input.ts';
import { executeScenario } from '../scripts/evaluation/scenarios.ts';
import { coverageInventory, coverageMarkdown } from '../scripts/evaluation/coverage.ts';
import { inspectMarkdownReport, REPORT_COLUMNS } from '../scripts/evaluation/report-format.ts';
import { runBatch } from '../scripts/evaluation/runner.ts';
import type { EvalCase } from '../scripts/evaluation/contracts.ts';

const suite=()=>loadDataset('evals/scenario-coverage/dataset.json');
type Row={eventId:string;product:string;version:string|null;publishedAt:string|null;sourceUrls:string[]};
function fixtureReport(c:EvalCase):string {
  const rows=c.scoring.checks.find(rule=>rule.path==='facts.report.rows')!.expected as Row[];
  return '# 冻结资料调查报告\n\n## 摘要\n\n这是本地协议测试生成的合成报告，仅覆盖已提供的材料。\n\n## 核验事实\n\n'
    +'| '+REPORT_COLUMNS.join(' | ')+' |\n| --- | --- | --- | --- | --- | --- |\n'
    +rows.map(r=>'| '+[r.eventId,r.product,r.version??'-',r.publishedAt??'-','依据提供的材料；未知或冲突不择一',r.sourceUrls.map((url,i)=>`[来源${i+1}](${url})`).join('; ')].join(' | ')+' |\n').join('')
    +'\n## 证据与引用\n\n以上链接仅作为冻结证据引用，未联网访问。\n\n## 覆盖与缺口\n\n仅依据当前提供的资料，缺日期、冲突、空结果或来源失败均保留未知，不能推断全部来源。\n';
}
function modelSteps(c:EvalCase):Array<{name?:string;args?:Record<string,unknown>;text?:string}> {
  if(c.coverage?.category==='activation') return c.coverage.polarity==='positive'
    ? [{name:'mcp__fixture__investigate',args:{product:'Kimi Code'}},{text:'入口已被调用；这是合成协议测试。'}]
    : [{text:'仅回答用户当前请求，没有启动调查入口。这是合成协议测试。'}];
  if(c.coverage?.category==='core_logic')return[{name:'mcp__fixture__read_context',args:{}},{name:'mcp__fixture__collect',args:{query:'releases'}},{text:'受控协议测试完成，资料已读取。'}];
  return [{name:'mcp__fixture__read_material',args:{}},{text:fixtureReport(c)}];
}
async function calibration(c:EvalCase,text:string){
  const data=store(),input=buildExecutionInput(c);assert.equal(input.scenario.driver,'runtime');if(input.scenario.driver!=='runtime')throw Error();
  input.scenario.modelMode='scripted';input.scenario.steps=[{kind:'call_tool',name:'mcp__fixture__read_material',args:{}},{kind:'respond',text}];
  const observed=await executeScenario(input,data.root);data.write('observed.json',observed);
  // Explicit grader calibration only. Actual boundary enforcement is exercised by runBatch separately.
  data.write('boundary.json',{privateReadDenied:true,childProcessDenied:true,outputCanaryLeaked:false});
  const project=()=>collectProjection(data.root,observed,undefined,c.expected_final.reportContract);
  return{data,observed,project,result:grade(c,project())};
}
check('contract','Four-scenario coverage inventories every registered case once and keeps engineering tests outside the case denominator',()=>{
  const inventory=coverageInventory();assert.equal(inventory.totalCases,57);
  assert.equal(inventory.datasets.flatMap(d=>d.cases).filter(c=>c.executionMode==='frozen_tools_live_model').length,38);
  assert.equal(suite().entries.length,25);assert.ok(suite().entries.every(e=>e.value.status==='needs_review'&&e.value.oracle.review===null));
  for(const row of Object.values(inventory.matrix)){assert.ok(row.positive.count>0);assert.ok(row.negative.count>0);}
  assert.equal(inventory.matrix.activation.positive.count,4);assert.equal(inventory.matrix.activation.negative.count,4);
  assert.ok(coverageMarkdown(inventory).includes('工程回归位置（不计入 Agent Eval 数量）'));
  assert.ok(inventory.engineeringReferences.some(e=>e.file==='tests/pi-subprocess.test.ts'));
});
check('contract','Markdown output requirements are disclosed from one frozen contract without disclosing expected rows or scoring labels',()=>{
  for(const entry of suite().entries){
    const input=buildExecutionInput(entry.value),text=JSON.stringify(input);assert.ok(!text.includes('expected_final'));assert.ok(!text.includes('scoring'));assert.ok(!text.includes('facts.report.rows'));
    if(entry.value.expected_final.reportContract){assert.equal(input.scenario.driver,'runtime');if(input.scenario.driver!=='runtime')throw Error();
      for(const section of entry.value.expected_final.reportContract.sections)assert.ok(input.scenario.instruction.includes('## '+section));
      assert.ok(input.scenario.instruction.includes(REPORT_COLUMNS.join(' | ')));assert.equal(entry.value.expected_final.outputContract,undefined);
    }
  }
});
check('contract','Active report cases cannot silently acquire an undisclosed output contract and historical case bytes remain preserved',()=>{
  const original=loadDataset('evals/history/scenario-coverage/2026-10-27.1/dataset.json');assert.equal(original.entries.length,21);
  const current=suite();for(const old of original.entries){const now=current.entries.find(e=>e.value.id===old.value.id)!;
    if(now.value.revision===old.value.revision)assert.equal(now.sha256,old.sha256);else assert.equal(now.value.coverage?.category,'artifact_quality');}
  const previous=loadDataset('evals/history/scenario-coverage/2026-10-27.2/dataset.json');
  assert.equal(previous.entries.length,25);for(const entry of current.entries.filter(e=>e.value.expected_final.reportContract)){
    assert.equal(entry.value.input.scenario.driver,'runtime');if(entry.value.input.scenario.driver!=='runtime')throw Error();assert.equal(entry.value.input.scenario.maxOutputTokens,4096);
    const before=previous.entries.find(e=>e.value.id===entry.value.id)!.value;assert.equal(entry.value.revision,before.revision+1);assert.deepEqual(entry.value.expected_final,before.expected_final);
  }
  const c=structuredClone(current.entries.find(e=>e.value.id==='report-complete')!.value);delete c.expected_final.reportContract;
  const data=store(),text=JSON.stringify(c);data.text('case.json',text);
  data.write('dataset.json',{schemaVersion:'cwatch.eval-dataset.v1',id:'undeclared-report',version:'1',cases:[{id:c.id,revision:c.revision,file:'case.json',sha256:sha256(text)}]});
  assert.throws(()=>loadDataset(data.path('dataset.json')),/report_contract_missing/);
});
check('semantic','Complete report grading detects missing sections, empty sections, fabricated facts, wrong citations and omitted rows',async()=>{
  const c=suite().entries.find(e=>e.value.id==='report-complete')!.value,text=fixtureReport(c);
  const correct=await calibration(c,text);assert.equal(correct.result.executionPassed,true);assert.equal(correct.result.verdict,'needs_review');
  const mutations=[text.replace('## 摘要','## 无关章节'),text.replace(/## 摘要[\s\S]*?## 核验事实/,'## 摘要\n\n## 核验事实'),
    text.replace('1.1.0 |','99.0.0 |'),text.replace('https://nimbus.example/releases/1.1.0','https://invented.example/unsupported'),
    text.split('\n').filter(line=>!line.startsWith('| R2 |')).join('\n'),
    text.replace('[来源1](https://nimbus.example/releases/1.1.0)','[来源1](javascript:alert)'),
    text.replace('## 摘要','```markdown\n## 摘要')+'\n```',
    text.replace('## 摘要','````markdown\ncode\n```\n## 摘要'),
  ];
  for(const mutant of mutations){const bad=await calibration(c,mutant);assert.equal(bad.result.verdict,'fail');assert.equal(bad.result.executionPassed,false);}
});
check('contract','A report must exist on disk and match the final response rather than merely claiming it was produced',async()=>{
  const c=suite().entries.find(e=>e.value.id==='report-complete')!.value,f=await calibration(c,fixtureReport(c));
  const report=JSON.parse(readFileSync(f.data.path('run.result.json'),'utf8')) as {report:string};
  assert.equal(select(f.project(),'facts.report.artifactExists'),true);assert.ok(select(f.project(),'facts.report.artifactSha256'));
  writeFileSync(f.data.path(report.report),'Unrelated artifact');assert.equal(grade(c,f.project()).verdict,'fail');assert.equal(select(f.project(),'facts.report.artifactMatchesResponse'),false);
  unlinkSync(f.data.path(report.report));assert.equal(select(f.project(),'facts.report.artifactExists'),false);assert.equal(grade(c,f.project()).verdict,'fail');
});
check('semantic','Report rules retain unknown dates, unresolved versions and empty result sets without inventing replacement facts',()=>{
  for(const id of ['report-missing-date','report-conflicting-version','report-empty-material']){
    const c=suite().entries.find(e=>e.value.id===id)!.value,expected=c.scoring.checks.find(rule=>rule.path==='facts.report.rows')!.expected;
    const report=inspectMarkdownReport(fixtureReport(c),c.expected_final.reportContract!);assert.equal(report.formatValid,true);assert.deepEqual(report.rows,expected);
  }
});
check('semantic','Model core-logic graders reject skipped steps, wrong tools and invalid parameters even when the final answer claims success',async()=>{
  const c=suite().entries.find(e=>e.value.id==='model-core-ordered')!.value;
  for(const sequence of [
    [{name:'mcp__fixture__collect',args:{query:'releases'}}],
    [{name:'mcp__fixture__read_context',args:{}},{name:'mcp__fixture__unregistered',args:{}}],
    [{name:'mcp__fixture__read_context',args:{}},{name:'mcp__fixture__collect',args:{query:42}}],
  ]){
    const data=store(),input=buildExecutionInput(c);if(input.scenario.driver!=='runtime')throw Error();input.scenario.modelMode='scripted';
    input.scenario.steps=[...sequence.map(call=>({kind:'call_tool' as const,...call})),{kind:'respond',text:'所有步骤和参数都正确，任务已全部完成。'}];
    const observed=await executeScenario(input,data.root);data.write('boundary.json',{privateReadDenied:true,childProcessDenied:true,outputCanaryLeaked:false});
    const result=grade(c,collectProjection(data.root,observed));assert.equal(result.verdict,'fail');assert.equal(result.checks.find(rule=>rule.criterionId==='model-arguments')!.outcome,'fail');
  }
});
check('integration','Seven new scripted runtime cases execute in restricted workers and report real positive/negative outcomes',async()=>{
  const output=store(),batch=await runBatch({dataset:'evals/scenario-coverage/dataset.json',out:output.path('batch-output')});
  assert.equal(batch.report.results.length,7);assert.ok(batch.report.results.every(r=>r.executionPassed));assert.equal(batch.report.metrics.invalid,0);
  assert.equal(batch.report.metrics.scenarioCoverage.core_logic.positive.planned,1);assert.equal(batch.report.metrics.scenarioCoverage.core_logic.negative.planned,3);
  assert.equal(batch.report.metrics.scenarioCoverage.resilience.positive.planned,1);assert.equal(batch.report.metrics.scenarioCoverage.resilience.negative.planned,2);
  assert.equal(batch.report.metrics.releaseGate,false);assert.equal(batch.gate,true);
});
check('integration','Eighteen model-mode cases use the real SDK and actual tool/Markdown pipeline under an explicitly scripted local provider',async()=>{
  let steps:ReturnType<typeof modelSteps>=[],cursor=0;const errors:string[]=[],requests:Array<Record<string,any>>=[];
  const server=createServer(async(req,res)=>{try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push(request);
    const step=steps[cursor++];if(!step)throw Error('unexpected_extra_fixture_request');
    const delta=step.name?{role:'assistant',tool_calls:[{index:0,id:'scenario-call-'+requests.length,type:'function',function:{name:step.name,arguments:JSON.stringify(step.args)}}]}:{role:'assistant',content:step.text};
    const chunk={id:'scenario-response-'+requests.length,object:'chat.completion.chunk',created:1,model:'scenario-fixture',choices:[{index:0,delta,finish_reason:null}]};
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk)+'\n\n');
    res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:step.name?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}})+'\n\n');res.end('data: [DONE]\n\n');
  }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end('protocol fixture failed');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error();
  try{
    let sequence=0;
    for(const entry of suite().entries.filter(e=>e.value.scope.executionMode==='frozen_tools_live_model')){
      steps=modelSteps(entry.value);cursor=0;const data=store(),observed=await executeScenario(buildExecutionInput(entry.value),data.root,
        {provider:'scenario-fixture-'+(++sequence),modelId:'scenario-fixture',apiKey:'local-protocol-fixture-only',baseUrl:'http://127.0.0.1:'+address.port+'/v1'});
      data.write('observed.json',observed);data.write('boundary.json',{privateReadDenied:true,childProcessDenied:true,outputCanaryLeaked:false});
      const projection=collectProjection(data.root,observed,entry.value.expected_final.outputContract,entry.value.expected_final.reportContract),result=grade(entry.value,projection);
      assert.equal(result.executionPassed,true,entry.value.id+': '+JSON.stringify(result.checks.filter(c=>c.outcome!=='pass')));assert.equal(result.verdict,'needs_review');
      assert.equal(cursor,steps.length);assert.ok(observed.usage.physicalModelRequests>=1);
      assert.ok(!JSON.stringify(requests).includes('facts.report.rows'));
    }
    assert.deepEqual(errors,[]);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
