import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { check, store } from './harness.ts';
import { harness, mcpProtocol } from './web.test.ts';
import { readWebOptions, type WebOptions } from '@cwatch/shared/sources/web';
import { readSearchMcp } from '@cwatch/shared/sources/web-mcp';
import { detectKnownRestPreset } from '@cwatch/shared/sources/web-rest-presets';
import { SourceConfigsSchema, SourceServerBuilder } from '@cwatch/shared/sources/server-builder';
import { validateTrace, Redactor } from '@cwatch/shared/sessions/trace';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { PiContextManager, getMessagesAfterCompactBoundary } from '@cwatch/shared/agent/backend/pi/context';
import { buildProxyTools } from '@cwatch/shared/agent/backend/pi/tool-hooks';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { id, type AgentSessionHooks, type RetrievalResult } from '@cwatch/core/types';

const live = new AbortController().signal;
const pageUrl = 'https://nodejs.org/article';
const query = { query: 'Node.js', limit: 2 };
const base: WebOptions = { slug: 'web', allowedDomains: ['nodejs.org'] };

check('contract', 'readWebOptions recognizes Anthropic, OpenAI and Gemini native defaults without leaking Anthropic base URL', () => {
  const anthropic = readWebOptions('web', ['nodejs.org'], { MODEL_PROVIDER: 'anthropic', MODEL_ID: 'claude-sonnet-4-5', API_KEY: 'a-key', WEB_NATIVE_BASE_URL: 'https://api.anthropic.com/v1' });
  assert.deepEqual(anthropic.native, { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'a-key', baseUrl: 'https://api.anthropic.com/v1' });

  const openai = readWebOptions('web', ['nodejs.org'], { MODEL_PROVIDER: 'openai', MODEL_ID: 'gpt-5', API_KEY: 'o-key', WEB_NATIVE_BASE_URL: 'https://api.anthropic.com/v1' });
  assert.deepEqual(openai.native, { provider: 'openai', model: 'gpt-5', apiKey: 'o-key', baseUrl: 'https://api.openai.com/v1' });

  const gemini = readWebOptions('web', ['nodejs.org'], { MODEL_PROVIDER: 'google', MODEL_ID: 'gemini-2.5-pro', API_KEY: 'g-key', WEB_NATIVE_BASE_URL: 'https://api.anthropic.com/v1' });
  assert.deepEqual(gemini.native, { provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'g-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });

  // Custom proxy BASE_URL is not assumed to support native server web tools under auto mode.
  const proxy = readWebOptions('web', ['nodejs.org'], { MODEL_PROVIDER: 'openai', MODEL_ID: 'gpt-5', API_KEY: 'o-key', BASE_URL: 'https://proxy.example/v1' });
  assert.equal(proxy.native, undefined);
  assert.equal(proxy.nativeUnavailableReason, 'no_controlled_native_adapter_for_configured_provider');
});

check('integration', 'OpenAI native web_search validates tool call events, domain scope, deduplication and snippet cap', async () => {
  let seenAuth = '';
  const h = await harness(
    { ...base, native: { provider: 'openai', model: 'gpt-5', apiKey: 'native-fixture-key', baseUrl: 'https://api.openai.com/v1' } },
    {
      fetcher: async (url, init) => {
        assert.equal(String(url), 'https://api.openai.com/v1/responses');
        seenAuth = new Headers(init?.headers).get('authorization') ?? '';
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_tool_calls, 1);
        assert.deepEqual(body.tools[0].filters.allowed_domains, ['nodejs.org']);
        return Response.json({
          usage: { input_tokens: 10, output_tokens: 20 },
          output: [
            { type: 'web_search_call', id: 'ws-1', status: 'completed', action: { type: 'search', sources: [{ url: pageUrl, title: 'Node.js Source' }, { url: 'https://attacker.example/bad', title: 'Outside' }] } },
            { type: 'message', content: [{ type: 'output_text', text: 'Release summary ' + 's'.repeat(2500), annotations: [{ type: 'url_citation', url: pageUrl, title: 'Node.js Release', cited_text: 'x'.repeat(2500) }] }] },
          ],
        });
      },
    },
  );
  const result = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(seenAuth, 'Bearer native-fixture-key');
  assert.equal(result.backend, 'native.openai');
  assert.equal(result.status, 'success_with_data');
  assert.equal(result.searchResults!.length, 1);
  assert.equal(result.searchResults![0].url, pageUrl);
  assert.equal(result.searchResults![0].snippet.length, 2000);
  // OpenAI native fetch explicitly reports unsupported instead of fabricating page text.
  const fetchResult = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
  assert.equal(fetchResult.status, 'unknown');
  assert.match(fetchResult.error!, /unsupported/);
  assert.deepEqual(validateTrace(h.finish(), ['native-fixture-key']), []);
});

check('integration', 'Gemini native web_search and web_fetch use header auth and verify grounding and url_context metadata', async () => {
  const h = await harness(
    { ...base, native: { provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'native-fixture-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' } },
    {
      fetcher: async (url, init) => {
        const parsed = new URL(String(url));
        assert.equal(parsed.searchParams.has('key'), false);
        assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'native-fixture-key');
        const body = JSON.parse(String(init?.body));
        if (body.tools[0].google_search) {
          return Response.json({
            candidates: [{
              content: { parts: [{ text: 'Node.js release info' }] },
              groundingMetadata: {
                webSearchQueries: ['Node.js'],
                groundingChunks: [{ web: { uri: pageUrl, title: 'Node.js Docs' } }, { web: { uri: 'https://attacker.example/x', title: 'Bad' } }],
                groundingSupports: [{ segment: { text: 'Grounded snippet text' }, groundingChunkIndices: [0] }],
              },
            }],
          });
        }
        return Response.json({
          candidates: [{
            content: { parts: [{ text: 'Fetched official body' }] },
            urlContextMetadata: { urlMetadata: [{ retrievedUrl: pageUrl, urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] },
          }],
        });
      },
    },
  );
  const searchRes = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(searchRes.backend, 'native.gemini');
  assert.equal(searchRes.searchResults!.length, 1);
  assert.equal(searchRes.searchResults![0].snippet, 'Grounded snippet text');

  const fetchRes = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
  assert.equal(fetchRes.backend, 'native.gemini');
  assert.equal(fetchRes.pages![0].url, pageUrl);
  assert.equal(fetchRes.pages![0].text, 'Fetched official body');
  assert.deepEqual(validateTrace(h.finish(), ['native-fixture-key']), []);
});

check('integration', 'AI-only native web_fetch passes through snapshot archival and ToolResultGovernor snip governance', async () => {
  const largePage = 'NATIVE-HEAD:' + 'n'.repeat(26_000) + ':NATIVE-TAIL';
  const h = await harness(
    { ...base, native: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'native-fixture-key', baseUrl: 'https://native.example/v1' } },
    {
      fetcher: async () => Response.json({
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [
          { type: 'server_tool_use', id: 'srv-1', name: 'web_fetch', input: { url: pageUrl } },
          { type: 'web_fetch_tool_result', tool_use_id: 'srv-1', content: { type: 'web_fetch_result', url: pageUrl, content: { title: 'Node.js', source: { type: 'text', data: largePage } }, retrieved_at: '2026-10-17T00:00:00Z' } },
        ],
      }),
    },
  );

  // Execute via proxy tool just like the live Pi session does.
  const binding = h.registry.binding('web_fetch');
  const proxyHooks = {
    executeTool: (name, args, signal, expected, toolCallId) => h.executor.execute(name, args, signal, expected, toolCallId),
  } as Pick<AgentSessionHooks, 'executeTool'> as AgentSessionHooks;
  const proxyTools = buildProxyTools([binding], proxyHooks);
  const proxyResult = await proxyTools[0].execute('call-native-1', { url: pageUrl }, live, undefined, undefined as never);
  const obs = proxyResult.details as RetrievalResult;
  assert.equal(obs.backend, 'native.anthropic');
  assert.equal(obs.pages![0].truncated, true);
  assert.equal(obs.pages![0].text.length, 24_000);
  assert.equal(obs.rawTruncated, true);
  assert.ok(obs.snapshot && readFileSync(h.data.path(obs.snapshot.path), 'utf8').includes(':NATIVE-TAIL'));

  // Feed the native toolResult into PiContextManager with tight maxChars so ToolResultGovernor MUST snip it.
  const sessionId = id(), sessionStore = store();
  const manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
  const transcript = new SessionTranscript(sessionStore, sessionId, new Redactor(['native-fixture-key']));
  const { model } = await createPiRuntime('fixture-snip', 'fixture', { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1/unused' }, live);
  const usage = { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const contextHooks = {
    onTranscript: entries => transcript.append(entries),
    beforeRequest: () => ({ maxOutputTokens: 4096 }),
    onUsage: () => {},
  } as Pick<AgentSessionHooks, 'onTranscript' | 'beforeRequest' | 'onUsage'> as AgentSessionHooks;
  const contextMgr = new PiContextManager(
    manager,
    contextHooks,
    18_000, 32_000,
    { canRead: true, microcompactTools: ['web_search', 'web_fetch'] },
  );
  manager.appendMessage({ role: 'user', content: 'Inspect Node.js release notes', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-native-1', name: 'web_fetch', arguments: { url: pageUrl } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'call-native-1', toolName: 'web_fetch', content: proxyResult.content as Array<{ type: 'text'; text: string }>, details: proxyResult.details, isError: false, timestamp: Date.now() });

  const prepared = await contextMgr.prepare({ systemPrompt: 'host', tools: [], messages: getMessagesAfterCompactBoundary(manager) }, {} as ModelRuntime, model, 4096, live);
  const toolMsg = prepared.messages.find(m => m.role === 'toolResult')!;
  const rendered = JSON.stringify(toolMsg);
  assert.ok(rendered.length <= 3600);
  assert.match(rendered, /Archived tool result \(snip\)/);
  assert.match(rendered, /\[\.\.\.snipped\.\.\.\]/);
  assert.match(rendered, /NATIVE-HEAD/);
  assert.match(rendered, /session__read_tool_result/);

  // Original full native toolResult remains readable via paged transcript lookup.
  const originalEntry = manager.getEntries().find(e => e.type === 'message' && e.message.role === 'toolResult')!;
  let offset = 0, reconstructed = '';
  do {
    const page = transcript.readToolResult({ entryId: originalEntry.id, toolCallId: 'call-native-1', offset, limit: 4096 });
    reconstructed += page.content;
    offset = page.nextOffset ?? -1;
  } while (offset !== -1);
  assert.ok(reconstructed.includes('NATIVE-HEAD:'));
  assert.ok(reconstructed.length > 24_000);
  assert.deepEqual(validateTrace(h.finish(), ['native-fixture-key']), []);
});

for (const presetCase of [
  {
    name: 'Tavily search & extract',
    url: 'https://api.tavily.com/search',
    key: 'tvly-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(url.toString(), 'https://api.tavily.com/search');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tvly-fixture-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'Node.js', max_results: 2 });
    },
    response: { results: [{ url: pageUrl, title: 'Node.js', content: 'Tavily snippet' }] },
    expectedSnippet: 'Tavily snippet',
  },
  {
    name: 'Exa search',
    url: 'https://api.exa.ai/search',
    key: 'exa-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(url.toString(), 'https://api.exa.ai/search');
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'exa-fixture-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'Node.js', numResults: 2 });
    },
    response: { results: [{ url: pageUrl, title: 'Node.js', text: 'Exa snippet' }] },
    expectedSnippet: 'Exa snippet',
  },
  {
    name: 'Brave Search GET',
    url: 'https://api.search.brave.com/res/v1/web/search',
    key: 'brave-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('x-subscription-token'), 'brave-fixture-key');
      assert.equal(url.searchParams.get('q'), 'Node.js');
      assert.equal(url.searchParams.get('count'), '2');
    },
    response: { web: { results: [{ url: pageUrl, title: 'Node.js', description: 'Brave snippet' }] } },
    expectedSnippet: 'Brave snippet',
  },
  {
    name: 'Serper organic results',
    url: 'https://google.serper.dev/search',
    key: 'serper-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(url.toString(), 'https://google.serper.dev/search');
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'serper-fixture-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { q: 'Node.js', num: 2 });
    },
    response: { organic: [{ link: pageUrl, title: 'Node.js', snippet: 'Serper snippet' }] },
    expectedSnippet: 'Serper snippet',
  },
  {
    name: 'Bocha webPages.value results',
    url: 'https://api.bochaai.com/v1/web-search',
    key: 'bocha-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(url.toString(), 'https://api.bochaai.com/v1/web-search');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer bocha-fixture-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'Node.js', count: 2 });
    },
    response: { code: 200, data: { webPages: { value: [{ url: pageUrl, name: 'Node.js', summary: 'Bocha summary' }] } } },
    expectedSnippet: 'Bocha summary',
  },
  {
    name: 'Firecrawl v1 search',
    url: 'https://api.firecrawl.dev/v1/search',
    key: 'fc-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(url.toString(), 'https://api.firecrawl.dev/v1/search');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fc-fixture-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'Node.js', limit: 2 });
    },
    response: { success: true, data: [{ url: pageUrl, title: 'Node.js', description: 'Firecrawl snippet' }] },
    expectedSnippet: 'Firecrawl snippet',
  },
  {
    name: 'Jina search (s.jina.ai)',
    url: 'https://s.jina.ai/',
    key: 'jina-fixture-key',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(url.origin, 'https://s.jina.ai');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer jina-fixture-key');
      assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), { q: 'Node.js' });
    },
    response: { code: 200, data: [{ url: pageUrl, title: 'Node.js', content: 'Jina snippet' }] },
    expectedSnippet: 'Jina snippet',
  },
  {
    name: 'Google Custom Search with GOOGLE_SEARCH_ENGINE_ID',
    url: 'https://www.googleapis.com/customsearch/v1',
    key: 'google-fixture-key',
    googleCx: 'cx-fixture',
    op: 'web_search' as const,
    assertReq: (url: URL, init?: RequestInit) => {
      assert.equal(init?.method, 'GET');
      assert.equal(url.searchParams.get('key'), 'google-fixture-key');
      assert.equal(url.searchParams.get('cx'), 'cx-fixture');
      assert.equal(url.searchParams.get('q'), 'Node.js');
      assert.equal(url.searchParams.get('num'), '2');
    },
    response: { items: [{ link: pageUrl, title: 'Node.js', snippet: 'Google CSE snippet' }] },
    expectedSnippet: 'Google CSE snippet',
  },
]) check('integration', 'auto protocol detects mainstream REST preset: ' + presetCase.name + ' ahead of native with zero MCP handshake', async () => {
  let calls = 0;
  const searchMcp = readSearchMcp({}, {
    SEARCH_MCP_URL: presetCase.url,
    SEARCH_MCP_TOKEN: presetCase.key,
    ...(presetCase.googleCx ? { GOOGLE_SEARCH_ENGINE_ID: presetCase.googleCx } : {}),
  });
  const h = await harness(
    { ...base, native: { provider: 'anthropic', model: 'claude', apiKey: 'native-fixture-key', baseUrl: 'https://native.example/v1' }, searchMcp },
    {
      fetcher: async (url, init) => {
        calls++;
        const parsed = new URL(String(url));
        assert.ok(!parsed.hostname.includes('native.example'));
        presetCase.assertReq(parsed, init);
        return Response.json(presetCase.response);
      },
    },
  );
  const result = await h.executor.execute(presetCase.op, query, live) as RetrievalResult;
  assert.equal(calls, 1);
  assert.equal(result.backend, 'web.api');
  assert.equal(result.searchResults![0].url, pageUrl);
  assert.equal(result.searchResults![0].snippet, presetCase.expectedSnippet);
  assert.deepEqual(validateTrace(h.finish(), [presetCase.key, 'native-fixture-key', ...(presetCase.googleCx ? [presetCase.googleCx] : [])]), []);
});

