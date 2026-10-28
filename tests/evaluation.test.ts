import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CaseSchema } from '../scripts/evaluation/contracts.ts';
import { loadDataset, validateLineage, sha256 } from '../scripts/evaluation/dataset.ts';
import { regradeArchivedCase, readArchivedCase, collectFailureCandidate } from '../scripts/evaluation/operations.ts';
import { grade, inventory, verifyInventory, collectProjection, select, parseFinalJson, type EvalResult } from '../scripts/evaluation/grader.ts';
import { summarize, compareReports, workerFailureKind } from '../scripts/evaluation/runner.ts';
import { Trace, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { abortable } from '@cwatch/core/types';
import { ExplicitResourceLoader } from '@cwatch/shared/agent/backend/pi/explicit-resources';
import { inspectFinalOutput, outputContractInstruction, OUTPUT_CONTRACTS } from '../scripts/evaluation/output-format.ts';
import { buildExecutionInput } from '../scripts/evaluation/execution-input.ts';
import { check, store } from './harness.ts';

// Calibration uses a pending copy regardless of real human reviews; never rewrite the dataset.
const sample=()=>{
  const c=loadDataset('evals/regression/dataset.json').entries.find(e=>e.value.id==='github-rate-limit')!.value;
  c.status='needs_review';c.oracle.review=null;return c;
};
function fixture(){
  const c=sample(),data=store(),trace=new Trace(data,'calibration-task','calibration-run');
  trace.emit('run_started',{purpose:'Grader unit calibration only',mode:'replay'});trace.emit('run_completed',{status:'partial'});
  data.write('boundary.json',{privateReadDenied:true,childProcessDenied:true,outputCanaryLeaked:false});
  const observation={runId:'calibration-run',status:'partial' as const,tracePath:trace.key,facts:{driver:'calibration',apiStatus:'rate_limited',fixtureCallCount:1,fixtureEscapes:0,guideRead:true},usage:{mode:'fixture' as const,mainTaskTokens:null,maintenanceTokens:null,physicalModelRequests:0,completeness:'not_applicable' as const}};
  return{c,data,projection:collectProjection(data.root,observation),observation};
}
check('contract','Eval dataset validates six facets, frozen hashes and all three correctly labeled origins',()=>{
  const d=loadDataset('evals/regression/dataset.json');assert.equal(d.entries.length,12);
  assert.ok(d.entries.filter(e=>e.value.status==='approved').every(e=>e.value.oracle.review?.kind==='human'));
  assert.deepEqual(new Set(d.entries.map(e=>e.value.origin.layer)),new Set(['manual','observed_failure','synthetic']));
  assert.ok(d.entries.every(e=>e.value.origin.environment!=='production'));
});
check('contract','Eval schema rejects missing facets, unscored requirements, unsafe selectors and forged review eligibility',()=>{
  const c=sample();assert.equal(CaseSchema.safeParse({...c,input:undefined}).success,false);
  const unscored=structuredClone(c);unscored.expected_process.requirements.push({id:'unscored',assertion:'must be graded'});assert.equal(CaseSchema.safeParse(unscored).success,false);
  assert.equal(CaseSchema.safeParse({...c,status:'approved'}).success,false);
  const unsafe=structuredClone(c);unsafe.scoring.checks[0].path='facts.__proto__.x';assert.equal(CaseSchema.safeParse(unsafe).success,false);
  assert.throws(()=>select({},'constructor.name'),/unsafe_selector/);
});
check('contract','Eval case hashes prevent a silently edited label from entering the same dataset version',()=>{
  const data=store(),dir=mkdtempSync(resolve(data.root,'dataset-')),c=sample();
  writeFileSync(resolve(dir,'case.json'),JSON.stringify(c));
  writeFileSync(resolve(dir,'dataset.json'),JSON.stringify({schemaVersion:'cwatch.eval-dataset.v1',id:'tamper',version:'1',cases:[{id:c.id,revision:c.revision,file:'case.json',sha256:'0'.repeat(64)}]}));
  assert.throws(()=>loadDataset(resolve(dir,'dataset.json')),/case_hash_mismatch/);
});
check('contract','Eval lineage forbids split leakage, missing parents and cycles',()=>{
  const a=sample(),b=structuredClone(a);b.id='variant';b.origin={...b.origin,layer:'synthetic',parentCaseIds:[a.id]};
  validateLineage([a,b]);b.split='holdout';assert.throws(()=>validateLineage([a,b]),/family_split_leakage/);
  b.split='regression';b.origin.parentCaseIds=['missing'];assert.throws(()=>validateLineage([a,b]),/missing_parent_case/);
  b.origin.parentCaseIds=[a.id];a.origin.parentCaseIds=[b.id];assert.throws(()=>validateLineage([a,b]),/lineage_cycle/);
});
check('semantic','Grader calibration keeps passing candidates pending and recognizes an independently recorded review in a unit fixture',()=>{
  const f=fixture(),pending=grade(f.c,f.projection);assert.equal(pending.executionPassed,true);assert.equal(pending.verdict,'needs_review');assert.equal(pending.releaseEligible,false);
  // Test-only review fixture: never persisted into the real dataset or advertised as a human approval.
  const reviewed=structuredClone(f.c);reviewed.status='approved';reviewed.oracle.review={by:'unit-fixture-not-a-real-reviewer',kind:'human',at:'2026-10-25T00:00:00Z'};
  const passed=grade(reviewed,f.projection);assert.equal(passed.verdict,'pass');assert.equal(passed.releaseEligible,true);
});
check('semantic','Grader calibration detects misclassified limits, forbidden terminal success and pending labels never mask failure',()=>{
  const f=fixture();f.projection.facts.apiStatus='auth_failed';const failed=grade(f.c,f.projection);
  assert.equal(failed.verdict,'fail');assert.ok(failed.failures.includes('runtime.error_classification'));assert.equal(failed.releaseEligible,false);
  f.projection.status='complete';assert.ok(grade(f.c,f.projection).failures.includes('runtime.unexpected_terminal'));
});
check('semantic','Missing evidence stays unknown rather than passed and a leaked canary is an unconditional failed boundary',()=>{
  const f=fixture();delete (f.projection.facts as Record<string,unknown>).guideRead;
  assert.equal(grade(f.c,f.projection).checks.find(c=>c.criterionId==='C4')?.outcome,'unknown');assert.equal(grade(f.c,f.projection).executionPassed,false);
  f.projection.boundary.outputCanaryLeaked=true;const failed=grade(f.c,f.projection);assert.equal(failed.verdict,'fail');assert.ok(failed.failures.includes('safety.secret_leak'));
});
check('semantic','Malformed or incomplete SUT Trace fails observability instead of being excused as an invalid evaluation',()=>{
  const f=fixture();writeFileSync(f.data.path(f.observation.tracePath),'not-json\n');
  const projection=collectProjection(f.data.root,f.observation),r=grade(f.c,projection);assert.equal(r.verdict,'fail');assert.ok(r.failures.includes('observability.invalid_trace'));
});
check('contract','Evidence manifest detects tampering and outside-workspace references',()=>{
  const f=fixture(),items=inventory(f.data.root);assert.deepEqual(verifyInventory(f.data.root,items),[]);
  f.data.text('boundary.json','{}');assert.ok(verifyInventory(f.data.root,items).some(e=>e.startsWith('hash_mismatch:')));
  assert.ok(verifyInventory(f.data.root,[{path:'../outside.json',sha256:'0'.repeat(64),bytes:0}]).length>0);
});
check('semantic','Reports retain pending and invalid denominators and never manufacture live-model accuracy or cost',()=>{
  const f=fixture(),pending=grade(f.c,f.projection),invalid:EvalResult={...pending,caseId:'invalid',verdict:'invalid',executionPassed:false,releaseEligible:false};
  const report=summarize([pending,invalid]);assert.equal(report.planned,2);assert.equal(report.valid,1);assert.equal(report.explicitPassRate,0);assert.equal(report.effectiveCoverage,.5);
  assert.equal(report.releaseGate,false);assert.equal(report.measuredLiveModelAccuracy,null);assert.equal(report.actualLiveModelCost,null);
});
check('semantic','Version comparison exposes regressions and missing attempts while rejecting changed labels or graders',()=>{
  const f=fixture(),good=grade(f.c,f.projection),bad={...good,executionPassed:false,verdict:'fail' as const};
  const a={datasetSha256:'same',results:[good]},b={datasetSha256:'same',results:[bad]};
  assert.deepEqual(compareReports(a,b).regressions,[good.caseId]);assert.equal(compareReports(a,{...b,results:[]}).missing.length,1);
  assert.throws(()=>compareReports(a,{...b,datasetSha256:'other'}),/incomparable_dataset/);
  assert.throws(()=>compareReports(a,{...b,results:[{...bad,graderVersion:'changed'}]}),/incomparable_grader/);
});
check('contract','Cancellation during promise construction observes its rejection without crashing after a durable terminal',async()=>{
  const controller=new AbortController(),reason=new Error('synchronous cancellation'),unhandled:unknown[]=[];
  const listener=(error:unknown)=>unhandled.push(error);process.on('unhandledRejection',listener);
  try{
    const operation=(async()=>{controller.abort(reason);throw reason;})();
    assert.throws(()=>abortable(operation,controller.signal),/synchronous cancellation/);
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(unhandled,[]);
  }finally{process.removeListener('unhandledRejection',listener);}
});
check('contract','Explicit SDK resources expose host prompt only and cannot discover or extend hidden user Skills',async()=>{
  const loader=new ExplicitResourceLoader('host-controlled prompt');await loader.reload();
  assert.equal(loader.getSystemPrompt(),'host-controlled prompt');assert.deepEqual(loader.getSkills().skills,[]);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles,[]);assert.deepEqual(loader.getExtensions().extensions,[]);
  assert.throws(()=>loader.extendResources({skillPaths:[{path:'private-answer',metadata:{source:'local',scope:'project',origin:'top-level'}}]}),/implicit_sdk_resources_disabled/);
});
check('semantic','A worker crash with SUT evidence remains a tested-system failure rather than an excluded invalid sample',()=>{
  assert.equal(workerFailureKind(true),'sut_failure');assert.equal(workerFailureKind(false),'harness_failure');
});
check('contract','Real-model cases reject scripted answer trajectories and keep their output format contract explicit',()=>{
  const c=loadDataset('evals/model-diagnostic/dataset.json').entries[0].value;
  assert.equal(c.scope.executionMode,'frozen_tools_live_model');assert.equal(c.input.scenario.driver,'runtime');
  if(c.input.scenario.driver!=='runtime')throw Error('expected runtime');
  assert.deepEqual(c.input.scenario.steps,[]);assert.ok(c.scoring.checks.some(check=>check.path==='facts.finalJsonValid'));
  c.input.scenario.steps=[{kind:'respond',text:'scripted answer'}];assert.equal(CaseSchema.safeParse(c).success,false);
});
function archiveFixture(failed=false,legacyFormat=false){
  const f=fixture(),data=store(),root=data.path('batch'),dir=data.path('batch/case');
  if(failed)f.observation.facts.apiStatus='auth_failed';
  if(legacyFormat){
    f.c.scoring.checks.push({id:'legacy-format',requirementRefs:['F1'],method:'equals',path:'facts.finalJsonValid',expected:true,required:true,hardFail:false,failureCode:'answer.invalid_format'});
    f.c.failure_taxonomy.allowedCodes.push('answer.invalid_format');Object.assign(f.observation.facts,{finalJsonValid:false});
  }
  const projection=collectProjection(f.data.root,f.observation),result=grade(f.c,projection);
  data.text('batch/case/'+f.observation.tracePath,readFileSync(f.data.path(f.observation.tracePath),'utf8'));
  data.write('batch/case/observed.json',f.observation);data.write('batch/case/boundary.json',projection.boundary);data.write('batch/case/projection.json',projection);
  const source=JSON.stringify(f.c,null,2)+'\n';data.text('batch/private/case.source',source);
  const manifest={caseSha256:sha256(source),frozenCaseRef:'../private/case.source',evidence:inventory(dir)};
  data.write('batch/case/manifest.json',manifest);
  const report={results:[result],artifacts:[{caseId:f.c.id,attempt:1,directory:'batch/case',manifestSha256:sha256(readFileSync(data.path('batch/case/manifest.json')))}]};
  if(legacyFormat){result.verdict='fail';result.executionPassed=false;result.failures=['answer.invalid_format'];} // Simulates the old grader, not a real model run.
  data.write('batch/report.json',report);return{...f,data,dir,reportPath:data.path('batch/report.json'),result};
}
check('contract','Archived regrading uses frozen labels and verified evidence while preserving the original result',()=>{
  const f=archiveFixture(),original=readFileSync(f.reportPath,'utf8'),regraded=regradeArchivedCase(f.reportPath,f.c.id);
  assert.equal(regraded.result.executionPassed,true);assert.equal(regraded.result.verdict,'needs_review');assert.ok(existsSync(regraded.path));
  const projection=regraded.result.checks.flatMap(c=>c.evidence).find(e=>e.artifact.startsWith('projection.regrade-'));
  assert.ok(projection);assert.ok(existsSync(resolve(f.dir,projection.artifact)));
  assert.equal(readFileSync(f.reportPath,'utf8'),original);
  f.data.text('batch/case/'+f.observation.tracePath,'{}\n');assert.throws(()=>readArchivedCase(f.reportPath,f.c.id),/evidence_integrity_failure/);
});
check('contract','Failure intake rejects pending cases and keeps confirmed evaluation failures unapproved and outside the dataset',()=>{
  const good=archiveFixture();assert.throws(()=>collectFailureCandidate(good.reportPath,good.c.id,good.data.root),/only_confirmed_sut_failures/);
  const bad=archiveFixture(true),candidate=collectFailureCandidate(bad.reportPath,bad.c.id,bad.data.root),value=CaseSchema.parse(JSON.parse(readFileSync(candidate.path,'utf8')));
  assert.equal(value.status,'needs_review');assert.equal(value.origin.environment,'development_acceptance');assert.equal(value.origin.originalRunId,bad.observation.runId);
  assert.deepEqual(value.origin.parentCaseIds,[bad.c.id]);assert.equal(candidate.registeredInDataset,false);assert.equal(value.oracle.review,null);
});
check('contract','Holdout cases stored inside the developer workspace are rejected even with a valid content hash',()=>{
  const data=store(),c=sample();c.split='holdout';const text=JSON.stringify(c);data.text('case.json',text);
  data.write('dataset.json',{schemaVersion:'cwatch.eval-dataset.v1',id:'exposed-holdout',version:'1',cases:[{id:c.id,revision:c.revision,file:'case.json',sha256:sha256(text)}]});
  assert.throws(()=>loadDataset(data.path('dataset.json')),/holdout_in_development_workspace/);
});
check('semantic','Fact extraction remains separate from output-format compliance and never chooses between ambiguous JSON answers',()=>{
  assert.deepEqual(parseFinalJson('{"version":"1"}'),{value:{version:'1'},formatValid:true,extraction:'entire'});
  const prose=parseFinalJson('Explanation\n```json\n{"version":"1"}\n```\nExtra prose');
  assert.deepEqual(prose.value,{version:'1'});assert.equal(prose.formatValid,false);assert.equal(prose.extraction,'embedded_fence');
  assert.equal(parseFinalJson('```json\n{"version":"1"}\n```\n```json\n{"version":"2"}\n```').value,null);
});
check('semantic','A known JSON answer missing a required field fails instead of being mislabeled as unavailable grading evidence',()=>{
  const f=fixture(),c=loadDataset('evals/model-diagnostic/dataset.json').entries.find(e=>e.value.id==='model-github-rate-limit')!.value;
  Object.assign(f.projection.facts,{finalJson:{},finalJsonValid:true});
  const result=grade(c,f.projection);assert.equal(result.checks.find(c=>c.criterionId==='final-sourceStatus')?.outcome,'fail');
});
check('semantic','Rate-limit note validation rejects omitted, blank and non-string notes while accepting varied explanations',()=>{
  const f=fixture(),c=loadDataset('evals/model-diagnostic/dataset.json').entries.find(e=>e.value.id==='model-github-rate-limit')!.value;
  const answer={sourceStatus:'rate_limited',updatesKnown:false,versions:[]};
  Object.assign(f.projection.facts,{finalJsonValid:true,outputContract:'json_object_only'});
  const outcome=()=>grade(c,f.projection).checks.find(check=>check.criterionId==='final-note')?.outcome;
  for(const note of ['', ' \n\t ', null, false, 0, [], {}]){
    Object.assign(f.projection.facts,{finalJson:{...answer,note}});assert.equal(outcome(),'fail');
  }
  Object.assign(f.projection.facts,{finalJson:answer});assert.equal(outcome(),'fail');
  for(const note of ['来源限流，窗口内版本更新未知。','The source is rate limited; available evidence cannot establish updates.']){
    Object.assign(f.projection.facts,{finalJson:{...answer,note}});
    assert.equal(outcome(),'pass');assert.equal(grade(c,f.projection).executionPassed,true);
  }
  Object.assign(f.projection.facts,{finalJson:null});assert.equal(outcome(),'unknown');
});
check('contract','Rate-limit task discloses its one-request constraint and note validation has a valid selector contract',()=>{
  const c=loadDataset('evals/model-diagnostic/dataset.json').entries.find(e=>e.value.id==='model-github-rate-limit')!.value;
  const input=buildExecutionInput(c);assert.equal(input.scenario.driver,'runtime');
  if(input.scenario.driver!=='runtime')throw Error('expected runtime');
  assert.match(input.scenario.instruction,/目标接口只请求一次；遇到失败不得重试/);
  const rule=c.scoring.checks.find(check=>check.id==='final-note')!;assert.equal(rule.method,'non_empty_string');
  const invalid=structuredClone(c),bad=invalid.scoring.checks.find(check=>check.id==='final-note')!;
  delete bad.path;assert.equal(CaseSchema.safeParse(invalid).success,false);
  bad.path=rule.path;bad.expected=true;assert.equal(CaseSchema.safeParse(invalid).success,false);
});
check('semantic','Output contracts distinguish raw JSON, sole fences and prose without accepting multiple answers',()=>{
  const raw=' {"version":"1"} ',fenced='```json\n{"version":"1"}\n```',prose='Explanation\n'+fenced+'\nContext';
  for(const p of OUTPUT_CONTRACTS)assert.equal(inspectFinalOutput(raw,p).formatValid,true);
  assert.equal(inspectFinalOutput(fenced,'json_object_only').formatValid,false);
  assert.equal(inspectFinalOutput(fenced,'single_json_block').formatValid,true);
  assert.equal(inspectFinalOutput(prose,'single_json_block').formatValid,false);
  assert.equal(inspectFinalOutput(prose,'json_artifact_with_prose').formatValid,true);
  for(const p of OUTPUT_CONTRACTS){assert.equal(inspectFinalOutput(fenced+'\n'+fenced,p).formatValid,false);assert.equal(inspectFinalOutput('[]',p).formatValid,false);}
  assert.equal(inspectFinalOutput(prose).formatValid,null);
});
check('contract','The same Case output policy generates the model instruction and scoring input without disclosing answers',()=>{
  for(const entry of loadDataset('evals/model-diagnostic/dataset.json').entries){
    const c=entry.value,before=JSON.stringify(c.input),input=buildExecutionInput(c);
    assert.equal(c.expected_final.outputContract,'json_object_only');
    assert.equal(input.scenario.driver,'runtime');if(input.scenario.driver!=='runtime')throw Error('expected runtime');
    assert.equal(input.scenario.outputContract,c.expected_final.outputContract);
    assert.ok(input.scenario.instruction.endsWith(outputContractInstruction(c.expected_final.outputContract!)));
    assert.equal(JSON.stringify(c.input),before);assert.equal(Object.hasOwn(input,'expected_final'),false);
    const ambiguous=structuredClone(c);if(ambiguous.input.scenario.driver==='runtime')ambiguous.input.scenario.outputContract='single_json_block';
    assert.equal(CaseSchema.safeParse(ambiguous).success,false);
  }
});
check('contract','New dataset execution rejects undeclared format gates while frozen legacy Cases remain readable for audit',()=>{
  const c=loadDataset('evals/model-diagnostic/dataset.json').entries[0].value;delete c.expected_final.outputContract;
  assert.equal(CaseSchema.safeParse(c).success,true);
  const data=store(),text=JSON.stringify(c);data.text('case.json',text);
  data.write('dataset.json',{schemaVersion:'cwatch.eval-dataset.v1',id:'ambiguous',version:'1',cases:[{id:c.id,revision:c.revision,file:'case.json',sha256:sha256(text)}]});
  assert.throws(()=>loadDataset(data.path('dataset.json')),/output_contract_missing/);
});
check('semantic','Undeclared legacy output requirements stay pending, and an unrelated real error still fails',()=>{
  const f=archiveFixture(false,true),pending=regradeArchivedCase(f.reportPath,f.c.id).result;
  assert.equal(pending.verdict,'needs_review');assert.deepEqual(pending.failures,[]);
  assert.equal(pending.checks.find(c=>c.criterionId==='legacy-format')?.outcome,'unknown');
  assert.ok(pending.reviewIssues.includes('oracle.output_contract_missing'));
  assert.ok(!pending.reviewIssues.includes('observability.missing_evidence'));
  f.projection.facts.apiStatus='auth_failed';const failed=grade(f.c,f.projection);
  assert.equal(failed.verdict,'fail');assert.ok(failed.failures.includes('runtime.error_classification'));
});
check('contract','Disputed legacy format failures cannot enter the failure corpus under the corrected grader',()=>{
  const f=archiveFixture(false,true);assert.throws(()=>collectFailureCandidate(f.reportPath,f.c.id,f.data.root),/failure_not_confirmed_by_current_grader/);
});
check('contract','An active synthetic case cannot inherit a withdrawn failure as its parent',()=>{
  const a=sample(),b=structuredClone(a);a.status='retired';b.id='withdrawn-parent-variant';b.origin={...b.origin,layer:'synthetic',parentCaseIds:[a.id]};
  assert.throws(()=>validateLineage([a,b]),/active_case_uses_retired_parent/);
});

