import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LangfuseClient } from './langfuse-client.ts';
import { readJudgeConfig } from './judge.ts';
import type { QualitySubject } from './quality.ts';
import { LLM_DIMENSIONS } from './dimensions.ts';

export const EVAL_SCENARIOS=['activation','core_logic','resilience','artifact_quality'] as const;
export const EvalScenarioSchema=z.enum(EVAL_SCENARIOS);
export type EvalScenario=z.infer<typeof EvalScenarioSchema>;
export const JUDGE_DIMENSIONS=LLM_DIMENSIONS;
export const JudgeDimensionSchema=z.enum(JUDGE_DIMENSIONS);
export type JudgeDimension=z.infer<typeof JudgeDimensionSchema>;
const labels:Record<JudgeDimension,string>={outcome:'结果',trajectory:'过程',evidence:'证据'};
const mapping=[{variable:'packet',source:'metadata',jsonPath:'$.evalJudgePacket'}];
const output={dataType:'CATEGORICAL',categories:['pass','fail','unknown'],shouldAllowMultipleMatches:false,
  scoreValueInstructions:'Aggregate only the assigned findings: fail > unknown > pass. No numeric grading.',
  scoreReasoningInstructions:'scoreExplanation is a JSON-encoded STRING containing subjectSha256, scenario, dimension, role, findings, concerns, and dateChecks for evidence_audit. Apply only this Judge dimension in the frozen packet.rubric.'};
const EvaluatorSchema=z.object({id:z.string(),name:z.string(),versionId:z.string(),version:z.number().optional(),type:z.literal('llm_as_judge'),
  prompt:z.union([z.string(),z.array(z.object({role:z.string(),content:z.string()}))]),modelConfig:z.object({provider:z.string(),model:z.string()}).passthrough().nullable(),
  variableMapping:z.array(z.object({variable:z.string(),source:z.string(),jsonPath:z.string().nullable().optional()}).passthrough()).nullable(),
  outputDefinition:z.object({dataType:z.string(),categories:z.array(z.string()).optional(),shouldAllowMultipleMatches:z.boolean().optional()}).passthrough()}).passthrough();
export type DimensionEvaluator=z.infer<typeof EvaluatorSchema>;

