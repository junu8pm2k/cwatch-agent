import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeDiscovery, discoveryUrl, type DiscoveryQuery } from '@cwatch/shared/intelligence/source-coverage';
import { PreferredWebSource, allowedUrl } from '@cwatch/shared/sources/web';
import { SourceConfigsSchema, SourceServerBuilder } from '@cwatch/shared/sources/server-builder';
import { EvidenceStore } from '@cwatch/shared/intelligence/evidence';
import type { RetrievalResult } from '@cwatch/core/types';
import { check, store, task } from './harness.ts';

const domains = ['nodejs.org', 'github.com'], refs = ['https://nodejs.org/en', 'https://nodejs.org/docs', 'https://github.com/nodejs/node'];
const result = (urls: string[] = []): RetrievalResult => ({ status: urls.length ? 'success_with_data' : 'success_empty', signals: [], raw: 'synthetic discovery', provenance: 'fixture', searchResults: urls.map(url => ({ url, title: 'Node.js', snippet: 'candidate', published_at: null, retrieved_at: '2026-10-24T00:00:00Z' })) });
const query = (urls: string[], returned?: number, filteredOutsideScope?: number): DiscoveryQuery => ({ query: 'Node.js site:nodejs.org', limit: 10, result: result(urls), returned, filteredOutsideScope });
const page = (url: string): RetrievalResult => ({ status: 'success_with_data', signals: [], raw: 'synthetic page', provenance: 'fixture', pages: [{ url, title: 'Node.js', text: 'A nonempty synthetic page', published_at: null, retrieved_at: '2026-10-24T00:00:00Z', truncated: false }] });

