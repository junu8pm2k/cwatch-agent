import assert from 'node:assert/strict';
import { check, fixture, json, store, task as defaultTask } from './harness.ts';
import { EvidenceStore, reviewClaims } from "@cwatch/shared/intelligence/evidence";
import { SourceServerBuilder, SourceConfigsSchema } from "@cwatch/shared/sources/server-builder";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";
const task = () => { const value = defaultTask(); value.allowedSources.push('news'); return value; };
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
  const value=defaultTask(); value.allowedSources.push('platform'); const registry=new ToolRegistry(),builder=new SourceServerBuilder(process.cwd()),data=store();
  try {
    await builder.register(SourceConfigsSchema.parse([...json('examples/sources.json'), json('tests/fixtures/platform-source.json')]),'replay',registry,new AbortController().signal);
    const steps=json<any[]>('fixtures/model-script.json'); steps[0].args.sources=value.allowedSources;
    const result=await runInvestigation(value,new ReplayModel(steps),registry,data,'replay');
    assert.equal(result.status,'partial');assert.ok(result.gaps.includes('source_not_collected:platform'));assert.ok(result.report);
  } finally {await registry.close();await builder.mcpPool.close();}
});
