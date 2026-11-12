import { z } from 'zod';
import { HumanScoreSchema, RUBRIC, validateLlmAnswer, type QualityAnswer, type QualitySubject } from './quality.ts';
import { EvalScenarioSchema, JudgeDimensionSchema } from './langfuse-judges.ts';

export const PlatformScoreSchema=z.object({id:z.string(),projectId:z.string(),name:z.string(),source:z.string(),value:z.unknown(),
  timestamp:z.string(),updatedAt:z.string(),comment:z.string().nullable().optional(),configId:z.string().nullable().optional(),
  authorUserId:z.string().nullable().optional(),queueId:z.string().nullable().optional(),metadata:z.record(z.string(),z.unknown()).nullable().optional(),
  subject:z.object({kind:z.string(),id:z.string(),traceId:z.string().optional()}).passthrough().nullable().optional()}).passthrough();
export type PlatformScore=z.infer<typeof PlatformScoreSchema>;
const verdict=z.enum(['pass','fail','unknown']);
export const HumanSlotSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('process'),criterionId:z.string(),configId:z.string(),name:z.string()}),
  z.object({kind:z.literal('safety'),requirementId:z.string(),configId:z.string(),name:z.string()}),
]);
export type HumanSlot=z.infer<typeof HumanSlotSchema>;
export const RejectionSlotSchema=z.object({criterionId:z.string(),configId:z.string(),name:z.string()});
export type RejectionSlot=z.infer<typeof RejectionSlotSchema>;
export const NativeSlotSchema=z.object({criterionId:z.string().optional(),evaluatorId:z.string(),versionId:z.string(),name:z.string(),role:z.enum(['primary','evidence_audit']),
  contract:z.enum(['criterion','scenario','dimension']).optional(),scenario:EvalScenarioSchema.optional(),dimension:JudgeDimensionSchema.optional(),observationId:z.string().optional(),
  reviewInput:z.object({kind:z.literal('host_review_retry'),rootObservationId:z.string(),subjectSha256:z.string().regex(/^[a-f0-9]{64}$/),packetSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional()}).superRefine((value,ctx)=>{
  if(value.contract==='dimension'?(!value.dimension||!value.scenario||!value.observationId):value.contract==='scenario'?(!value.scenario||!value.observationId):!value.criterionId)ctx.addIssue({code:'custom',message:'Native binding must declare its criterion or dimension observation'});
  if(value.reviewInput&&(value.contract!=='dimension'||value.role!=='primary'||value.dimension!=='trajectory'))ctx.addIssue({code:'custom',message:'Host review retry is explicitly scoped to the primary trajectory input'});
});
export type NativeSlot=z.infer<typeof NativeSlotSchema>;
export interface ReviewTarget {projectId:string;traceId:string;observationId:string}
export class ReviewPending extends Error {}
export function onTarget(score:PlatformScore,target:ReviewTarget):boolean {
  return score.projectId===target.projectId&&score.subject?.kind==='observation'&&score.subject.id===target.observationId&&score.subject.traceId===target.traceId;
}
function latest(rows:PlatformScore[]):PlatformScore|undefined {
  return [...rows].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id)).at(-1);
}
/** Human comments remain readable: explain the verdict and cite [task], [rules], [trace:7], etc. */
export function parseReviewComment(comment:string|null|undefined,allowed:ReadonlySet<string>):{reason:string;evidence:string[]} {
  if(!comment?.trim())throw new ReviewPending('请为人工判定填写理由及证据引用');
  let reason:string,evidence:string[];
  if(comment.trim().startsWith('{')){
    const value=z.object({reason:z.string().trim().min(1),evidence:z.array(z.string()).min(1).max(20)}).strict().parse(JSON.parse(comment));
    ({reason,evidence}=value);
  }else{
    evidence=[...new Set([...comment.matchAll(/\[([^\[\]\r\n]+)\]/g)].map(match=>match[1]))];
    reason=comment.replace(/\[[^\[\]\r\n]+\]/g,'').trim();
  }
  if(!reason||!evidence.length||evidence.length>20)throw new ReviewPending('人工判定需要具体理由和至少一个 [证据引用]');
  if(evidence.some(ref=>!allowed.has(ref)))throw new ReviewPending('人工证据引用不在该次执行的证据清单中');
  return {reason,evidence};
}
export function resolveHumanReview(subject:QualitySubject,target:ReviewTarget,queue:{id:string;completed:boolean},slots:HumanSlot[],raw:unknown[]){
  if(!queue.completed)throw new ReviewPending('等待人工完成标注队列中的该条任务');
  const rows=raw.map(row=>PlatformScoreSchema.parse(row)).filter(row=>onTarget(row,target)&&row.source==='ANNOTATION'&&row.queueId===queue.id);
  const selected=slots.map(slot=>{
    const candidates=rows.filter(row=>row.configId===slot.configId&&row.name===slot.name);
    const authors=new Set(candidates.map(row=>row.authorUserId).filter(Boolean));
    if(authors.size>1)throw new ReviewPending('同一条目有多位审核者，请先人工裁定；不会自动取多数票');
    const score=latest(candidates);
    if(!score?.authorUserId)throw new ReviewPending('等待有真实审核者身份的人工标注：'+slot.name);
    const finding={verdict:verdict.parse(score.value),...parseReviewComment(score.comment,subject.references)};
    const required=slot.kind==='process'?subject.packet.rubric?.criteria.find(c=>c.processCriterionId===slot.criterionId)?.evidenceRequired??[]:['task','trace:<sequence>'];
    if(finding.verdict!=='unknown'&&required.some(kind=>!finding.evidence.some(ref=>kind==='trace:<sequence>'?ref.startsWith('trace:'):ref===kind)))throw new ReviewPending('人工判定缺少必要证据：'+slot.name);
    return{slot,score,finding};
  });
  if(new Set(selected.map(row=>row.score.authorUserId)).size!==1)throw new ReviewPending('各人工条目需由同一审核者完成，避免拼接不同人的意见');
  const processChecks=selected.flatMap(row=>row.slot.kind==='process'?[{criterionId:row.slot.criterionId,...row.finding}]:[]);
  const judgments=subject.packet.humanReview.dimensions.map(dimension=>{
    const findings=selected.filter(row=>dimension==='trajectory'?row.slot.kind==='process':row.slot.kind==='safety').map(row=>row.finding);
    if(!findings.length)throw new ReviewPending('人工条目未覆盖分配的评审维度');
    const value=dimension==='trajectory'&&findings.some(f=>f.verdict==='unknown')?'unknown':findings.some(f=>f.verdict==='fail')?'fail':findings.some(f=>f.verdict==='unknown')?'unknown':'pass';
    return{dimension,verdict:value,reason:findings.map(f=>f.reason).join('\n'),evidence:[...new Set(findings.flatMap(f=>f.evidence))].slice(0,20)};
  });
  const input=HumanScoreSchema.parse({schemaVersion:'cwatch.human-score-input.v5',subjectSha256:subject.subjectSha256,rubricVersion:RUBRIC.version,
    reviewer:'Langfuse user '+selected[0].score.authorUserId,answer:{judgments,processChecks,findings:[],concerns:[]},notes:'Imported from completed Langfuse annotation; original platform scores retained.'});
  return{input,scores:selected.map(row=>row.score)};
}
/** Optional explicit vetoes never convert a human non-rejection into a model pass or erase an older veto. */
export function resolveHumanRejections(subject:QualitySubject,target:ReviewTarget,queue:{id:string;completed:boolean},slots:RejectionSlot[],raw:unknown[]){
  if(!queue.completed)return[];
  const rows=raw.map(row=>PlatformScoreSchema.parse(row)).filter(row=>onTarget(row,target)&&row.source==='ANNOTATION'&&row.queueId===queue.id);
  return slots.flatMap(slot=>{
    const candidates=rows.filter(row=>row.configId===slot.configId&&row.name===slot.name);
    if(new Set(candidates.map(row=>row.authorUserId).filter(Boolean)).size>1)throw new ReviewPending('否决项有多位审核者，需要明确人工裁定');
    const score=latest(candidates);if(!score)return[];
    const value=z.enum(['not_reviewed','no_rejection','reject']).parse(score.value);if(value!=='reject')return[];
    if(!score.authorUserId)throw new ReviewPending('否决需要真实审核者身份');
    const finding={criterionId:slot.criterionId,verdict:'fail' as const,...parseReviewComment(score.comment,subject.references)};
    const criterion=subject.packet.rubric?.criteria.find(c=>c.id===slot.criterionId);
    if(!criterion||!['outcome','evidence'].includes(criterion.dimension))throw Error('human_rejection_criterion_unassigned');
    if(criterion.evidenceRequired.some(kind=>!finding.evidence.some(ref=>kind==='trace:<sequence>'?ref.startsWith('trace:'):ref===kind)))throw new ReviewPending('人工否决缺少必要证据');
    return[{score,input:{schemaVersion:'cwatch.human-rejection-input.v1' as const,subjectSha256:subject.subjectSha256,reviewer:'Langfuse user '+score.authorUserId,
      userStatement:score.comment!,findings:[finding],notes:JSON.stringify({source:'Langfuse ANNOTATION',queueId:queue.id,scoreId:score.id,updatedAt:score.updatedAt})}}];
  });
}
const NativeExplanationSchema=z.object({criterionId:z.string(),reason:z.string().trim().min(1).max(4000),evidence:z.array(z.string()).min(1).max(20),dateChecks:z.array(z.unknown()).optional()}).strict();
const DateCheckSchema=z.object({offset:z.number().int().nonnegative(),date:z.string(),criterionId:z.string().nullable(),
  answerRole:z.enum(['publication','launch','retrieval','availability','other','unknown']),sourceRole:z.enum(['publication','launch','retrieval','availability','other','unknown']),
  assertsEvent:z.boolean(),sourceQuote:z.string().min(1).nullable(),verdict:z.enum(['supported','unsupported','unknown']),reason:z.string().min(1)}).strict();
