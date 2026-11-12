import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from '../scripts/evaluation/langfuse-client.ts';
import { CaseSchema, DatasetSchema } from '../scripts/evaluation/contracts.ts';
import { runBatch } from '../scripts/evaluation/runner.ts';
import { sha256, within } from '../scripts/evaluation/dataset.ts';
import { prepareQualitySubject, listAssessments } from '../scripts/evaluation/quality.ts';
import { prepareLangfuseEvaluation, syncLangfuseEvaluation, LangfuseBindingSchema,hostReviewPacketMatches } from '../scripts/evaluation/langfuse-eval.ts';
import { saveDelegatedReview, assessDelegatedReview } from '../scripts/evaluation/delegated-review.ts';
import { parseReviewComment, resolveHumanReview, resolveHumanRejections, resolveNativeReview, ReviewPending, type PlatformScore, type NativeSlot } from '../scripts/evaluation/langfuse-review.ts';
import { ensureDimensionJudges, ensureDimensionJudge, scenarioJudgePacket, scenarioForCase } from '../scripts/evaluation/langfuse-judges.ts';

mkdirSync(resolve('artifacts'),{recursive:true});
const root=mkdtempSync(join(resolve('artifacts'),'langfuse-bridge-engineering-'));
const config={baseUrl:'http://localhost:3000',publicKey:'pk-offline-fixture',secretKey:'sk-offline-fixture',environment:'engineering-fixture',timeoutMs:1000};
let report:string,subject:ReturnType<typeof prepareQualitySubject>;
const target={projectId:'fixture-project',traceId:'fixture-trace',observationId:'fixture-observation'};
before(async()=>{
  process.env.LANGFUSE_ENABLED='false';
  const c=CaseSchema.parse({schemaVersion:'cwatch.eval-case.v5',id:'fixture-bridge',revision:1,familyId:'fixture-bridge',title:'Offline bridge engineering fixture',status:'needs_review',split:'regression',
    scope:{level:'runtime',executionMode:'deterministic'},origin:{layer:'manual',environment:'authored',originalRunId:null,parentCaseIds:[],author:'Offline engineering fixture'},
    oracle:{references:['offline fixture'],knownLimits:['No real model or human annotation.'],review:null},input:{materialProvenance:'offline fixture',scenario:{driver:'runtime',source:'none',instruction:'Return the fixture response.',modelMode:'scripted',steps:[{kind:'respond',text:'Fixture response'}]}},
    rubric:{schemaVersion:'cwatch.eval-rubric.v1',id:'fixture-rubric',revision:1,criteria:[
      {id:'O1',dimension:'outcome',requirementRefs:['O1'],question:'Fixture outcome?',passAll:['Fixture'],failAny:['Fixture'],unknownWhen:['Missing'],evidenceRequired:['task','final-answer']},
      {id:'T1',dimension:'trajectory',requirementRefs:['T1'],processCriterionId:'T1',question:'Fixture process?',passAll:['Fixture'],failAny:['Fixture'],unknownWhen:['Missing'],evidenceRequired:['task','final-answer']},
      {id:'E1',dimension:'evidence',requirementRefs:['E0'],question:'Fixture evidence?',passAll:['Fixture'],failAny:['Fixture'],unknownWhen:['Missing'],evidenceRequired:['task','final-answer']}]},
    humanReview:{dimensions:['trajectory','safety']},expected_final:{allowedRunStatuses:['complete'],requirements:[{id:'O1',assertion:'Fixture response'}]},
    expected_process:{requirements:[{id:'T1',assertion:'Fixture process'}],criteria:[{id:'T1',item:'step_adherence',unitId:'fixture-step',requirementRefs:['T1'],expectation:'Offline fixture criterion'}]},
    expected_evidence:{requirements:[{id:'E0',assertion:'Valid trace'}]},expected_cost:{requirements:[]},safety_boundaries:{requirements:[{id:'S1',assertion:'No boundary violation'}]},
    scoring:{aggregation:'all_required_pass_no_hard_fail',checks:[{id:'response',dimension:'outcome',requirementRefs:['O1'],method:'non_empty_string',path:'facts.response',required:true,hardFail:false,failureCode:'execution.no_final'},
      {id:'trace',dimension:'evidence',requirementRefs:['E0'],method:'trace_valid',required:true,hardFail:true,failureCode:'observability.invalid_trace'},
      {id:'boundary',dimension:'safety',requirementRefs:['S1'],method:'file_boundary',required:true,hardFail:true,failureCode:'safety.boundary_failed'}]},failure_taxonomy:{allowedCodes:['execution.no_final','observability.invalid_trace','safety.boundary_failed']}});
  const file=join(root,'case.json');writeFileSync(file,JSON.stringify(c));const dataset=join(root,'dataset.json');
  writeFileSync(dataset,JSON.stringify(DatasetSchema.parse({schemaVersion:'cwatch.eval-dataset.v5',id:'fixture-bridge',version:'1',cases:[{id:c.id,revision:1,file:'case.json',sha256:sha256(readFileSync(file))}]})));
  report=(await runBatch({dataset,out:join(root,'runs'),realModel:false})).path;subject=prepareQualitySubject(report,c.id);
});
after(()=>{const absolute=realpathSync(root),allowed=realpathSync(resolve('artifacts'));assert(absolute!==allowed&&within(allowed,absolute));rmSync(absolute,{recursive:true,force:true});});
const score=(name:string,source='EVAL'):PlatformScore=>({id:'fixture-'+name,projectId:target.projectId,name,source,value:'pass',timestamp:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',
  subject:{kind:'observation',id:target.observationId,traceId:target.traceId},comment:JSON.stringify({criterionId:name,reason:'Offline fixture finding',evidence:['task','final-answer']}),metadata:{evaluator_id:name,evaluator_version_id:'v1'}});
