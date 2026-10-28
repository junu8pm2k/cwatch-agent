import { abortable, hash, type RetrievalResult, type ToolExecutionContext } from '@cwatch/core/types';
import { Redactor } from '../sessions/trace.ts';
import { WebFailure } from './web-errors.ts';
import { apiEndpoint, type WebApiOptions, type ResolvedApiEndpoint } from './web-api-config.ts';
import { WebSearchInputSchema, WebFetchInputSchema } from './web-tools.ts';
import { normalizeWebResult } from './web-results.ts';

function field(value: any, path?: string): any { if (!path) return value; for (const key of path.split('.')) { if (value == null || !Object.hasOwn(Object(value), key)) return undefined; value = value[key]; } return value; }
async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > 2_000_000) { await response.body?.cancel().catch(() => {}); throw new WebFailure('parse_failed', 'api_response_too_large'); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (reader) try { for (;;) { const next = await abortable(reader.read(), signal); if (next.done) break; size += next.value.byteLength; if (size > 2_000_000) { await reader.cancel(); throw new WebFailure('parse_failed', 'api_response_too_large'); } chunks.push(next.value); } }
  finally { if (signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Called only inside the executor-authorized HTTP stage. */
async function requestApi(operation: 'search' | 'fetch', config: ResolvedApiEndpoint, args: Record<string, unknown>, signal: AbortSignal, fetcher: typeof fetch) {
  const url = apiEndpoint(config.endpoint), headers = new Headers(config.headers);
  const params: Record<string, unknown> = { ...config.fixedParams, ...config.envParams };
  if (operation === 'search') { const q = config.queryParam ?? 'query', n = config.limitParam ?? 'limit'; params[q] = args.query; params[n] = args.limit; }
  else { const key = config.urlParam ?? 'url'; params[key] = config.urlAsArray ? [args.url] : args.url; }
  if (config.auth && config.token) {
    const { location } = config.auth, name = config.auth.name ?? (location === 'header' ? 'Authorization' : 'api_key');
    const prefix = config.auth.scheme === 'bearer' || config.auth.scheme === undefined && location === 'header' ? 'Bearer ' : '';
    if (location === 'header') headers.set(name, prefix + config.token);
    else {
      if (Object.hasOwn(params, name)) throw new WebFailure('parse_failed', 'api_auth_parameter_conflicts_with_input');
      if (location === 'query') url.searchParams.set(name, prefix + config.token); else params[name] = prefix + config.token;
    }
  }
  let body: string | undefined;
  if (config.method === 'GET') for (const [key, value] of Object.entries(params)) url.searchParams.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  else { headers.set('content-type', 'application/json'); body = JSON.stringify(params); }
  let response: Response;
  try { response = await abortable(fetcher(url, { method: config.method, headers, ...(body ? { body } : {}), redirect: 'error', signal }), signal); }
  catch { signal.throwIfAborted(); throw new WebFailure('unavailable', 'api_transport_unavailable'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new WebFailure(response.status === 401 || response.status === 403 ? 'auth_failed' : response.status === 429 ? 'rate_limited' : response.status >= 300 && response.status < 400 ? 'parse_failed' : 'unavailable', 'api_HTTP_' + response.status);
  }
  let raw: string;
  try { raw = await responseText(response, signal); }
  catch (error) { signal.throwIfAborted(); if (error instanceof WebFailure) throw error; throw new WebFailure('unavailable', 'api_response_read_failed'); }
  if (config.response.format === 'text') return { raw, mapped: undefined };
  let data: any; try { data = JSON.parse(raw); } catch { throw new WebFailure('parse_failed', 'api_invalid_json_response'); }
  if (data?.error || data?.errors || data?.success === false) throw new WebFailure('unknown', 'api_response_reports_error');
  const mapping = config.response;
  if (operation === 'search' && mapping.resultsPath) {
    let items = field(data, mapping.resultsPath);
    if (items === undefined && mapping.emptyResultsWhenMissing) items = [];
    if (!Array.isArray(items)) throw new WebFailure('parse_failed', 'api_results_path_not_array');
    data = { results: items.map(item => ({ url: field(item, mapping.urlField ?? 'url'), title: field(item, mapping.titleField ?? 'title'), snippet: field(item, mapping.snippetField ?? 'snippet') ?? '' })) };
  } else if (operation === 'fetch' && (mapping.pagePath || mapping.textField)) {
    const page = field(data, mapping.pagePath);
    data = { url: field(page, mapping.urlField ?? 'url') ?? args.url, title: field(page, mapping.titleField ?? 'title') ?? '', content: field(page, mapping.textField ?? 'content') };
  }
  return { raw, mapped: data };
}

/** Local implementation of the host's web tools. No MCP client/server or discovery. */
export class WebApiAdapter {
  constructor(readonly options: WebApiOptions, private readonly checkUrl: (url: string) => unknown, private readonly fetcher: typeof fetch = fetch) {}

  async call(operation: string, args: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<RetrievalResult> {
    if (!context) throw new Error('web_api_execution_context_required');
    signal.throwIfAborted();
    if (operation !== 'web_search' && operation !== 'web_fetch') throw new WebFailure('unsupported', 'web_api_operation_not_supported');
    const name = operation === 'web_search' ? 'search' : 'fetch';
    const input = (name === 'search' ? WebSearchInputSchema : WebFetchInputSchema).safeParse(args);
    if (!input.success) throw new WebFailure('parse_failed', 'web_api_invalid_input');
    const endpoint = this.options[name];
    if (!endpoint) throw new WebFailure('unsupported', 'web_api_operation_not_configured:' + name);
    if (name === 'fetch') this.checkUrl(String(args.url));

    const secrets = this.options.secrets.flatMap(v => [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2), JSON.stringify(v).slice(1, -1)]);
    const redactor = new Redactor(secrets);
    const metadata = { provider: 'api', backend: 'web.api', protocol: 'http', transport: 'direct', operation, endpoint: redactor.clean(endpoint.endpoint), httpMethod: endpoint.method };
    return context.stage('web.api.' + operation, async () => {
      const timeout = new AbortController(), handle = setTimeout(() => timeout.abort(new DOMException('API timeout', 'TimeoutError')), 25_000);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        context.event('provider_tool_event', { ...metadata, phase: 'request', input: redactor.clean(input.data) });
        const result = await context.stage('web.api.http.' + name, async () => {
          try { return await requestApi(name, endpoint, input.data, combined, this.fetcher); }
          catch (error) {
            signal.throwIfAborted();
            if (timeout.signal.aborted) throw new WebFailure('unavailable', 'api_request_timeout');
            if (error instanceof WebFailure) throw error;
            // Never put upstream exceptions (possibly containing credentials) in Trace.
            throw new WebFailure('unknown', 'api_request_failed');
          }
        });
        combined.throwIfAborted();
        const raw = redactor.clean(result.raw), data = redactor.clean(result.mapped);
        const normalized = normalizeWebResult(operation, args, { data, text: data === undefined ? raw : '', raw: JSON.stringify({ upstreamResponse: raw, ...(data !== undefined ? { data } : {}) }) }, this.checkUrl, 'web.api');
        context.event('provider_tool_event', { ...metadata, phase: 'response', endpointId: hash(endpoint.endpoint).slice(0, 16), returned: normalized.returned, filteredOutsideScope: normalized.filteredOutsideScope });
        return normalized.result;
      } finally { clearTimeout(handle); }
    });
  }
}
