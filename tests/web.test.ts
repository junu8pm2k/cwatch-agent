import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, task, store, deferred, waitTick, fixture } from './harness.ts';
import { PreferredWebSource, readWebOptions, allowedUrl, type WebOptions, type WebDependencies } from "@cwatch/shared/sources/web";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager } from "@cwatch/shared/agent/core/permission-manager";
import { Trace, Redactor, validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { id, type RetrievalResult } from "@cwatch/core/types";
import { EvidenceStore } from "@cwatch/shared/intelligence/evidence";
import { SourceServerBuilder, SourceConfigsSchema } from "@cwatch/shared/sources/server-builder";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";
import { readSearchMcp } from "@cwatch/shared/sources/web-mcp";

const live = new AbortController().signal;
const base: WebOptions = { slug: 'web', allowedDomains: ['nodejs.org'] };
const native: WebOptions['native'] = { provider: 'anthropic', apiKey: 'native-fixture-key', model: 'fixture-model', baseUrl: 'https://native.example/v1' };
export async function harness(options: WebOptions = base, dependencies: WebDependencies = {}, toolTimeoutMs = 1000) {
  const data = store(), registry = new ToolRegistry(), t = task(); t.allowedSources = ['web'];
  const trace = new Trace(data, t.taskId, id(), new Redactor(['native-fixture-key', 'mcp-fixture-key'])); trace.emit('run_started', { task: t });
  const source = new PreferredWebSource(options, dependencies); await registry.register('web', 'builtin', source, live);
  const executor = new ToolExecutor(registry, new ActionPolicy(), new ApprovalManager(), data, trace, t, toolTimeoutMs);
  return { data, registry, source, executor, trace, task: t, finish: () => { trace.emit('run_completed', {}); return data.lines<TraceEvent>(trace.key); } };
}
function nativeResponse(name = 'web_search', input: Record<string, unknown> = { query: 'Node.js' }) {
  return { stop_reason: 'end_turn', usage: { input_tokens: 5 }, content: [
    { type: 'server_tool_use', id: 'native-1', name, input },
    { type: name + '_tool_result', tool_use_id: 'native-1', content: name === 'web_search' ? [{ type: 'web_search_result', url: 'https://nodejs.org/article', title: 'Node.js news' }] : { type: 'web_fetch_result', url: input.url, content: { title: 'Node.js', source: { type: 'text', data: 'Node.js text' } }, retrieved_at: '2026-10-17T00:00:00Z' } },
  ] };
}
check('contract', 'StepFun custom model is not assumed to have controlled native web tools', () => {
  const options = readWebOptions('web', ['nodejs.org'], { MODEL_PROVIDER: 'stepfun', MODEL_ID: 'step-5-preview', API_KEY: 'not-used' });
  assert.equal(options.native, undefined); assert.equal(options.nativeUnavailableReason, 'no_controlled_native_adapter_for_configured_provider');
});
check('contract', 'native configuration must be explicit or a recognized native Anthropic endpoint', () => {
  const options = readWebOptions('web', ['nodejs.org'], { MODEL_PROVIDER: 'anthropic', MODEL_ID: 'configured-model', API_KEY: 'key' }); assert.equal(options.native?.model, 'configured-model');
  assert.equal(readWebOptions('web', ['nodejs.org'], { WEB_NATIVE_PROVIDER: 'off', MODEL_PROVIDER: 'anthropic', API_KEY: 'key' }).native, undefined);
});
check('integration', 'native search preferred, bounded, traced and never dispatched through planner model', async () => {
  let requests = 0;
  const h = await harness({ ...base, native }, { fetcher: async (_url, init) => {
    requests++; const body = JSON.parse(String(init?.body)); assert.equal(body.tools.length, 1); assert.equal(body.tools[0].max_uses, 1); assert.deepEqual(body.tools[0].allowed_domains, ['nodejs.org']); assert.ok(!String(init?.body).includes('native-fixture-key')); return Response.json(nativeResponse());
  } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 2 }, live) as RetrievalResult;
  assert.equal(result.backend, 'native.anthropic'); assert.equal(requests, 1); assert.equal(result.searchResults?.length, 1);
  const events = h.finish(); assert.deepEqual(validateTrace(events, ['native-fixture-key']), []); assert.ok(events.some(e => e.type === 'provider_tool_event')); assert.equal(events.filter(e => e.type === 'backend_started').length, 1);
});
check('integration', 'native fetch returns exact-URL page data with audit events', async () => {
  const url = 'https://nodejs.org/article'; const h = await harness({ ...base, native }, { fetcher: async () => Response.json(nativeResponse('web_fetch', { url })) });
  const result = await h.executor.execute('web_fetch', { url }, live) as RetrievalResult; assert.equal(result.pages?.[0].url, url); assert.equal(result.backend, 'native.anthropic'); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'unsupported native without configured MCP returns unavailable with no direct webpage request', async () => {
  let requests = 0; const h = await harness({ ...base, native }, { fetcher: async url => { requests++; assert.ok(String(url).includes('native.example')); return new Response('web_search not supported', { status: 400 }); } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 2 }, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, /web_backend_unavailable/); assert.equal(requests, 1); assert.deepEqual(validateTrace(h.finish()), []);
});
for (const [http, status] of [[401, 'auth_failed'], [429, 'rate_limited']] as const) check('contract', 'native HTTP ' + http + ' does not silently fall back', async () => {
  let requests = 0; const h = await harness({ ...base, native }, { fetcher: async () => { requests++; return new Response('failure', { status: http }); } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 2 }, live) as RetrievalResult; assert.equal(result.status, status); assert.equal(requests, 1);
});
check('contract', 'native answer without tool events is rejected as unverifiable', async () => {
  const h = await harness({ ...base, native }, { fetcher: async () => Response.json({ content: [{ type: 'text', text: 'invented web answer' }] }) });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult; assert.equal(result.status, 'parse_failed'); assert.equal(result.searchResults, undefined);
});
check('contract', 'native rewritten query or wrong URL is recorded and rejected, not accepted as authorized data', async () => {
  const h = await harness({ ...base, native }, { fetcher: async () => Response.json(nativeResponse('web_search', { query: 'unapproved query' })) });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult; assert.equal(result.status, 'parse_failed'); assert.ok(h.data.lines<TraceEvent>(h.trace.key).some(e => e.type === 'provider_tool_event'));
});
check('contract', 'web denied source and out-of-scope URL/query have zero HTTP executions', async () => {
  let requests = 0; const h = await harness(base, { fetcher: async () => { requests++; return new Response('unused'); } });
  await assert.rejects(h.executor.execute('web_fetch', { url: 'https://attacker.example/' }, live));
  await assert.rejects(h.executor.execute('web_search', { query: 'unrelated company', limit: 1 }, live));
  h.registry.setActive('web', false); await assert.rejects(h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live)); assert.equal(requests, 0); assert.ok(h.data.executions().every(e => e.execute_count === 0));
});
check('contract', 'source revocation between native rejection and MCP prevents MCP request', async () => {
  let requests = 0; let h: Awaited<ReturnType<typeof harness>>;
  h = await harness({ ...base, native, searchMcp }, { fetcher: async () => { requests++; h.registry.setActive('web', false); return new Response('web_search unsupported', { status: 400 }); } });
  await assert.rejects(h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live), /backend_policy_block/); assert.equal(requests, 1);
});
check('contract', 'web cancellation stops fallback and late provider events', async () => {
  let requests = 0; const late = deferred<Response>(), controller = new AbortController(); const h = await harness({ ...base, native }, { fetcher: async () => { requests++; return late.promise; } });
  const running = h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, controller.signal); await waitTick(); controller.abort(new Error('cancelled')); await assert.rejects(running); late.resolve(new Response('web_search unsupported', { status: 400 })); await waitTick();
  assert.equal(requests, 1); assert.equal(h.data.executions()[0].state, 'cancelled'); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'no configured web backend returns explicit errors and performs zero network requests', async () => {
  let requests = 0; const h = await harness(base, { fetcher: async () => { requests++; throw new Error('must not fetch'); } });
  for (const [name, args] of [['web_search', { query: 'Node.js', limit: 1 }], ['web_fetch', { url: 'https://nodejs.org/article' }]] as const) {
    const result = await h.executor.execute(name, args, live) as RetrievalResult;
    assert.equal(result.status, 'unknown'); assert.match(result.error!, /web_backend_unavailable/); assert.equal(result.searchResults, undefined); assert.equal(result.pages, undefined);
  }
  assert.equal(requests, 0); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'URL guard still excludes IP literals, credentials and unsupported ports', () => {
  for (const value of ['http://nodejs.org/', 'https://127.1/', 'https://nodejs.org:8080/', 'https://user:pass@nodejs.org/', 'https://nodejs.org/?api_key=secret']) assert.throws(() => allowedUrl(value, ['nodejs.org', '127.0.0.1']));
});
check('integration', 'full agent loop consumes search/fetch observations and retains discovery gaps beside structured facts', async () => {
  const h = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol() });
  h.task.allowedSources.push('github');
  const configs = SourceConfigsSchema.parse(JSON.parse(readFileSync('examples/sources.json', 'utf8'))).filter(c => c.kind === 'github_releases'); await new SourceServerBuilder(process.cwd()).register(configs, 'replay', h.registry, live);
  const result = await runInvestigation(h.task, new ReplayModel([
    { kind: 'call_tool', name: 'workflow__save_plan', args: { taskId: h.task.taskId, objective: 'Fixture web discovery plus verified API evidence', sources: ['web', 'github'], queries: ['Node.js'], evidenceRequirements: ['URL and evidence'], window: { start: h.task.window.start, end: h.task.window.end } } },
    { kind: 'call_tool', name: 'web_search', args: { query: 'Node.js', limit: 2 } },
    { kind: 'call_tool', name: 'web_fetch', args: { url: 'https://nodejs.org/article' } },
    { kind: 'call_tool', name: 'session__read_source_guide', args: { source: 'github' } },
    { kind: 'call_tool', name: 'mcp__github__api_github', args: { path: '/repos/nodejs/node/releases', method: 'GET', params: { per_page: 1 } } },
    { kind: 'call_tool', name: 'workflow__analyze', args: {} },
    { kind: 'call_tool', name: 'workflow__review', args: {} },
    { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Fixture run: generic web material remains discovery; structured API data supplies claims.', claimIds: '$analyzed_claim_ids' } },
    { kind: 'respond', text: 'Fixture draft saved.' },
  ]), h.registry, h.data, 'replay');
  assert.equal(result.status, 'partial', result.error); assert.ok(result.gaps.some(g => g.includes('discovery_only'))); assert.equal(new EvidenceStore(h.data).events().length, 1);
  assert.deepEqual(validateTrace(h.data.lines('traces/' + result.runId + '.jsonl')), []); await h.registry.close();
});
check('semantic', 'search discoveries are saved as gaps and never promoted to facts automatically', async () => {
  const h = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol() }); const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult;
  const facts = new EvidenceStore(h.data), analyzed = facts.ingest(h.task, result); assert.equal(facts.events().length, 0); assert.ok(analyzed.gaps.some(g => g.includes('discovery_only'))); assert.ok(result.snapshot); assert.ok(readFileSync(h.data.path(result.snapshot.path), 'utf8').includes('https://nodejs.org/article'));
});
check('contract', 'full raw response is snapshotted before bounded model observation; snapshot tampering rejected', async () => {
  const raw = '<html><title>Node.js</title><main>' + 'content '.repeat(5000) + '</main></html>';
  const h = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol({ data: { url: 'https://nodejs.org/article', content: raw } }) });
  const result = await h.executor.execute('web_fetch', { url: 'https://nodejs.org/article' }, live) as RetrievalResult;
  assert.equal(result.rawTruncated, true); assert.equal(result.raw.length, 16000); assert.equal(JSON.parse(readFileSync(h.data.path(result.snapshot!.path), 'utf8')).structuredContent.content, raw); assert.equal(result.pages![0].truncated, true);
  assert.throws(() => new EvidenceStore(h.data).ingest(h.task, { ...result, snapshot: { ...result.snapshot!, hash: 'wrong' } }), /snapshot_mismatch/);
});
check('contract', 'web adapters require executor context; no callable direct network bypass', async () => {
  let requests = 0; const source = new PreferredWebSource(base, { fetcher: async () => { requests++; return new Response('unused'); } });
  await assert.rejects(source.callTool('web_search', { query: 'Node.js', limit: 1 }, live), /execution_context_required/); assert.equal(requests, 0);
});

