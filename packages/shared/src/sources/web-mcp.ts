import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { hash, type RetrievalResult, type ToolExecutionContext } from "@cwatch/core/types";
import { WebFailure } from './web-errors.ts';
import { normalizeMcpResult } from './web-mcp-results.ts';
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { ApiMcpConfigSchema, readApiMcp, type ApiMcpConfig, type ApiMcpOptions } from './web-api-config.ts';

const Ajv = AjvModule as unknown as typeof import('ajv').default;
const Ajv2020 = Ajv2020Module as unknown as typeof import('ajv/dist/2020.js').default;
function compileSchema(schema: Record<string, any>) {
  if (schema.$async) throw new WebFailure('parse_failed', 'search_mcp_async_schema_not_supported');
  const Validator = /draft-0[467]/.test(String(schema.$schema ?? '')) ? Ajv : Ajv2020;
  const validate = new Validator({ strict: false, validateFormats: false }).compile(schema);
  return validate;
}
export class McpSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validate = compileSchema(schema);
    return input => validate(input) ? { valid: true, data: input as T, errorMessage: undefined } : { valid: false, data: undefined, errorMessage: 'search_mcp_output_schema_mismatch' };
  }
}
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const RemoteMcpConfigSchema = z.object({
  type: z.literal('remote').optional(),
  url: z.string().url().optional(), urlEnv: envName.optional(), tokenEnv: envName.optional(),
  transport: z.enum(['auto', 'streamable-http', 'sse']).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  authHeader: z.string().regex(/^[A-Za-z0-9-]+$/).optional(), authScheme: z.enum(['bearer', 'raw']).optional(),
  tools: z.object({ search: z.string().min(1).optional(), fetch: z.string().min(1).optional() }).strict().optional(),
}).strict();
export const SearchMcpConfigSchema = z.union([RemoteMcpConfigSchema, ApiMcpConfigSchema]);
export type SearchMcpConfig = z.infer<typeof SearchMcpConfigSchema>;
type RemoteMcpConfig = z.input<typeof RemoteMcpConfigSchema>;
export interface RemoteMcpOptions { type?: 'remote'; url: string; token?: string; transport?: 'auto' | 'streamable-http' | 'sse'; requestTimeoutMs?: number; authHeader?: string; authScheme?: 'bearer' | 'raw'; tools?: RemoteMcpConfig['tools'] }
export type SearchMcpOptions = RemoteMcpOptions | ApiMcpOptions;
export function mcpEndpoint(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('invalid_SEARCH_MCP_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(k => /key|token|secret|password|credential|auth/i.test(k))) throw new Error('SEARCH_MCP_URL_requires_HTTPS_without_embedded_credentials');
  return url;
}
export function readSearchMcp(config: ApiMcpConfig, env: NodeJS.ProcessEnv): ApiMcpOptions;
export function readSearchMcp(config: RemoteMcpConfig, env: NodeJS.ProcessEnv): RemoteMcpOptions | undefined;
export function readSearchMcp(config: SearchMcpConfig, env: NodeJS.ProcessEnv): SearchMcpOptions | undefined;
export function readSearchMcp(config: SearchMcpConfig | ApiMcpConfig, env: NodeJS.ProcessEnv): SearchMcpOptions | undefined {
  const parsed = SearchMcpConfigSchema.parse(config);
  if (parsed.type === 'api') return readApiMcp(parsed, env);
  const value = parsed.url ?? env[parsed.urlEnv ?? 'SEARCH_MCP_URL']?.trim();
  if (!value) return undefined;
  return { url: mcpEndpoint(value).toString(), token: env[parsed.tokenEnv ?? 'SEARCH_MCP_TOKEN']?.trim() || undefined, transport: parsed.transport ?? 'auto', authHeader: parsed.authHeader ?? 'Authorization', authScheme: parsed.authScheme ?? 'bearer', tools: parsed.tools, ...(parsed.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: parsed.requestTimeoutMs }) };
}

