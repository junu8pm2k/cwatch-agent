import assert from 'node:assert/strict';
import { check } from './harness.ts';
import { harness, mcpProtocol } from './web.test.ts';
import { readSearchMcp, selectMcpTool, SearchMcpConfigSchema } from "@cwatch/shared/sources/web-mcp";
import { normalizeMcpResult } from "@cwatch/shared/sources/web-mcp-results";
import { allowedUrl, PreferredWebSource, type WebOptions } from "@cwatch/shared/sources/web";
import { validateTrace } from "@cwatch/shared/sessions/trace";
import { SourceConfigsSchema, SourceServerBuilder } from "@cwatch/shared/sources/server-builder";
import type { RetrievalResult } from "@cwatch/core/types";

const live = new AbortController().signal, endpoint = 'https://different-search.example/mcp';
const remoteOptions = { url: endpoint, token: 'mcp-fixture-key' };
const options: WebOptions = { slug: 'web', allowedDomains: ['nodejs.org'], searchMcp: remoteOptions };
const queryArgs = { query: 'Node.js', limit: 2 }, pageArgs = { url: 'https://nodejs.org/article' };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const guard = (url: string) => allowedUrl(url, ['nodejs.org']);
check('contract', 'only URL plus token config works with independent model settings and custom environment names', () => {
  assert.equal(readSearchMcp({}, { SEARCH_MCP_URL: endpoint, SEARCH_MCP_TOKEN: 'remote', MODEL_PROVIDER: 'other', API_KEY: 'model' })?.token, 'remote');
  assert.equal(readSearchMcp({ urlEnv: 'OTHER_URL', tokenEnv: 'OTHER_TOKEN' }, { OTHER_URL: endpoint, OTHER_TOKEN: 'remote' })?.url, endpoint);
  assert.equal(readSearchMcp({}, { SEARCH_MCP_TOKEN: 'remote' }), undefined);
  assert.equal(SearchMcpConfigSchema.safeParse({ provider: 'vendor', url: endpoint }).success, false);
  for (const url of ['https://user:pass@host.example/mcp', 'https://host.example/mcp#fragment', 'https://host.example/mcp?token=secret']) assert.throws(() => readSearchMcp({ url }, {}));
});
check('contract', 'Remote MCP request timeout is explicit, bounded and propagated without changing the configured endpoint', () => {
  const configured = readSearchMcp({ requestTimeoutMs: 60000 }, { SEARCH_MCP_URL: endpoint, SEARCH_MCP_TOKEN: 'remote' })!;
  assert.equal(configured.url, endpoint); assert.equal(configured.requestTimeoutMs, 60000);
  assert.equal(readSearchMcp({}, { SEARCH_MCP_URL: endpoint })?.requestTimeoutMs, undefined);
  for (const requestTimeoutMs of [0, 999, 300001, 1.5, '60000']) assert.equal(SearchMcpConfigSchema.safeParse({ requestTimeoutMs }).success, false);
});

check('integration', 'Configured MCP fetch consumes a nested page envelope and records its request budget and exact URL', async () => {
  const search = { ...remoteOptions, requestTimeoutMs: 60_000 };
  const builder = new SourceServerBuilder(process.cwd(), undefined, search, 180_000);
  const { client } = await builder.build({ slug: 'web', kind: 'web', active: true, allowedDomains: ['nodejs.org'] }, 'live', live);
  assert.ok(client instanceof PreferredWebSource);
  const h = await harness(client.options, { fetcher: mcpProtocol({ url: endpoint,
    data: { code: 0, message: '', page: { url: pageArgs.url, markdown: 'Official page body', title: 'Node.js' } },
  }) });
  const result = await h.executor.execute('web_fetch', pageArgs, live) as RetrievalResult;
  assert.equal(result.status, 'success_with_data'); assert.equal(result.backend, 'mcp.remote');
  assert.equal(result.pages![0].url, pageArgs.url); assert.equal(result.pages![0].text, 'Official page body');
  assert.equal(result.pages![0].published_at, null); assert.match(result.raw, /"page"/);
  const events = h.finish(); assert.deepEqual(validateTrace(events), []);
  assert.ok(events.some(event => event.type === 'provider_tool_event' && event.data.requestTimeoutMs === 180_000));
  assert.equal(search.requestTimeoutMs, 60_000);
  assert.ok(!events.some(event => event.type === 'backend_started' && !String(event.data.backend).startsWith('mcp.remote.')));
});