check('semantic', 'Official reference coverage deduplicates repeated hits across queries without counting duplicates as recall', () => {
  const metrics = summarizeDiscovery(refs, domains, [query([refs[0], refs[0]], 4, 2), query([refs[0], refs[1]], 3, 1)], []);
  assert.equal(metrics.queryCount, 2); assert.equal(metrics.uniqueWhitelistCandidates, 2);
  assert.equal(metrics.upstreamReturned, 7); assert.equal(metrics.upstreamFilteredOutsideScope, 3);
  assert.equal(metrics.searchReferenceCoverage.count, 2); assert.equal(metrics.searchReferenceCoverage.total, 3);
  assert.equal(metrics.referenceTextAvailability.count, 0); assert.equal(metrics.structuredSignalsFromWebResults, 0);
});
check('semantic', 'Known starting URLs restore bounded entry reach when official search is empty without falsifying search coverage', () => {
  const metrics = summarizeDiscovery(refs, domains, [query([], 0, 0)], refs.map(url => ({ url, result: page(url) })));
  assert.equal(metrics.uniqueWhitelistCandidates, 0); assert.equal(metrics.searchReferenceCoverage.count, 0);
  assert.equal(metrics.referenceTextAvailability.count, 3); assert.equal(metrics.combinedReferenceReach.count, 3);
  assert.equal(metrics.structuredSignalsFromWebResults, 0); assert.deepEqual(metrics.missingReferenceText, []);
});
check('semantic', 'A shared official hostname or another GitHub repository does not satisfy an exact reference entry', () => {
  const metrics = summarizeDiscovery(refs, domains, [query(['https://nodejs.org/another', 'https://github.com/other/project'])], []);
  assert.equal(metrics.uniqueWhitelistCandidates, 2); assert.equal(metrics.searchReferenceCoverage.count, 0);
  assert.equal(metrics.unreviewedNonReferenceCandidates.length, 2);
  assert.equal(metrics.upstreamReturned, null); assert.equal(metrics.upstreamFilteredOutsideScope, null);
});
check('contract', 'Discovery metrics reject widened reference scope and do not accept foreign candidate or mismatched fetch URLs', () => {
  assert.throws(() => summarizeDiscovery(['https://outside.example/'], domains, [], []), /web_scope/);
  assert.throws(() => summarizeDiscovery([], domains, [], []), /discovery_reference_required/);
  const metrics = summarizeDiscovery(refs, domains, [query(['https://outside.example/', refs[0]])], [{ url: refs[1], result: page(refs[0]) }]);
  assert.equal(metrics.rejectedOutsideScope, 1); assert.equal(metrics.uniqueWhitelistCandidates, 1);
  assert.equal(metrics.referenceTextAvailability.count, 0);
});
check('contract', 'Discovery URL matching removes fragments and trailing slash but preserves page paths, queries and tag case', () => {
  assert.equal(discoveryUrl('https://nodejs.org/docs/#section', domains), 'https://nodejs.org/docs');
  assert.equal(discoveryUrl('https://github.com/NodeJS/Node/', domains), 'https://github.com/nodejs/node');
  assert.notEqual(discoveryUrl('https://github.com/NodeJS/Node/releases/tag/V1', domains), discoveryUrl('https://github.com/nodejs/node/releases/tag/v1', domains));
  assert.notEqual(discoveryUrl('https://nodejs.org/docs?version=1', domains), discoveryUrl('https://nodejs.org/docs?version=2', domains));
});
check('semantic', 'Failed or cancelled fetches never fill reference text coverage and snippets never become structured facts', () => {
  const failed: RetrievalResult = { status: 'rate_limited', signals: [], raw: '', provenance: 'fixture', error: 'rate_limited' };
  const metrics = summarizeDiscovery(refs, domains, [query([refs[0]])], [{ url: refs[0], result: failed }]);
  assert.equal(metrics.referenceTextAvailability.count, 0); assert.equal(metrics.structuredSignalsFromWebResults, 0);
  const evidence = new EvidenceStore(store());
  assert.ok(evidence.ingest(task(), result([refs[0]])).gaps.some(gap => gap.includes('discovery_only')));
  assert.ok(evidence.ingest(task(), page(refs[0])).gaps.some(gap => gap.includes('discovery_only')));
  assert.equal(evidence.events().length, 0); assert.equal(evidence.claims(task(), []).length, 0);
});
check('contract', 'Configured official seeds and whitelist are disclosed in stable tools without exposing provider credentials', async () => {
  const source = new PreferredWebSource({ slug: 'web', allowedDomains: domains, urls: refs, searchMcp: { url: 'https://service.example/private-endpoint', token: 'private-provider-key' } });
  const tools = await source.listTools();
  for (const tool of tools) for (const url of refs) assert.ok(tool.description.includes(url));
  assert.ok(tools.every(tool => tool.description.includes('not proof')));
  assert.ok(!JSON.stringify(tools).includes('private-provider-key')); assert.ok(!JSON.stringify(tools).includes('private-endpoint'));
  assert.equal(source.validateScope('web_fetch', { url: 'https://nodejs.org/other' }, task()), undefined);
  assert.equal(source.validateScope('web_fetch', { url: 'https://outside.example/' }, task()), 'web_url_outside_scope');
  const invalid = new PreferredWebSource({ slug: 'web', allowedDomains: domains, urls: ['https://outside.example/'] });
  await assert.rejects(invalid.listTools(), /web_scope/);
});
check('contract', 'Source builder carries configured seeds into the actual web tool catalog without network discovery', async () => {
  const config = SourceConfigsSchema.parse([{ slug: 'web', kind: 'web', allowedDomains: domains, urls: refs, searchMcp: { url: 'https://service.example/mcp' } }])[0];
  const builder = new SourceServerBuilder(process.cwd());
  const { client } = await builder.build(config, 'live', new AbortController().signal);
  try { assert.ok((await client.listTools(new AbortController().signal)).every(tool => tool.description.includes(refs[1]))); }
  finally { await client.close(); await builder.mcpPool.close(); }
});
check('contract', 'Competitor discovery query matrix preserves the official-site whitelist and seeds', () => {
  const catalog = JSON.parse(readFileSync('examples/competitor-acceptance/targets.json', 'utf8'));
  const matrix = JSON.parse(readFileSync('examples/competitor-acceptance/discovery-queries.json', 'utf8'));
  assert.equal(matrix.limit, 10); assert.equal(matrix.targets.length, 3);
  for (const target of catalog.targets) {
    const source = SourceConfigsSchema.parse(JSON.parse(readFileSync(`examples/competitor-acceptance/${target.id}.sources.json`, 'utf8'))).find(source => source.kind === 'web')!;
    assert.deepEqual(source.allowedDomains, target.domains); assert.deepEqual(source.urls, target.urls);
    const queries = matrix.targets.find((entry: { id: string }) => entry.id === target.id).queries as string[];
    assert.equal(queries.length, 2);
    for (const text of queries) {
      assert.ok(text.includes(target.name)); const scope = /site:([^\s)]+)/.exec(text)![1];
      allowedUrl('https://' + scope, target.domains);
    }
  }
});
