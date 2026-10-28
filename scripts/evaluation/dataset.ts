import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { CaseSchema, DatasetSchema, type EvalCase } from './contracts.ts';

export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function within(root:string,path:string):boolean{const rel=relative(root,path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
export function readStructured(path:string):unknown{
  const bytes=readFileSync(path);if(bytes.length>1_000_000)throw Error('eval_file_too_large');
  if(path.endsWith('.json'))return JSON.parse(bytes.toString('utf8'));
  const doc=parseDocument(bytes.toString('utf8'),{uniqueKeys:true});if(doc.errors.length)throw Error('invalid_eval_yaml: '+doc.errors[0].message);
  return doc.toJS({maxAliasCount:32});
}
export interface LoadedCase{value:EvalCase;file:string;sha256:string}
export function validateLineage(cases:EvalCase[]):void{
  const byId=new Map(cases.map(c=>[c.id,c]));if(byId.size!==cases.length)throw Error('duplicate_case_id');
  const familySplit=new Map<string,string>(),visiting=new Set<string>(),done=new Set<string>();
  for(const c of cases){if(familySplit.has(c.familyId)&&familySplit.get(c.familyId)!==c.split)throw Error('family_split_leakage');familySplit.set(c.familyId,c.split);}
  function visit(c:EvalCase):void{
    if(visiting.has(c.id))throw Error('lineage_cycle');if(done.has(c.id))return;visiting.add(c.id);
    for(const p of c.origin.parentCaseIds){const parent=byId.get(p);if(!parent)throw Error('missing_parent_case');
      if(parent.status==='retired'&&c.status!=='retired')throw Error('active_case_uses_retired_parent');
      if(parent.familyId!==c.familyId||parent.split!==c.split)throw Error('lineage_family_or_split_mismatch');visit(parent);}
    visiting.delete(c.id);done.add(c.id);
  }
  cases.forEach(visit);
}
export function loadDataset(file:string,workspace=process.cwd()){
  const absolute=realpathSync(file),base=dirname(absolute),manifest=DatasetSchema.parse(readStructured(absolute));
  const entries:LoadedCase[]=manifest.cases.map(entry=>{
    const path=realpathSync(resolve(base,entry.file));if(!within(base,path))throw Error('case_path_escape');
    const digest=sha256(readFileSync(path));if(digest!==entry.sha256)throw Error('case_hash_mismatch: '+entry.id);
    const value=CaseSchema.parse(readStructured(path));if(value.id!==entry.id||value.revision!==entry.revision)throw Error('case_identity_mismatch');
    if(value.status!=='retired'&&value.scoring.checks.some(c=>c.path==='facts.finalJsonValid')&&!value.expected_final.outputContract)throw Error('output_contract_missing: '+value.id);
    if(value.status!=='retired'&&value.scoring.checks.some(c=>c.path?.startsWith('facts.report.'))&&!value.expected_final.reportContract)throw Error('report_contract_missing: '+value.id);
    if(value.split==='holdout'&&within(realpathSync(workspace),path))throw Error('holdout_in_development_workspace');
    return{value,file:path,sha256:digest};
  });
  validateLineage(entries.map(e=>e.value));
  return{manifest,entries,sha256:sha256(readFileSync(absolute)),file:absolute};
}