check('contract', 'Nested fetch envelopes cannot conceal failed status, multiple pages, empty text or a foreign returned URL', () => {
  for (const page of [{ url: 'https://attacker.example/', markdown: 'foreign' }, { url: 'https://nodejs.org/other', markdown: 'wrong page' }, { url: pageArgs.url }, [{ url: pageArgs.url, markdown: 'one' }, { url: pageArgs.url, markdown: 'two' }]]) {
    assert.throws(() => normalizeMcpResult('web_fetch', pageArgs, { structuredContent: { code: 0, page } }, guard));
  }
  assert.throws(() => normalizeMcpResult('web_fetch', pageArgs, { structuredContent: { code: 1, message: 'fetch failed', page: { url: pageArgs.url, markdown: 'stale body' } } }, guard), /web_result_error/);
});

check('integration', 'MCP request timeout returns one explicit failure without switching endpoint, transport or backend', async () => {
  let calls = 0;
  const protocol = mcpProtocol({ url: endpoint });
  const h = await harness({ ...options, searchMcp: { ...remoteOptions, requestTimeoutMs: 1000 } }, { fetcher: async (url, init) => {
    if (init?.method === 'POST' && JSON.parse(String(init.body)).method === 'tools/call') {
      calls++;
      return await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }
    return protocol(url, init);
  } }, 3000);
  const result = await h.executor.execute('web_fetch', pageArgs, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, /search_mcp_(?:request|transport)_timeout/); assert.equal(calls, 1);
  assert.equal(result.pages, undefined); const events = h.finish(); assert.deepEqual(validateTrace(events), []);
  assert.ok(events.filter(event => event.type === 'backend_started').every(event => String(event.data.backend).startsWith('mcp.remote.')));
});

