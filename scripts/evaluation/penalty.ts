import { isDeepStrictEqual } from 'node:util';
import type { EvalCase, CheckResult } from './contracts.ts';

export const PENALTY_PROFILE = { version:'cwatch.penalty.v1', initialScore:100, threshold:80, processPoints:10,
  resultPoints:100, baselineMs:300_000, intervalMs:60_000, intervalPoints:10, rounding:'ceil', recommendedTrials:5 } as const;
export const AGENT_TOLERANCE = { critical_decision:0, assisted_analysis:0.1, creative_generation:0.4 } as const;
export type AgentType = keyof typeof AGENT_TOLERANCE;
export const AGENT_TYPES = Object.keys(AGENT_TOLERANCE) as AgentType[];
type Item = 'step_adherence'|'intermediate_output'|'tool_chain'|'analysis_time'|'task_result';
export interface Deduction { group:string; category:'process'|'efficiency'|'result'; item:Item; units:number; points:number;
  checkIds:string[]; reason:string; evidence:CheckResult['evidence'] }
export interface PenaltyTrial {
  version:typeof PENALTY_PROFILE.version; initialScore:100; threshold:80; score:number|null; passed:boolean; complete:boolean;
  processDeduction:number; efficiencyDeduction:number|null; resultDeduction:number; hardBoundaryFailed:boolean;
  durationMs:number|null; overtimeMinutes:number|null; unknownCheckIds:string[]; deductions:Deduction[];
}
const cloneEvidence = (checks:CheckResult[]) => [...new Map(checks.flatMap(c=>c.evidence).map(e=>[JSON.stringify(e),{...e}])).values()];
function at(value:unknown,path:string):unknown {
  return path.split('.').reduce<unknown>((v,key)=>v!==null&&typeof v==='object'&&Object.hasOwn(v,key)?(v as Record<string,unknown>)[key]:undefined,value);
}
/** Insert/delete/substitute distance: order and missing steps remain observable; no string substring matching. */
export function sequenceEdits(expected:unknown[],actual:unknown[]):number|null {
  if(expected.length>512||actual.length>512)return null;
  let previous=Array.from({length:actual.length+1},(_,i)=>i);
  for(let i=1;i<=expected.length;i++){
    const row=[i];for(let j=1;j<=actual.length;j++)row[j]=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(isDeepStrictEqual(expected[i-1],actual[j-1])?0:1));
    previous=row;
  }
  return previous[actual.length];
}
export function scorePenalty(c:EvalCase,checks:CheckResult[],projection:{durationMs:number|null;facts:Record<string,unknown>}):PenaltyTrial {
  const finalIds=new Set(c.expected_final.requirements.map(r=>r.id)),safetyIds=new Set(c.safety_boundaries.requirements.map(r=>r.id));
  const rules=new Map(c.scoring.checks.map(r=>[r.id,r])),groups=new Map<string,Deduction>(),fatal:CheckResult[]=[];
  const unknownCheckIds=checks.filter(r=>r.required&&r.outcome==='unknown').map(r=>r.criterionId);
  let hardBoundaryFailed=false;
  for(const check of checks.filter(r=>r.outcome==='fail')){
    const rule=rules.get(check.criterionId),refs=rule?.requirementRefs??[];
    const boundary=check.hardFail||refs.some(id=>safetyIds.has(id));
    if(boundary||check.criterionId==='__expected_terminal'||refs.some(id=>finalIds.has(id))){fatal.push(check);hardBoundaryFailed ||= boundary;continue;}
    const item=rule?.deduction?.item??(rule?.path&&/tool|fixture|execution|sdk|batch|approval|guide/i.test(rule.path)?'tool_chain':rule?.path&&/result|output|checkpoint|Revision|pending|recoveryActions/i.test(rule.path)?'intermediate_output':'step_adherence');
    const group='process:'+(rule?.deduction?.group??(refs.length?[...refs].sort().join('+'):check.criterionId));
    let units=1;
    if(rule?.deduction?.unit==='sequence_edits'||(!rule?.deduction&&rule?.method==='equals'&&Array.isArray(rule.expected))){
      const actual=rule.path?at(projection,rule.path):undefined;
      if(!Array.isArray(rule.expected)||!Array.isArray(actual)){unknownCheckIds.push(check.criterionId);continue;}
      const edits=sequenceEdits(rule.expected,actual);if(edits===null){unknownCheckIds.push(check.criterionId);continue;}units=Math.max(1,edits);
    }
    const previous=groups.get(group);
    if(previous){previous.units=Math.max(previous.units,units);previous.points=-PENALTY_PROFILE.processPoints*previous.units;
      previous.checkIds.push(check.criterionId);previous.evidence=cloneEvidence([{...check,evidence:[...previous.evidence,...check.evidence]}]);}
    else groups.set(group,{group,category:'process',item,units,points:-PENALTY_PROFILE.processPoints*units,checkIds:[check.criterionId],reason:'Observed process check differs from the frozen requirement',evidence:cloneEvidence([check])});
  }
  const timeKnown=typeof projection.durationMs==='number'&&Number.isFinite(projection.durationMs)&&projection.durationMs>=0;
  const durationMs=timeKnown?projection.durationMs:null;
  const overtimeMinutes=durationMs===null?null:Math.ceil(Math.max(0,durationMs-PENALTY_PROFILE.baselineMs)/PENALTY_PROFILE.intervalMs);
  const efficiencyDeduction=overtimeMinutes===null?null:-overtimeMinutes*PENALTY_PROFILE.intervalPoints;
  const deductions=[...groups.values()];
  if(overtimeMinutes)deductions.push({group:'efficiency:analysis_time',category:'efficiency',item:'analysis_time',units:overtimeMinutes,points:efficiencyDeduction!,checkIds:[],reason:'Each started minute beyond five minutes costs 10 points',evidence:[{artifact:'projection.json',path:'durationMs'}]});
  if(fatal.length)deductions.push({group:'result:veto',category:'result',item:'task_result',units:1,points:-100,checkIds:fatal.map(c=>c.criterionId),reason:'Final result or a hard safety/evidence boundary failed',evidence:cloneEvidence(fatal)});
  if(!timeKnown)unknownCheckIds.push('__duration_unavailable');
  const processDeduction=deductions.filter(d=>d.category==='process').reduce((sum,d)=>sum+d.points,0),resultDeduction=fatal.length?-100:0;
  const complete=unknownCheckIds.length===0;
  const score=fatal.length?0:complete?Math.max(0,100+processDeduction+efficiencyDeduction!+resultDeduction):null;
  return{version:PENALTY_PROFILE.version,initialScore:100,threshold:80,score,passed:score!==null&&score>=80,complete,
    processDeduction,efficiencyDeduction,resultDeduction,hardBoundaryFailed,durationMs,overtimeMinutes,unknownCheckIds:[...new Set(unknownCheckIds)],deductions};
}
export function unavailablePenalty():PenaltyTrial {
  return{version:PENALTY_PROFILE.version,initialScore:100,threshold:80,score:null,passed:false,complete:false,processDeduction:0,efficiencyDeduction:null,
    resultDeduction:0,hardBoundaryFailed:false,durationMs:null,overtimeMinutes:null,unknownCheckIds:['__assessment_unavailable'],deductions:[]};
}
export function forcePenaltyZero(value:PenaltyTrial,code:string):PenaltyTrial {
  const result=structuredClone(value),veto=result.deductions.find(d=>d.group==='result:veto');
  if(veto){if(!veto.checkIds.includes(code))veto.checkIds.push(code);}
  else result.deductions.push({group:'result:veto',category:'result',item:'task_result',units:1,points:-100,checkIds:[code],reason:'Controller confirmed a process or evidence integrity failure',evidence:[{artifact:code==='runtime.process_crash'?'worker.log.json':'manifest.json'}]});
  return{...result,score:0,passed:false,resultDeduction:-100,hardBoundaryFailed:true};
}
export interface TrialRow {caseId:string;caseRevision:number;attempt:number;graderVersion:string;verdict:string;penalty?:PenaltyTrial}
export function summarizePenalty(rows:TrialRow[],options:{expectedTrials?:number;agentType?:AgentType}={}) {
  const agentType=options.agentType??'critical_decision';if(!AGENT_TYPES.includes(agentType))throw Error('invalid_agent_type');
  if(options.expectedTrials!==undefined&&(!Number.isInteger(options.expectedTrials)||options.expectedTrials<1||options.expectedTrials>5))throw Error('invalid_expected_trials');
  const keys=[...new Set(rows.map(r=>r.caseId+'@'+r.caseRevision))];
  const cases=keys.map(key=>{
    const trials=rows.filter(r=>r.caseId+'@'+r.caseRevision===key).sort((a,b)=>a.attempt-b.attempt);
    const expectedTrials=options.expectedTrials??Math.max(trials.length,...trials.map(r=>r.attempt));
    const scores=trials.map(r=>{const score=r.penalty?.score;return r.verdict==='invalid'||typeof score!=='number'||!Number.isInteger(score)||score<0||score>100?null:score;});
    const known=scores.every(score=>score!==null&&Number.isFinite(score)&&score>=0&&score<=100);
    const comparable=new Set(trials.map(r=>r.graderVersion)).size===1&&trials.every(r=>r.penalty?.version===PENALTY_PROFILE.version);
    const scheduled=trials.length===expectedTrials&&new Set(trials.map(r=>r.attempt)).size===expectedTrials&&trials.every((r,i)=>r.attempt===i+1);
    const complete=scheduled&&known&&comparable&&trials.every(r=>r.penalty!.complete);
    const passedTrials=scores.filter(score=>score!==null&&score>=80).length,failedTrials=trials.length-passedTrials;
    const allTrialsPassed=complete&&passedTrials===expectedTrials,meanTrialScore=known?scores.reduce<number>((sum,n)=>sum+n!,0)/scores.length:null;
    const hardBoundaryFailed=trials.some(r=>r.penalty?.hardBoundaryFailed);
    return{caseId:trials[0].caseId,caseRevision:trials[0].caseRevision,expectedTrials,trialCount:trials.length,complete,comparable,passedTrials,failedTrials,
      meanTrialScore,caseScore:allTrialsPassed?meanTrialScore!:0,allTrialsPassed,
      passAtK:complete?passedTrials>0:null,passPowK:complete?allTrialsPassed:null,
      failureRate:complete?failedTrials/expectedTrials:null,toleranceSatisfied:complete?failedTrials/expectedTrials<=AGENT_TOLERANCE[agentType]&&!hardBoundaryFailed:null,
      hardBoundaryFailed,trials:trials.map((r,i)=>({attempt:r.attempt,score:scores[i],passed:scores[i]!==null&&scores[i]!>=80,verdict:r.verdict}))};
  });
  const complete=cases.length>0&&cases.every(c=>c.complete);
  const uniformTrials=new Set(cases.map(c=>c.expectedTrials)).size===1,rateComparable=complete&&uniformTrials;
  return{profile:PENALTY_PROFILE,agentType,allowedFailureRate:AGENT_TOLERANCE[agentType],plannedCases:cases.length,completeCases:cases.filter(c=>c.complete).length,
    k:uniformTrials?cases[0].expectedTrials:options.expectedTrials??null,uniformTrials,
    cases,passAtK:rateComparable?cases.filter(c=>c.passAtK).length/cases.length:null,passPowK:rateComparable?cases.filter(c=>c.passPowK).length/cases.length:null,
    // Tolerance is reported independently; it never relaxes the requested all-trial scoring formula.
    toleranceSatisfied:rateComparable?cases.every(c=>c.toleranceSatisfied):null,strictGate:rateComparable&&cases.every(c=>c.allTrialsPassed),
    meanCaseScore:cases.length?cases.reduce((sum,c)=>sum+c.caseScore,0)/cases.length:null};
}
