import type { EvalCase, CheckResult } from './contracts.ts';
import type { Assessment } from './quality.ts';
import { EVAL_DIMENSIONS } from './dimensions.ts';
import { rubricDimensions } from './rubric.ts';
import { PENALTY_PROFILE } from './penalty.ts';

/** Automatic-only score: deliberately separate from the human-confirmed final score. */
export function automaticAssessment(c:EvalCase,checks:CheckResult[],durationMs:number|null,llm:Assessment|null,human:Assessment|null,pendingRequests=0){
  const assigned=rubricDimensions(c.rubric),answer=llm?.status==='completed'?llm.answer:null;
  const unknown=checks.filter(x=>x.required&&x.outcome==='unknown').map(x=>x.criterionId);
  const fatal=checks.filter(x=>x.outcome==='fail'&&(x.required||x.hardFail)&&(x.hardFail||['outcome','evidence','safety'].includes(x.dimension)));
  const vetoes=fatal.map(x=>({id:x.criterionId,dimension:x.dimension,reason:x.reason}));
  for(const dimension of assigned){
    const finding=answer?.judgments.find(j=>j.dimension===dimension);
    if(!finding||finding.verdict==='unknown')unknown.push('llm:'+dimension);
    if(dimension!=='trajectory'&&finding?.verdict==='fail')vetoes.push({id:'llm:'+dimension,dimension,reason:finding.reason});
  }
  const process=c.expected_process.criteria.map(p=>({id:p.id,finding:answer?.processChecks.find(f=>f.criterionId===p.id)??null}));
  for(const p of process)if(!p.finding||p.finding.verdict==='unknown')unknown.push(p.id);
  if(answer?.concerns.length)unknown.push('llm:unresolved_concerns');
  if(pendingRequests)unknown.push('llm:incomplete_request');
  const timeKnown=durationMs!==null&&Number.isFinite(durationMs)&&durationMs>=0;
  if(!timeKnown)unknown.push('duration_unavailable');
  const processDeduction=process.every(p=>p.finding&&p.finding.verdict!=='unknown')?-process.filter(p=>p.finding?.verdict==='fail').length*PENALTY_PROFILE.processPoints:null;
  const efficiencyDeduction=timeKnown?-Math.ceil(Math.max(0,durationMs!-PENALTY_PROFILE.baselineMs)/PENALTY_PROFILE.intervalMs)*PENALTY_PROFILE.intervalPoints:null;
  const complete=unknown.length===0,resultDeduction=vetoes.length?-PENALTY_PROFILE.resultPoints:complete?0:null;
  const score=vetoes.length?0:complete?Math.max(0,PENALTY_PROFILE.initialScore+processDeduction!+efficiencyDeduction!+resultDeduction!):null;
  const requiredFailed=checks.some(x=>(x.required||x.hardFail)&&x.outcome==='fail');
  const passed=complete&&!requiredFailed&&score!==null&&score>=PENALTY_PROFILE.threshold;
  const dimensions=EVAL_DIMENSIONS.map(d=>{
    const rows=checks.filter(x=>x.dimension===d.id&&(x.required||x.hardFail));
    const code=rows.some(x=>x.outcome==='fail')?'fail':rows.some(x=>x.outcome==='unknown')?'unknown':rows.length?'pass':'not_applicable';
    const judge=assigned.some(id=>id===d.id)?answer?.judgments.find(j=>j.dimension===d.id)?.verdict??'unknown':'not_applicable';
    const manual=c.humanReview.dimensions.some(id=>id===d.id)?human?.answer?.judgments.find(j=>j.dimension===d.id)?.verdict??'pending':'not_applicable';
    return {id:d.id,name:d.name,code: d.id==='cost'?(timeKnown?'measured':'unknown'):code,llm:judge,human:manual,
      deduction:d.id==='trajectory'?processDeduction:d.id==='cost'?efficiencyDeduction:0,
      veto:vetoes.some(v=>v.dimension===d.id),vetoDeductionShared:true};
  });
  return {schemaVersion:'cwatch.automatic-assessment.v1',scope:'automatic_only',complete,score,passed,
    verdict:vetoes.length||requiredFailed||(score!==null&&score<80)?'fail':complete?'pass':'needs_review',
    processDeduction,efficiencyDeduction,resultDeduction,vetoes,dimensions,unknownCheckIds:[...new Set(unknown)],
    manualRequired:c.humanReview.dimensions,
    note:'Only automatic judgments are included. This is not the human-confirmed final score, Case approval or release gate.'};
}
