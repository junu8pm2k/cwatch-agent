import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonHash, QualityAnswerSchema, validateQualityAnswer, listAssessments, type QualitySubject } from './quality.ts';
import { scorePenalty } from './penalty.ts';
import { automaticAssessment } from './automatic.ts';
import { within } from './dataset.ts';

const verdict=z.enum(['pass','fail','unknown']);
export const DelegatedReviewInputSchema=z.object({
  schemaVersion:z.literal('cwatch.ai-delegated-review.v1'),subjectSha256:z.string().regex(/^[a-f0-9]{64}$/),
  reviewer:z.object({kind:z.literal('ai_delegate'),name:z.string().min(1),authorization:z.string().min(1)}).strict(),
  humanConfirmed:z.literal(false),baselineConfirmed:z.literal(false),
  audit:z.object({verdict,reason:z.string().min(1).max(8000),evidence:z.array(z.string()).min(1),notes:z.array(z.string()).default([])}).strict(),
  assignedReview:QualityAnswerSchema.nullable(),
}).strict();
export type DelegatedReviewInput=z.infer<typeof DelegatedReviewInputSchema>;

/** This is a separate AI record, never an Assessment(kind=human) or a Langfuse ANNOTATION. */
export function saveDelegatedReview(subject:QualitySubject,raw:unknown){
  const input=DelegatedReviewInputSchema.parse(raw);
  if(input.subjectSha256!==subject.subjectSha256)throw Error('delegated_review_subject_mismatch');
  if(input.audit.evidence.some(ref=>!subject.references.has(ref)))throw Error('delegated_review_unknown_evidence');
  if(subject.humanApplicable){
    validateQualityAnswer(input.assignedReview,subject,'human');
    for(const finding of input.assignedReview!.processChecks){
      const criterion=subject.packet.rubric!.criteria.find(c=>c.processCriterionId===finding.criterionId)!;
      if(finding.verdict!=='unknown'&&criterion.evidenceRequired.some(kind=>!finding.evidence.some(ref=>kind==='trace:<sequence>'?ref.startsWith('trace:'):ref===kind)))throw Error('delegated_review_required_evidence_missing');
    }
  }else if(input.assignedReview!==null)throw Error('delegated_review_unassigned_human_dimension');
  const directory=join(subject.archive.batch,'ai-delegated-reviews',subject.packet.caseId+'-'+subject.subjectSha256.slice(0,12));mkdirSync(directory,{recursive:true});
  if(!within(realpathSync(subject.archive.batch),realpathSync(directory)))throw Error('delegated_review_path_escape');
  const path=join(directory,'review.json'),inputSha256=jsonHash(input);
  if(existsSync(path)){
    const previous=z.object({createdAt:z.string().datetime(),inputSha256:z.string(),input:DelegatedReviewInputSchema}).strict().parse(JSON.parse(readFileSync(path,'utf8')));
    if(previous.inputSha256!==inputSha256||jsonHash(previous.input)!==previous.inputSha256)throw Error('delegated_review_immutable_conflict');
    return {path,record:previous};
  }
  const record={createdAt:new Date().toISOString(),inputSha256,input};writeFileSync(path,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  return {path,record};
}

/** Reuses the original deduction algorithm, while preserving the different reviewer provenance. */
export function assessDelegatedReview(subject:QualitySubject,raw:unknown){
  const saved=saveDelegatedReview(subject,raw),input=saved.record.input,records=listAssessments(subject);
  const llm=records.filter(r=>r.kind==='llm').at(-1)??null;
  const rubric=llm?.status==='completed'&&llm.answer?{recordRef:'assessments/'+llm.id+'/record.json',...llm.answer}:null;
  const manual=input.assignedReview?{recordRef:saved.path,...input.assignedReview}:null;
  const rules=subject.packet.rules,penalty=scorePenalty(subject.archive.value,rules.checks,{durationMs:rules.durationMs},{rubric,human:manual});
  const automatic=automaticAssessment(subject.archive.value,rules.checks,rules.durationMs,llm,null);
  const reviewDisagreement=input.audit.verdict==='fail'&&penalty.score!==null&&penalty.score>0;
  const score=reviewDisagreement?null:penalty.score;
  return {schemaVersion:'cwatch.ai-delegated-result.v1',scope:'ai_delegated_review',humanConfirmed:false,baselineConfirmed:false,
    caseId:subject.packet.caseId,revision:subject.packet.caseRevision,runId:subject.packet.runId,subjectSha256:subject.subjectSha256,
    review:saved.path,reviewer:input.reviewer,audit:input.audit,assignedReview:input.assignedReview,
    automaticScore:automatic.score,score,verdict:reviewDisagreement?'needs_adjudication':score===0?'fail':penalty.complete&&penalty.passed?'pass':'needs_review',
    penalty,reviewDisagreement,llmStatus:llm?.status??(subject.llmApplicable?'missing':'not_applicable'),llmError:llm?.error??null,
    note:'User-authorized AI substitute review. No human annotation, human baseline confirmation or regression qualification is implied.'};
}