check('integration', 'Tavily URL auto-derives same-origin /extract for web_fetch while vendor MCP URLs stay on MCP', async () => {
  assert.equal(detectKnownRestPreset({ url: 'https://mcp.tavily.com/mcp', token: 'k' }), undefined);
  assert.equal(detectKnownRestPreset({ url: 'https://mcp.exa.ai/mcp', token: 'k' }), undefined);
  assert.equal(detectKnownRestPreset({ url: 'https://api.tavily.com/mcp', token: 'k' }), undefined);

  const searchMcp = readSearchMcp({}, { SEARCH_MCP_URL: 'https://api.tavily.com/search', SEARCH_MCP_TOKEN: 'tvly-key' });
  const h = await harness({ ...base, searchMcp }, {
    fetcher: async (url, init) => {
      assert.equal(String(url), 'https://api.tavily.com/extract');
      assert.deepEqual(JSON.parse(String(init?.body)), { urls: [pageUrl] });
      return Response.json({ results: [{ url: pageUrl, raw_content: 'Extracted Tavily body' }] });
    },
  });
  const res = await h.executor.execute('web_fetch', { url: pageUrl }, live) as RetrievalResult;
  assert.equal(res.backend, 'web.api');
  assert.equal(res.pages![0].text, 'Extracted Tavily body');
  assert.deepEqual(validateTrace(h.finish(), ['tvly-key']), []);

  // Vendor MCP URL uses MCP protocol, not REST preset.
  const mcpUrl = 'https://mcp.tavily.com/mcp';
  const hMcp = await harness({ ...base, searchMcp: { url: mcpUrl, token: 'mcp-fixture-key' } }, { fetcher: mcpProtocol({ url: mcpUrl }) });
  const mcpRes = await hMcp.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(mcpRes.backend, 'mcp.remote');
  assert.deepEqual(validateTrace(hMcp.finish(), ['mcp-fixture-key']), []);
});

