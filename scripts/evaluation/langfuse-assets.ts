import { readFileSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { LangfuseClient } from './langfuse-client.ts';
import { EVAL_SCENARIOS, JUDGE_DIMENSIONS, ensureDimensionJudge } from './langfuse-judges.ts';
import { evaluationAssets, caseFromDatasetItem, SCENARIO_LABELS, DATASET_PREFIX } from './langfuse-suite.ts';
import { sha256, within } from './dataset.ts';
import type { EvalCase } from './contracts.ts';
import { CaseSchema } from './contracts.ts';

const rows=z.array(z.object({id:z.string(),name:z.string()}).passthrough());
const promptSchema=z.object({name:z.string(),version:z.number(),type:z.enum(['text','chat']),prompt:z.unknown(),config:z.unknown(),labels:z.array(z.string())}).passthrough();
const itemSchema=z.object({id:z.string(),input:z.unknown(),expectedOutput:z.unknown(),metadata:z.unknown(),status:z.string()}).passthrough();
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Advance the same stable item ID only from an unedited lower revision; Langfuse retains item versions. */
function caseMatchesOrAdvances(current:z.infer<typeof itemSchema>,desired:ReturnType<typeof evaluationAssets>[number]):boolean {
  if(current.status!=='ACTIVE')throw Error('dataset_item_archived: '+current.id);
  if(same(current.input,desired.input)&&same(current.expectedOutput,desired.expectedOutput)&&same(current.metadata,desired.metadata))return true;
  const previous=caseFromDatasetItem(current);
  if(previous.id!==desired.caseId||previous.revision>=desired.revision)throw Error('dataset_item_changed: '+current.id);
  const source=z.object({sourceFile:z.string(),caseSha256:z.string()}).parse(current.metadata),path=realpathSync(resolve(source.sourceFile));
  if(!within(realpathSync(process.cwd()),path)||sha256(readFileSync(path))!==source.caseSha256||!same(CaseSchema.parse(JSON.parse(readFileSync(path,'utf8'))),previous))throw Error('dataset_previous_revision_edited: '+current.id);
  return false;
}

async function registerPrompt(client:LangfuseClient,existing:Set<string>,definition:{name:string;type:'text'|'chat';prompt:unknown;config:Record<string,unknown>;labels:string[];tags:string[]},update=false){
  if(existing.has(definition.name)){
    const current=promptSchema.parse(await client.request('/api/public/v2/prompts/'+encodeURIComponent(definition.name)+'?label=latest'));
    const matches=current.type===definition.type&&same(current.prompt,definition.prompt)&&same(current.config,definition.config);
    if(matches){
      if(!definition.labels.every(label=>current.labels.includes(label)))throw Error('registered_prompt_label_changed: '+definition.name);
      return {name:current.name,version:current.version,action:'reused'};
    }
    if(!update)throw Error('registered_prompt_differs_review_before_sync: '+definition.name);
    const owner=z.object({purpose:z.literal('dimension_judge'),evaluatorId:z.literal(String(definition.config.evaluatorId))}).safeParse(current.config);
    if(!owner.success)throw Error('registered_prompt_not_owned: '+definition.name);
  }
  const created=promptSchema.parse(await client.request('/api/public/v2/prompts',{...definition,commitMessage:'Cwatch dimension Judge policy. Per-Case rubric comes from Dataset metadata; task inputs are not Prompt templates.'}));
  existing.add(definition.name);return {name:created.name,version:created.version,action:'created'};
}

/** Publishes complete review candidates, without running models, granting approval or assigning fake scores. */
export async function syncLangfuseAssets(client:LangfuseClient,options:{updatePrompts?:boolean;archiveInputTemplates?:boolean}={}){
  const cases=evaluationAssets(),datasets=rows.parse(await client.pages('/api/public/v2/datasets'));
  const prompts=new Set(z.array(z.object({name:z.string()})).parse(await client.pages('/api/public/v2/prompts')).map(p=>p.name));
  const datasetResults=[],promptResults=[];
  for(const scenario of EVAL_SCENARIOS){
    const name=DATASET_PREFIX+scenario,matches=datasets.filter(d=>d.name===name),planned=cases.filter(c=>c.scenario===scenario);
    if(matches.length>1)throw Error('ambiguous_dataset: '+name);
    const existing=matches.length?z.array(itemSchema).parse(await client.pages('/api/public/dataset-items?datasetName='+encodeURIComponent(name))):[];
    for(const current of existing){
      const desired=planned.find(item=>item.id===current.id);
      if(desired){
        caseMatchesOrAdvances(current,desired);
      }else if(current.status==='ACTIVE'){
        const legacy=z.object({schemaVersion:z.literal('cwatch.langfuse-draft-case.v1'),caseId:z.string(),revision:z.number()}).safeParse(current.metadata);
        if(!legacy.success||current.expectedOutput!==null||!planned.some(item=>item.caseId===legacy.data.caseId&&item.revision>legacy.data.revision))throw Error('unmanaged_active_item_in_dataset: '+current.id);
      }
    }
    const dataset=matches[0]??z.object({id:z.string(),name:z.string()}).parse(await client.request('/api/public/v2/datasets',{name,
      description:SCENARIO_LABELS[scenario]+'：逐题输入、预期与评分量表齐全；待基线审核，尚未评分。100分起始扣分。',
      metadata:{schemaVersion:'cwatch.langfuse-dataset.v2',scenario,label:SCENARIO_LABELS[scenario],source:'evals/cwatch/dataset.json',expectedCaseCount:planned.length}}));
    let created=0,updated=0,archived=0;
    for(const item of planned){
      const current=existing.find(row=>row.id===item.id);
      if(!current||!caseMatchesOrAdvances(current,item)){
        await client.request('/api/public/dataset-items',{datasetName:name,id:item.id,input:item.input,expectedOutput:item.expectedOutput,metadata:item.metadata,status:'ACTIVE'});
        if(current)updated++;else created++;
      }
    }
    for(const old of existing.filter(row=>row.status==='ACTIVE'&&!planned.some(item=>item.id===row.id))){
      await client.request('/api/public/dataset-items',{datasetName:name,id:old.id,input:old.input,expectedOutput:old.expectedOutput,metadata:old.metadata,status:'ARCHIVED'});archived++;
    }
    datasetResults.push({name,id:dataset.id,scenario,label:SCENARIO_LABELS[scenario],items:planned.length,created,updated,archived});
  }
  for(const dimension of JUDGE_DIMENSIONS){
    const evaluator=await ensureDimensionJudge(client,dimension,{updatePrompts:options.updatePrompts}),type=typeof evaluator.prompt==='string'?'text':'chat';
    promptResults.push(await registerPrompt(client,prompts,{name:'cwatch/judges/'+dimension,type,prompt:evaluator.prompt,
      config:{purpose:'dimension_judge',dimension,evaluatorId:evaluator.id,modelConfig:evaluator.modelConfig,
        note:'Publishing a Prompt version does not change the Evaluator. Apply the evaluation label with --apply-registered-prompts.'},
      labels:['evaluation'],tags:['cwatch','dimension-judge',dimension]},options.updatePrompts));
  }
  const archivedInputTemplates=options.archiveInputTemplates?await archiveLegacyInputTemplates(client,[...prompts].filter(name=>name.startsWith('cwatch/cases/'))):[];
  return {schemaVersion:'cwatch.langfuse-assets.v2',projectId:await client.projectId(),datasets:datasetResults,prompts:promptResults,archivedInputTemplates,
    legacyTaskTemplates:[...prompts].filter(name=>name.startsWith('cwatch/cases/')),
    readiness:'14 complete review candidates; new revisions have no confirmed baseline or scores. Only three Judge Prompt templates are managed.'};
}

/** Reversible labels/config only: no Prompt versions or prior experiment records are deleted. */
async function archiveLegacyInputTemplates(client:LangfuseClient,names:string[]){
  const result=[];
  for(const name of names){
    const current=promptSchema.parse(await client.request('/api/public/v2/prompts/'+encodeURIComponent(name)+'?label=latest'));
    const config=z.object({schemaVersion:z.literal('cwatch.langfuse-draft-case.v1'),purpose:z.enum(['agent_task_draft','archived_input_copy']),caseId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/),revision:z.number().int().positive()}).passthrough().parse(current.config);
    if(name!=='cwatch/cases/'+config.caseId+'-r'+config.revision)throw Error('legacy_template_identity_changed');
    if(config.purpose==='archived_input_copy'){
      if(!current.labels.includes('archived'))throw Error('legacy_archive_label_changed');
      result.push({name,version:current.version,action:'already_archived'});continue;
    }
    // Keep an exact copy before replacing the active draft label with an archive label.
    const directory=resolve('.runtime/langfuse-assets/legacy-input-template-backups');mkdirSync(directory,{recursive:true});
    const backup=join(directory,config.caseId+'-r'+config.revision+'-v'+current.version+'.json'),bytes=JSON.stringify(current,null,2)+'\n';
    if(existsSync(backup)){if(readFileSync(backup,'utf8')!==bytes)throw Error('legacy_template_backup_conflict');}else writeFileSync(backup,bytes,{flag:'wx'});
    const created=promptSchema.parse(await client.request('/api/public/v2/prompts',{name,type:current.type,prompt:current.prompt,
      config:{...config,purpose:'archived_input_copy',retirementReason:'重复的Agent input副本；当前任务与逐题评分规则见Dataset cwatch/current，评分模板只用cwatch/judges。'},
      labels:['archived'],tags:['cwatch','archived-input-copy'],commitMessage:'Retire redundant Agent input template. Use Dataset input; retained as recoverable history, never a Judge.'}));
    await client.request('/api/public/v2/prompts/'+encodeURIComponent(name)+'/versions/'+current.version,{newLabels:current.labels.filter(label=>!['draft','latest'].includes(label))},{},'PATCH');
    result.push({name,version:created.version,action:'archived'});
  }
  return result;
}