check('contract','Model suite registers twenty reviewable cases in four five-case groups and preserves archived revisions',()=>{
  const dataset=loadDataset('evals/model-diagnostic/dataset.json');
  const catalog=JSON.parse(readFileSync('evals/model-diagnostic/catalog.json','utf8')) as {datasetVersion:string;groups:Array<{category:string;caseIds:string[]}>};
  assert.equal(dataset.entries.length,20);assert.equal(catalog.datasetVersion,dataset.manifest.version);
  assert.equal(catalog.groups.length,4);assert.ok(catalog.groups.every(g=>g.caseIds.length===5));
  const ids=catalog.groups.flatMap(g=>g.caseIds);assert.equal(new Set(ids).size,20);
  assert.deepEqual([...ids].sort(),dataset.entries.map(e=>e.value.id).sort());
  assert.ok(dataset.entries.every(e=>e.value.status==='approved'?e.value.oracle.review?.kind==='human':e.value.status==='needs_review'&&e.value.oracle.review===null));
  const prior=loadDataset('evals/history/model-diagnostic/2026-10-25.3/dataset.json');
  for(const original of prior.entries){const current=dataset.entries.find(e=>e.value.id===original.value.id)!;
    assert.ok(current.value.revision>=original.value.revision);
    if(current.value.revision===original.value.revision)assert.equal(current.sha256,original.sha256);
  }
  const refs=JSON.parse(readFileSync('evals/materials/model-suite-reference.json','utf8')) as {cases:Array<{caseId:string;material:unknown}>};
  assert.equal(refs.cases.length,17);
  for(const ref of refs.cases){const c=dataset.entries.find(e=>e.value.id===ref.caseId)!.value;
    assert.equal(c.input.scenario.driver,'runtime');if(c.input.scenario.driver!=='runtime')throw Error('expected runtime');
    assert.deepEqual(c.input.scenario.source==='github_api'?c.input.scenario.response:c.input.scenario.tools[0].value,ref.material);
  }
});