interface RemoteTool { name: string; inputSchema: Record<string, any>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
const aliases = {
  query: ['query', 'q', 'search_query', 'searchQuery', 'search_term', 'searchTerm', 'searchPhrase'],
  limit: ['limit', 'n', 'count', 'max_results', 'maxResults', 'num_results', 'numResults', 'number_of_results'],
  url: ['url', 'uri', 'target_url', 'web_url', 'webUrl', 'urls'],
};
function field(tool: RemoteTool, keys: string[]): string | undefined { return keys.find(k => Object.hasOwn(tool.inputSchema.properties ?? {}, k)); }
export function selectMcpTool(tools: RemoteTool[], operation: string, args: Record<string, unknown>, explicit?: string): { name: string; input: Record<string, unknown>; schemaHash: string } {
  const search = operation === 'web_search', primary = search ? aliases.query : aliases.url;
  const candidates = tools.filter(tool => {
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) return false;
    if (explicit) return tool.name === explicit;
    const name = tool.name.replace(/[.\-]/g, '_').toLowerCase();
    if (/(?:^|_)(?:delete|remove|create|update|write|send|publish|execute|admin|crawl|map)(?:_|$)/.test(name)) return false;
    return field(tool, primary) !== undefined && (search ? /(?:^|_)(?:search|websearch)(?:_|$)/.test(name) : /(?:^|_)(?:fetch|scrape|extract|read_url|read_page|read_webpage|get_page|get_webpage|retrieve_url|visit_page)(?:_|$)/.test(name));
  });
  if (!candidates.length) throw new WebFailure('unsupported', 'search_mcp_operation_not_discovered:' + operation);
  if (candidates.length !== 1) throw new WebFailure('parse_failed', 'search_mcp_ambiguous_tools: configure tools.' + (search ? 'search' : 'fetch'));
  const tool = candidates[0], key = field(tool, primary);
  if (!key) throw new WebFailure('parse_failed', 'search_mcp_unrecognized_input_schema');
  const properties = tool.inputSchema.properties ?? {}, input: Record<string, unknown> = { [key]: properties[key]?.type === 'array' ? [search ? args.query : args.url] : search ? args.query : args.url };
  if (search) {
    const limitKey = field(tool, aliases.limit);
    if (limitKey) input[limitKey] = Math.min(Number(args.limit), properties[limitKey]?.maximum ?? Number(args.limit));
    if (properties.use_common_search?.type === 'boolean') input.use_common_search = true;
  }
  try { if (!compileSchema(tool.inputSchema)(input)) throw new Error('invalid'); }
  catch { throw new WebFailure('parse_failed', 'search_mcp_tool_schema_incompatible'); }
  return { name: tool.name, input, schemaHash: hash(tool.inputSchema) };
}