check('integration', 'unknown custom REST endpoint auto-switches from failed MCP handshake to REST (including 405 POST->GET) and caches decision', async () => {
  const endpoint = 'https://custom-search.example/v1/search';
  const calls: string[] = [];
  const h = await harness(
    { ...base, native: { provider: 'openai', model: 'gpt-5', apiKey: 'native-fixture-key', baseUrl: 'https://api.openai.com/v1' }, searchMcp: { url: endpoint, token: 'mcp-fixture-key' } },
    {
      fetcher: async (url, init) => {
        const method = init?.method ?? 'GET';
        calls.push(method + ' ' + String(url));
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body));
          // Reject MCP JSON-RPC initialize; also reject REST POST with 405 to test GET fallback.
          if (body.jsonrpc === '2.0') return new Response('not jsonrpc', { status: 400 });
          return new Response('use GET', { status: 405 });
        }
        const parsed = new URL(String(url));
        assert.equal(parsed.searchParams.get('query'), 'Node.js');
        assert.equal(parsed.searchParams.get('limit'), '2');
        return Response.json({ results: [{ url: pageUrl, title: 'Node.js', snippet: 'Custom REST GET' }] });
      },
    },
  );
  const first = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(first.backend, 'web.api');
  assert.equal(first.searchResults![0].snippet, 'Custom REST GET');
  const firstCallCount = calls.length;

  // Second call uses cached REST protocol directly (no repeat MCP initialize).
  const second = await h.executor.execute('web_search', query, live) as RetrievalResult;
  assert.equal(second.backend, 'web.api');
  assert.equal(calls.length, firstCallCount + 2); // POST 405 -> GET 200, no MCP probe
  assert.deepEqual(validateTrace(h.finish(), ['mcp-fixture-key', 'native-fixture-key']), []);
});