check('semantic','New model-case graders reject every wrong or omitted required answer field without approving calibration fixtures',()=>{
  const dataset=loadDataset('evals/model-diagnostic/dataset.json');
  const refs=JSON.parse(readFileSync('evals/materials/model-suite-reference.json','utf8')) as {cases:Array<{caseId:string;expected:Record<string,unknown>;allowedRunStatuses:Array<'complete'|'partial'>;processExpected:Record<string,unknown>}>};
  const f=fixture();
  for(const ref of refs.cases){const c=structuredClone(dataset.entries.find(e=>e.value.id===ref.caseId)!.value);
    c.status='needs_review';c.oracle.review=null;
    const projection=structuredClone(f.projection);projection.status=ref.allowedRunStatuses[0];
    Object.assign(projection.facts,ref.processExpected,{finalJson:ref.expected,finalJsonValid:true,outputContract:'json_object_only'});
    const correct=grade(c,projection);assert.equal(correct.executionPassed,true,ref.caseId);assert.equal(correct.verdict,'needs_review');
    for(const key of Object.keys(ref.expected)){
      const rule=c.scoring.checks.find(rule=>rule.path==='facts.finalJson.'+key);assert.ok(rule,ref.caseId+':'+key);
      for(const omitted of [false,true]){const bad=structuredClone(projection),answer=structuredClone(ref.expected);
        if(omitted)delete answer[key];else answer[key]='deliberately_wrong_grader_calibration_value';
        Object.assign(bad.facts,{finalJson:answer});const graded=grade(c,bad);
        assert.equal(graded.verdict,'fail',ref.caseId+':'+key);assert.equal(graded.checks.find(check=>check.criterionId===rule.id)?.outcome,'fail');
      }
    }
  }
});

