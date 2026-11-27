import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, deferred, waitTick } from './harness.ts';
import { harness, mcpProtocol } from './web.test.ts';
import { readSearchMcp } from "@cwatch/shared/sources/web-mcp";
import { WebApiConfigSchema, readWebApi, type WebApiConfig } from "@cwatch/shared/sources/web-api-config";
import { WebApiAdapter } from "@cwatch/shared/sources/web-api";
import { validateTrace } from "@cwatch/shared/sessions/trace";
import type { RetrievalResult } from "@cwatch/core/types";
import { PreferredWebSource, type WebOptions } from "@cwatch/shared/sources/web";
import { SourceConfigsSchema, SourceServerBuilder } from "@cwatch/shared/sources/server-builder";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";

const live = new AbortController().signal, pageUrl = 'https://nodejs.org/article', key = 'api-fixture-secret';
const searchConfig: WebApiConfig = { search: { url: 'https://api-fixture.example/search', method: 'POST', limitParam: 'max_results', auth: { tokenEnv: 'SEARCH_API_KEY' } } };
function options(config: WebApiConfig = searchConfig, env: NodeJS.ProcessEnv = { SEARCH_API_KEY: key }): WebOptions { return { slug: 'web', allowedDomains: ['nodejs.org'], webApi: readWebApi(config, env) }; }
const query = { query: 'Node.js', limit: 2 };
check('integration', 'local REST search uses direct HTTP and shared policy stages without MCP handshake', async () => {
  let calls = 0;
  const h = await harness(options(), { fetcher: async (url, init) => {
    calls++; assert.equal(String(url), 'https://api-fixture.example/search'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + key);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: 'Node.js', max_results: 2 });
    return Response.json({ results: [{ url: pageUrl, title: 'Node.js', content: 'release notes' }] });
  } });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(result.backend, 'web.api'); assert.equal(result.searchResults![0].snippet, 'release notes'); assert.equal(calls, 1);
  const events = h.finish(); assert.deepEqual(validateTrace(events, [key]), []);
  assert.deepEqual(events.filter(e => e.type === 'backend_started').map(e => e.data.backend), ['web.api.web_search', 'web.api.http.search']);
  assert.ok(events.some(e => e.type === 'provider_tool_event' && e.data.transport === 'direct' && e.data.protocol === 'http' && e.data.operation === 'web_search'));
  assert.ok(result.snapshot); assert.ok(readFileSync(h.data.path(result.snapshot.path), 'utf8').includes('upstreamResponse'));
});
check('integration', 'Google-style GET query/key/cx and custom result field mapping work through the local API adapter', async () => {
  const config: WebApiConfig = { search: { url: 'https://www.googleapis.com/customsearch/v1', method: 'GET', queryParam: 'q', limitParam: 'num', auth: { tokenEnv: 'GOOGLE_SEARCH_API_KEY', location: 'query', name: 'key' }, paramsFromEnv: { cx: 'GOOGLE_SEARCH_ENGINE_ID' }, response: { resultsPath: 'items', urlField: 'link', titleField: 'title', snippetField: 'snippet', emptyResultsWhenMissing: true } } };
  const h = await harness(options(config, { GOOGLE_SEARCH_API_KEY: key, GOOGLE_SEARCH_ENGINE_ID: 'engine-fixture' }), { fetcher: async (url, init) => {
    const parsed = new URL(String(url)); assert.equal(parsed.origin + parsed.pathname, 'https://www.googleapis.com/customsearch/v1'); assert.equal(parsed.searchParams.get('q'), 'Node.js'); assert.equal(parsed.searchParams.get('num'), '2'); assert.equal(parsed.searchParams.get('cx'), 'engine-fixture'); assert.equal(parsed.searchParams.get('key'), key); assert.equal(init?.method, 'GET');
    return Response.json({ items: [{ link: pageUrl, title: 'Node.js', snippet: 'notes' }], requestEcho: String(url) });
  } });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(result.backend, 'web.api'); assert.equal(result.searchResults![0].url, pageUrl); assert.ok(!result.raw.includes(key)); assert.ok(!readFileSync(h.data.path(result.snapshot!.path), 'utf8').includes(key)); assert.deepEqual(validateTrace(h.finish(), [key, 'engine-fixture']), []);
});
check('integration', 'local REST fetch tool uses an API with array URL input and nested page mapping', async () => {
  const config: WebApiConfig = { fetch: { url: 'https://reader-fixture.example/extract', method: 'POST', urlParam: 'urls', urlAsArray: true, auth: { tokenEnv: 'FETCH_API_KEY', location: 'header', name: 'X-Api-Key', scheme: 'raw' }, response: { pagePath: 'data', textField: 'markdown', urlField: 'source', titleField: 'heading' } } };
  const h = await harness(options(config, { FETCH_API_KEY: key }), { fetcher: async (url, init) => {
    assert.equal(String(url), 'https://reader-fixture.example/extract'); assert.equal(new Headers(init?.headers).get('X-Api-Key'), key); assert.deepEqual(JSON.parse(String(init?.body)), { urls: [pageUrl] });
    return Response.json({ data: { source: pageUrl, heading: 'Node.js', markdown: 'Release details' } });
  } });
  const result = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
  assert.equal(result.backend, 'web.api'); assert.equal(result.pages![0].text, 'Release details'); assert.deepEqual(validateTrace(h.finish(), [key]), []);
});
check('integration', 'REST body API key and plaintext fetch are supported without credential exposure', async () => {
  const config: WebApiConfig = { fetch: { url: 'https://api-fixture.example/read', auth: { tokenEnv: 'FETCH_KEY', location: 'body', name: 'api_key' }, response: { format: 'text' } } };
  const h = await harness(options(config, { FETCH_KEY: key }), { fetcher: async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).api_key, key); return new Response('Node.js notes; echoed credential=' + key); } });
  const result = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
  assert.ok(result.pages![0].text.includes('[REDACTED]')); assert.ok(!result.raw.includes(key)); assert.deepEqual(validateTrace(h.finish(), [key]), []);
});
for (const [http, status] of [[401, 'auth_failed'], [403, 'auth_failed'], [429, 'rate_limited'], [503, 'unknown']] as const) check('contract', 'REST HTTP ' + http + ' returns an explicit local tool failure with no fallback', async () => {
  let calls = 0; const h = await harness(options(), { fetcher: async () => { calls++; return new Response('upstream error ' + key, { status: http }); } });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(result.status, status); assert.match(result.error!, new RegExp('api_HTTP_' + http)); assert.equal(calls, 1); assert.equal(result.searchResults, undefined); assert.deepEqual(validateTrace(h.finish(), [key]), []);
});
check('contract', 'REST missing fetch capability never invokes search API or directly fetches page', async () => {
  let calls = 0; const h = await harness(options(), { fetcher: async () => { calls++; throw new Error('must not fetch'); } });
  const result = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, /operation_not_configured/); assert.equal(calls, 0); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'local API tool input is denied by parent entity and URL scope before HTTP', async () => {
  let calls = 0; const h = await harness(options(), { fetcher: async () => { calls++; throw new Error('must not fetch'); } });
  await assert.rejects(h.executor.execute('web_search', { query: 'unrelated company', limit: 2 }, live));
  await assert.rejects(h.executor.execute('web_fetch', { url: 'https://attacker.example/' }, live));
  h.registry.setActive('web', false); await assert.rejects(h.executor.execute('web_search', query, live)); assert.equal(calls, 0);
});
check('contract', 'API HTTP request rechecks revocation after local tool execution starts', async () => {
  let calls = 0; const h = await harness(options(), { fetcher: async () => { calls++; throw new Error('must not fetch'); } });
  const emit = h.trace.emit.bind(h.trace);
  h.trace.emit = (type, data = {}) => { emit(type, data); if (type === 'backend_started' && data.backend === 'web.api.web_search') h.registry.setActive('web', false); };
  await assert.rejects(h.executor.execute('web_search', query, live), /backend_policy_block/); assert.equal(calls, 0); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'API request cancellation rejects late results and produces no events after termination', async () => {
  const pending = deferred<Response>(), started = deferred<void>(), controller = new AbortController(); let calls = 0;
  const h = await harness(options(), { fetcher: async () => { calls++; started.resolve(); return pending.promise; } });
  const running = h.executor.execute('web_search', query, controller.signal); await started.promise; controller.abort(new Error('cancelled')); await assert.rejects(running);
  const events = h.finish(); pending.resolve(Response.json({ results: [{ url: pageUrl, title: 'late' }] })); await waitTick();
  assert.equal(calls, 1); assert.equal(h.data.executions()[0].state, 'cancelled'); assert.deepEqual(h.data.lines(h.trace.key), events); assert.deepEqual(validateTrace(events), []);
});
check('contract', 'API redirect, malformed JSON and oversized bodies stay failures', async () => {
  for (const response of [new Response(null, { status: 302 }), new Response('{invalid'), new Response('too big', { headers: { 'content-length': '2000001' } })]) {
    const h = await harness(options(), { fetcher: async (_url, init) => { assert.equal(init?.redirect, 'error'); return response; } });
    const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
    assert.equal(result.status, 'parse_failed'); assert.equal(result.searchResults, undefined); assert.deepEqual(validateTrace(h.finish()), []);
  }
});
check('semantic', 'mapped REST search filters disallowed URLs, empty success remains empty and errors do not become empty', async () => {
  for (const [data, expected] of [[{ results: [] }, 'success_empty'], [{ results: [{ url: 'https://attacker.example/', title: 'outside' }] }, 'success_empty'], [{ error: 'failure' }, 'unknown']] as const) {
    const h = await harness(options(), { fetcher: async () => Response.json(data) });
    const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
    assert.equal(result.status, expected); assert.deepEqual(result.signals, []);
  }
});
check('contract', 'API source schema validates endpoints, credential presence and incompatible options', () => {
  assert.ok(SourceConfigsSchema.safeParse([{ slug: 'web', kind: 'web', allowedDomains: ['nodejs.org'], webApi: searchConfig }]).success);
  assert.equal(WebApiConfigSchema.safeParse({}).success, false);
  assert.equal(WebApiConfigSchema.safeParse({ search: { url: 'https://api.example/search', method: 'GET', auth: { tokenEnv: 'KEY', location: 'body' } } }).success, false);
  assert.throws(() => readWebApi(searchConfig, { API_KEY: key }), /credential_environment_missing/);
  assert.throws(() => readWebApi({ search: { url: 'http://api.example/search' } }, {}), /HTTPS/);
  assert.throws(() => readWebApi({ search: { url: 'https://api.example/search?key=secret' } }, {}), /embedded_credentials/);
  assert.equal(SourceConfigsSchema.safeParse([{ slug: 'web', kind: 'web', webApi: searchConfig, searchMcp: {} }]).success, false);
  assert.equal(SourceConfigsSchema.safeParse([{ slug: 'other', kind: 'mcp', webApi: searchConfig }]).success, false);
});
check('contract', 'local API adapter requires executor context before any HTTP', async () => {
  const resolved = readWebApi(searchConfig, { SEARCH_API_KEY: key }); let calls = 0;
  const api = new WebApiAdapter(resolved, () => {}, async () => { calls++; throw new Error('must not fetch'); });
  await assert.rejects(api.call('web_search', query, live, undefined as never), /execution_context_required/); assert.equal(calls, 0);
});
check('integration', 'explicit local API selection stays independent of native model credentials', async () => {
  let requests = 0;
  const h = await harness({ ...options(), native: { provider: 'anthropic', apiKey: 'native-fixture-key', model: 'fixture', baseUrl: 'https://native.example/v1' } }, { fetcher: async url => {
    requests++; assert.equal(String(url), 'https://api-fixture.example/search');
    return Response.json({ results: [{ url: pageUrl, title: 'Node.js' }] });
  } });
  assert.equal((await h.executor.execute('web_search', query, live) as RetrievalResult).backend, 'web.api'); assert.equal(requests, 1);
  assert.ok(h.finish().filter(e => e.type === 'backend_started').every(e => String(e.data.backend).startsWith('web.api.')));
});
check('integration', 'local API discoveries run through plan/analyze/review/draft with honest gaps', async () => {
  const h = await harness(options({ ...searchConfig, fetch: { url: 'https://reader-fixture.example/extract' } }), { fetcher: async url => Response.json(String(url).includes('/extract') ? { url: pageUrl, content: 'Fetched release details' } : { results: [{ url: pageUrl, title: 'Node.js', content: 'Discovery result' }] }) });
  const result = await runInvestigation(h.task, new ReplayModel([
    { kind: 'call_tool', name: 'workflow__save_plan', args: { taskId: h.task.taskId, objective: 'local API fixture investigation', sources: ['web'], queries: ['Node.js'], evidenceRequirements: ['Verified URL'], window: { start: h.task.window.start, end: h.task.window.end } } },
    { kind: 'call_tool', name: 'web_search', args: query },
    { kind: 'call_tool', name: 'web_fetch', args: { url: pageUrl } },
    { kind: 'call_tool', name: 'workflow__analyze', args: {} },
    { kind: 'call_tool', name: 'workflow__review', args: {} },
    { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Local API fixture produced discovery material, which is not yet verified evidence.', claimIds: '$analyzed_claim_ids' } },
    { kind: 'respond', text: 'Fixture draft saved with evidence gaps.' },
  ]), h.registry, h.data, 'replay');
  assert.equal(result.status, 'partial', result.error); assert.ok(result.gaps.some(g => g.includes('discovery_only'))); assert.ok(result.report);
  assert.deepEqual(validateTrace(h.data.lines('traces/' + result.runId + '.jsonl')), []); await h.registry.close();
});

check('integration', 'local API and external MCP tools share executor policy, observations and trace', async () => {
  const h = await harness(options(), { fetcher: async () => Response.json({ results: [{ url: pageUrl, title: 'API discovery' }] }) });
  h.task.allowedSources.push('remoteweb');
  await h.registry.register('remoteweb', 'mcp', new PreferredWebSource({ slug: 'remoteweb', allowedDomains: ['nodejs.org'], searchMcp: { url: 'https://fixture.example/mcp' } }, { fetcher: mcpProtocol({ url: 'https://fixture.example/mcp' }) }), live);
  const api = await h.executor.execute('web_search', query, live) as RetrievalResult;
  const mcp = await h.executor.execute('mcp__remoteweb__web_search', query, live) as RetrievalResult;
  assert.equal(api.backend, 'web.api'); assert.equal(mcp.backend, 'mcp.remote');
  assert.ok(api.snapshot); assert.ok(mcp.snapshot);
  assert.equal(h.data.executions().length, 2);
  const events = h.finish(); assert.deepEqual(validateTrace(events, [key]), []);
  assert.equal(events.filter(e => e.type === 'execution_finished' && e.data.state === 'completed').length, 2);
  await h.registry.close();
});

check('contract', 'legacy searchMcp API configuration executes locally without MCP discovery', async () => {
  const legacy = { type: 'api' as const, ...searchConfig };
  assert.ok(SourceConfigsSchema.safeParse([{ slug: 'web', kind: 'web', allowedDomains: ['nodejs.org'], searchMcp: legacy }]).success);
  const h = await harness({ slug: 'web', allowedDomains: ['nodejs.org'], searchMcp: readSearchMcp(legacy, { SEARCH_API_KEY: key }) }, { fetcher: async () => Response.json({ results: [] }) });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(result.backend, 'web.api');
  assert.ok(h.finish().filter(e => e.type === 'backend_started').every(e => String(e.data.backend).startsWith('web.api.')));
});

check('contract', 'local fetch rejects a mismatched returned URL and marks bounded page text', async () => {
  const config: WebApiConfig = { fetch: { url: 'https://reader-fixture.example/extract' } };
  for (const wrong of [true, false]) {
    const h = await harness(options(config, {}), { fetcher: async () => Response.json({ url: wrong ? 'https://nodejs.org/other' : pageUrl, content: 'x'.repeat(24_001) }) });
    const result = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
    if (wrong) { assert.equal(result.status, 'parse_failed'); assert.equal(result.pages, undefined); }
    else { assert.equal(result.pages![0].text.length, 8_000); assert.equal(result.pages![0].textSnapshot?.totalChars, 24_001); assert.equal(result.pages![0].truncated, true); assert.ok(readFileSync(h.data.path(result.snapshot!.path), 'utf8').includes('x'.repeat(24_001))); }
    assert.deepEqual(validateTrace(h.finish()), []);
  }
});

check('contract', 'local API adapter refuses unknown operations and malformed input before HTTP', async () => {
  let calls = 0;
  const api = new WebApiAdapter(readWebApi(searchConfig, { SEARCH_API_KEY: key }), () => {}, async () => { calls++; throw Error('must not fetch'); });
  const context = { event: () => {}, stage: async <T>(_name: string, run: () => Promise<T>): Promise<T> => run() };
  await assert.rejects(api.call('delete', query, live, context), /operation_not_supported/);
  await assert.rejects(api.call('web_search', { ...query, limit: 11 }, live, context), /invalid_input/);
  assert.equal(calls, 0);
});
check('contract', 'API source examples validate and replay without reading real service credentials', async () => {
  for (const name of ['sources-web-api.json', 'sources-web-api-google.json', 'sources-web-api-tavily.json']) {
    const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync('examples/' + name, 'utf8')));
    for (const config of configs) { const { client } = await new SourceServerBuilder(process.cwd()).build(config, 'replay', live); assert.equal((await client.listTools(live)).length, 2); await client.close(); }
  }
});
check('contract', 'upstream stream errors cannot leak API credentials into HTTP stage trace', async () => {
  const h = await harness(options(), { fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('upstream URL contains ' + key)); } })) });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, /response_read_failed/); assert.deepEqual(validateTrace(h.finish(), [key]), []);
});
check('contract', 'API auth cannot overwrite an authorized query parameter or configured request value', async () => {
  let calls = 0;
  const config: WebApiConfig = { search: { url: 'https://api-fixture.example/search', method: 'GET', auth: { tokenEnv: 'KEY', location: 'query', name: 'query' } } };
  const h = await harness(options(config, { KEY: key }), { fetcher: async () => { calls++; throw new Error('must not fetch'); } });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(result.status, 'parse_failed'); assert.match(result.error!, /conflicts_with_input/); assert.equal(calls, 0);
});
check('contract', 'API query credentials with reserved characters are redacted in echoed URLs', async () => {
  const secret = 'fixture+query/credential?value=123';
  const config: WebApiConfig = { search: { url: 'https://api-fixture.example/search', method: 'GET', auth: { tokenEnv: 'MY_CREDENTIAL', location: 'query', name: 'key' } } };
  const h = await harness(options(config, { MY_CREDENTIAL: secret }), { fetcher: async url => Response.json({ results: [{ url: pageUrl, title: 'Node.js' }], echo: String(url) }) });
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  const saved = readFileSync(h.data.path(result.snapshot!.path), 'utf8');
  for (const value of [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2)]) assert.ok(!saved.includes(value));
  assert.deepEqual(validateTrace(h.finish(), [secret]), []);
});