function applyDateAudit(subject:QualitySubject,findings:QualityAnswer['findings'],raw:unknown):void {
  const dates=z.array(DateCheckSchema).parse(raw??[]),answer=subject.packet.finalAnswer??'';
  const mentions=[...answer.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match=>({offset:match.index,date:match[0]}));
  if(dates.length!==mentions.length||new Set(dates.map(d=>d.offset)).size!==dates.length||mentions.some(m=>!dates.some(d=>d.offset===m.offset&&d.date===m.date)))throw Error('native_evidence_date_audit_incomplete');
  const material=JSON.stringify(subject.packet.task);
  for(const date of dates){
    if(date.sourceQuote&&!material.includes(JSON.stringify(date.sourceQuote).slice(1,-1)))throw Error('native_evidence_date_quote_not_found');
    if(date.verdict==='supported'&&!date.sourceQuote)throw Error('native_evidence_date_support_missing');
    if(date.criterionId===null)continue;
    const finding=findings.find(f=>f.criterionId===date.criterionId);if(!finding)throw Error('native_evidence_date_criterion_unassigned');
    if(date.verdict==='unsupported'||date.assertsEvent&&date.answerRole==='launch'&&date.sourceRole==='publication'){finding.verdict='fail';finding.reason+=' Date '+date.offset+': '+date.reason;}
    else if(date.verdict==='unknown'&&finding.verdict!=='fail'){finding.verdict='unknown';finding.reason+=' Date '+date.offset+': '+date.reason;}
  }
}
const ScenarioExplanationSchema=z.object({subjectSha256:z.string(),scenario:EvalScenarioSchema,role:z.enum(['primary','evidence_audit']),
  findings:z.array(z.object({criterionId:z.string(),verdict,reason:z.string(),evidence:z.array(z.string())}).strict()),
  concerns:z.array(z.enum(['factual_dispute','safety_concern'])),dateChecks:z.array(z.unknown()).optional()}).strict();
