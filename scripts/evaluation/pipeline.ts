import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readModelConfig, type ModelConfig } from '@cwatch/shared/config/models';
import { Redactor } from '@cwatch/shared/sessions/trace';
import { loadDataset, sha256, within } from './dataset.ts';
import { runBatch } from './runner.ts';
import { humanTemplate, listAssessments, prepareQualitySubject, saveQualityReport, scoreRules, combinedAssessment, type QualitySubject } from './quality.ts';
import { JUDGE_VERSION, readJudgeConfig, scoreLlm, type JudgeTransport } from './judge.ts';
import { saveDetailedEvaluationReport } from './report.ts';
import { archiveEvaluation } from './archive.ts';
import type { EvalResult } from './grader.ts';
import { listHumanRejections } from './adjudication.ts';

export interface PipelineOptions {
  dataset?:string;report?:string;caseId?:string;repeat?:number;out?:string;realModel?:boolean;gate?:'automatic'|'final'|'regression';signal?:AbortSignal;baselineRoot?:string;
  judgeConfig?:ModelConfig;judgeTransport?:JudgeTransport;onEvent?:(event:Record<string,unknown>)=>void;
}
export interface HumanReviewRequest {
  caseId:string;attempt:number;runId:string;input:string;subject:string;prompt:string|null;answer:string|null;
  answerPath:string|null;trace:string|null;traceEvents:string;dimensions:string[];
}
export interface HumanReviewCheckpoint {
  schemaVersion:'cwatch.eval-review-checkpoint.v1';id:string;status:'awaiting_human';exitCode:2;
  sourceReport:string;checkpointPath:string;report:null;archive:null;humanInputs:Array<{caseId:string;attempt:number;path:string}>;
  reviews:HumanReviewRequest[];errors:string[];ledger:string;message:string;
}
/** Expected suspension: callers must ask the user before resuming the final report stage. */
export class HumanReviewRequired extends Error {
  constructor(readonly checkpoint:HumanReviewCheckpoint){super(checkpoint.message);this.name='HumanReviewRequired';}
}
/** Failed attempts with observable work must still be judged, including truncated responses. */
export function judgeUnavailableReason(runStatus:string|null|undefined,facts:Record<string,unknown>):string|null {
  const error=typeof facts.error==='string'?facts.error:'';
  const response=typeof facts.response==='string'?facts.response.trim():'';
  const hasWork=Boolean(response)||(typeof facts.toolRequestCount==='number'&&facts.toolRequestCount>0)||
    (Array.isArray(facts.skillReads)&&facts.skillReads.some(read=>read&&typeof read==='object'&&read.completed===true));
  // Recognize historical truncation records too; they used the provider_unavailable prefix.
  if(runStatus!=='failed'||hasWork||/truncated_response|model_response_truncated/.test(error)||!/(?:^|\s)provider_unavailable:/.test(error))return null;
  return 'Task model unavailable before observable execution; Judge skipped. Execution error: '+error;
}
function existingHumanTemplate(subject:QualitySubject):string|null {
  const root=join(subject.archive.batch,'assessments');if(!existsSync(root))return null;
  for(const name of readdirSync(root)){
    const path=join(root,name,'human-input.json');if(!existsSync(path))continue;
    if(!within(realpathSync(root),realpathSync(path)))throw Error('human_template_escape');
    if(JSON.parse(readFileSync(path,'utf8')).subjectSha256===subject.subjectSha256)return path;
  }
  return null;
}
/** Execution -> rules -> Judge -> optional human queue -> scoped report -> archive. */
export async function runEvaluationPipeline(options:PipelineOptions){
  if(Boolean(options.dataset)===Boolean(options.report))throw Error('Provide exactly one of --dataset (new run) or --report (resume existing evidence)');
  const mode=options.realModel!==false,gate=options.gate??'automatic',evaluationMode=gate==='final'?'human_review':'automatic';
  const secrets=Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value??'').filter(Boolean);
  if(options.judgeConfig)secrets.push(options.judgeConfig.apiKey);
  const redactor=new Redactor(secrets);
  let judgeConfig=options.judgeConfig;
  // Validate configuration before spending any task-model calls.
  if(options.dataset){
    const data=loadDataset(options.dataset),entries=data.entries.filter(e=>e.value.status!=='retired'&&e.value.split==='regression'&&
      (e.value.scope.executionMode==='frozen_tools_live_model')===mode&&(!options.caseId||e.value.id===options.caseId));
    if(!entries.length)throw Error('no_matching_cases');
    if(mode)readModelConfig();
    if(entries.some(e=>e.value.rubric!==null))judgeConfig??=readJudgeConfig();
  }
  const source=options.report?{path:realpathSync(options.report)}:await runBatch({dataset:options.dataset,caseId:options.caseId,repeat:options.repeat??(gate==='regression'?5:1),out:options.out,realModel:mode,signal:options.signal});
  const reportPath=resolve(source.path),batch=dirname(reportPath),id=randomUUID(),ledger=join(batch,'pipeline-events-'+id+'.jsonl');
  const lockRoot=join(dirname(batch),'.locks');mkdirSync(lockRoot,{recursive:true});
  if(!within(realpathSync(dirname(batch)),realpathSync(lockRoot)))throw Error('pipeline_lock_escape');
  const lock=join(lockRoot,batch.split(/[\\/]/).at(-1)+'.lock');let lockFd:number;
  try{lockFd=openSync(lock,'wx');}catch{throw Error('evaluation_batch_busy: another pipeline is processing this batch');}
  try{
  const stages:Array<Record<string,unknown>>=[],errors:string[]=[],humanInputs:Array<{caseId:string;attempt:number;path:string}>=[],reviews:HumanReviewRequest[]=[];
  const emit=(stage:string,status:string,details:Record<string,unknown>={})=>{
    const event=redactor.clean({at:new Date().toISOString(),stage,status,...details});stages.push(event);appendFileSync(ledger,JSON.stringify(event)+'\n');options.onEvent?.(event);
  };
  emit('execution',options.report?'reused':'completed',{report:reportPath});
  const raw=JSON.parse(readFileSync(reportPath,'utf8')) as {results:EvalResult[]};
  for(const row of raw.results){
    if(!row.runId||row.verdict==='invalid'){errors.push('execution_unavailable:'+row.caseId);emit('assessment','unavailable',{caseId:row.caseId,attempt:row.attempt});continue;}
    try{
      const subject=prepareQualitySubject(reportPath,row.caseId,row.attempt,redactor);let records=listAssessments(subject);
      if(!records.some(r=>r.kind==='rules'&&r.status==='completed'))scoreRules(subject);
      emit('rules','completed',{caseId:row.caseId,attempt:row.attempt,checks:subject.packet.rules.checks.length});
      if(subject.llmApplicable){
        judgeConfig??=readJudgeConfig();
        const previous=records.filter(r=>r.kind==='llm').at(-1);
        const unavailableReason=judgeUnavailableReason(row.runStatus,subject.packet.observedFacts);
        const reusable=previous?.status==='completed'&&previous.metadata.graderVersion===JUDGE_VERSION&&previous.metadata.provider===judgeConfig.provider&&
          previous.metadata.modelId===judgeConfig.modelId&&previous.metadata.endpointFingerprint===sha256(judgeConfig.baseUrl??'sdk-default')&&previous.metadata.rubricSha256===subject.packet.rubricSha256;
        if(reusable)emit('judge','reused',{caseId:row.caseId,attempt:row.attempt,assessmentId:previous.id});
        else if(unavailableReason){
          emit('judge','unavailable',{caseId:row.caseId,attempt:row.attempt,reason:unavailableReason});
        }else{
          emit('judge','running',{caseId:row.caseId,attempt:row.attempt});
          const result=await scoreLlm(subject,judgeConfig,{signal:options.signal,transport:options.judgeTransport});
          emit('judge',result.record.status,{caseId:row.caseId,attempt:row.attempt,assessmentId:result.record.id,verdict:result.record.verdict,
            ...(result.record.error?{error:result.record.error}:{})});
        }
      }else emit('judge','not_applicable',{caseId:row.caseId,attempt:row.attempt});
      records=listAssessments(subject);
      if(evaluationMode==='automatic'){
        emit('human',subject.humanApplicable?'not_requested':'not_applicable',{caseId:row.caseId,attempt:row.attempt,
          historicalRecord:records.filter(r=>r.kind==='human'&&r.status==='completed').at(-1)?.id??null});
      }else if(listHumanRejections(subject).length){
        emit('human','rejected',{caseId:row.caseId,attempt:row.attempt,reason:'Explicit human criterion rejection; no further approvals required to establish failure.'});
      }else{
        const human=records.filter(r=>r.kind==='human'&&r.status==='completed').at(-1),assessed=combinedAssessment(subject,records);
        const needsHuman=subject.humanApplicable&&(!human||human.answer?.judgments.some(j=>j.verdict==='unknown')||human.answer?.processChecks.some(p=>p.verdict==='unknown')||human.answer?.concerns.length||assessed.disagreement);
        if(assessed.penalty.resultDeduction===-100)emit('human','not_required_for_known_failure',{caseId:row.caseId,attempt:row.attempt});
        else if(needsHuman){
          const path=existingHumanTemplate(subject)??humanTemplate(subject).path;humanInputs.push({caseId:row.caseId,attempt:row.attempt,path});
          const observed=JSON.parse(readFileSync(join(subject.archive.directory,'observed.json'),'utf8'));
          const scenario=subject.archive.value.input.scenario;
          reviews.push({caseId:row.caseId,attempt:row.attempt,runId:row.runId,input:path,subject:join(dirname(path),'subject.json'),
            prompt:scenario.driver==='runtime'?scenario.instruction:null,answer:subject.packet.finalAnswer,
            answerPath:typeof observed.facts?.response==='string'?join(subject.archive.directory,'responses',row.runId+'.md'):null,
            trace:observed.structuredTracePath?join(subject.archive.directory,observed.structuredTracePath):null,
            traceEvents:join(subject.archive.directory,observed.tracePath),dimensions:[...subject.packet.humanReview.dimensions]});
          emit('human','required',{caseId:row.caseId,attempt:row.attempt,input:path,subject:reviews.at(-1)!.subject});
        }else emit('human',subject.humanApplicable?'completed':'not_applicable',{caseId:row.caseId,attempt:row.attempt});
      }
    }catch(error){const message=redactor.clean(error instanceof Error?error.message:'assessment_failed');errors.push(message);emit('assessment','error',{caseId:row.caseId,attempt:row.attempt,error:message});}
  }
  if(humanInputs.length){
    const checkpointPath=join(batch,'review-checkpoint-'+id+'.json');
    const message='Human review is required before generating the final report. Present the supplied prompt, answer and Trace to the user and ask now. Import their actual response, then resume with --report and --gate final. No final report or ZIP has been generated.';
    emit('pipeline','awaiting_human',{checkpoint:checkpointPath,message});
    const checkpoint:HumanReviewCheckpoint={schemaVersion:'cwatch.eval-review-checkpoint.v1',id,status:'awaiting_human',exitCode:2,
      sourceReport:reportPath,checkpointPath,report:null,archive:null,humanInputs,reviews,errors,ledger,message};
    writeFileSync(checkpointPath,JSON.stringify(checkpoint,null,2)+'\n',{flag:'wx'});
    writeFileSync(join(dirname(batch),'latest-evaluation.json'),JSON.stringify(checkpoint,null,2)+'\n');
    throw new HumanReviewRequired(checkpoint);
  }
  const quality=evaluationMode==='human_review'?saveQualityReport(reportPath,redactor):null;
  const detail=saveDetailedEvaluationReport(reportPath,{baselineRoot:options.baselineRoot,regression:gate==='regression',evaluationMode});
  emit('report','completed',{evaluationMode,quality:quality?.path??null,json:detail.json,markdown:detail.markdown});
  const regression=detail.regression;
  if(regression){writeFileSync(join(batch,'regression-gate-'+id+'.json'),JSON.stringify(regression,null,2)+'\n',{flag:'wx'});emit('regression',regression.passed?'passed':'blocked',{score:regression.score});}
  const exitCode=errors.length?3:regression?(regression.passed?0:regression.score===0?1:2):gate==='automatic'?(detail.automaticPassed?0:detail.automaticFailed?1:2)
    :detail.finalPassed?0:quality!.report.results.some(r=>r.verdict==='fail')?1:2;
  const result={schemaVersion:'cwatch.eval-pipeline-result.v2',id,gate,evaluationMode,exitCode,sourceReport:reportPath,qualityReport:quality?.path??null,
    report:detail,automaticPassed:detail.automaticPassed,finalPassed:detail.finalPassed,regression,humanInputs,errors,ledger,
    format:'cwatch.detailed-eval-report.v3',pipelineVersion:'cwatch.eval-pipeline.v2',caseRubricSource:'frozen_case_only',stages};
  const resultPath=join(batch,'pipeline-result-'+id+'.json');writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  // All required execution/scoring/report files are complete before the immutable ZIP snapshot.
  const archive=archiveEvaluation(batch,[...secrets,...(judgeConfig?[judgeConfig.apiKey]:[])]);
  const pointer={...result,resultPath,archive};
  writeFileSync(join(dirname(batch),'latest-evaluation.json'),JSON.stringify(pointer,null,2)+'\n');
  options.onEvent?.({stage:'archive',status:'completed',path:archive.path,sha256:archive.sha256});
  return pointer;
  }finally{closeSync(lockFd);unlinkSync(lock);}
}
