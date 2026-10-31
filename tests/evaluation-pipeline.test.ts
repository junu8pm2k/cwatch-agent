import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { CaseSchema, DatasetSchema } from '../scripts/evaluation/contracts.ts';
import { sha256, within } from '../scripts/evaluation/dataset.ts';
import { runEvaluationPipeline, judgeUnavailableReason, HumanReviewRequired } from '../scripts/evaluation/pipeline.ts';
import { decodePiMessage } from '@cwatch/shared/agent/models';
import { archiveEvaluation } from '../scripts/evaluation/archive.ts';
import { automaticAssessment } from '../scripts/evaluation/automatic.ts';
import { prepareBaseline, approveBaseline, baselineForCase } from '../scripts/evaluation/baseline.ts';
import { saveDetailedEvaluationReport } from '../scripts/evaluation/report.ts';
import { assessRegressionBatch, REGRESSION_POLICY } from '../scripts/evaluation/regression-policy.ts';
import { checkRegressionSuite, qualifyRegressionCase, runRegressionSuite, RegressionSuiteSchema } from '../scripts/evaluation/regression.ts';
import type { ModelConfig } from '@cwatch/shared/config/models';
import type { Assessment } from '../scripts/evaluation/quality.ts';
import { prepareQualitySubject, scoreHuman, jsonHash } from '../scripts/evaluation/quality.ts';
import { JUDGE_LIMITS, piJudgeTransport, scoreLlm } from '../scripts/evaluation/judge.ts';
import { saveHumanRejection, listHumanRejections } from '../scripts/evaluation/adjudication.ts';