const DimensionExplanationSchema=ScenarioExplanationSchema.extend({dimension:JudgeDimensionSchema});
function resolveDimensionReview(subject:QualitySubject,target:ReviewTarget,slots:NativeSlot[],raw:unknown[]):{answer:QualityAnswer;scores:PlatformScore[]} {
  const dimensions=subject.packet.llmDimensions,primary=slots.filter(slot=>slot.role==='primary'),audit=slots.filter(slot=>slot.role==='evidence_audit');
  if(slots.some(slot=>slot.contract!=='dimension'||!slot.dimension)||primary.length!==dimensions.length||dimensions.some(d=>primary.filter(slot=>slot.dimension===d).length!==1)||
    audit.length!==(dimensions.includes('evidence')?1:0)||new Set(primary.map(slot=>slot.evaluatorId)).size!==primary.length)throw Error('dimension_judge_bindings_invalid');
  const evidence=primary.find(slot=>slot.dimension==='evidence');
  const validPrimary=(slot:NativeSlot)=>slot.observationId===target.observationId?!slot.reviewInput:
    Boolean(slot.dimension==='trajectory'&&slot.reviewInput?.kind==='host_review_retry'&&slot.reviewInput.rootObservationId===target.observationId&&
      slot.reviewInput.subjectSha256===subject.subjectSha256&&/^[a-f0-9]{64}$/.test(slot.reviewInput.packetSha256));
  if(primary.some(slot=>!validPrimary(slot))||slots.some(slot=>slot.scenario!==primary[0].scenario)||
    audit.some(slot=>slot.dimension!=='evidence'||slot.observationId===target.observationId||slot.evaluatorId!==evidence?.evaluatorId||slot.versionId!==evidence?.versionId))throw Error('dimension_judge_role_targets_invalid');
  const rows=raw.map(row=>PlatformScoreSchema.parse(row));
  const selected=slots.map(slot=>{
    const score=latest(rows.filter(row=>onTarget(row,{...target,observationId:slot.observationId!})&&row.source==='EVAL'&&row.name===slot.name&&row.metadata?.evaluator_id===slot.evaluatorId&&row.metadata?.evaluator_version_id===slot.versionId));
    if(!score)throw new ReviewPending('等待 '+slot.dimension+' Judge 的 '+slot.role+' 评分');
    const explanation=DimensionExplanationSchema.parse(JSON.parse(score.comment??''));
    if(explanation.subjectSha256!==subject.subjectSha256||explanation.dimension!==slot.dimension||explanation.scenario!==slot.scenario||explanation.role!==slot.role)throw Error('dimension_judge_subject_or_role_mismatch');
    const criteria=subject.packet.rubric!.criteria.filter(c=>c.dimension===slot.dimension);
    const focused:QualitySubject={...subject,packet:{...subject.packet,rubric:{...subject.packet.rubric!,criteria},llmDimensions:[slot.dimension!]}};
    const answer=validateLlmAnswer({findings:explanation.findings,concerns:explanation.concerns},focused);
    const expected=answer.findings.some(f=>f.verdict==='fail')?'fail':answer.findings.some(f=>f.verdict==='unknown')?'unknown':'pass';
    if(score.value!==expected)throw Error('dimension_judge_score_summary_mismatch');
    if(slot.role==='evidence_audit')applyDateAudit(subject,answer.findings,explanation.dateChecks);
    return{slot,score,answer};
  });
  const priority={pass:0,unknown:1,fail:2},second=selected.find(row=>row.slot.role==='evidence_audit')?.answer;
  const findings=selected.filter(row=>row.slot.role==='primary').flatMap(row=>row.answer.findings).map(finding=>{
    const review=second?.findings.find(f=>f.criterionId===finding.criterionId);return review&&priority[review.verdict]>priority[finding.verdict]?review:finding;
  });
  return{answer:validateLlmAnswer({findings,concerns:[...new Set(selected.flatMap(row=>row.answer.concerns))]},subject),scores:selected.map(row=>row.score)};
}
function resolveScenarioReview(subject:QualitySubject,target:ReviewTarget,slots:NativeSlot[],raw:unknown[]):{answer:QualityAnswer;scores:PlatformScore[]} {
  const primarySlots=slots.filter(slot=>slot.role==='primary'),auditSlots=slots.filter(slot=>slot.role==='evidence_audit');
  const evidenceCriteria=subject.packet.rubric?.criteria.filter(c=>c.dimension==='evidence')??[];
  if(slots.some(slot=>slot.contract!=='scenario')||primarySlots.length!==1||auditSlots.length!==(evidenceCriteria.length?1:0))throw Error('scenario_judge_bindings_invalid');
  const primary=primarySlots[0];
  if(primary.observationId!==target.observationId||slots.some(slot=>slot.scenario!==primary.scenario||slot.evaluatorId!==primary.evaluatorId||slot.versionId!==primary.versionId)||auditSlots.some(slot=>slot.observationId===primary.observationId))throw Error('scenario_judge_role_targets_invalid');
  const rows=raw.map(row=>PlatformScoreSchema.parse(row));
  const selected=slots.map(slot=>{
    const score=latest(rows.filter(row=>onTarget(row,{...target,observationId:slot.observationId!})&&row.source==='EVAL'&&row.name===slot.name&&row.metadata?.evaluator_id===slot.evaluatorId&&row.metadata?.evaluator_version_id===slot.versionId));
    if(!score)throw new ReviewPending('等待场景 Judge 的 '+slot.role+' 评分：'+slot.name);
    const explanation=ScenarioExplanationSchema.parse(JSON.parse(score.comment??''));
    if(explanation.subjectSha256!==subject.subjectSha256||explanation.scenario!==slot.scenario||explanation.role!==slot.role)throw Error('scenario_judge_subject_or_role_mismatch');
    const focused:QualitySubject=slot.role==='evidence_audit'?{...subject,packet:{...subject.packet,rubric:{...subject.packet.rubric!,criteria:evidenceCriteria},llmDimensions:['evidence']}}:subject;
    const answer=validateLlmAnswer({findings:explanation.findings,concerns:explanation.concerns},focused);
    const expected=answer.findings.some(f=>f.verdict==='fail')?'fail':answer.findings.some(f=>f.verdict==='unknown')?'unknown':'pass';
    if(score.value!==expected)throw Error('scenario_judge_score_summary_mismatch');
    if(slot.role==='evidence_audit')applyDateAudit(subject,answer.findings,explanation.dateChecks);
    return{slot,score,answer};
  });
  const result=selected.find(row=>row.slot.role==='primary')!.answer,audit=selected.find(row=>row.slot.role==='evidence_audit')?.answer;
  const priority={pass:0,unknown:1,fail:2};
  const findings=result.findings.map(finding=>{
    const second=audit?.findings.find(row=>row.criterionId===finding.criterionId);return second&&priority[second.verdict]>priority[finding.verdict]?second:finding;
  });
  return{answer:validateLlmAnswer({findings,concerns:[...new Set([...result.concerns,...(audit?.concerns??[])])]},subject),scores:selected.map(row=>row.score)};
}
/** Version-pinned platform findings go through the original frozen-rubric validator. */
export function resolveNativeReview(subject:QualitySubject,target:ReviewTarget,slots:NativeSlot[],raw:unknown[]):{answer:QualityAnswer;scores:PlatformScore[]} {
  if(slots.some(slot=>slot.contract==='dimension'))return resolveDimensionReview(subject,target,slots,raw);
  if(slots.some(slot=>slot.contract==='scenario'))return resolveScenarioReview(subject,target,slots,raw);
  const criteria=subject.packet.rubric?.criteria??[];
  if(slots.filter(slot=>slot.role==='primary').length!==criteria.length||criteria.some(c=>slots.filter(slot=>slot.role==='primary'&&slot.criterionId===c.id).length!==1))throw Error('native_bindings_must_cover_frozen_rubric');
  const evidenceIds=new Set(criteria.filter(c=>c.dimension==='evidence').map(c=>c.id));
  if([...evidenceIds].some(id=>!slots.some(slot=>slot.role==='evidence_audit'&&slot.criterionId===id)))throw Error('independent_evidence_audit_required');
  if(slots.some(slot=>!slot.criterionId||!criteria.some(c=>c.id===slot.criterionId)||(slot.role==='evidence_audit'&&!evidenceIds.has(slot.criterionId))))throw Error('native_binding_criterion_unassigned');
  const rows=raw.map(row=>PlatformScoreSchema.parse(row));
  const selected=slots.map(slot=>{
    const score=latest(rows.filter(row=>onTarget(row,target)&&row.source==='EVAL'&&row.name===slot.name&&row.metadata?.evaluator_id===slot.evaluatorId&&row.metadata?.evaluator_version_id===slot.versionId));
    if(!score)throw new ReviewPending('等待指定版本的 Langfuse Judge：'+slot.name);
    const explanation=NativeExplanationSchema.parse(JSON.parse(score.comment??''));
    if(explanation.criterionId!==slot.criterionId)throw Error('native_score_criterion_mismatch');
    const finding={criterionId:explanation.criterionId,verdict:verdict.parse(score.value),reason:explanation.reason,evidence:explanation.evidence};
    const criterion=criteria.find(c=>c.id===slot.criterionId)!;
    validateLlmAnswer({findings:[finding],concerns:[]},{...subject,packet:{...subject.packet,rubric:{...subject.packet.rubric!,criteria:[criterion]},llmDimensions:[criterion.dimension]}});
    if(slot.role==='evidence_audit'){
      applyDateAudit(subject,[finding],explanation.dateChecks);
    }
    return{slot,score,finding};
  });
  const priority={pass:0,unknown:1,fail:2};
  const findings=criteria.map(c=>selected.filter(row=>row.slot.criterionId===c.id).sort((a,b)=>priority[b.finding.verdict]-priority[a.finding.verdict])[0].finding);
  return{answer:validateLlmAnswer({findings,concerns:[]},subject),scores:selected.map(row=>row.score)};
}
