import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LangfuseClient } from '../scripts/evaluation/langfuse-client.ts';
import { syncLangfuseAssets, applyRegisteredJudgePrompts, pullLangfuseSuite } from '../scripts/evaluation/langfuse-assets.ts';
import { evaluationAssets, caseFromDatasetItem, SUITE_FILE } from '../scripts/evaluation/langfuse-suite.ts';
import { loadDataset } from '../scripts/evaluation/dataset.ts';

function fixture(){
  const datasets:Record<string,unknown>[]=[],items:Record<string,unknown>[]=[],prompts:Record<string,unknown>[]=[],writes:string[]=[];
  const evaluators=['outcome','trajectory','evidence'].map(dimension=>({id:'judge-'+dimension,name:'cwatch.judge.'+dimension,versionId:'v1',version:1,type:'llm_as_judge',
    prompt:'Evaluate '+dimension+' {{packet}}',modelConfig:{provider:'fixture',model:'fixture'},variableMapping:[{variable:'packet',source:'metadata',jsonPath:'$.evalJudgePacket'}],
    outputDefinition:{dataType:'CATEGORICAL',categories:['pass','fail','unknown'],shouldAllowMultipleMatches:false}}));
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
    if(body)writes.push(path);
    if(path==='/api/public/projects')return response({data:[{id:'fixture-project'}]});
    if(path==='/api/public/v2/evaluators')return response({data:evaluators});
    if(path.startsWith('/api/public/v2/evaluators/')){
      const evaluator=evaluators.find(e=>path.endsWith(e.id));assert(evaluator);
      if(body)Object.assign(evaluator,body,{versionId:'v2',version:2});return response(evaluator);
    }
    if(path==='/api/public/v2/datasets'){
      if(!body)return response({data:datasets});const value={...body,id:'dataset-'+datasets.length};datasets.push(value);return response(value);
    }
    if(path==='/api/public/dataset-items'){
      if(!body)return response({data:items.filter(i=>i.datasetName===url.searchParams.get('datasetName'))});
      const value={...body,expectedOutput:body.expectedOutput??null};const index=items.findIndex(i=>i.id===value.id);if(index<0)items.push(value);else items[index]=value;return response(value);
    }
    if(path==='/api/public/v2/prompts'){
      if(!body)return response({data:prompts});const value={...body,version:1};prompts.push(value);return response(value);
    }
    if(path.startsWith('/api/public/v2/prompts/')){
      const name=decodeURIComponent(path.slice('/api/public/v2/prompts/'.length)),value=prompts.find(p=>p.name===name);assert(value);return response(value);
    }
    throw Error('unexpected fixture request: '+path);
  };
  const client=new LangfuseClient({baseUrl:'http://fixture.invalid',publicKey:'fixture-public',secretKey:'fixture-secret',timeoutMs:1000,environment:'test'},transport);
  return {client,datasets,items,prompts,writes,evaluators};
}

test('14 full Cases round-trip between local runner and Dataset without leaking the oracle into Agent input',()=>{
  const cases=evaluationAssets(),original=loadDataset(SUITE_FILE).entries;assert.equal(cases.length,14);
  assert.deepEqual(['activation','core_logic','resilience','artifact_quality'].map(s=>cases.filter(c=>c.scenario===s).length),[2,8,2,2]);
  for(let i=0;i<cases.length;i++){
    assert.deepEqual(caseFromDatasetItem(cases[i]),original[i].value);
    assert.deepEqual(Object.keys(cases[i].input),['instruction']);
    assert(!cases[i].input.instruction.includes('passAll'));
    assert.equal(cases[i].metadata.evaluation.status,'needs_review');assert.equal(cases[i].metadata.evaluation.oracle.review,null);
  }
  assert.deepEqual(cases.filter(c=>!c.metadata.judgeDimensions.length).map(c=>c.caseId),['core-006','artifact-001','artifact-002']);
  assert(cases.every(c=>!c.metadata.baselineConfirmed&&c.metadata.scoringStatus==='not_scored'));
  assert(cases.filter(c=>c.scenario==='resilience').every(c=>c.metadata.execution.scenario.tools.length===2));
  const modified={...cases[0],metadata:{...cases[0].metadata,scoringPolicy:{...cases[0].metadata.scoringPolicy,processPoints:5}}};
  assert.throws(()=>caseFromDatasetItem(modified),/platform_penalty_policy_changed/);
});