mkdirSync(resolve('artifacts'),{recursive:true});
const root=mkdtempSync(join(resolve('artifacts'),'pipeline-engineering-test-'));
after(()=>{const target=realpathSync(root),allowed=realpathSync(resolve('artifacts'));assert.ok(target!==allowed&&within(allowed,target));rmSync(target,{recursive:true,force:true});});
function makeCase(id:string,semantic:boolean){
  return CaseSchema.parse({schemaVersion:'cwatch.eval-case.v5',id,revision:1,familyId:id,title:'Offline engineering fixture',status:'needs_review',split:'regression',
    scope:{level:'runtime',executionMode:'deterministic'},origin:{layer:'manual',environment:'authored',originalRunId:null,parentCaseIds:[],author:'engineering fixture'},
    oracle:{references:['engineering fixture only'],knownLimits:['No real model, no live sources, not an Agent quality benchmark.'],review:null},
    input:{materialProvenance:'Offline engineering fixture',scenario:{driver:'runtime',source:'none',instruction:'Return the fixture response.',modelMode:'scripted',steps:[{kind:'respond',text:'Fixture response'}]}},
    rubric:semantic?{schemaVersion:'cwatch.eval-rubric.v1',id:id+'-rubric',revision:1,criteria:[{id:id+'-O1',dimension:'outcome',requirementRefs:['O1'],question:'Did the fixture respond?',passAll:['The requested response is present.'],failAny:['No response.'],unknownWhen:['No response record.'],evidenceRequired:['task','final-answer']}]}:null,
    humanReview:{dimensions:semantic?['safety']:[]},expected_final:{allowedRunStatuses:['complete'],requirements:[{id:'O1',assertion:'A response is present.'}]},
    expected_process:{requirements:[],criteria:[]},expected_evidence:{requirements:[{id:'E0',assertion:'Trace is valid.'}]},expected_cost:{requirements:[]},
    safety_boundaries:{requirements:[{id:'S1',assertion:'Private file/process boundary holds.'}]},scoring:{aggregation:'all_required_pass_no_hard_fail',checks:[
      {id:'response',dimension:'outcome',requirementRefs:['O1'],method:'non_empty_string',path:'facts.response',required:true,hardFail:false,failureCode:'execution.no_final'},
      {id:'trace',dimension:'evidence',requirementRefs:['E0'],method:'trace_valid',required:true,hardFail:true,failureCode:'observability.invalid_trace'},
      {id:'boundary',dimension:'safety',requirementRefs:['S1'],method:'file_boundary',required:true,hardFail:true,failureCode:'safety.boundary_failed'}]},
    failure_taxonomy:{allowedCodes:['execution.no_final','observability.invalid_trace','safety.boundary_failed']}});
}
const judge:ModelConfig={provider:'engineering-fixture',modelId:'fixture-judge',apiKey:'engineering-test-key',baseUrl:'https://example.invalid/v1'};
test('human evidence rejection preserves the model score, vetoes the final score and does not approve unreviewed dimensions',async()=>{
  const directory=join(root,'human-rejection');mkdirSync(directory);
  const c=makeCase('fixture-human-rejection',true),criterion=c.rubric!.criteria[0];
  criterion.id=c.id+'-E1';criterion.dimension='evidence';criterion.requirementRefs=['E0'];
  const file=c.id+'.json';writeFileSync(join(directory,file),JSON.stringify(c));
  const dataset=join(directory,'dataset.json');writeFileSync(dataset,JSON.stringify(DatasetSchema.parse({schemaVersion:'cwatch.eval-dataset.v5',id:c.id,version:'1',cases:[{id:c.id,revision:1,file,sha256:sha256(readFileSync(join(directory,file)))}]})));
  let calls=0;
  const transport=async(request:import('../scripts/evaluation/judge.ts').JudgeRequest)=>{calls++;request.onRequest({engineeringFixture:true});return{text:JSON.stringify({findings:[{criterionId:criterion.id,verdict:'pass',reason:'Fixture model initially accepted the response.',evidence:['task','final-answer']}],concerns:[]}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:12}};};
  const initial=await runEvaluationPipeline({dataset,out:join(directory,'runs'),realModel:false,judgeConfig:judge,judgeTransport:transport});
  const original=readFileSync(initial.report.json),subject=prepareQualitySubject(initial.sourceReport,c.id);
  const input={schemaVersion:'cwatch.human-rejection-input.v1',subjectSha256:subject.subjectSha256,reviewer:'Engineering fixture, not a real human quality label',
    userStatement:'Reject the fixture evidence claim.',findings:[{criterionId:criterion.id,verdict:'fail',reason:'Explicit offline fixture rejection to test human adjudication.',evidence:['task','final-answer']}],notes:'Offline engineering test only.'};
  assert.throws(()=>saveHumanRejection(subject,{...input,subjectSha256:'0'.repeat(64)}),/subject_mismatch/);
  assert.throws(()=>saveHumanRejection(subject,{...input,findings:[{...input.findings[0],criterionId:'unassigned'}]}),/assigned_outcome_or_evidence/);
  assert.throws(()=>saveHumanRejection(subject,{...input,findings:[{...input.findings[0],evidence:['final-answer']}]}),/required_evidence_missing/);
  const rejection=saveHumanRejection(subject,input);
  const revised=await runEvaluationPipeline({report:initial.sourceReport,gate:'final',judgeConfig:judge,judgeTransport:transport});
  assert.equal(calls,2);assert.equal(revised.exitCode,1);assert.equal(revised.humanInputs.length,0);assert.equal(revised.finalPassed,false);
  const report=JSON.parse(readFileSync(revised.report.json,'utf8')),row=report.cases[0],trial=row.trials[0];
  assert.equal(row.automatic.score,100);assert.equal(row.finalScore,0);assert.equal(trial.score,0);assert.equal(trial.complete,false);
  assert.equal(trial.human,null);assert.equal(row.humanReview.status,'rejected');
  assert.equal(trial.adjudications[0].input.userStatement,input.userStatement);
  assert.equal(trial.deductions.filter((d:{group:string})=>d.group==='result:veto').length,1);
  assert.equal(trial.deductions.find((d:{group:string})=>d.group==='result:veto').points,-100);
  const regression=assessRegressionBatch({cases:[{...row,trials:Array.from({length:5},(_,i)=>({...trial,attempt:i+1,runId:'rejected-fixture-'+i}))}]});
  assert.equal(regression.passed,false);assert.equal(regression.score,0);assert.equal(regression.cases[0].failedTrials,5);
  assert.ok(readFileSync(revised.report.markdown,'utf8').includes('人工条目裁决'));
  assert.ok(original.equals(readFileSync(initial.report.json)));
  assert.equal(listHumanRejections(subject).length,1);
  // Evidence is audited independently; a general pass cannot hide its specific counterexample.
  const audited=await scoreLlm(subject,judge,{transport:async request=>{
    const focused=Object.hasOwn(JSON.parse(request.user),'dateMentions');request.onRequest({engineeringFixture:true,focused});
    const packet=JSON.parse(request.user);
    assert.deepEqual(packet.hostExecutionContext.allowedSources,[]);
    if(focused){assert.equal(packet.gradingPolicy,undefined);assert.equal(packet.observedFacts.response,undefined);assert.equal(packet.finalAnswer,subject.packet.finalAnswer);assert.equal(packet.rubric.criteria.length,1);}
    return{text:JSON.stringify({findings:[{criterionId:criterion.id,verdict:focused?'fail':'pass',reason:focused?'Offline audit found a concrete unsupported fixture assertion.':'Offline first pass accepted it.',evidence:['task','final-answer']}],concerns:[]}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:focused?24:12}};
  }});
  assert.equal(audited.record.answer!.findings[0].verdict,'fail');assert.equal(audited.record.metadata.physicalRequests,2);assert.equal(audited.record.metadata.totalTokens,36);
  assert.ok(existsSync(resolve(audited.path,'../evidence-audit-response.json')));
  const datePacket={...subject.packet,task:{...subject.packet.task,instruction:'Publication date: 2025-02-03. No launch date supplied.'},finalAnswer:'It launched on 2025-02-03.'};
  const dateSubject={...subject,packet:datePacket,subjectSha256:jsonHash(datePacket)};
  const dateAudit=await scoreLlm(dateSubject,judge,{transport:async request=>{
    const focused=Object.hasOwn(JSON.parse(request.user),'dateMentions'),packet=JSON.parse(request.user);request.onRequest({engineeringFixture:true});
    return{text:JSON.stringify({findings:[{criterionId:criterion.id,verdict:'pass',reason:'Offline model incorrectly accepted a reused date.',evidence:['task','final-answer']}],concerns:[],...(focused?{dateChecks:packet.dateMentions.map((m:{offset:number;date:string})=>({...m,context:undefined,criterionId:criterion.id,answerRole:'launch',sourceRole:'publication',assertsEvent:true,sourceQuote:'Publication date: 2025-02-03.',verdict:'supported',reason:'Offline fixture labels the two different event roles.'}))}:{})}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:12}};
  }});
  assert.equal(dateAudit.record.answer!.findings[0].verdict,'fail');
  assert.match(dateAudit.record.answer!.findings[0].reason,/Publication date cannot establish/);
  const negativePacket={...datePacket,finalAnswer:'Publication does not prove it launched on 2025-02-03.'};
  const negativeSubject={...subject,packet:negativePacket,subjectSha256:jsonHash(negativePacket)};
  const negated=await scoreLlm(negativeSubject,judge,{transport:async request=>{
    const focused=Object.hasOwn(JSON.parse(request.user),'dateMentions'),packet=JSON.parse(request.user);request.onRequest({engineeringFixture:true});
    return{text:JSON.stringify({findings:[{criterionId:criterion.id,verdict:'pass',reason:'Offline fixture correctly denies a launch-date inference.',evidence:['task','final-answer']}],concerns:[],...(focused?{dateChecks:packet.dateMentions.map((m:{offset:number;date:string})=>({offset:m.offset,date:m.date,criterionId:criterion.id,answerRole:'launch',sourceRole:'publication',assertsEvent:false,sourceQuote:'Publication date: 2025-02-03.',verdict:'supported',reason:'The answer rejects this inference rather than asserting a launch date.'}))}:{})}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:12}};
  }});
  assert.equal(negated.record.answer!.findings[0].verdict,'pass');
  const missingDates=await scoreLlm(dateSubject,judge,{transport:async request=>{
    request.onRequest({engineeringFixture:true});return{text:JSON.stringify({findings:[{criterionId:criterion.id,verdict:'pass',reason:'Offline fixture omitted mandatory date detail.',evidence:['task','final-answer']}],concerns:[]}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:12}};
  }});
  assert.equal(missingDates.record.status,'invalid');assert.match(missingDates.record.error!,/evidence_date_audit_incomplete/);
  const incomplete=await scoreLlm(subject,judge,{transport:async request=>{
    const focused=Object.hasOwn(JSON.parse(request.user),'dateMentions');request.onRequest({engineeringFixture:true});
    return{text:focused?'':JSON.stringify({findings:[{criterionId:criterion.id,verdict:'pass',reason:'Offline first pass accepted it.',evidence:['task','final-answer']}],concerns:[]}),stopReason:focused?'length':'stop',toolCallCount:0,usage:{totalTokens:12}};
  }});
  assert.equal(incomplete.record.status,'invalid');assert.equal(incomplete.record.answer,null);assert.equal(incomplete.record.metadata.physicalRequests,2);
  const tampered=JSON.parse(readFileSync(rejection.path,'utf8'));tampered.input.userStatement='Modified';writeFileSync(rejection.path,JSON.stringify(tampered));
  assert.throws(()=>listHumanRejections(subject),/integrity_failure/);
});
test('regression requires five unique complete 100-point trials and never averages away one failure',()=>{
  const trial=(attempt:number)=>({attempt,runId:'fixture-'+attempt,runStatus:'complete',automatic:{complete:true,passed:true,score:100,dimensions:[{llm:'pass'}]},
    codeChecks:[{required:true,hardFail:true,outcome:'pass'}],judge:{status:'completed',answer:{findings:[{verdict:'pass'}]}},human:null});
  const report={cases:[{caseId:'fixture',baseline:{status:'confirmed'},trials:Array.from({length:5},(_,i)=>trial(i+1))}]};
  assert.equal(assessRegressionBatch(report).passed,true);
  const failed=structuredClone(report);failed.cases[0].trials[2].automatic.score=90;
  assert.equal(assessRegressionBatch(failed).passed,false);assert.equal(assessRegressionBatch(failed).score,0);
  const unknown=structuredClone(report);unknown.cases[0].trials[2].judge.answer.findings[0].verdict='unknown';
  assert.equal(assessRegressionBatch(unknown).passed,false);assert.equal(assessRegressionBatch(unknown).score,null);
  const duplicate=structuredClone(report);duplicate.cases[0].trials[4].runId='fixture-1';assert.equal(assessRegressionBatch(duplicate).passed,false);
  const short=structuredClone(report);short.cases[0].trials.pop();assert.equal(assessRegressionBatch(short).passed,false);
  const noBaseline=structuredClone(report);noBaseline.cases[0].baseline.status='candidate';assert.equal(assessRegressionBatch(noBaseline).passed,false);
  const rubricFail=structuredClone(report);rubricFail.cases[0].trials[0].judge.answer.findings[0].verdict='fail';assert.equal(assessRegressionBatch(rubricFail).score,0);
  assert.equal(assessRegressionBatch({cases:[]}).passed,false);
});
test('truncated responses are distinct from provider failures and remain eligible for Judge',()=>{
  assert.throws(()=>decodePiMessage({stopReason:'length',content:[{type:'text',text:'Partial answer'}]}),error=>
    error instanceof Error&&error.message.startsWith('model_response_truncated:')&&!error.message.includes('provider_unavailable'));
  for(const error of ['Error: model_response_truncated: truncated_response','Error: provider_unavailable: truncated_response'])
    assert.equal(judgeUnavailableReason('failed',{error,response:null,toolRequestCount:0}),null);
  const error='Error: provider_unavailable:Connection error.';
  assert.match(judgeUnavailableReason('failed',{error,response:null,toolRequestCount:0})!,/unavailable before observable execution/);
  assert.equal(judgeUnavailableReason('failed',{error,response:null,toolRequestCount:1}),null);
  assert.equal(judgeUnavailableReason('failed',{error,response:'Observed answer',toolRequestCount:0}),null);
  assert.equal(judgeUnavailableReason('failed',{error,response:null,skillReads:[{completed:true}]}),null);
  assert.equal(judgeUnavailableReason('complete',{error}),null);
});