check('contract', 'readSearchMcp falls back to API_SEARCH_URL/API_FETCH_URL when SEARCH_MCP_URL is empty and never borrows model API_KEY', async () => {
  const fromApiEnv = readSearchMcp({}, {
    API_SEARCH_URL: 'https://api.tavily.com/search',
    API_SEARCH_KEY: 'api-s-key',
    API_FETCH_URL: 'https://api.tavily.com/extract',
    API_FETCH_KEY: 'api-f-key',
    API_KEY: 'model-secret',
  })!;
  assert.equal(fromApiEnv.url, 'https://api.tavily.com/search');
  assert.equal(fromApiEnv.token, 'api-s-key');
  assert.equal(fromApiEnv.fetchUrl, 'https://api.tavily.com/extract');
  assert.equal(fromApiEnv.fetchToken, 'api-f-key');

  // Even a plain kind='web' source without searchMcp field picks up env search tool in live mode.
  const prevUrl = process.env.SEARCH_MCP_URL, prevToken = process.env.SEARCH_MCP_TOKEN;
  process.env.SEARCH_MCP_URL = 'https://api.tavily.com/search';
  process.env.SEARCH_MCP_TOKEN = 'env-search-key';
  try {
    const config = SourceConfigsSchema.parse([{ slug: 'web', kind: 'web', allowedDomains: ['nodejs.org'] }])[0];
    const { client } = await new SourceServerBuilder(process.cwd()).build(config, 'live', live);
    const options = (client as unknown as { options: WebOptions }).options;
    assert.equal(options.searchMcp && 'url' in options.searchMcp ? options.searchMcp.url : undefined, 'https://api.tavily.com/search');
    assert.equal(options.searchMcp && 'token' in options.searchMcp ? options.searchMcp.token : undefined, 'env-search-key');
    await client.close();
  } finally {
    if (prevUrl === undefined) delete process.env.SEARCH_MCP_URL; else process.env.SEARCH_MCP_URL = prevUrl;
    if (prevToken === undefined) delete process.env.SEARCH_MCP_TOKEN; else process.env.SEARCH_MCP_TOKEN = prevToken;
  }
});