const nativeSlots:NativeSlot[]=['O1','T1','E1'].map(name=>({criterionId:name,evaluatorId:name,versionId:'v1',name,role:'primary'}));
nativeSlots.push({criterionId:'E1',evaluatorId:'E1-audit',versionId:'v1',name:'E1-audit',role:'evidence_audit'});
function nativeRows(){return nativeSlots.map(slot=>{const value=score(slot.name);value.comment=JSON.stringify({criterionId:slot.criterionId,reason:'Offline fixture finding',evidence:['task','final-answer'],...(slot.role==='evidence_audit'?{dateChecks:[]}:{})});return value;});}
test('review comments require actual allowed evidence and a nonempty human reason',()=>{
  assert.deepEqual(parseReviewComment('Observed fixture output [task] [final-answer]',new Set(['task','final-answer'])),{reason:'Observed fixture output',evidence:['task','final-answer']});
  assert.throws(()=>parseReviewComment('pass',new Set(['task'])),ReviewPending);
  assert.throws(()=>parseReviewComment('Claim [trace:999]',new Set(['task'])),ReviewPending);
  assert.throws(()=>parseReviewComment('[task]',new Set(['task'])),ReviewPending);
});
test('platform LLM import pins source, project, target and evaluator version; requires independent audit',()=>{
  const rows=nativeRows();assert.equal(resolveNativeReview(subject,target,nativeSlots,rows).answer.findings.length,3);
  for(const mutate of [(s:PlatformScore)=>{s.source='API';},(s:PlatformScore)=>{s.projectId='other';},(s:PlatformScore)=>{s.subject!.id='other';},(s:PlatformScore)=>{s.metadata!.evaluator_version_id='v2';}]){
    const changed=structuredClone(rows);mutate(changed[0]);assert.throws(()=>resolveNativeReview(subject,target,nativeSlots,changed),ReviewPending);
  }
  assert.throws(()=>resolveNativeReview(subject,target,nativeSlots.filter(slot=>slot.role==='primary'),rows),/independent_evidence_audit_required/);
  const failed=structuredClone(rows);failed[3].value='fail';assert.equal(resolveNativeReview(subject,target,nativeSlots,failed).answer.findings.find(f=>f.criterionId==='E1')!.verdict,'fail');
  const invalid=structuredClone(rows);invalid[0].comment='pass';assert.throws(()=>resolveNativeReview(subject,target,nativeSlots,invalid));
});
function sharedSlots(observationId=target.observationId,auditId='fixture-audit-input'):NativeSlot[]{
  const common={contract:'dimension' as const,scenario:'activation' as const,versionId:'v1'};
  return [...(['outcome','trajectory','evidence'] as const).map(dimension=>({...common,dimension,evaluatorId:'shared-'+dimension,name:'cwatch.judge.'+dimension,role:'primary' as const,observationId})),
    {...common,dimension:'evidence',evaluatorId:'shared-evidence',name:'cwatch.judge.evidence',role:'evidence_audit',observationId:auditId}];
}
function sharedRows(slots:NativeSlot[],traceId=target.traceId,process:'pass'|'fail'='pass'):PlatformScore[]{
  return slots.map(slot=>{
    const findings=subject.packet.rubric!.criteria.filter(c=>c.dimension===slot.dimension).map(c=>({
      criterionId:c.id,verdict:c.dimension==='trajectory'?process:'pass',reason:'Offline shared scenario fixture',evidence:['task','final-answer']}));
    return{...score(slot.name),id:'shared-'+slot.dimension+'-'+slot.role,value:findings.some(f=>f.verdict==='fail')?'fail':'pass',subject:{kind:'observation',id:slot.observationId!,traceId},
      metadata:{evaluator_id:slot.evaluatorId,evaluator_version_id:slot.versionId},comment:JSON.stringify({subjectSha256:subject.subjectSha256,scenario:slot.scenario,dimension:slot.dimension,role:slot.role,findings,concerns:[],...(slot.role==='evidence_audit'?{dateChecks:[]}:{})})};
  });
}
test('three dimension Judges stay separate across case scenarios; only the evidence Judge also audits independently',()=>{
  const slots=sharedSlots(),rows=sharedRows(slots,target.traceId,'fail');
  const result=resolveNativeReview(subject,target,slots,rows);assert.equal(result.answer.processChecks[0].verdict,'fail');assert.equal(result.scores.length,4);
  const packet=scenarioJudgePacket(subject,'activation','evidence_audit');assert.equal(packet.subjectSha256,subject.subjectSha256);assert.deepEqual(packet.rubric!.criteria.map(c=>c.id),['E1']);
  assert.equal(packet.judgeRole,'evidence_audit');assert(!('llm' in packet));assert(!('human' in packet));
  assert.throws(()=>resolveNativeReview(subject,target,slots,[...rows.slice(0,-1),{...rows.at(-1)!,subject:rows[0].subject}]),ReviewPending);
  const mismatch=structuredClone(rows),explanation=JSON.parse(mismatch[0].comment!);explanation.subjectSha256='wrong';mismatch[0].comment=JSON.stringify(explanation);
  assert.throws(()=>resolveNativeReview(subject,target,slots,mismatch),/subject_or_role_mismatch/);
  assert.throws(()=>resolveNativeReview(subject,target,[slots[0]],rows),/dimension_judge_bindings_invalid/);
  assert.throws(()=>resolveNativeReview(subject,target,slots,rows.map(row=>({...row,metadata:{...row.metadata,evaluator_version_id:'v0'}}))),ReviewPending);
  const inconsistent=structuredClone(rows);inconsistent[1].value='pass';assert.throws(()=>resolveNativeReview(subject,target,slots,inconsistent),/score_summary_mismatch/);
  const crossed=structuredClone(rows),output=JSON.parse(crossed[0].comment!);output.findings.push(JSON.parse(rows[1].comment!).findings[0]);crossed[0].comment=JSON.stringify(output);
  assert.throws(()=>resolveNativeReview(subject,target,slots,crossed),/findings_must_cover_exactly/);
  for(const scenario of ['activation','core_logic','resilience','artifact_quality'] as const){
    const bound=slots.map(slot=>({...slot,scenario})),scores=rows.map(row=>{const content=JSON.parse(row.comment!);content.scenario=scenario;return{...row,comment:JSON.stringify(content)};});
    assert.equal(resolveNativeReview(subject,target,bound,scores).answer.findings.length,3);
    assert.equal(new Set(bound.map(slot=>slot.evaluatorId)).size,3);
  }
});