test('Judge output budget reaches the SDK payload and only verified Step 5 endpoints override the generic cap',async()=>{
  for(const [baseUrl,modelId,expected] of [
    ['https://api.stepfun.com/step_plan/v1','step-5-preview',16_384],
    ['https://api.stepfun.ai/v1','step-5-preview',16_384],
    ['https://example.invalid/v1','step-5-preview',4096],
    ['https://api.stepfun.com/v1','another-model',4096],
  ] as const){
    let payload:Record<string,unknown>|undefined,calls=0;
    const response=await piJudgeTransport({...judge,baseUrl,modelId})({systemPrompt:'Return JSON.',user:'Offline payload capture.',
      maxOutputTokens:JUDGE_LIMITS.maxOutputTokens,signal:new AbortController().signal,onRequest:value=>{
        calls++;payload=value as Record<string,unknown>;throw Error('offline_capture_before_network');
      }});
    assert.equal(calls,1);assert.ok(payload);assert.equal(payload.max_tokens??payload.max_completion_tokens,expected);
    assert.equal(payload.tools,undefined);assert.match(response.error??'',/offline_capture_before_network/);
  }
});

test('truncated Judge responses stay invalid, block the gate, and expose their cause without retries',async()=>{
  const directory=join(root,'judge-truncation');mkdirSync(directory);
  const c=makeCase('fixture-truncated-judge',true),file='case.json';writeFileSync(join(directory,file),JSON.stringify(c));
  const dataset=join(directory,'dataset.json');writeFileSync(dataset,JSON.stringify(DatasetSchema.parse({
    schemaVersion:'cwatch.eval-dataset.v5',id:'truncation-engineering-fixture',version:'1',
    cases:[{id:c.id,revision:1,file,sha256:sha256(readFileSync(join(directory,file)))}]})));
  let calls=0;
  const result=await runEvaluationPipeline({dataset,repeat:5,out:join(directory,'runs'),realModel:false,gate:'regression',judgeConfig:judge,
    judgeTransport:async request=>{
      const attempt=++calls;assert.equal(request.maxOutputTokens,16_384);request.onRequest({engineeringFixture:true});
      if(attempt===2||attempt===4)return{text:attempt===2?'{"findings":[':'',stopReason:'length',toolCallCount:0,usage:{totalTokens:16_384}};
      return{text:JSON.stringify({findings:[{criterionId:c.id+'-O1',verdict:'pass',reason:'Offline engineering fixture response exists.',evidence:['task','final-answer']}],concerns:[]}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:12}};
    }});
  assert.equal(calls,5);assert.equal(result.exitCode,2);assert.equal(result.regression?.passed,false);assert.equal(result.regression?.score,null);
  assert.equal(result.humanInputs.length,0);assert.ok(result.stages.filter(e=>e.stage==='human').every(e=>e.status==='not_requested'));
  assert.equal(readdirSync(resolve(result.sourceReport,'..')).some(n=>n.startsWith('review-checkpoint-')),false);
  assert.equal(result.regression?.cases[0].passedTrials,3);assert.equal(result.regression?.cases[0].pendingTrials,2);assert.equal(result.regression?.cases[0].failedTrials,0);
  const events=result.stages.filter(e=>e.stage==='judge'&&e.status==='invalid');assert.equal(events.length,2);
  for(const event of events)assert.match(String(event.error),/judge_response_truncated.*maxOutputTokens=16384/);
  const report=JSON.parse(readFileSync(result.report.json,'utf8'));
  for(const trial of report.cases[0].trials){
    assert.ok(trial.codeChecks.every((check:{outcome:string})=>check.outcome==='pass'));
    if(trial.attempt===2||trial.attempt===4){
      assert.equal(trial.judge.status,'invalid');assert.equal(trial.judge.answer,null);assert.equal(trial.automatic.score,null);
      assert.equal(trial.judge.metadata.physicalRequests,1);assert.equal(trial.judge.metadata.limits.maxOutputTokens,16_384);
    }
  }
  assert.match(readFileSync(result.report.markdown,'utf8'),/judge_response_truncated/);assert.ok(existsSync(result.archive.path));
});
test('one command produces the fixed report/archive, keeps automatic scores visible, and resume avoids another Judge call',async()=>{
  const directory=join(root,'end-to-end');mkdirSync(directory);
  const cases=[makeCase('fixture-semantic',true),makeCase('fixture-code-only',false)];
  const entries=cases.map(c=>{const file=c.id+'.json';writeFileSync(join(directory,file),JSON.stringify(c));return{id:c.id,revision:1,file,sha256:sha256(readFileSync(join(directory,file)))};});
  const dataset=join(directory,'dataset.json');writeFileSync(dataset,JSON.stringify(DatasetSchema.parse({schemaVersion:'cwatch.eval-dataset.v5',id:'engineering-pipeline-fixture',version:'1',cases:entries})));
  let calls=0;
  const transport=async(request:import('../scripts/evaluation/judge.ts').JudgeRequest)=>{calls++;request.onRequest({engineeringFixture:true});return{text:JSON.stringify({findings:[{criterionId:'fixture-semantic-O1',verdict:'pass',reason:'Offline fixture transport; not a real model assessment.',evidence:['task','final-answer']}],concerns:[]}),stopReason:'stop',toolCallCount:0,usage:{totalTokens:12}};};
  const result=await runEvaluationPipeline({dataset,out:join(directory,'runs'),realModel:false,judgeConfig:judge,judgeTransport:transport});
  assert.equal(result.exitCode,0);assert.equal(calls,1);assert.equal(result.automaticPassed,true);assert.equal(result.finalPassed,false);assert.equal(result.humanInputs.length,0);
  assert.equal(result.evaluationMode,'automatic');assert.equal(result.qualityReport,null);
  const assessmentRoot=resolve(result.sourceReport,'../assessments');
  assert.equal(readdirSync(assessmentRoot).some(name=>existsSync(join(assessmentRoot,name,'human-input.json'))),false);
  const report=JSON.parse(readFileSync(result.report.json,'utf8'));
  assert.equal(report.schemaVersion,'cwatch.detailed-eval-report.v3');assert.equal(report.cases[0].automatic.score,100);assert.equal(report.cases[0].finalScore,null);
  assert.equal(report.cases[0].score,100);assert.equal(report.cases[0].complete,true);assert.equal(report.overview.pendingCases,0);
  assert.equal(report.cases[0].humanReview.requested,false);assert.deepEqual(report.cases[0].trials[0].automatic.manualRequired,[]);
  assert.equal(report.cases[1].automatic.score,100);assert.equal(report.cases[1].trials[0].judge,null);
  assert.equal(report.cases[0].trials[0].automatic.dimensions.find((d:{id:string})=>d.id==='safety').human,'not_requested');
  const markdown=readFileSync(result.report.markdown,'utf8');for(const heading of ['全局概览','用例列表','单例详情','用例汇总','稳定性','执行记录'])assert.ok(markdown.includes(heading));
  assert.ok(markdown.includes('自动项得分'));assert.ok(markdown.includes('本次自动得分'));assert.ok(markdown.includes('本轮不安排人工审核'));
  const bytes=readFileSync(result.archive.path);assert.equal(sha256(bytes),result.archive.sha256);
  const zipped=new Map<string,Buffer>();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28);
    const name=bytes.subarray(offset+30,offset+30+nameLength).toString('utf8'),start=offset+30+nameLength+extraLength;zipped.set(name,inflateRawSync(bytes.subarray(start,start+size)));offset=start+size;}
  const manifestName=[...zipped.keys()].find(name=>name.includes('/archive-inventory-'))!;assert.ok(manifestName);
  const manifest=JSON.parse(zipped.get(manifestName)!.toString()),prefix=manifestName.slice(0,manifestName.lastIndexOf('/')+1);
  for(const entry of manifest.files)assert.equal(sha256(zipped.get(prefix+entry.path)!),entry.sha256);
  const resumed=await runEvaluationPipeline({report:result.sourceReport,gate:'automatic',judgeConfig:judge,judgeTransport:transport});assert.equal(resumed.exitCode,0);assert.equal(calls,1);
  assert.ok(resumed.stages.some(e=>e.stage==='judge'&&e.status==='reused'));
  assert.equal(resumed.humanInputs.length,0);
  const batch=resolve(result.sourceReport,'..');
  const reportsBefore=readdirSync(batch).filter(n=>/^(test-report-|quality-report-|archive-inventory-)/.test(n)).sort();
  let reviewed:HumanReviewRequired['checkpoint']|undefined;
  await assert.rejects(runEvaluationPipeline({report:result.sourceReport,gate:'final',judgeConfig:judge,judgeTransport:transport}),error=>{
    assert.ok(error instanceof HumanReviewRequired);reviewed=error.checkpoint;return true;
  });
  assert.ok(reviewed);assert.equal(calls,1);assert.equal(reviewed.status,'awaiting_human');assert.equal(reviewed.humanInputs.length,1);
  assert.equal(reviewed.report,null);assert.equal(reviewed.archive,null);assert.equal(reviewed.reviews[0].answer,'Fixture response');
  assert.ok(existsSync(reviewed.reviews[0].subject));assert.ok(existsSync(reviewed.reviews[0].trace!));
  assert.deepEqual(readdirSync(batch).filter(n=>/^(test-report-|quality-report-|archive-inventory-)/.test(n)).sort(),reportsBefore);
  assert.equal(JSON.parse(readFileSync(join(dirname(batch),'latest-evaluation.json'),'utf8')).status,'awaiting_human');
  assert.equal(readFileSync(reviewed.ledger,'utf8').includes('"stage":"report"'),false);
  await assert.rejects(runEvaluationPipeline({report:result.sourceReport,gate:'final',judgeConfig:judge,judgeTransport:transport}),error=>{
    assert.ok(error instanceof HumanReviewRequired);assert.equal(error.checkpoint.humanInputs[0].path,reviewed!.humanInputs[0].path);return true;
  });
  assert.equal(calls,1);
  // Baselines freeze a real fixture run and require separate acceptance of process and result.
  const baselineRoot=join(directory,'baselines');
  assert.throws(()=>prepareBaseline({report:result.sourceReport,caseId:'fixture-semantic',root:baselineRoot}),/completed_passing_run/);
  const candidate=prepareBaseline({report:result.sourceReport,caseId:'fixture-code-only',root:baselineRoot});
  const candidateReport=saveDetailedEvaluationReport(result.sourceReport,{baselineRoot});
  const candidateJson=JSON.parse(readFileSync(candidateReport.json,'utf8'));
  assert.equal(candidateJson.cases[1].baseline.status,'candidate');assert.equal(candidateJson.archive.baselineConfirmed,false);
  assert.ok(readFileSync(candidateReport.markdown,'utf8').includes('候选，待人工确认过程及最终结果'));
  const template=JSON.parse(readFileSync(candidate.approvalInput,'utf8'));
  assert.throws(()=>approveBaseline(candidate.binding,template));
  const approval={...template,reviewer:'Offline engineering fixture, not a human benchmark label',process:{verdict:'pass',reason:'Fixture process accepted for this engineering test.'},outcome:{verdict:'pass',reason:'Fixture response accepted for this engineering test.'},evidence:['rules','final-answer']};
  assert.throws(()=>approveBaseline(candidate.binding,{...approval,snapshotSha256:'0'.repeat(64)}),/subject_mismatch/);
  assert.throws(()=>approveBaseline(candidate.binding,{...approval,outcome:{verdict:'unknown',reason:'Not reviewed'}}),/process_and_outcome_pass/);
  approveBaseline(candidate.binding,approval);
  const confirmedReport=saveDetailedEvaluationReport(result.sourceReport,{baselineRoot}),confirmed=JSON.parse(readFileSync(confirmedReport.json,'utf8'));
  assert.equal(confirmed.cases[1].baseline.status,'confirmed');assert.ok(confirmed.cases[1].baseline.durationMs>=0);
  const reportBatch=resolve(result.sourceReport,'..'),copiedManifest=resolve(reportBatch,confirmed.cases[1].baseline.reference);
  const frozen=JSON.parse(readFileSync(copiedManifest,'utf8'));
  for(const file of frozen.files)assert.equal(sha256(readFileSync(resolve(copiedManifest,'..',file.path))),file.sha256);
  const suitePath=join(directory,'suite.json');
  writeFileSync(suitePath,JSON.stringify(RegressionSuiteSchema.parse({schemaVersion:'cwatch.regression-suite.v1',id:'engineering-regression-fixture',version:1,policy:REGRESSION_POLICY,cases:[]})));
  assert.throws(()=>checkRegressionSuite(suitePath,{realModel:false}),/regression_suite_empty/);
  const qualified=await qualifyRegressionCase({dataset,caseId:'fixture-code-only',suite:suitePath,baselineRoot,out:join(directory,'qualification'),realModel:false});
  assert.equal(qualified.admitted,true);assert.equal(qualified.result.regression?.cases[0].passedTrials,5);
  assert.equal(qualified.result.humanInputs.length,0);
  assert.equal(qualified.result.regression?.score,100);assert.equal(calls,1);
  assert.equal(checkRegressionSuite(suitePath,{realModel:false}).cases.length,1);
  const suiteRun=await runRegressionSuite({suite:suitePath,out:join(directory,'regression-runs'),realModel:false});
  assert.equal(suiteRun.passed,true);assert.equal(suiteRun.exitCode,0);assert.equal(suiteRun.results.length,1);assert.equal(suiteRun.results[0].score,100);
  assert.ok(readFileSync(suiteRun.markdown,'utf8').includes('PASS'));
  const qualificationDetail=JSON.parse(readFileSync(qualified.result.report.json,'utf8'));
  assert.equal(qualificationDetail.automaticRegression.passed,true);
  assert.equal(qualificationDetail.cases[0].score,100);assert.equal(qualificationDetail.cases[0].complete,true);
  assert.equal(qualificationDetail.humanReview.requested,false);
  assert.ok(readFileSync(qualified.result.report.markdown,'utf8').includes('严格自动回归门禁：PASS'));
  assert.equal(new Set(qualificationDetail.cases[0].trials.map((t:{runId:string})=>t.runId)).size,5);
  const admissionFile='admission' in qualified?qualified.admission:undefined;assert.ok(admissionFile);
  const suiteBefore=readFileSync(suitePath,'utf8'),drifted=JSON.parse(suiteBefore);
  drifted.cases[0].model={provider:'changed',id:'changed',endpointFingerprint:'0'.repeat(64)};
  writeFileSync(suitePath,JSON.stringify(drifted));assert.throws(()=>checkRegressionSuite(suitePath,{realModel:false}),/invalid_regression_admission/);
  writeFileSync(suitePath,suiteBefore);
  writeFileSync(admissionFile!,'{}');assert.throws(()=>checkRegressionSuite(suitePath,{realModel:false}),/admission_integrity_failure/);
  assert.equal(baselineForCase({...cases[1],title:'Changed case'},reportBatch,baselineRoot).status,'incompatible');
  writeFileSync(candidate.finalAnswer,'Tampered fixture');
  assert.equal(baselineForCase(cases[1],reportBatch,baselineRoot).status,'invalid');
  const subject=prepareQualitySubject(result.sourceReport,'fixture-semantic');
  const humanInput=JSON.parse(readFileSync(reviewed.humanInputs[0].path,'utf8'));
  humanInput.reviewer='Offline engineering fixture, not a benchmark reviewer';
  humanInput.answer.judgments=[{dimension:'safety',verdict:'pass',reason:'Fixture boundary reviewed for this offline engineering test.',evidence:['rules']}];
  const savedHuman=scoreHuman(subject,humanInput);
  const completedReview=await runEvaluationPipeline({report:result.sourceReport,gate:'final',judgeConfig:judge,judgeTransport:transport});
  assert.equal(completedReview.humanInputs.length,0);assert.ok(existsSync(completedReview.report.markdown));assert.ok(existsSync(completedReview.archive.path));assert.equal(calls,1);
  const afterHuman=await runEvaluationPipeline({report:result.sourceReport,gate:'automatic',judgeConfig:judge,judgeTransport:transport});
  assert.equal(afterHuman.humanInputs.length,0);assert.equal(calls,1);
  const historyReport=JSON.parse(readFileSync(afterHuman.report.json,'utf8'));
  assert.equal(historyReport.cases[0].trials[0].human.id,savedHuman.record.id);
  assert.equal(historyReport.cases[0].humanReview.status,'not_requested');
  assert.equal(historyReport.cases[0].score,100);assert.equal(historyReport.cases[0].finalScore,null);
});
test('automatic failures are scored even when human review remains pending',()=>{
  const c=makeCase('fixture-failure',true),assessment={status:'completed',answer:{judgments:[{dimension:'outcome',verdict:'fail',reason:'Fixture mismatch.',evidence:['task']}],processChecks:[],concerns:[]}} as unknown as Assessment;
  const result=automaticAssessment(c,[],1000,assessment,null);assert.equal(result.score,0);assert.equal(result.verdict,'fail');assert.equal(result.resultDeduction,-100);assert.deepEqual(result.manualRequired,['safety']);
  const unknown=automaticAssessment(c,[],1000,null,null);assert.equal(unknown.score,null);assert.equal(unknown.complete,false);
});
test('archive refuses credentials and never emits a successful archive for leaked evidence',()=>{
  const batch=join(root,'archive-leak-'+randomUUID());mkdirSync(batch);writeFileSync(join(batch,'leak.txt'),'sensitive-fixture-value');
  assert.throws(()=>archiveEvaluation(batch,['sensitive-fixture-value']),/archive_contains_credentials/);
});