export function scenarioForCase(caseId:string,explicit?:EvalScenario):EvalScenario|undefined {
  if(explicit)return explicit;
  if(caseId.startsWith('activation-'))return 'activation';
  if(caseId.startsWith('core-'))return 'core_logic';
  if(caseId.startsWith('resilience-'))return 'resilience';
  if(caseId.startsWith('artifact-'))return 'artifact_quality';
  return undefined;
}
export function dimensionJudgePrompt(dimension:JudgeDimension):string {
  const root=new URL('../../evals/judges/',import.meta.url);
  return readFileSync(fileURLToPath(new URL(dimension+'.md',root)),'utf8').trim()+'\n\n'+readFileSync(fileURLToPath(new URL('common.md',root)),'utf8').trim()+'\n\nPacket:\n{{packet}}';
}
function promptText(prompt:DimensionEvaluator['prompt']):string {return typeof prompt==='string'?prompt:prompt.map(message=>message.content).join('\n');}
function validateContract(evaluator:DimensionEvaluator):void {
  if(evaluator.variableMapping?.length!==1||evaluator.variableMapping[0].variable!=='packet'||evaluator.variableMapping[0].source!=='metadata'||evaluator.variableMapping[0].jsonPath!=='$.evalJudgePacket'||
    evaluator.outputDefinition.dataType!=='CATEGORICAL'||JSON.stringify([...(evaluator.outputDefinition.categories??[])].sort())!==JSON.stringify(['fail','pass','unknown'])||evaluator.outputDefinition.shouldAllowMultipleMatches===true||!promptText(evaluator.prompt).includes('{{packet}}'))throw Error('dimension_judge_contract_changed: '+evaluator.name);
}
/** Result/process/evidence are Judge responsibilities. The four scenarios are only Case context. */
export async function ensureDimensionJudge(client:LangfuseClient,dimension:JudgeDimension,options:{updatePrompts?:boolean}={}):Promise<DimensionEvaluator> {
  const name='cwatch.judge.'+dimension;
  const existing=z.array(z.object({id:z.string(),name:z.string()}).passthrough()).parse(await client.cursorPages('/api/public/v2/evaluators')).filter(row=>row.name===name);
  if(existing.length>1)throw Error('ambiguous_dimension_judge: '+name);
  const previous=existing[0]?EvaluatorSchema.parse(await client.request('/api/public/v2/evaluators/'+encodeURIComponent(existing[0].id))):undefined;
  if(previous&&!options.updatePrompts){validateContract(previous);return previous;}
  const model=readJudgeConfig(),prompt=dimensionJudgePrompt(dimension),modelConfig={provider:model.provider,model:model.modelId};
  const definition={type:'llm_as_judge',prompt,modelConfig,variableMapping:mapping,outputDefinition:output};
  if(previous){
    const matches=promptText(previous.prompt)===prompt&&previous.modelConfig?.provider===modelConfig.provider&&previous.modelConfig.model===modelConfig.model&&
      JSON.stringify(previous.variableMapping?.map(({variable,source,jsonPath})=>({variable,source,jsonPath})))===JSON.stringify(mapping)&&
      Object.entries(output).every(([key,value])=>JSON.stringify(previous.outputDefinition[key])===JSON.stringify(value));
    if(matches){validateContract(previous);return previous;}
    const updated=EvaluatorSchema.parse(await client.request('/api/public/v2/evaluators/'+encodeURIComponent(previous.id),definition,{},'PATCH',120000));
    if(updated.id!==previous.id)throw Error('dimension_judge_identity_changed');validateContract(updated);return updated;
  }
  const created=EvaluatorSchema.parse(await client.request('/api/public/v2/evaluators',{...definition,name,description:labels[dimension]+'维度共享评委。四类场景共用此评委；具体 Case 规则与场景上下文由 packet 传入。只判定本维度，分数由原扣分程序计算。'},{},'POST',120000));
  validateContract(created);return created;
}
export async function ensureDimensionJudges(client:LangfuseClient,options:{updatePrompts?:boolean}={}){
  const result=[];
  for(const dimension of JUDGE_DIMENSIONS){const evaluator=await ensureDimensionJudge(client,dimension,options);result.push({dimension,label:labels[dimension],id:evaluator.id,name:evaluator.name,versionId:evaluator.versionId,version:evaluator.version,model:evaluator.modelConfig});}
  return result;
}
export async function retireScenarioJudges(client:LangfuseClient){
  const rows=z.array(z.object({id:z.string(),name:z.string()}).passthrough()).parse(await client.cursorPages('/api/public/v2/evaluators')),retired=[];
  for(const scenario of EVAL_SCENARIOS){
    const matches=rows.filter(row=>row.name==='cwatch.judge.'+scenario);if(matches.length>1)throw Error('ambiguous_legacy_scenario_judge');
    if(!matches.length)continue;
    const record=z.object({evaluationRuleAssignments:z.array(z.unknown()).optional()}).passthrough().parse(await client.request('/api/public/v2/evaluators/'+encodeURIComponent(matches[0].id)));
    if(record.evaluationRuleAssignments?.length)throw Error('legacy_scenario_judge_has_active_assignments');
    const name='cwatch.legacy.scenario.'+scenario;
    if(rows.some(row=>row.name===name))throw Error('legacy_scenario_name_conflict');
    await client.request('/api/public/v2/evaluators/'+encodeURIComponent(matches[0].id),{name,description:'已弃用：此前误按场景拆分的评委。保留记录，不用于新评测。当前统一使用结果、过程、证据三个评分角度。'},{},'PATCH');
    retired.push({id:matches[0].id,oldName:matches[0].name,name});
  }
  return retired;
}
/** Each scoring input binds one real execution and its frozen rubric; prompts contain no Case/run IDs. */
export function scenarioJudgePacket(subject:QualitySubject,scenario:EvalScenario|null,role:'primary'|'evidence_audit'){
  const rubric=subject.packet.rubric;
  const facts:Record<string,unknown>=subject.packet.observedFacts;
  const focused=role==='evidence_audit'&&rubric?{...rubric,criteria:rubric.criteria.filter(c=>c.dimension==='evidence')}:rubric;
  return {...subject.packet,subjectSha256:subject.subjectSha256,evalScenario:scenario,judgeRole:role,rubric:focused,
    scenarioInstructions:scenario?readFileSync(fileURLToPath(new URL('../../evals/judges/'+scenario+'.md',import.meta.url)),'utf8'):null,
    ...(role==='evidence_audit'?{llmDimensions:['evidence'],observedFacts:{skillReads:facts.skillReads,toolRequestCount:facts.toolRequestCount,externalSourceCallCount:facts.externalSourceCallCount}}:{}),
    dateMentions:[...(subject.packet.finalAnswer??'').matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match=>({offset:match.index,date:match[0]}))};
}
