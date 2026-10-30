import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadDataset, sha256, within } from './dataset.ts';
import { EVAL_DIMENSION_IDS } from './dimensions.ts';
const category = z.enum(EVAL_DIMENSION_IDS);
const polarity = z.enum(['positive','negative']);
const IndexSchema = z.object({schemaVersion:z.literal('cwatch.coverage-index.v2'),datasets:z.array(z.object({file:z.string(),classification:z.record(z.string(),z.tuple([category,polarity])).nullable()}).strict()).min(1),
  engineering:z.array(z.object({category,file:z.string(),covers:z.string()}).strict()),
}).strict();
/** This is design coverage, not an execution result or a model-quality pass rate. */
export function coverageInventory(indexFile:string,workspace=process.cwd()) {
  const base=realpathSync(workspace),indexPath=realpathSync(resolve(workspace,indexFile));
  if(!within(base,indexPath))throw Error('coverage_index_escape');
  const index=IndexSchema.parse(JSON.parse(readFileSync(indexPath,'utf8'))),seen=new Set<string>();
  const datasets=index.datasets.map(spec=>{
    const file=realpathSync(resolve(workspace,spec.file));if(!within(base,file))throw Error('coverage_dataset_escape');
    const dataset=loadDataset(file,workspace),active=dataset.entries.filter(e=>e.value.status!=='retired');
    if(spec.classification&&Object.keys(spec.classification).some(id=>!active.some(e=>e.value.id===id)))throw Error('coverage_orphan_case');
    const cases=active.map(({value})=>{
      if(seen.has(value.id))throw Error('coverage_duplicate_case');seen.add(value.id);
      const external=spec.classification?.[value.id],metadata=value.coverage;
      if(!external&&!metadata)throw Error('coverage_missing_classification:'+value.id);
      if(external&&metadata&&(external[0]!==metadata.category||external[1]!==metadata.polarity))throw Error('coverage_classification_conflict');
      return{id:value.id,revision:value.revision,category:external?.[0]??metadata!.category,polarity:external?.[1]??metadata!.polarity,
        target:metadata?.target??'legacy_contract',executionMode:value.scope.executionMode,status:value.status,title:value.title};
    });
    return{file:spec.file,id:dataset.manifest.id,version:dataset.manifest.version,sha256:dataset.sha256,cases};
  });
  for(const e of index.engineering){const file=resolve(workspace,e.file);if(!existsSync(file)||!within(base,realpathSync(file)))throw Error('coverage_missing_engineering_reference:'+e.file);}
  const cases=datasets.flatMap(d=>d.cases);
  const matrix=Object.fromEntries(category.options.map(cat=>[cat,Object.fromEntries(polarity.options.map(pol=>{
    const rows=cases.filter(c=>c.category===cat&&c.polarity===pol);return[pol,{count:rows.length,caseIds:rows.map(c=>c.id),realModel:rows.filter(c=>c.executionMode==='frozen_tools_live_model').length,approved:rows.filter(c=>c.status==='approved').length}];
  }))]));
  if(Object.values(matrix).some(row=>row.positive.count===0||row.negative.count===0))throw Error('coverage_missing_polarity');
  return{schemaVersion:'cwatch.coverage-inventory.v2',indexSha256:sha256(readFileSync(indexPath)),kind:'design_inventory_not_execution',totalCases:cases.length,datasets,matrix,
    engineeringReferences:index.engineering,limits:['Tool activation does not imply automatic Skill routing.','Protocol fixtures and scripted fault cases do not measure live model quality.','Case existence or approval does not mean that a run passed.']};
}
export function coverageMarkdown(value:ReturnType<typeof coverageInventory>):string {
  return ['# 五维评测覆盖清单','',`已注册 ${value.totalCases} 个 Agent Eval 用例。下表是设计覆盖，不是执行通过率。`,'',
    '| 场景 | 正例 | 负例 | 真实模型模式用例 |','|---|---:|---:|---:|',...Object.entries(value.matrix).map(([cat,row])=>`| ${cat} | ${row.positive.count} | ${row.negative.count} | ${row.positive.realModel+row.negative.realModel} |`),'',
    ...value.datasets.flatMap(d=>['## '+d.id,'',`版本 ${d.version}；题单 SHA-256：${d.sha256}`,'','| Case | 场景 | 正负 | 模式 | 标准状态 |','|---|---|---|---|---|',...d.cases.map(c=>`| ${c.id} | ${c.category} | ${c.polarity} | ${c.executionMode} | ${c.status} |`),'']),
    '## 工程回归位置（不计入 Agent Eval 数量）','',...value.engineeringReferences.map(e=>`- ${e.file}：${e.covers}`),'',...value.limits.map(s=>'- '+s),''].join('\n');
}