check('contract', 'Parent cancellation interrupts a configured longer MCP request without retry or page success', async () => {
  const controller = new AbortController(); let calls = 0;
  const protocol = mcpProtocol({ url: endpoint });
  const h = await harness({ ...options, searchMcp: { ...remoteOptions, requestTimeoutMs: 60000 } }, { fetcher: async (url, init) => {
    if (init?.method === 'POST' && JSON.parse(String(init.body)).method === 'tools/call') {
      calls++; setTimeout(() => controller.abort(new Error('fetch-probe-cancel')), 20);
      return await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }
    return protocol(url, init);
  } });
  await assert.rejects(h.executor.execute('web_fetch', pageArgs, controller.signal), /fetch-probe-cancel/);
  assert.equal(calls, 1); assert.deepEqual(validateTrace(h.finish()), []);
});
for (const variant of [
  { name: 'vendor_search', inputSchema: schema({ q: { type: 'string' }, count: { type: 'integer', maximum: 10 } }, ['q']), input: { q: 'Node.js', count: 2 }, data: { hits: [{ link: pageArgs.url, name: 'Node.js', description: 'notes' }] } },
  { name: 'web_search_exa', inputSchema: schema({ query: { type: 'string' }, numResults: { type: 'integer' } }, ['query']), input: { query: 'Node.js', numResults: 2 }, data: { results: [{ url: pageArgs.url, title: 'Node.js', text: 'notes' }] } },
  { name: 'tavily-search', inputSchema: schema({ query: { type: 'string' }, max_results: { type: 'integer' } }, ['query']), input: { query: 'Node.js', max_results: 2 }, data: { results: [{ url: pageArgs.url, title: 'Node.js', content: 'notes' }] } },
] as const) check('integration', 'generic SDK discovery adapts ' + variant.name + ' without provider configuration', async () => {
  const h = await harness(options, { fetcher: mcpProtocol({ url: endpoint, tools: [{ name: variant.name, inputSchema: variant.inputSchema }], data: variant.data, onCall: (name, input) => { assert.equal(name, variant.name); assert.deepEqual(input, variant.input); } }) });
  const result = await h.executor.execute('web_search', queryArgs, live) as RetrievalResult;
  assert.equal(result.backend, 'mcp.remote'); assert.equal(result.searchResults![0].url, pageArgs.url); assert.equal(result.searchResults![0].snippet, 'notes');
  const events = h.finish(); assert.deepEqual(validateTrace(events, ['mcp-fixture-key']), []); assert.ok(events.some(e => e.data.remoteTool === variant.name && typeof e.data.schemaHash === 'string'));
});
check('integration', 'generic fetch recognizes batch extract with one authorized URL and nested results', async () => {
  const h = await harness(options, { fetcher: mcpProtocol({ url: endpoint, tools: [{ name: 'tavily_extract', inputSchema: schema({ urls: { type: 'array', items: { type: 'string' } } }, ['urls']) }], data: { results: [{ url: pageArgs.url, raw_content: 'extracted text' }] }, onCall: (name, input) => { assert.equal(name, 'tavily_extract'); assert.deepEqual(input, { urls: [pageArgs.url] }); } }) });
  const result = await h.executor.execute('web_fetch', pageArgs, live) as RetrievalResult;
  assert.equal(result.backend, 'mcp.remote'); assert.equal(result.pages![0].text, 'extracted text'); assert.deepEqual(validateTrace(h.finish()), []);
});
check('integration', 'MCP search text blocks are parsed as bounded Markdown discovery results', async () => {
  const h = await harness(options, { fetcher: mcpProtocol({ url: endpoint, text: '[Node.js](https://nodejs.org/article)\nRelease notes' }) });
  const result = await h.executor.execute('web_search', queryArgs, live) as RetrievalResult;
  assert.equal(result.searchResults![0].url, pageArgs.url); assert.equal(result.searchResults![0].title, 'Node.js'); assert.deepEqual(validateTrace(h.finish()), []);
});
check('semantic', 'generic result shapes stay discoveries and never invent publication dates', () => {
  for (const data of [[{ url: pageArgs.url, title: 'Node.js' }], { data: { web: [{ url: pageArgs.url, title: 'Node.js' }] } }, { web: { results: [{ url: pageArgs.url, title: 'Node.js' }] } }]) {
    const result = normalizeMcpResult('web_search', queryArgs, { structuredContent: data }, guard).result;
    assert.equal(result.searchResults!.length, 1); assert.equal(result.searchResults![0].published_at, null); assert.deepEqual(result.signals, []);
  }
  assert.equal(normalizeMcpResult('web_search', queryArgs, { content: [{ type: 'text', text: 'No results found.' }] }, guard).result.status, 'success_empty');
  assert.throws(() => normalizeMcpResult('web_search', queryArgs, { content: [{ type: 'text', text: 'unsupported opaque answer' }] }, guard), /unrecognized/);
  assert.throws(() => normalizeMcpResult('web_search', queryArgs, { content: [{ type: 'text', text: '{broken json' }] }, guard), /invalid_json/);
});
check('semantic', 'generic fetch supports Markdown and resources but rejects reported wrong URLs', () => {
  for (const value of [
    { structuredContent: { success: true, data: { markdown: 'page', metadata: { sourceURL: pageArgs.url } } } },
    { content: [{ type: 'text', text: 'page' }] },
    { content: [{ type: 'resource', resource: { uri: pageArgs.url, text: 'page' } }] },
  ]) assert.equal(normalizeMcpResult('web_fetch', pageArgs, value, guard).result.pages![0].text, 'page');
  assert.throws(() => normalizeMcpResult('web_fetch', pageArgs, { structuredContent: { url: 'https://attacker.example/', markdown: 'page' } }, guard), /url_mismatch/);
});
check('contract', 'ambiguous or destructive remote tools never get guessed or called', () => {
  const tool = { name: 'web_search', inputSchema: schema({ query: { type: 'string' } }, ['query']) };
  assert.throws(() => selectMcpTool([tool, { ...tool, name: 'other_search' }], 'web_search', queryArgs), /ambiguous/);
  assert.equal(selectMcpTool([tool, { ...tool, name: 'other_search' }], 'web_search', queryArgs, 'other_search').name, 'other_search');
  assert.throws(() => selectMcpTool([{ ...tool, name: 'delete_search' }], 'web_search', queryArgs), /not_discovered/);
  assert.throws(() => selectMcpTool([{ ...tool, annotations: { destructiveHint: true } }], 'web_search', queryArgs), /not_discovered/);
});
check('contract', 'MCP schemas accept 2020-12 and draft-7 but reject unknown required fields and async validators', () => {
  for (const draft of ['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#']) {
    const inputSchema = { ...schema({ query: { type: 'string' } }, ['query']), $schema: draft };
    assert.equal(selectMcpTool([{ name: 'search', inputSchema }], 'web_search', queryArgs).input.query, 'Node.js');
  }
  assert.throws(() => selectMcpTool([{ name: 'search', inputSchema: { ...schema({ query: { type: 'string' } }, ['query']), $async: true } }], 'web_search', queryArgs), /schema_incompatible/);
});
check('integration', 'generic transport supports custom API-key header and anonymous MCP', async () => {
  for (const anonymous of [false, true]) {
    const config = { ...options, searchMcp: { url: endpoint, token: anonymous ? undefined : 'mcp-fixture-key', authHeader: 'X-Api-Key', authScheme: 'raw' as const } };
    const h = await harness(config, { fetcher: mcpProtocol({ url: endpoint, authHeader: 'X-Api-Key', authValue: anonymous ? null : 'mcp-fixture-key' }) });
    assert.equal((await h.executor.execute('web_search', queryArgs, live) as RetrievalResult).backend, 'mcp.remote'); assert.deepEqual(validateTrace(h.finish(), ['mcp-fixture-key']), []);
  }
});
check('contract', 'URL-only search config registers in replay without reading tokens or network access', async () => {
  const config = SourceConfigsSchema.parse([{ slug: 'web', kind: 'web', searchMcp: {}, allowedDomains: ['nodejs.org'], fixture: 'fixtures/web-discovery.json' }])[0];
  const { client } = await new SourceServerBuilder(process.cwd()).build(config, 'replay', live);
  assert.equal((await client.listTools(live)).length, 2); await client.close();
});
check('contract', 'removed local fallback configuration is rejected instead of silently ignored', () => {
  for (const removed of [{ feeds: ['https://nodejs.org/feed.xml'] }, { searchBackend: 'brave' }]) {
    assert.equal(SourceConfigsSchema.safeParse([{ slug: 'web', kind: 'web', allowedDomains: ['nodejs.org'], ...removed }]).success, false);
  }
});

