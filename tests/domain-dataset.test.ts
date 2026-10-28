import assert from 'node:assert/strict';
import { check, fixture, json, store, task as defaultTask } from './harness.ts';
import { EvidenceStore, reviewClaims } from "@cwatch/shared/intelligence/evidence";
import { RetrievalSchema, type RetrievalResult } from "@cwatch/core/types";
import { SourceServerBuilder, SourceConfigsSchema } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";
interface LabeledCase {id:string;inputs:Array<{fixture?:string;signal?:Record<string,any>;result?:unknown}>;expected:{events:number;versions:number;evidence:number;claims:number;review:string;gapIncludes:string[]}}
const dataset=json<{cases:LabeledCase[]}>('fixtures/eval-cases.json');
const task = () => { const value = defaultTask(); value.allowedSources.push('news'); return value; };
for(const item of dataset.cases)check('semantic','labeled domain dataset: '+item.id,()=>{
  const facts=new EvidenceStore(store()),value=task(),ids:string[]=[],gaps:string[]=[];
  for(const input of item.inputs){
    let result:RetrievalResult;
    if(input.result)result=RetrievalSchema.parse(input.result);
    else {
      result=fixture(input.fixture);
      const base=result.signals[0],override=input.signal??{};
      result.signals[0]={...base,...override,entity:{...base.entity,...override.entity},content:{...base.content,...override.content}};
    }
    const added=facts.ingest(value,result);ids.push(...added.evidenceIds);gaps.push(...added.gaps);
  }
  const claims=facts.claims(value,ids),review=reviewClaims(value,claims,facts.events(),facts.versions(),facts.evidence());
  assert.deepEqual({events:facts.events().length,versions:facts.versions().length,evidence:facts.evidence().length,claims:claims.length,review:review.decision},{events:item.expected.events,versions:item.expected.versions,evidence:item.expected.evidence,claims:item.expected.claims,review:item.expected.review});
  for(const expected of item.expected.gapIncludes)assert.ok(gaps.some(gap=>gap.includes(expected)),expected);
  if(!item.expected.gapIncludes.length)assert.deepEqual(gaps,[]);
});
check('semantic','Previously stored evidence cannot escape a narrower source or signal-type scope',()=>{
  const facts=new EvidenceStore(store()),value=task(),collected=facts.ingest(value,fixture()),claims=facts.claims(value,collected.evidenceIds);
  const narrower={...value,allowedSources:['news']};assert.deepEqual(facts.claims(narrower,collected.evidenceIds),[]);
  assert.notEqual(reviewClaims(narrower,claims,facts.events(),facts.versions(),facts.evidence()).decision,'accept');
  const price=fixture();price.raw='Synthetic price fixture';price.signals[0].signalType='price';price.signals[0].eventKey='price:pro';price.signals[0].content.value='29 USD';
  const wide={...value,signalTypes:['release','price'] as const};const priceIds=facts.ingest({...wide,signalTypes:[...wide.signalTypes]},price).evidenceIds;
  assert.equal(facts.claims({...wide,signalTypes:[...wide.signalTypes]},priceIds).length,1);
  assert.deepEqual(facts.claims(value,priceIds),[]);
});
check('semantic','Omitting a planned source remains partial even when other collected facts are valid',async()=>{
  const value=defaultTask(),registry=new ToolRegistry(),builder=new SourceServerBuilder(process.cwd()),data=store();
  try {
    await builder.register(SourceConfigsSchema.parse(json('examples/sources.json')),'replay',registry,new AbortController().signal);
    const steps=json<any[]>('fixtures/model-script.json').filter(step=>step.name!=='mcp__github__api_github');
    const result=await runInvestigation(value,new ReplayModel(steps),registry,data,'replay');
    assert.equal(result.status,'partial');assert.ok(result.gaps.includes('source_not_collected:github'));assert.ok(result.report);
  } finally {await registry.close();await builder.mcpPool.close();}
});