const MCP_URL = 'https://search-fixture.example/mcp';
const searchMcp: WebOptions['searchMcp'] = { url: MCP_URL, token: 'mcp-fixture-key' };
const mcpTools = [
  { name: 'web_search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, n: { type: 'integer' }, use_common_search: { type: 'boolean' } }, required: ['query'] } },
  { name: 'web_fetch', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];
export function mcpProtocol(options: { url?: string; authHeader?: string; authValue?: string | null; tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>; data?: any; text?: string; onCall?: (name: string, input: any) => void; onList?: () => void; isError?: boolean; callError?: { code: number; message: string } } = {}) {
  return (async (url, init) => {
    assert.equal(String(url), options.url ?? MCP_URL); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get(options.authHeader ?? 'authorization'), options.authValue === undefined ? 'Bearer mcp-fixture-key' : options.authValue);
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: any;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture-search-mcp', version: '1' } };
    else if (message.method === 'tools/list') { options.onList?.(); result = { tools: options.tools ?? mcpTools }; }
    else if (message.method === 'tools/call') {
      const { name, arguments: input } = message.params; options.onCall?.(name, input);
      if (options.callError) return Response.json({ jsonrpc: '2.0', id: message.id, error: options.callError });
      const data = options.data ?? (name === 'web_search' ? { results: [{ url: 'https://nodejs.org/article', title: 'Node.js', snippet: 'release', time: '2026-10-17 00:00:00' }] } : { url: input.url, title: 'Node.js', content: 'Node.js release details' });
      result = options.text !== undefined ? { content: [{ type: 'text', text: options.text }], isError: options.isError ?? false } : { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: options.isError ?? false };
    } else throw new Error('unexpected fixture method');
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  }) as typeof fetch;
}
check('contract', 'generic MCP URL and token are independent from the model and never reuse its key', () => {
  const env = { SEARCH_MCP_URL: MCP_URL, SEARCH_MCP_TOKEN: 'separate', MODEL_PROVIDER: 'any', API_KEY: 'model-secret' };
  assert.equal(readSearchMcp({}, env)?.token, 'separate'); assert.equal(readSearchMcp({}, env)?.url, MCP_URL);
  assert.equal(readSearchMcp({ url: MCP_URL }, { API_KEY: 'model-secret' })?.token, undefined);
  assert.equal(readSearchMcp({}, {}) , undefined);
  assert.throws(() => readSearchMcp({ url: 'http://unsafe.example/mcp' }, env), /HTTPS/);
  assert.throws(() => readSearchMcp({ url: 'https://unsafe.example/mcp?api_key=private' }, env), /embedded_credentials/);
});
check('integration', 'native remains ahead of configured MCP with zero MCP requests', async () => {
  let calls = 0;
  const h = await harness({ ...base, native, searchMcp }, { fetcher: async url => { calls++; assert.ok(String(url).includes('native.example')); return Response.json(nativeResponse()); } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 2 }, live) as RetrievalResult;
  assert.equal(result.backend, 'native.anthropic'); assert.equal(calls, 1); assert.deepEqual(validateTrace(h.finish()), []);
});
check('integration', 'native unsupported goes to configured MCP with both tiers audited', async () => {
  let calls = 0; const protocol = mcpProtocol({ onCall: (name, input) => { calls++; assert.equal(name, 'web_search'); assert.deepEqual(input, { query: 'Node.js', n: 2, use_common_search: true }); } });
  const h = await harness({ ...base, native, searchMcp }, { fetcher: async (url, init) => String(url).includes('native.example') ? new Response('web_search unsupported', { status: 400 }) : protocol(url, init) });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 2 }, live) as RetrievalResult;
  assert.equal(result.backend, 'mcp.remote'); assert.equal(calls, 1); assert.equal(result.searchResults![0].published_at, null);
  const events = h.finish(); assert.deepEqual(validateTrace(events, ['mcp-fixture-key']), []); assert.equal(events.filter(e => e.type === 'backend_started').length, 4);
  assert.ok(events.some(e => e.type === 'provider_tool_event' && e.data.protocol === 'mcp'));
});
check('integration', 'MCP fetch maps exact URL content and saves raw snapshot', async () => {
  const h = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol() });
  const result = await h.executor.execute('web_fetch', { url: 'https://nodejs.org/article' }, live) as RetrievalResult;
  assert.equal(result.backend, 'mcp.remote'); assert.equal(result.pages![0].text, 'Node.js release details'); assert.ok(result.snapshot); assert.deepEqual(validateTrace(h.finish()), []);
});
for (const reason of ['unsupported', 'unavailable'] as const) check('integration', 'MCP ' + reason + ' returns an explicit error without local network calls', async () => {
  const protocol = mcpProtocol({ tools: [] }); let directCalls = 0;
  const h = await harness({ ...base, searchMcp }, { fetcher: async (url, init) => {
    if (String(url) === MCP_URL) return reason === 'unsupported' ? protocol(url, init) : new Response('unavailable', { status: 503 });
    directCalls++; throw new Error('removed fallback must not execute');
  } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 2 }, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, new RegExp(reason)); assert.equal(result.backend, 'mcp.remote'); assert.equal(directCalls, 0);
  assert.deepEqual(validateTrace(h.finish()), []);
});
for (const [http, status] of [[401, 'auth_failed'], [429, 'rate_limited']] as const) check('contract', 'MCP HTTP ' + http + ' stops without hiding failure in local fallback', async () => {
  const h = await harness({ ...base, searchMcp }, { fetcher: async url => { assert.equal(String(url), MCP_URL); return new Response('failure', { status: http }); } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult;
  assert.equal(result.status, status); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'missing MCP token never borrows model key and server auth failure remains visible', async () => {
  let calls = 0; const h = await harness({ ...base, searchMcp: { ...searchMcp!, token: undefined } }, { fetcher: async (url, init) => { calls++; assert.equal(String(url), MCP_URL); assert.equal(new Headers(init?.headers).has('authorization'), false); return new Response('unauthorized', { status: 401 }); } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult;
  assert.equal(result.status, 'auth_failed'); assert.equal(calls, 1);
});
check('semantic', 'MCP search filters out of scope results without falling back or inventing timestamps', async () => {
  const h = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol({ data: { results: [{ url: 'https://attacker.example/a', title: 'Node.js' }] } }) });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult;
  assert.equal(result.status, 'success_empty'); assert.equal(result.backend, 'mcp.remote'); assert.equal(result.searchResults!.length, 0);
  assert.ok(h.finish().some(e => e.data.filteredOutsideScope === 1));
});
check('contract', 'MCP invalid page URL and schema incompatibility are rejected without local fallback', async () => {
  const page = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol({ data: { url: 'https://attacker.example/a', content: 'wrong page' } }) });
  assert.equal((await page.executor.execute('web_fetch', { url: 'https://nodejs.org/article' }, live) as RetrievalResult).status, 'parse_failed');
  const schema = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol({ tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['unsupported_parameter'] } }], onCall: () => { throw new Error('must not call'); } }) });
  assert.equal((await schema.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult).status, 'parse_failed');
});
check('contract', 'source revocation after MCP discovery blocks tools/call before network execution', async () => {
  let calls = 0; let h: Awaited<ReturnType<typeof harness>>;
  h = await harness({ ...base, searchMcp }, { fetcher: mcpProtocol({ onList: () => h.registry.setActive('web', false), onCall: () => { calls++; } }) });
  await assert.rejects(h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live), /backend_policy_block/);
  assert.equal(calls, 0); assert.deepEqual(validateTrace(h.finish()), []);
});
check('contract', 'MCP cancellation stops future operations and local fallback', async () => {
  const controller = new AbortController(), pending = deferred<Response>(); let requests = 0;
  const h = await harness({ ...base, searchMcp }, { fetcher: async () => { requests++; return pending.promise; } });
  const running = h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, controller.signal);
  await waitTick(); controller.abort(new Error('cancelled')); await assert.rejects(running); pending.resolve(new Response('unavailable', { status: 503 })); await waitTick();
  assert.equal(requests, 1); assert.equal(h.data.executions()[0].state, 'cancelled'); assert.deepEqual(validateTrace(h.finish()), []);
});
check('integration', 'MCP request timeout is visible with no local HTTP fallback', async () => {
  const protocol = mcpProtocol({ callError: { code: -32001, message: 'request timed out' } }); let directCalls = 0;
  const h = await harness({ ...base, searchMcp }, { fetcher: async (url, init) => { if (String(url) === MCP_URL) return protocol(url, init); directCalls++; throw new Error('must not fetch page'); } });
  const result = await h.executor.execute('web_fetch', { url: 'https://nodejs.org/article' }, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, /request_timeout/); assert.equal(result.pages, undefined); assert.equal(directCalls, 0); assert.deepEqual(validateTrace(h.finish()), []);
});
check('integration', 'both native and MCP unsupported stop after two tiers', async () => {
  const protocol = mcpProtocol({ tools: [] }); let directCalls = 0;
  const h = await harness({ ...base, native, searchMcp }, { fetcher: async (url, init) => {
    if (String(url).includes('native.example')) return new Response('web_search unsupported', { status: 400 });
    if (String(url) === MCP_URL) return protocol(url, init); directCalls++; throw new Error('must not execute local fallback');
  } });
  const result = await h.executor.execute('web_search', { query: 'Node.js', limit: 1 }, live) as RetrievalResult;
  assert.equal(result.status, 'unknown'); assert.match(result.error!, /operation_not_discovered/); assert.equal(directCalls, 0);
  const events = h.finish(); assert.deepEqual(validateTrace(events), []);
  assert.deepEqual(events.filter(e => e.type === 'backend_started').map(e => e.data.backend), ['native.anthropic.web_search', 'mcp.remote.connect', 'mcp.remote.list_tools']);
});