function sseFixture(endpointTarget = 'https://different-search.example/messages?session=fixture') {
  let controller: ReadableStreamDefaultController<Uint8Array>, closed = false;
  const encoder = new TextEncoder(), protocol = mcpProtocol({ url: endpoint });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mcp-fixture-key');
    if (init?.method === 'GET' || !init?.method) {
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(encoder.encode('event: endpoint\ndata: ' + endpointTarget + '\n\n')); }, cancel() { closed = true; } });
      init?.signal?.addEventListener('abort', () => { if (!closed) { closed = true; try { controller.close(); } catch {} } }, { once: true });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (String(url) === endpoint) return new Response(null, { status: 405 });
    const response = await protocol(endpoint, init);
    if (response.status === 200) controller.enqueue(encoder.encode('event: message\ndata: ' + await response.text() + '\n\n'));
    return new Response(null, { status: 202 });
  };
  return { fetcher, calls };
}
check('integration', 'legacy SSE is automatically negotiated after Streamable HTTP 405 with the same token', async () => {
  const fixture = sseFixture(), h = await harness(options, { fetcher: fixture.fetcher });
  const result = await h.executor.execute('web_search', queryArgs, live) as RetrievalResult;
  assert.equal(result.backend, 'mcp.remote'); assert.ok(fixture.calls.some(url => url.includes('/messages?')));
  const events = h.finish(); assert.deepEqual(validateTrace(events), []); assert.ok(events.some(e => e.type === 'web_route' && e.data.reason === 'streamable_http_not_supported'));
});
check('contract', 'SSE advertised cross-origin post endpoint never receives credentials', async () => {
  const fixture = sseFixture('https://attacker.example/messages'), h = await harness({ ...options, searchMcp: { url: endpoint, token: 'mcp-fixture-key', transport: 'sse' } }, { fetcher: fixture.fetcher });
  const result = await h.executor.execute('web_search', queryArgs, live) as RetrievalResult;
  assert.equal(result.status, 'parse_failed'); assert.ok(fixture.calls.every(url => !url.includes('attacker.example'))); assert.deepEqual(validateTrace(h.finish()), []);
});
