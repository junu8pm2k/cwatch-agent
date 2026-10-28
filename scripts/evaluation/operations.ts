import { readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaseSchema, type EvalCase } from './contracts.ts';
import { sha256, within, readStructured } from './dataset.ts';
import { collectProjection, grade, verifyInventory, preserveControllerFailures, type EvalResult, type ArtifactDigest } from './grader.ts';
import type { WorkerObservation } from './contracts.ts';

interface EvidenceManifest{caseSha256:string;frozenCaseRef:string;evidence:ArtifactDigest[];restrictedEvidence?:Array<{ref:string;sha256:string}>}
interface ArchivedReport{results:EvalResult[];artifacts:Array<{caseId:string;attempt:number;directory:string;manifestSha256:string}>}
export function readArchivedCase(reportFile:string,caseId:string,attempt=1){
  const reportPath=realpathSync(reportFile),batch=dirname(reportPath),out=dirname(batch),report=JSON.parse(readFileSync(reportPath,'utf8')) as ArchivedReport;
  const item=report.artifacts.find(r=>r.caseId===caseId&&r.attempt===attempt);if(!item)throw Error('archived_case_not_found');
  const directory=realpathSync(resolve(out,item.directory));if(!within(batch,directory))throw Error('archived_case_path_escape');
  const manifestPath=join(directory,'manifest.json');if(sha256(readFileSync(manifestPath))!==item.manifestSha256)throw Error('manifest_integrity_failure');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as EvidenceManifest;
  const errors=verifyInventory(directory,manifest.evidence);if(errors.length)throw Error('evidence_integrity_failure: '+errors.join(','));
  for(const raw of manifest.restrictedEvidence??[]){const path=realpathSync(resolve(directory,raw.ref));
    if(!within(batch,path)||sha256(readFileSync(path))!==raw.sha256)throw Error('restricted_evidence_integrity_failure');}
  const source=realpathSync(resolve(directory,manifest.frozenCaseRef));if(!within(join(batch,'private'),source))throw Error('frozen_case_path_escape');
  if(sha256(readFileSync(source))!==manifest.caseSha256)throw Error('frozen_case_integrity_failure');
  const value=CaseSchema.parse(readStructured(source));if(value.id!==caseId)throw Error('frozen_case_identity_mismatch');
  return{directory,value,report,reportPath,batch};
}
export function regradeArchivedCase(reportFile:string,caseId:string,attempt=1){
  const archived=readArchivedCase(reportFile,caseId,attempt);
  const observation=JSON.parse(readFileSync(join(archived.directory,'observed.json'),'utf8')) as WorkerObservation;
  const projection=collectProjection(archived.directory,observation,archived.value.expected_final.outputContract,archived.value.expected_final.reportContract),result=grade(archived.value,projection,attempt);
  preserveControllerFailures(result,archived.report.results.find(r=>r.caseId===caseId&&r.attempt===attempt)?.failures??[]);
  const revision=randomUUID(),projectionName='projection.regrade-'+revision+'.json',projectionPath=join(archived.directory,projectionName);
  writeFileSync(projectionPath,JSON.stringify(projection,null,2)+'\n',{flag:'wx'});
  for(const check of result.checks)for(const evidence of check.evidence)if(evidence.artifact==='projection.json')evidence.artifact=projectionName;
  for(const deduction of result.penalty?.deductions??[])for(const evidence of deduction.evidence)if(evidence.artifact==='projection.json')evidence.artifact=projectionName;
  const path=join(archived.directory,'regrade-'+revision+'.json');
  writeFileSync(path,JSON.stringify({result,projection:{path:projectionName,sha256:sha256(readFileSync(projectionPath))},originalReportSha256:sha256(readFileSync(archived.reportPath)),gradedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  return{path,result};
}
/** Candidate intake only. A production label is never inferred from a development evaluation. */
export function collectFailureCandidate(reportFile:string,caseId:string,workspace=process.cwd(),attempt=1){
  const archived=readArchivedCase(reportFile,caseId,attempt),prior=archived.report.results.find(r=>r.caseId===caseId&&r.attempt===attempt);
  if(!prior||prior.verdict!=='fail'||!prior.runId)throw Error('only_confirmed_sut_failures_can_be_collected');
  const observed=JSON.parse(readFileSync(join(archived.directory,'observed.json'),'utf8')) as WorkerObservation;
  const current=grade(archived.value,collectProjection(archived.directory,observed,archived.value.expected_final.outputContract,archived.value.expected_final.reportContract),attempt);
  preserveControllerFailures(current,prior.failures);
  if(current.verdict!=='fail')throw Error('failure_not_confirmed_by_current_grader');
  const candidate:EvalCase=structuredClone(archived.value);
  candidate.id=caseId.slice(0,60)+'-failure-'+randomUUID().slice(0,8);candidate.revision=1;candidate.status='needs_review';candidate.oracle.review=null;
  candidate.origin={layer:'observed_failure',environment:'development_acceptance',originalRunId:prior.runId,parentCaseIds:[caseId],author:'failure-intake'};
  candidate.oracle.references.push('archived-run:'+prior.runId,'failure-codes:'+current.failures.join(','));
  candidate.oracle.knownLimits.push('Collected from an evaluation failure, not production traffic. Parent criteria retained as a candidate and require human confirmation.');
  CaseSchema.parse(candidate);
  const target=resolve(workspace,'evals/candidates');mkdirSync(target,{recursive:true});
  if(!within(realpathSync(workspace),realpathSync(target)))throw Error('candidate_output_escape');
  const path=join(target,candidate.id+'.json');writeFileSync(path,JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
  return{path,id:candidate.id,status:candidate.status,registeredInDataset:false};
}
