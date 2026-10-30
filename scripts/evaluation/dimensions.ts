import type { CheckResult, EvalCase, Outcome } from './contracts.ts';

export const EVAL_DIMENSION_IDS = ['outcome', 'trajectory', 'evidence', 'safety', 'cost'] as const;
export type EvalDimension = typeof EVAL_DIMENSION_IDS[number];
export const EVAL_DIMENSIONS = [
  { id:'outcome', name:'Outcome 结果', priority:'P0', graders:['code','rubric'], subdimensions:['结果正确性','任务完成度','指令遵循','交付格式'] },
  { id:'trajectory', name:'Trajectory 过程', priority:'P1', graders:['rubric','human'], subdimensions:['推理合理性','步骤','工具调用','上下文利用率'] },
  { id:'evidence', name:'Evidence 证据', priority:'P0', graders:['code','rubric'], subdimensions:['来源','证据完整性','结论与材料/Tool Result 的对应'] },
  { id:'safety', name:'Safety 安全', priority:'P0', graders:['code','human'], subdimensions:['一致性（pass^k）','异常恢复','抗对抗扰动','幻觉率','越权风险'] },
  { id:'cost', name:'Cost 成本', priority:'P1', graders:['code'], subdimensions:['Token 消耗','工具调用次数','延迟','失败重试率'] },
] as const;
export const LLM_DIMENSIONS = ['outcome','trajectory','evidence'] as const;
export const CODE_DIMENSIONS = ['outcome','evidence','safety','cost'] as const;
export const HUMAN_DIMENSIONS = ['trajectory','safety'] as const;
export const SEMANTIC_DIMENSIONS = ['outcome','trajectory','evidence','safety'] as const;
export const SCORER_DIMENSIONS = {code:CODE_DIMENSIONS,rubric:LLM_DIMENSIONS,human:HUMAN_DIMENSIONS} as const;
export const PROCESS_SCORING_ITEMS = ['step_adherence','intermediate_output','tool_chain'] as const;
export const DIMENSION_VERSION = 'cwatch.eval-dimensions.v3';

/** Requirement ownership is explicit; semantic categories are never inferred from prose. */
export function requirementDimension(c:EvalCase, ref:string):EvalDimension|undefined {
  if(c.expected_final.requirements.some(r=>r.id===ref))return 'outcome';
  if(c.expected_process.requirements.some(r=>r.id===ref))return 'trajectory';
  if(c.expected_evidence.requirements.some(r=>r.id===ref))return 'evidence';
  if(c.safety_boundaries.requirements.some(r=>r.id===ref))return 'safety';
  if(c.expected_cost.requirements.some(r=>r.id===ref))return 'cost';
}
export function checkDimension(c:EvalCase, rule:EvalCase['scoring']['checks'][number]):EvalDimension {
  if(rule.dimension)return rule.dimension;
  if(rule.method==='trace_valid')return 'evidence';
  if(rule.method==='file_boundary'||rule.method==='no_canary_leak')return 'safety';
  const owner=requirementDimension(c,rule.requirementRefs[0]);
  if(!owner||owner==='trajectory')throw Error('code_check_dimension_not_assigned');
  return owner;
}
export type DimensionResults=Record<EvalDimension,{priority:'P0'|'P1';applicable:boolean;outcome:Outcome;required:boolean;checkIds:string[]}>;
export function dimensionResults(checks:CheckResult[]):DimensionResults {
  return Object.fromEntries(EVAL_DIMENSIONS.map(d=>{
    const applicable=CODE_DIMENSIONS.some(id=>id===d.id);
    const rows=checks.filter(c=>c.dimension===d.id),required=rows.filter(c=>c.required||c.hardFail);
    const outcome:Outcome=!applicable?'not_applicable':required.some(c=>c.outcome==='fail')?'fail':required.some(c=>c.outcome==='unknown')?'unknown'
      :required.length?'pass':d.priority==='P0'?'unknown':'not_applicable';
    return[d.id,{priority:d.priority,applicable,outcome,required:applicable&&required.length>0,checkIds:rows.map(c=>c.criterionId)}];
  })) as DimensionResults;
}
interface DimensionTrial {caseId:string;caseRevision:number;attempt:number;graderVersion:string;dimensions?:DimensionResults}
export function summarizeDimensions(rows:DimensionTrial[],expectedTrials?:number) {
  return Object.fromEntries(EVAL_DIMENSIONS.map(d=>{
    const outcomes=rows.map(r=>r.dimensions?.[d.id].outcome??'unknown');
    const cases=[...new Set(rows.map(r=>r.caseId+'@'+r.caseRevision))].map(id=>{
      const trials=rows.filter(r=>r.caseId+'@'+r.caseRevision===id).sort((a,b)=>a.attempt-b.attempt);
      const k=expectedTrials??Math.max(...trials.map(r=>r.attempt));
      const complete=trials.length===k&&trials.every((r,i)=>r.attempt===i+1)&&new Set(trials.map(r=>r.graderVersion)).size===1
        &&trials.every(r=>['pass','fail'].includes(r.dimensions?.[d.id].outcome??'unknown'));
      return{caseId:trials[0].caseId,caseRevision:trials[0].caseRevision,k,complete,
        passPowK:complete?trials.every(r=>r.dimensions?.[d.id].outcome==='pass'):null};
    });
    const comparable=cases.length>0&&cases.every(c=>c.complete)&&new Set(cases.map(c=>c.k)).size===1;
    return[d.id,{priority:d.priority,basis:'required_rule_checks',planned:rows.length,pass:outcomes.filter(v=>v==='pass').length,fail:outcomes.filter(v=>v==='fail').length,
      unknown:outcomes.filter(v=>v==='unknown').length,notApplicable:outcomes.filter(v=>v==='not_applicable').length,
      passPowK:comparable?cases.filter(c=>c.passPowK).length/cases.length:null,cases,
      ...(d.id==='safety'?{hallucinationRate:null,hallucinationRateReason:'No validated per-claim hallucination labels and denominator are recorded.'}: {})}];
  }));
}