check('contract','A recorded review can advance a model Case revision while pending calibration and lineage remain valid',()=>{
  const source=loadDataset('evals/model-diagnostic/dataset.json'),data=store();
  const before=JSON.stringify(source.entries.find(e=>e.value.id==='model-kimi-window-boundary')!.value);
  const entries=source.entries.map(entry=>{
    const c=structuredClone(entry.value);
    if(c.id==='model-kimi-window-boundary'){
      // Explicit unit fixture only, not a real reviewer or persisted production approval.
      c.revision++;c.status='approved';c.oracle.review={by:'unit-fixture-not-a-real-reviewer',kind:'human',at:'2026-10-25T00:00:00Z'};
    }
    const text=JSON.stringify(c),file=c.id+'.json';data.text(file,text);
    return{id:c.id,revision:c.revision,file,sha256:sha256(text)};
  });
  data.write('dataset.json',{...source.manifest,version:'review-workflow-unit-fixture',cases:entries});
  const reviewed=loadDataset(data.path('dataset.json')).entries.find(e=>e.value.id==='model-kimi-window-boundary')!.value;
  assert.equal(reviewed.status,'approved');assert.equal(reviewed.oracle.review?.kind,'human');
  assert.equal(JSON.stringify(source.entries.find(e=>e.value.id===reviewed.id)!.value),before);
});

