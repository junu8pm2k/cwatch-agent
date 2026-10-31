import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { QualitySubject } from './quality.ts';
import type { PenaltyTrial } from './penalty.ts';
import { sha256, within } from './dataset.ts';
import { inventory, verifyInventory } from './grader.ts';

/** An explicit human rejection is separate from the original model assessment. */
export const HumanRejectionSchema = z.object({
  schemaVersion: z.literal('cwatch.human-rejection-input.v1'), subjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewer: z.string().trim().min(1).max(100).refine(s=>!/[\x00-\x1f\x7f]/.test(s)), userStatement: z.string().trim().min(1).max(4000),
  findings: z.array(z.object({ criterionId: z.string().min(1), verdict: z.literal('fail'),
    reason: z.string().trim().min(1).max(4000), evidence: z.array(z.string().min(1)).min(1).max(20) }).strict()).min(1).max(64),
  notes: z.string().max(8000).default(''),
}).strict();
const RecordSchema = z.object({schemaVersion:z.literal('cwatch.human-rejection.v1'),id:z.string().uuid(),
  createdAt:z.string().datetime(),caseId:z.string(),runId:z.string(),attempt:z.number().int().positive(),
  input:HumanRejectionSchema,inputSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type HumanRejection = z.infer<typeof RecordSchema>;
function validate(subject:QualitySubject,raw:unknown){
  const input=HumanRejectionSchema.parse(raw);
  if(input.subjectSha256!==subject.subjectSha256)throw Error('human_rejection_subject_mismatch');
  if(new Set(input.findings.map(f=>f.criterionId)).size!==input.findings.length)throw Error('duplicate_human_rejection_criterion');
  for(const finding of input.findings){
    const criterion=subject.packet.rubric?.criteria.find(c=>c.id===finding.criterionId);
    if(!criterion||!['outcome','evidence'].includes(criterion.dimension))throw Error('human_rejection_requires_assigned_outcome_or_evidence_criterion');
    if(finding.evidence.some(ref=>!subject.references.has(ref)))throw Error('unknown_human_rejection_evidence');
    if(criterion.evidenceRequired.some(kind=>!finding.evidence.some(ref=>kind==='trace:<sequence>'?ref.startsWith('trace:'):ref===kind)))throw Error('human_rejection_required_evidence_missing');
  }
  return input;
}
const encode=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
export function saveHumanRejection(subject:QualitySubject,raw:unknown){
  const input=validate(subject,raw),root=join(subject.archive.batch,'human-adjudications');
  mkdirSync(root,{recursive:true});
  if(!within(realpathSync(subject.archive.batch),realpathSync(root)))throw Error('human_rejection_path_escape');
  const record=RecordSchema.parse({schemaVersion:'cwatch.human-rejection.v1',id:randomUUID(),createdAt:new Date().toISOString(),
    caseId:subject.packet.caseId,runId:subject.packet.runId,attempt:subject.packet.attempt,input,inputSha256:sha256(JSON.stringify(input))});
  const directory=join(root,record.id);mkdirSync(directory);
  const path=join(directory,'record.json');writeFileSync(path,encode(record),{flag:'wx'});
  writeFileSync(join(directory,'subject.json'),encode(subject.packet),{flag:'wx'});
  writeFileSync(join(directory,'manifest.json'),encode({evidence:inventory(directory)}),{flag:'wx'});
  return{path,record};
}
export function listHumanRejections(subject:QualitySubject):HumanRejection[]{
  const root=join(subject.archive.batch,'human-adjudications');if(!existsSync(root))return[];
  if(!within(realpathSync(subject.archive.batch),realpathSync(root)))throw Error('human_rejection_path_escape');
  const records:HumanRejection[]=[];
  for(const name of readdirSync(root)){
    const directory=realpathSync(join(root,name));if(!within(realpathSync(root),directory))throw Error('human_rejection_path_escape');
    const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
    if(!Array.isArray(manifest.evidence)||!['record.json','subject.json'].every(path=>manifest.evidence.some((e:{path:string})=>e.path===path))||verifyInventory(directory,manifest.evidence).length)throw Error('human_rejection_integrity_failure');
    const record=RecordSchema.parse(JSON.parse(readFileSync(join(directory,'record.json'),'utf8')));
    const packet=JSON.parse(readFileSync(join(directory,'subject.json'),'utf8'));
    if(record.id!==name||sha256(JSON.stringify(record.input))!==record.inputSha256||sha256(JSON.stringify(packet))!==record.input.subjectSha256)throw Error('human_rejection_integrity_failure');
    if(record.input.subjectSha256!==subject.subjectSha256)continue;
    if(record.caseId!==subject.packet.caseId||record.runId!==subject.packet.runId||record.attempt!==subject.packet.attempt)throw Error('human_rejection_identity_mismatch');
    validate(subject,record.input);records.push(record);
  }
  return records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}
export function applyHumanRejections(subject:QualitySubject,penalty:PenaltyTrial,records:HumanRejection[]){
  if(!records.length)return;
  const dimensions=new Set<'outcome'|'evidence'>(),ids:string[]=[],reasons:string[]=[],evidence:Array<{artifact:string;path:string}>=[];
  for(const record of records)for(const [index,finding]of record.input.findings.entries()){
    const criterion=subject.packet.rubric!.criteria.find(c=>c.id===finding.criterionId)!;
    dimensions.add(criterion.dimension as 'outcome'|'evidence');ids.push('human:'+finding.criterionId);reasons.push(finding.reason);
    evidence.push({artifact:'human-adjudications/'+record.id+'/record.json',path:'input.findings.'+index});
  }
  const existing=penalty.deductions.find(d=>d.group==='result:veto');
  if(existing){existing.dimensions=[...new Set([...existing.dimensions,...dimensions])];existing.checkIds=[...new Set([...existing.checkIds,...ids])];existing.reason+='; Human rejection: '+reasons.join('; ');existing.evidence.push(...evidence);}
  else penalty.deductions.push({group:'result:veto',category:'result',dimensions:[...dimensions],item:'task_result',units:1,points:-100,
    checkIds:ids,reason:'Human rejection: '+reasons.join('; '),evidence});
  penalty.score=0;penalty.resultDeduction=-100;penalty.passed=false;penalty.hardBoundaryFailed ||= dimensions.has('evidence');
  // Other unreviewed dimensions remain unknown; rejection never fabricates their approval.
}