test('assets sync is idempotent, publishes specific expectations and only three Judge templates, and never invokes scoring',async()=>{
  const f=fixture(),first=await syncLangfuseAssets(f.client),writeCount=f.writes.length;
  assert.equal(first.datasets.length,4);assert.equal(f.items.length,14);assert.equal(f.prompts.length,3);
  assert(f.items.every(i=>i.expectedOutput!==null));assert(f.prompts.every(p=>!(p.labels as string[]).includes('production')));
  assert(f.prompts.every(p=>String(p.name).startsWith('cwatch/judges/')));
  const second=await syncLangfuseAssets(f.client);assert(second.datasets.every(d=>d.created===0));assert(second.prompts.every(p=>p.action==='reused'));
  assert.equal(f.writes.length,writeCount);
  assert(!f.writes.some(path=>/scores|ingestion|experiments|evaluation-executions/.test(path)));
  const applied=await applyRegisteredJudgePrompts(f.client);assert(applied.every(p=>!p.changed));assert.equal(f.writes.length,writeCount);
  const pulled=await pullLangfuseSuite(f.client);assert.equal(loadDataset(pulled.dataset).entries.length,14);
  // PostgreSQL JSONB may reorder nested object keys; semantic equality must still yield identical immutable exports.
  for(const item of f.items)for(const key of ['expectedOutput','metadata'])item[key]=JSON.parse(JSON.stringify(item[key],(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
  assert.equal((await pullLangfuseSuite(f.client)).dataset,pulled.dataset);
});

test('sync preserves platform edits; explicit prompt deployment reuses Judge identities',async()=>{
  const f=fixture();await syncLangfuseAssets(f.client);
  const template=f.prompts.find(p=>p.name==='cwatch/judges/outcome')!;template.prompt='User reviewed outcome instruction {{packet}}';template.version=2;
  await assert.rejects(syncLangfuseAssets(f.client),/registered_prompt_differs/);
  assert.equal(f.evaluators[0].version,1);
  const applied=await applyRegisteredJudgePrompts(f.client);assert.equal(applied[0].id,'judge-outcome');assert.equal(applied[0].changed,true);
  assert.equal(f.evaluators[0].prompt,template.prompt);assert.equal(f.evaluators[1].version,1);
  assert((await applyRegisteredJudgePrompts(f.client)).every(p=>!p.changed));
  // A changed Case at the same revision cannot silently overwrite the uploaded task.
  f.items[0].input={instruction:'Edited in platform'};
  await assert.rejects(syncLangfuseAssets(f.client),/dataset_item_changed/);
});

test('prompt-only legacy items are archived recoverably; unrelated items are never overwritten',async()=>{
  const f=fixture();await syncLangfuseAssets(f.client);
  f.items.push({id:'old-case1',datasetName:'cwatch/current/activation',input:{instruction:'original'},expectedOutput:null,status:'ACTIVE',metadata:{schemaVersion:'cwatch.langfuse-draft-case.v1',caseId:'activation-001',revision:5}});
  await syncLangfuseAssets(f.client);assert.equal(f.items.find(i=>i.id==='old-case1')!.status,'ARCHIVED');assert.deepEqual(f.items.find(i=>i.id==='old-case1')!.input,{instruction:'original'});
  assert.equal(f.items.filter(i=>i.status==='ACTIVE').length,14);
  f.items.push({id:'unmanaged',datasetName:'cwatch/current/activation',input:{instruction:'user authored'},expectedOutput:null,status:'ACTIVE',metadata:{}});
  await assert.rejects(syncLangfuseAssets(f.client),/unmanaged_active_item/);assert.equal(f.items.find(i=>i.id==='unmanaged')!.status,'ACTIVE');
});