check('semantic','Synthetic release oracle covers inclusive start, exclusive end, missing dates and actual timezone sorting',()=>{
  const refs=JSON.parse(readFileSync('evals/materials/model-suite-reference.json','utf8')) as {cases:Array<{caseId:string;material:{releases:Array<{tag:string;publishedAt:string|null;url:string;draft:boolean}>};expected:{versions:unknown[]}}>};
  for(const id of ['model-kimi-window-boundary','model-release-missing-date','model-release-timezone-order']){
    const ref=refs.cases.find(r=>r.caseId===id)!;
    const start=Date.parse(id==='model-kimi-window-boundary'?'2026-09-24T00:00:00+08:00':id==='model-release-missing-date'?'2026-10-01T00:00:00Z':'2026-10-01T16:00:00Z');
    const end=Date.parse(id==='model-kimi-window-boundary'?'2026-10-25T00:00:00+08:00':id==='model-release-missing-date'?'2026-11-01T00:00:00Z':'2026-10-02T00:00:00Z');
    const derived=ref.material.releases.filter(r=>r.publishedAt!==null&&!r.draft&&Date.parse(r.publishedAt)>=start&&Date.parse(r.publishedAt)<end)
      .sort((a,b)=>Date.parse(b.publishedAt!)-Date.parse(a.publishedAt!)).map(({tag,publishedAt,url})=>({tag,publishedAt,url}));
    assert.deepEqual(derived,ref.expected.versions,id);
  }
});
