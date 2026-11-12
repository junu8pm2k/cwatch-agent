import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CaseSchema, InputSchema, type EvalCase } from './contracts.ts';
import { loadDataset } from './dataset.ts';
import { rubricDimensions } from './rubric.ts';
import { PENALTY_PROFILE } from './penalty.ts';
import { EVAL_SCENARIOS, scenarioForCase } from './langfuse-judges.ts';

export const SUITE_FILE=fileURLToPath(new URL('../../evals/cwatch/dataset.json',import.meta.url));
export const DATASET_PREFIX='cwatch/current/';
export const SCENARIO_LABELS={activation:'触发',core_logic:'核心逻辑',resilience:'异常容错',artifact_quality:'产物质量'} as const;

/** Same CaseSchema feeds the local runner and the platform. Agent input never contains the oracle. */
export function evaluationAssets(){
  const loaded=loadDataset(SUITE_FILE);
  const cases=loaded.entries.map(({value:c,sha256:caseSha256},index)=>{
    const scenario=scenarioForCase(c.id);if(!scenario||c.input.scenario.driver!=='runtime')throw Error('unsupported_suite_case');
    const {input,expected_final,...evaluation}=c;
    if(input.scenario.driver!=='runtime')throw Error('unsupported_suite_driver');
    const {instruction,...executionScenario}=input.scenario;
    const pureInput=fileURLToPath(new URL('../../evals/cwatch/inputs/'+c.id+'.r'+c.revision+'.json',import.meta.url));
    if(JSON.stringify(InputSchema.parse(JSON.parse(readFileSync(pureInput,'utf8'))))!==JSON.stringify(input))throw Error('pure_trial_input_out_of_sync: '+c.id);
    return {caseId:c.id,revision:c.revision,scenario,datasetName:DATASET_PREFIX+scenario,id:'cwatch-current-'+c.id,
      input:{instruction},expectedOutput:expected_final,
      metadata:{schemaVersion:'cwatch.langfuse-case.v2' as const,caseId:c.id,revision:c.revision,number:index+1,title:c.title,scenario,scenarioLabel:SCENARIO_LABELS[scenario],
        caseSha256,sourceFile:'evals/cwatch/cases/'+c.id+'.r'+c.revision+'.json',readiness:'review_candidate',rubricStatus:c.rubric?'authored_pending_baseline_review':'code_only',
        baselineConfirmed:false,scoringStatus:'not_scored',scoringPolicy:PENALTY_PROFILE,
        judgeDimensions:rubricDimensions(c.rubric),humanDimensions:c.humanReview.dimensions,
        evaluation,execution:{scenario:executionScenario,materialProvenance:input.materialProvenance}}};
  });
  if(JSON.stringify(EVAL_SCENARIOS.map(s=>cases.filter(c=>c.scenario===s).length))!=='[2,8,2,2]')throw Error('suite_scenario_counts_changed');
  return cases;
}

/** Lossless platform-to-runner adapter. Expectations are read by the grader, never appended to Agent input. */
export function caseFromDatasetItem(raw:unknown):EvalCase {
  const item=z.object({input:z.object({instruction:z.string().min(1)}).strict(),expectedOutput:z.unknown(),metadata:z.object({
    schemaVersion:z.literal('cwatch.langfuse-case.v2'),caseId:z.string(),revision:z.number(),scoringPolicy:z.unknown(),judgeDimensions:z.array(z.string()),humanDimensions:z.array(z.string()),
    evaluation:z.record(z.string(),z.unknown()),execution:z.object({scenario:z.record(z.string(),z.unknown()),materialProvenance:z.string()}),
  })}).parse(raw);
  const c=CaseSchema.parse({...item.metadata.evaluation,input:{...item.metadata.execution,scenario:{...item.metadata.execution.scenario,instruction:item.input.instruction}},expected_final:item.expectedOutput});
  if(c.id!==item.metadata.caseId||c.revision!==item.metadata.revision)throw Error('platform_case_identity_mismatch');
  if(!isDeepStrictEqual(item.metadata.scoringPolicy,PENALTY_PROFILE))throw Error('platform_penalty_policy_changed');
  if(!isDeepStrictEqual(item.metadata.judgeDimensions,rubricDimensions(c.rubric))||!isDeepStrictEqual(item.metadata.humanDimensions,c.humanReview.dimensions))throw Error('platform_grader_assignment_out_of_sync');
  return c;
}