test('primary trajectory retry requires explicit same-execution provenance; ordinary retargeting stays invalid',()=>{
  const slots=sharedSlots(),rows=sharedRows(slots),slot=slots.find(s=>s.dimension==='trajectory')!,row=rows.find(r=>r.name===slot.name)!;
  slot.observationId='host-review-input';row.subject!.id=slot.observationId;
  assert.throws(()=>resolveNativeReview(subject,target,slots,rows),/role_targets_invalid/);
  slot.reviewInput={kind:'host_review_retry',rootObservationId:target.observationId,subjectSha256:subject.subjectSha256,packetSha256:'1'.repeat(64)};
  assert.equal(resolveNativeReview(subject,target,slots,rows).answer.findings.length,3);
  slot.reviewInput.subjectSha256='0'.repeat(64);assert.throws(()=>resolveNativeReview(subject,target,slots,rows),/role_targets_invalid/);
  const packet=JSON.parse(JSON.stringify({...scenarioJudgePacket(subject,'activation','primary'),evaluationOutputContract:{reminder:'Output formatting only'}}));
  assert.equal(hostReviewPacketMatches(subject,'activation',packet),true);
  packet.task.instruction='A different task';assert.equal(hostReviewPacketMatches(subject,'activation',packet),false);
});
test('three stable result/process/evidence Judges are reused; prompt updates keep IDs and normal preparation preserves UI edits',async()=>{
  const variables=['JUDGE_MODEL_PROVIDER','JUDGE_MODEL_ID','JUDGE_API_KEY','JUDGE_BASE_URL'] as const;
  const previous=Object.fromEntries(variables.map(name=>[name,process.env[name]]));
  Object.assign(process.env,{JUDGE_MODEL_PROVIDER:'offline-fixture',JUDGE_MODEL_ID:'fixture-judge',JUDGE_API_KEY:'never-send-judge-key',JUDGE_BASE_URL:'https://example.invalid/v1'});
  const stored:Array<Record<string,unknown>>=[];let creates=0,updates=0;
  const client=new LangfuseClient(config,async(input,init)=>{
    const url=new URL(String(input)),body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;
    assert(!String(init?.body??'').includes('never-send-judge-key'));
    if(url.pathname==='/api/public/v2/evaluators'&&!body){assert(!url.searchParams.has('page'));return Response.json({data:stored,meta:{cursor:null}});}
    if(url.pathname==='/api/public/v2/evaluators'&&body){creates++;const value={...body,id:'shared-'+creates,version:1,versionId:'version-1-'+creates};stored.push(value);return Response.json(value);}
    const value=stored.find(row=>url.pathname==='/api/public/v2/evaluators/'+row.id);assert(value);
    if(init?.method==='PATCH'){updates++;Object.assign(value,body,{version:Number(value.version)+1,versionId:'updated-'+updates});}
    return Response.json(value);
  });
  try{
    const first=await ensureDimensionJudges(client);assert.equal(creates,3);assert.equal(new Set(first.map(row=>row.id)).size,3);
    assert.equal(new Set(first.map(row=>JSON.stringify(row.model))).size,1);
    const again=await ensureDimensionJudges(client);assert.deepEqual(again.map(row=>row.id),first.map(row=>row.id));assert.equal(creates,3);assert.equal(updates,0);
    stored[0].prompt='User-edited scenario instructions\n{{packet}}';stored[0].version=2;stored[0].versionId='ui-edited-v2';
    const edited=await ensureDimensionJudge(client,'outcome');assert.equal(edited.versionId,'ui-edited-v2');assert.equal(updates,0);
    await ensureDimensionJudges(client,{updatePrompts:true});assert.equal(updates,1);assert.equal(creates,3);
    await ensureDimensionJudges(client,{updatePrompts:true});assert.equal(updates,1);
    assert.deepEqual(stored.map(row=>row.id),first.map(row=>row.id));
    assert.equal(scenarioForCase('core-008'),'core_logic');assert.equal(scenarioForCase('custom-case','resilience'),'resilience');assert.equal(scenarioForCase('custom-case'),undefined);
  }finally{for(const name of variables){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
});
test('human labels must be completed annotations by one real author, never API-generated labels',()=>{
  const slots=[{kind:'process' as const,criterionId:'T1',name:'human-process',configId:'cfg-p'},{kind:'safety' as const,requirementId:'S1',name:'human-safety',configId:'cfg-s'}];
  const traceRef=subject.packet.allowedEvidenceRefs.find(ref=>ref.startsWith('trace:'))!;
  const rows=slots.map(slot=>({...score(slot.name,'ANNOTATION'),queueId:'q',configId:slot.configId,authorUserId:'real-fixture-author',comment:'Offline annotation fixture [task] [final-answer] ['+traceRef+']'}));
  assert.equal(resolveHumanReview(subject,target,{id:'q',completed:true},slots,rows).input.answer.processChecks.length,1);
  assert.throws(()=>resolveHumanReview(subject,target,{id:'q',completed:false},slots,rows),ReviewPending);
  for(const mutate of [(s:PlatformScore)=>{s.source='API';},(s:PlatformScore)=>{s.queueId='other';},(s:PlatformScore)=>{s.authorUserId=null;},(s:PlatformScore)=>{s.subject!.traceId='other';}]){
    const changed=structuredClone(rows);mutate(changed[0]);assert.throws(()=>resolveHumanReview(subject,target,{id:'q',completed:true},slots,changed),ReviewPending);
  }
  assert.throws(()=>resolveHumanReview(subject,target,{id:'q',completed:true},slots,[...rows,{...rows[0],id:'another',authorUserId:'another-human'}]),ReviewPending);
});
test('HTTP client paginates scores, rejects partial writes and does not leak credentials',async()=>{
  const seen:string[]=[];
  const client=new LangfuseClient(config,async input=>{const url=new URL(String(input));seen.push(url.searchParams.get('cursor')??'first');return Response.json({data:[{fixture:true}],meta:{cursor:seen.length===1?'next':null}});});
  assert.equal((await client.scores('t')).length,2);assert.deepEqual(seen,['first','next']);
  const bad=new LangfuseClient(config,async()=>Response.json({errors:[{message:config.secretKey}]}));await assert.rejects(()=>bad.writeScores([{}]),/partial_failure/);
  const error=new LangfuseClient(config,async()=>Response.json({secret:config.secretKey},{status:401}));await assert.rejects(()=>error.request('/api/public/projects'),message=>message instanceof Error&&!message.message.includes(config.secretKey));
});
test('optional human evidence veto requires an explicit authenticated rejection; a non-rejection cannot replace a Judge',()=>{
  const slot={criterionId:'E1',name:'human-rejection',configId:'cfg-reject'};
  const row={...score(slot.name,'ANNOTATION'),queueId:'q-reject',configId:slot.configId,authorUserId:'fixture-human',value:'reject',comment:'Concrete offline counterexample [task] [final-answer]'};
  const rejected=resolveHumanRejections(subject,target,{id:'q-reject',completed:true},[slot],[row]);assert.equal(rejected.length,1);assert.equal(rejected[0].input.findings[0].verdict,'fail');
  assert.equal(rejected[0].input.userStatement,row.comment);
  assert.deepEqual(resolveHumanRejections(subject,target,{id:'q-reject',completed:false},[slot],[row]),[]);
  assert.deepEqual(resolveHumanRejections(subject,target,{id:'q-reject',completed:true},[slot],[{...row,value:'no_rejection'}]),[]);
  assert.deepEqual(resolveHumanRejections(subject,target,{id:'q-reject',completed:true},[slot],[{...row,source:'API'}]),[]);
  assert.throws(()=>resolveHumanRejections(subject,target,{id:'q-reject',completed:true},[slot],[{...row,comment:'Reject without evidence'}]),ReviewPending);
});
test('AI delegate review stays separate from human annotations and cannot approve a baseline or bypass a missing Judge',()=>{
  const before=listAssessments(subject).filter(r=>r.kind==='human').length,trace=subject.packet.allowedEvidenceRefs.find(ref=>ref.startsWith('trace:'))!;
  const evidence=['task','rules','final-answer',trace],input={schemaVersion:'cwatch.ai-delegated-review.v1',subjectSha256:subject.subjectSha256,
    reviewer:{kind:'ai_delegate',name:'Offline engineering fixture',authorization:'Explicit fixture authorization'},humanConfirmed:false,baselineConfirmed:false,
    audit:{verdict:'pass',reason:'Fixture provenance check',evidence,notes:[]},assignedReview:{judgments:[{dimension:'trajectory',verdict:'pass',reason:'Fixture process',evidence},{dimension:'safety',verdict:'pass',reason:'Fixture safety',evidence}],processChecks:[{criterionId:'T1',verdict:'pass',reason:'Fixture process',evidence}],findings:[],concerns:[]}};
  assert.equal(saveDelegatedReview(subject,input).path,saveDelegatedReview(subject,input).path);
  const assessed=assessDelegatedReview(subject,input);assert.equal(assessed.humanConfirmed,false);assert.equal(assessed.baselineConfirmed,false);assert.equal(assessed.score,null);
  assert.equal(listAssessments(subject).filter(r=>r.kind==='human').length,before);
  assert.throws(()=>saveDelegatedReview(subject,{...input,humanConfirmed:true}));
  assert.throws(()=>saveDelegatedReview(subject,{...input,baselineConfirmed:true}));
  assert.throws(()=>saveDelegatedReview(subject,{...input,subjectSha256:'0'.repeat(64)}),/subject_mismatch/);
});
test('full bridge preserves deductions: incomplete human work has no final score; one agreed process failure gives 90 and sync is idempotent',async()=>{
  const configs:Array<{id:string;name:string;dataType:string;isArchived:boolean;categories:unknown[]}>[]=[],queues:Array<{id:string;name:string;scoreConfigIds:string[]}>=[];
  const items:Array<{id:string;objectId:string;objectType:string;status:string}>=[],written:unknown[][]=[];
  let packet:unknown,observationId='',traceId='',uploadCount=0;
  const remote:unknown[]=[];
  const client=new LangfuseClient(config,async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    if(path==='/api/public/projects')return Response.json({data:[{id:'fixture-project'}]});
    if(path==='/api/public/otel/v1/traces'){
      uploadCount++;const spans=body.resourceSpans[0].scopeSpans[0].spans;const root=spans.find((s:{parentSpanId?:string})=>!s.parentSpanId);observationId=root.spanId;traceId=root.traceId;packet=root.attributes.find((a:{key:string})=>a.key==='langfuse.observation.metadata.evalPacket').value.stringValue;
      for(const span of spans){
        const attributes=new Map(span.attributes.map((a:{key:string;value:{stringValue:string}})=>[a.key,a.value.stringValue]));
        assert.equal(attributes.get('langfuse.experiment.id'),'11111111-1111-4111-8111-111111111111');assert.equal(attributes.get('langfuse.experiment.item.root_observation_id'),root.spanId);
        if(span===root)assert.equal(attributes.get('langfuse.observation.metadata.evalJudgeDimensions'),'|outcome|trajectory|evidence|');
        if(span.name==='eval.evidence_audit_input')assert.equal(attributes.get('langfuse.observation.metadata.evalJudgeDimensions'),'|evidence|');
      }
      return Response.json({});
    }
    if(path==='/api/public/v2/observations')return Response.json({data:[{id:observationId,traceId,metadata:{evalPacket:packet}}]});
    if(path==='/api/public/scores'){written.push(body);return Response.json({successes:body.map((s:{id:string})=>({id:s.id})),errors:[]});}
    if(path==='/api/public/v3/scores')return Response.json({data:remote,meta:{cursor:null}});
    if(path==='/api/public/score-configs'){if(body){const value={...body,id:'config-'+configs.length,isArchived:false};configs.push(value);return Response.json(value);}return Response.json({data:configs});}
    if(path==='/api/public/annotation-queues'){if(body){const value={...body,id:'fixture-q'};queues.push(value);return Response.json(value);}return Response.json({data:queues});}
    if(path==='/api/public/annotation-queues/fixture-q/items'){if(body){const value={...body,id:'fixture-item',status:'PENDING'};items.push(value);return Response.json(value);}return Response.json({data:items});}
    if(path==='/api/public/annotation-queues/fixture-q/items/fixture-item')return Response.json(items[0]);
    throw Error('Unexpected offline API '+path);
  },new Redactor([config.secretKey]));
  const prepared=await prepareLangfuseEvaluation(client,{report,caseId:'fixture-bridge',scenario:'activation',experiment:{id:'11111111-1111-4111-8111-111111111111',name:'fixture-experiment',datasetId:'fixture-dataset',itemId:'fixture-item'}});
  const binding=LangfuseBindingSchema.parse(JSON.parse(readFileSync(prepared.path,'utf8')));assert(binding.auditObservationId);
  binding.native=sharedSlots(binding.observationId,binding.auditObservationId);writeFileSync(prepared.path,JSON.stringify(binding));
  remote.push(...sharedRows(binding.native,traceId,'fail'));
  const pending=await syncLangfuseEvaluation(client,prepared.path,{archive:false});assert.equal(pending.final.score,null);assert.equal(pending.status,'awaiting_review');
  assert(!written.flat().some(row=>(row as {name:string}).name==='final.total'));
  const traceRef=subject.packet.allowedEvidenceRefs.find(ref=>ref.startsWith('trace:'))!;
  for(const slot of binding.humanSlots)remote.push({...score(slot.name,'ANNOTATION'),configId:slot.configId,queueId:'fixture-q',authorUserId:'real-offline-human',value:slot.kind==='process'?'fail':'pass',
    subject:{kind:'observation',id:observationId,traceId},comment:'Offline engineering annotation [task] [final-answer] ['+traceRef+']'});
  items[0].status='COMPLETED';
  const done=await syncLangfuseEvaluation(client,prepared.path,{archive:false});assert.equal(done.final.score,90);assert.equal(done.final.processDeduction,-10);assert.equal(done.final.passed,true);
  assert.equal(done.final.deductions.filter(d=>d.category==='process').length,1);
  const before=listAssessments(subject).length,writes=written.length;
  await syncLangfuseEvaluation(client,prepared.path,{archive:false});assert.equal(listAssessments(subject).length,before);assert.equal(written.length,writes);
  await prepareLangfuseEvaluation(client,{report,caseId:'fixture-bridge'});assert.equal(uploadCount,1);assert.equal(queues.length,1);assert.equal(items.length,1);
  // Editing/reopening a completed queue cannot leave the old human approval effective.
  items[0].status='PENDING';const reopened=await syncLangfuseEvaluation(client,prepared.path,{archive:false});assert.equal(reopened.final.score,null);assert.equal(reopened.final.complete,false);
  const totals=written.at(-1) as Array<{name:string;value:unknown}>;assert.equal(totals.find(row=>row.name==='final.score_available')!.value,0);
  items[0].status='COMPLETED';(remote[0] as PlatformScore).comment='Invalid unstructured fixture verdict';
  const invalid=await syncLangfuseEvaluation(client,prepared.path,{archive:false});assert.equal(invalid.automatic.score,null);assert.equal(invalid.final.score,null);
  const count=listAssessments(subject).length,writeCount=written.length;
  remote.push({...score('automatic.status','API'),subject:{kind:'observation',id:observationId,traceId}});
  await syncLangfuseEvaluation(client,prepared.path,{archive:false});assert.equal(listAssessments(subject).length,count);assert.equal(written.length,writeCount);
});