/** Pull platform Cases into an immutable manifest accepted by the original runner and grader. */
export async function pullLangfuseSuite(client:LangfuseClient){
  const cases:EvalCase[]=[];
  for(const scenario of EVAL_SCENARIOS){
    const items=z.array(itemSchema).parse(await client.pages('/api/public/dataset-items?datasetName='+encodeURIComponent(DATASET_PREFIX+scenario)));
    const active=items.filter(item=>item.status==='ACTIVE');
    if(active.length!==(scenario==='core_logic'?8:2))throw Error('platform_suite_count_changed: '+scenario);
    for(const item of active){
      const c=caseFromDatasetItem(item);
      if(!c.id.startsWith(({activation:'activation-',core_logic:'core-',resilience:'resilience-',artifact_quality:'artifact-'} as const)[scenario]))throw Error('platform_case_scenario_mismatch');
      cases.push(c);
    }
  }
  cases.sort((a,b)=>a.id.localeCompare(b.id));
  const digest=sha256('cwatch.platform-suite-export.v2\n'+canonical(cases)),directory=resolve('artifacts/langfuse-suite/'+digest.slice(0,16));
  const workspace=realpathSync(process.cwd());
  for(const path of [resolve('artifacts'),resolve('artifacts/langfuse-suite'),directory,join(directory,'cases')]){
    if(existsSync(path)&&!within(workspace,realpathSync(path)))throw Error('suite_export_path_escape');
    mkdirSync(path,{recursive:true});
  }
  const store=(path:string,body:string)=>{if(existsSync(path)){if(readFileSync(path,'utf8')!==body)throw Error('suite_export_conflict');}else writeFileSync(path,body,{flag:'wx'});};
  const entries=cases.map(c=>{
    const file='cases/'+c.id+'.r'+c.revision+'.json',body=JSON.stringify(JSON.parse(canonical(c)),null,2)+'\n';store(join(directory,file),body);
    return{id:c.id,revision:c.revision,file,sha256:sha256(body)};
  });
  const file=join(directory,'dataset.json');store(file,JSON.stringify({schemaVersion:'cwatch.eval-dataset.v5',id:'cwatch-langfuse-suite',version:digest,cases:entries},null,2)+'\n');
  return {dataset:file,caseCount:cases.length,sha256:digest,source:'Langfuse ACTIVE Dataset items',scoringEngine:'existing CaseSchema / grader / penalty'};
}