check('integration', 'MCP and REST API web_fetch also retain full snapshot archival and ToolResultGovernor snip governance', async () => {
  const largeBody = 'EXTERNAL-HEAD:' + 'e'.repeat(26_000) + ':EXTERNAL-TAIL';
  const scenarios: Array<{ label: string; expectedBackend: string; options: WebOptions; fetcher: typeof fetch }> = [
    {
      label: 'mcp',
      expectedBackend: 'mcp.remote',
      options: { ...base, searchMcp: { url: 'https://search-fixture.example/mcp', token: 'mcp-fixture-key' } },
      fetcher: mcpProtocol({ data: { url: pageUrl, title: 'Node.js', content: largeBody } }),
    },
    {
      label: 'rest',
      expectedBackend: 'web.api',
      options: { ...base, searchMcp: { url: 'https://api.tavily.com/search', token: 'mcp-fixture-key' } },
      fetcher: async () => Response.json({ results: [{ url: pageUrl, raw_content: largeBody }] }),
    },
  ];
  for (const scenario of scenarios) {
    const h = await harness(scenario.options, { fetcher: scenario.fetcher });
    const binding = h.registry.binding('web_fetch');
    const proxyHooks = {
      executeTool: (name, args, signal, expected, toolCallId) => h.executor.execute(name, args, signal, expected, toolCallId),
    } as Pick<AgentSessionHooks, 'executeTool'> as AgentSessionHooks;
    const proxyTools = buildProxyTools([binding], proxyHooks);
    const proxyResult = await proxyTools[0].execute('call-' + scenario.label, { url: pageUrl }, live, undefined, undefined as never);
    const obs = proxyResult.details as RetrievalResult;
    assert.equal(obs.backend, scenario.expectedBackend);
    assert.equal(obs.pages![0].truncated, true);
    assert.equal(obs.pages![0].text.length, 24_000);
    assert.equal(obs.rawTruncated, true);
    assert.ok(obs.snapshot && readFileSync(h.data.path(obs.snapshot.path), 'utf8').includes(':EXTERNAL-TAIL'));

    const sessionId = id(), sessionStore = store();
    const manager = SessionManager.inMemory(process.cwd(), { id: sessionId });
    const transcript = new SessionTranscript(sessionStore, sessionId, new Redactor(['mcp-fixture-key']));
    const { model } = await createPiRuntime('fixture-snip-' + scenario.label, 'fixture', { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1/unused' }, live);
    const usage = { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const contextHooks = {
      onTranscript: entries => transcript.append(entries),
      beforeRequest: () => ({ maxOutputTokens: 4096 }),
      onUsage: () => {},
    } as Pick<AgentSessionHooks, 'onTranscript' | 'beforeRequest' | 'onUsage'> as AgentSessionHooks;
    const contextMgr = new PiContextManager(manager, contextHooks, 18_000, 32_000, { canRead: true, microcompactTools: ['web_search', 'web_fetch'] });
    manager.appendMessage({ role: 'user', content: 'Inspect page', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-' + scenario.label, name: 'web_fetch', arguments: { url: pageUrl } }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: Date.now() });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'call-' + scenario.label, toolName: 'web_fetch', content: proxyResult.content as Array<{ type: 'text'; text: string }>, details: proxyResult.details, isError: false, timestamp: Date.now() });

    const prepared = await contextMgr.prepare({ systemPrompt: 'host', tools: [], messages: getMessagesAfterCompactBoundary(manager) }, {} as ModelRuntime, model, 4096, live);
    const toolMsg = prepared.messages.find(m => m.role === 'toolResult')!;
    const rendered = JSON.stringify(toolMsg);
    assert.ok(rendered.length <= 3600);
    assert.match(rendered, /Archived tool result \(snip\)/);
    assert.match(rendered, /\[\.\.\.snipped\.\.\.\]/);
    assert.match(rendered, /EXTERNAL-HEAD/);
    assert.match(rendered, /session__read_tool_result/);
    assert.deepEqual(validateTrace(h.finish(), ['mcp-fixture-key']), []);
  }
});

check('integration', 'SourceServerBuilder registers web tools from env-only AI config or env-only search URL with expected routing', async () => {
  const keys = ['MODEL_PROVIDER', 'MODEL_ID', 'API_KEY', 'BASE_URL', 'WEB_NATIVE_PROVIDER', 'WEB_NATIVE_API_KEY', 'WEB_NATIVE_MODEL', 'SEARCH_MCP_URL', 'SEARCH_MCP_TOKEN', 'API_SEARCH_URL', 'API_SEARCH_KEY', 'API_FETCH_URL', 'API_FETCH_KEY'] as const;
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const resetEnv = (overrides: Partial<Record<(typeof keys)[number], string>>) => {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
  };
  try {
    const configs = SourceConfigsSchema.parse([{ slug: 'web', kind: 'web', allowedDomains: ['*'], searchMcp: {} }]);
    const { ToolRegistry } = await import('@cwatch/shared/tools/registry');

    // Case 1: Only AI configured (OpenAI), no search tool URL -> registers web_search & web_fetch wired to native.openai
    resetEnv({ MODEL_PROVIDER: 'openai', MODEL_ID: 'gpt-5', API_KEY: 'ai-only-key', WEB_NATIVE_PROVIDER: 'auto' });
    const reg1 = new ToolRegistry(), builder1 = new SourceServerBuilder(process.cwd());
    const gaps1 = await builder1.register(configs, 'live', reg1, live);
    assert.deepEqual(gaps1, []);
    assert.deepEqual(reg1.list().map(t => t.proxy_name).sort(), ['web_fetch', 'web_search']);
    const built1 = await builder1.build(configs[0], 'live', live);
    const opt1 = (built1.client as unknown as { options: WebOptions }).options;
    assert.equal(opt1.native?.provider, 'openai');
    assert.equal(opt1.searchMcp, undefined);
    await built1.client.close();
    await reg1.close();

    // Case 2: Both AI and search tool URL+Key configured -> registers cleanly with searchMcp populated (prioritized over native)
    resetEnv({ MODEL_PROVIDER: 'openai', MODEL_ID: 'gpt-5', API_KEY: 'ai-only-key', WEB_NATIVE_PROVIDER: 'auto', SEARCH_MCP_URL: 'https://api.bochaai.com/v1/web-search', SEARCH_MCP_TOKEN: 'bocha-key' });
    const reg2 = new ToolRegistry(), builder2 = new SourceServerBuilder(process.cwd());
    const gaps2 = await builder2.register(configs, 'live', reg2, live);
    assert.deepEqual(gaps2, []);
    assert.deepEqual(reg2.list().map(t => t.proxy_name).sort(), ['web_fetch', 'web_search']);
    const built2 = await builder2.build(configs[0], 'live', live);
    const opt2 = (built2.client as unknown as { options: WebOptions }).options;
    assert.equal(opt2.native?.provider, 'openai');
    assert.equal(opt2.searchMcp && 'url' in opt2.searchMcp ? opt2.searchMcp.url : undefined, 'https://api.bochaai.com/v1/web-search');
    await built2.client.close();
    await reg2.close();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
