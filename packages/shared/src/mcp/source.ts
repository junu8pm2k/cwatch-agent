import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { abortable, RetrievalSchema, hash, type SourceClient, type ToolDefinition, type ToolExecutionContext } from "@cwatch/core/types";
import { Redactor } from "../sessions/trace.ts";
import { McpSchemaValidator } from "../sources/web-mcp.ts";
import { mcpSecrets, UserMcpSchema, validateMcpUrl, type UserMcpConfig } from "./storage.ts";
import { assertNetworkUrlAllowed } from '../sources/network-policy.ts';

const CAP = 2_000_000;
export class UserMcpSource implements SourceClient {
  readonly config: UserMcpConfig;
  private client?: Client;
  private transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  private lifetime = new AbortController();
  private operationSignal?: AbortSignal;
  private redactor: Redactor;
  private secrets: string[];
  constructor(config: UserMcpConfig, readonly cwd: string, private env: NodeJS.ProcessEnv = process.env, private fetcher: typeof fetch = fetch) {
    this.config = UserMcpSchema.parse(config);
    this.secrets = mcpSecrets(this.config, env); this.redactor = new Redactor(this.secrets);
  }
  private requiredEnv(name: string): string {
    const value = this.env[name]; if (!value?.trim()) throw new Error('mcp_missing_environment:' + name);
    return value;
  }
  private network = async (target: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = validateMcpUrl(this.config.url!), url = new URL(target instanceof Request ? target.url : String(target));
    assertNetworkUrlAllowed(url);
    if (url.origin !== endpoint.origin || url.username || url.password || (this.config.transport === 'streamable-http' && url.toString() !== endpoint.toString())) throw new Error('mcp_endpoint_changed');
    const headers = new Headers(init?.headers);
    if (this.config.tokenEnv) headers.set(this.config.authHeader, (this.config.authScheme === 'raw' ? '' : 'Bearer ') + this.requiredEnv(this.config.tokenEnv));
    const signal = AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : []), ...((init?.method ?? 'GET').toUpperCase() !== 'GET' && this.operationSignal ? [this.operationSignal] : [])]);
    const response = await this.fetcher(target, { ...init, headers, redirect: 'error', signal });
    if ([401, 403, 429].includes(response.status) || response.status >= 500 || response.status >= 300 && response.status < 400) throw new Error('mcp_HTTP_' + response.status);
    if (Number(response.headers.get('content-length')) > CAP) throw new Error('mcp_response_too_large');
    let size = 0;
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.length; if (size > CAP) throw new Error('mcp_response_too_large'); controller.enqueue(chunk); } }));
    return new Response(body ?? null, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  private async connect(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    if (this.client) return this.client;
    this.operationSignal = signal; this.lifetime = new AbortController();
    if (this.config.tokenEnv) this.requiredEnv(this.config.tokenEnv);
    const attempt = async (mode: 'stdio' | 'streamable-http' | 'sse') => {
      const client = new Client({ name: 'cwatch-user-mcp', version: '0.1.0' }, { jsonSchemaValidator: new McpSchemaValidator() });
      let transport: NonNullable<UserMcpSource['transport']>;
      if (mode === 'stdio') {
        const env = Object.fromEntries(Object.entries(this.env).filter(([key, value]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS)$/i.test(key) && value !== undefined)) as Record<string, string>;
        for (const [target, source] of [...Object.entries(this.config.env), ...Object.entries(this.config.publicEnv)]) env[target] = this.requiredEnv(source);
        transport = new StdioClientTransport({ command: this.config.command!, args: this.config.args, cwd: this.cwd, env, stderr: 'pipe', maxBufferSize: CAP });
        transport.stderr?.on('data', () => {}); // Drain diagnostics without exposing credentials or mixing them into the protocol.
      } else {
        const endpoint = validateMcpUrl(this.config.url!);
        const options = { fetch: this.network, requestInit: { redirect: 'error' as const } };
        transport = mode === 'sse'
          ? new SSEClientTransport(endpoint, { ...options, eventSourceInit: { fetch: this.network } })
          : new StreamableHTTPClientTransport(endpoint, { ...options, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
      }
      this.transport = transport;
      try { await abortable(client.connect(transport, { signal, timeout: 20_000 }), signal); }
      catch (error) { await client.close().catch(() => {}); await transport.close().catch(() => {}); throw error; }
      this.client = client; return client;
    };
    try { return await attempt(this.config.transport === 'stdio' ? 'stdio' : this.config.transport === 'sse' ? 'sse' : 'streamable-http'); }
    catch (error) {
      signal.throwIfAborted();
      if (this.config.transport === 'auto' && [404, 405].includes(Number((error as { code?: unknown }).code))) return attempt('sse');
      throw new Error(this.redactor.clean(String(error)));
    }
  }
  async listTools(signal: AbortSignal): Promise<ToolDefinition[]> {
    try {
      const client = await this.connect(signal), tools: ToolDefinition[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const listed = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 20_000 });
        for (const tool of listed.tools) {
          const wire = JSON.stringify(tool);
          if (this.secrets.some(secret => secret && wire.includes(secret))) throw new Error('mcp_discovery_contains_credentials');
          tools.push({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema, action: Object.hasOwn(this.config.toolSemantics, tool.name) ? this.config.toolSemantics[tool.name] : this.config.defaultAction });
        }
        cursor = listed.nextCursor;
        if (tools.length > 256 || cursor && (cursors.has(cursor) || cursors.size >= 4)) throw new Error('mcp_discovery_limit');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('mcp_duplicate_tool_names');
      return tools;
    } catch (error) { await this.close(); throw new Error(this.redactor.clean(String(error))); }
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<unknown> {
    signal.throwIfAborted(); if (!context) throw new Error('mcp_executor_context_required');
    this.operationSignal = signal;
    const abort = () => { this.lifetime.abort(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await context.stage('mcp.custom.call', async () => {
        const client = await this.connect(signal);
        return client.callTool({ name, arguments: args }, undefined, { signal, timeout: 20_000 });
      });
      signal.throwIfAborted();
      const raw = JSON.stringify(this.redactor.clean(result));
      if (Buffer.byteLength(raw) > CAP) throw new Error('mcp_result_too_large');
      context.event('provider_tool_event', { provider: 'mcp', sourceSlug: this.config.slug, remoteTool: name, isError: result.isError === true, resultHash: hash(raw) });
      if ((Object.hasOwn(this.config.toolResultFormats, name) ? this.config.toolResultFormats[name] : this.config.resultFormat) === 'retrieval' && !result.isError) {
        const text = (result.content as Array<{ type: string; text?: string }>).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
        let value: unknown; try { value = result.structuredContent ?? JSON.parse(text); } catch { throw new Error('mcp_retrieval_schema_mismatch'); }
        const checked = RetrievalSchema.safeParse(value);
        if (!checked.success) throw new Error('mcp_retrieval_schema_mismatch');
        const parsed = checked.data;
        if (parsed.signals.some(item => item.sourceSlug !== this.config.slug)) throw new Error('mcp_signal_source_mismatch');
        return this.redactor.clean(parsed);
      }
      return {
        kind: 'mcp_tool_result', status: result.isError ? 'tool_failed' : 'success', isError: result.isError === true,
        sourceSlug: this.config.slug, tool: name, provenance: 'live', raw,
        result: raw.length <= 48_000 ? JSON.parse(raw) : { preview: raw.slice(0, 48_000), truncated: true },
      };
    } catch (error) { if (signal.aborted) await this.close(); signal.throwIfAborted(); throw new Error(this.redactor.clean(String(error))); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async close(): Promise<void> {
    this.lifetime.abort(new Error('mcp_closed'));
    const client = this.client, transport = this.transport; this.client = undefined; this.transport = undefined;
    await client?.close().catch(() => {}); await transport?.close().catch(() => {});
  }
}