/** Remote search capability discovered from MCP, independent from the planner model. */
export class RemoteSearchMcp {
  constructor(readonly options: RemoteMcpOptions, private readonly checkUrl: (url: string) => unknown, private readonly fetcher: typeof fetch = fetch) {}
  async call(operation: string, args: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<RetrievalResult> {
    signal.throwIfAborted();
    const endpoint = mcpEndpoint(this.options.url), serverId = hash(endpoint.toString()).slice(0, 16);
    const requestTimeoutMs = z.number().int().min(1000).max(120_000).parse(this.options.requestTimeoutMs ?? 30_000);
    const controlTimeoutMs = Math.min(30_000, requestTimeoutMs);
    const metadata = { provider: 'mcp', serverId, protocol: 'mcp', operation };
    const headers = new Headers();
    if (this.options.token) headers.set(this.options.authHeader ?? 'Authorization', (this.options.authScheme === 'raw' ? '' : 'Bearer ') + this.options.token);
    let connectionMode = this.options.transport === 'sse' ? 'sse' : 'streamable-http';
    let activeClient: Client | undefined, lastHttpFailure: WebFailure | undefined;
    const network = async (target: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signal.throwIfAborted();
      const url = new URL(target instanceof Request ? target.url : String(target));
      if (url.origin !== endpoint.origin || (connectionMode === 'streamable-http' && url.toString() !== endpoint.toString()) || url.username || url.password) throw new WebFailure('parse_failed', 'search_mcp_endpoint_changed');
      const merged = new Headers(init?.headers); headers.forEach((v, k) => merged.set(k, v));
      let response: Response;
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      try { response = await this.fetcher(target, { ...init, headers: merged, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), timeout]) }); }
      catch { signal.throwIfAborted(); lastHttpFailure = new WebFailure('unavailable', timeout.aborted ? 'search_mcp_transport_timeout' : 'search_mcp_transport_unavailable'); throw lastHttpFailure; }
      const status = response.status;
      if (status === 401 || status === 403 || status === 429 || status >= 500 || status >= 300 && status < 400) {
        lastHttpFailure = new WebFailure(status === 401 || status === 403 ? 'auth_failed' : status === 429 ? 'rate_limited' : status >= 500 ? 'unavailable' : 'parse_failed', 'search_mcp_HTTP_' + status); throw lastHttpFailure;
      }
      if (Number(response.headers.get('content-length')) > 2_000_000) throw new WebFailure('parse_failed', 'search_mcp_response_too_large');
      let size = 0;
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > 2_000_000) throw new WebFailure('parse_failed', 'search_mcp_response_too_large'); controller.enqueue(chunk); } }));
      return new Response(body ?? null, { status, statusText: response.statusText, headers: response.headers });
    };
    const connect = async (mode: 'streamable-http' | 'sse'): Promise<Client> => {
      connectionMode = mode; lastHttpFailure = undefined;
      const client = new Client({ name: 'cwatch', version: '0.1.0' }, { jsonSchemaValidator: new McpSchemaValidator() }); activeClient = client;
      const options = { requestInit: { headers, redirect: 'error' as const }, fetch: network };
      const transport = mode === 'sse' ? new SSEClientTransport(endpoint, { ...options, eventSourceInit: { fetch: network } }) : new StreamableHTTPClientTransport(endpoint, { ...options, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
      await context.stage('mcp.remote.connect', () => client.connect(transport, { signal, timeout: controlTimeoutMs }));
      return client;
    };
    try {
      let client: Client;
      try { client = await connect(connectionMode as 'streamable-http' | 'sse'); }
      catch (error) {
        signal.throwIfAborted();
        if (this.options.transport && this.options.transport !== 'auto' || lastHttpFailure || ![404, 405].includes(Number((error as { code?: number }).code))) throw error;
        await activeClient?.close().catch(() => {});
        context.event('web_route', { route: 'mcp', serverId, transport: 'sse', reason: 'streamable_http_not_supported' });
        client = await connect('sse');
      }
      const tools: RemoteTool[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const listed = await context.stage('mcp.remote.list_tools', () => client.listTools(cursor ? { cursor } : {}, { signal, timeout: controlTimeoutMs }));
        tools.push(...listed.tools); cursor = listed.nextCursor;
        if (tools.length > 256 || cursor && (cursors.has(cursor) || cursors.size >= 4)) throw new WebFailure('parse_failed', 'search_mcp_discovery_limit');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(tools.map(t => t.name)).size !== tools.length) throw new WebFailure('parse_failed', 'search_mcp_duplicate_tool_names');
      const selected = selectMcpTool(tools, operation, args, operation === 'web_search' ? this.options.tools?.search : this.options.tools?.fetch);
      context.event('provider_tool_event', { ...metadata, transport: connectionMode, remoteTool: selected.name, input: selected.input, schemaHash: selected.schemaHash, requestTimeoutMs });
      const result = await context.stage('mcp.remote.' + operation, () => client.callTool({ name: selected.name, arguments: selected.input }, undefined, { signal, timeout: requestTimeoutMs }));
      signal.throwIfAborted();
      context.event('provider_tool_event', { ...metadata, remoteTool: selected.name, isError: result.isError === true });
      if (result.isError) {
        const text = JSON.stringify(result.content);
        throw new WebFailure(/unauthori[sz]ed|forbidden|invalid.*(?:key|token)|\b40[13]\b/i.test(text) ? 'auth_failed' : /rate.?limit|too many|\b429\b/i.test(text) ? 'rate_limited' : 'unknown', 'search_mcp_tool_error');
      }
      const normalized = normalizeMcpResult(operation, args, result, this.checkUrl);
      context.event('provider_tool_event', { ...metadata, returned: normalized.returned, filteredOutsideScope: normalized.filteredOutsideScope });
      return normalized.result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === 'backend_policy_block') throw error;
      if (error instanceof WebFailure) throw error;
      if (lastHttpFailure) throw lastHttpFailure;
      const code = (error as { code?: number }).code;
      if (code === -32601 || code === 404 || code === 405) throw new WebFailure('unsupported', 'search_mcp_method_not_supported');
      if (code === -32001) throw new WebFailure('unavailable', 'search_mcp_request_timeout');
      throw new WebFailure('parse_failed', 'search_mcp_protocol_error');
    } finally { await activeClient?.close().catch(() => {}); }
  }
}