/** Explicit deployment of reviewed Prompt Management versions to the same three Evaluator IDs. */
export async function applyRegisteredJudgePrompts(client:LangfuseClient){
  const plans=[];
  for(const dimension of JUDGE_DIMENSIONS){
    const evaluator=await ensureDimensionJudge(client,dimension);
    const template=promptSchema.parse(await client.request('/api/public/v2/prompts/'+encodeURIComponent('cwatch/judges/'+dimension)+'?label=evaluation'));
    z.object({purpose:z.literal('dimension_judge'),dimension:z.literal(dimension),evaluatorId:z.literal(evaluator.id)}).parse(template.config);
    const serialized=typeof template.prompt==='string'?template.prompt:JSON.stringify(template.prompt);
    if(!serialized.includes('{{packet}}'))throw Error('registered_judge_missing_packet: '+dimension);
    if(template.type==='text')z.string().parse(template.prompt);else z.array(z.object({role:z.string(),content:z.string()})).parse(template.prompt);
    plans.push({dimension,evaluator,template});
  }
  const results=[];
  for(const {dimension,evaluator,template} of plans){
    const changed=!same(evaluator.prompt,template.prompt);
    const updated=changed?z.object({id:z.literal(evaluator.id),versionId:z.string()}).parse(await client.request('/api/public/v2/evaluators/'+encodeURIComponent(evaluator.id),{prompt:template.prompt},{},'PATCH',120000)):evaluator;
    results.push({dimension,id:updated.id,versionId:updated.versionId,promptVersion:template.version,changed});
  }
  return results;
}
