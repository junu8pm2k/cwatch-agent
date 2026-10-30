import { PrerequisiteManager } from '../agent/core/prerequisite-manager.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RetrievalSchema, SignalSchema, now, abortable, hash, type AgentTask, type RetrievalResult, type SourceClient, type ToolDefinition, type ToolExecutionContext, type SourceGuidePort } from "@cwatch/core/types";
import { ToolRegistry } from "../tools/registry.ts";
import { readSearchMcp, SearchMcpConfigSchema } from './web-mcp.ts';
import { WebApiConfigSchema, readWebApi } from './web-api-config.ts';
import { ApiMcpSource, PlatformApiAdapter, PlatformApiConfigSchema, ApiRequestSchema, apiSecrets } from "./api-tools.ts";
import { McpConnectionPool } from "../mcp/client-pool.ts";
import { BrowserConfigSchema } from './browser-config.ts';
import { processEnvironment } from "../utils/process-environment.ts";
import { assertNetworkUrlAllowed, assertMcpIntegrationAllowed } from './network-policy.ts';

const sourceSchema = z.object({
  slug: z.string().regex(/^[a-zA-Z0-9_-]+$/), active: z.boolean().default(true),
  kind: z.enum(['mcp', 'web', 'browser', 'api']),
  browser: BrowserConfigSchema.optional(), api: PlatformApiConfigSchema.optional(),
  urls: z.array(z.string().url()).optional(),
  entityId: z.string().optional(), entityName: z.string().optional(), domain: z.string().optional(), product: z.string().optional(),
  fixture: z.string().optional(), fixtureRequest: ApiRequestSchema.optional(), command: z.string().optional(), args: z.array(z.string()).optional(),
  toolSemantics: z.record(z.string(), z.enum(['collect', 'analyze', 'modify', 'send', 'publish'])).optional(),
  allowedDomains: z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)).min(1).optional(),
  searchMcp: SearchMcpConfigSchema.optional(),
  webApi: WebApiConfigSchema.optional(),
}).strict().superRefine((value,ctx)=>{
  if (value.kind === 'mcp') {
    try { assertMcpIntegrationAllowed(value.slug, value.command, value.args); } catch { ctx.addIssue({code:'custom',message:'github_api_disabled_by_project_policy'}); }
  }
  for (const url of [...(value.urls ?? []), ...(value.api ? [value.api.baseUrl] : [])]) {
    try { assertNetworkUrlAllowed(url); } catch { ctx.addIssue({code:'custom',message:'github_api_disabled_by_project_policy'}); }
  }
  if (value.webApi && value.kind !== 'web') ctx.addIssue({code:'custom',message:'webApi configuration only belongs to web sources'});
  if (value.webApi && value.searchMcp) ctx.addIssue({code:'custom',message:'choose webApi or searchMcp, not both'});
  if (value.kind === 'api' && !value.api) ctx.addIssue({code:'custom',message:'API source requires api configuration'});
  if (value.api && value.kind !== 'api') ctx.addIssue({code:'custom',message:'api configuration only belongs to API sources'});
  if (value.browser && value.kind !== 'browser') ctx.addIssue({code:'custom',message:'browser configuration only belongs to browser sources'});
  if (value.kind === 'browser' && (!value.urls?.length || !value.allowedDomains?.length)) ctx.addIssue({code:'custom',message:'browser source requires explicit URLs and domains'});
});
export type SourceConfig = z.infer<typeof sourceSchema>;
export const SourceConfigsSchema = z.array(sourceSchema).superRefine((items, ctx) => { if (new Set(items.map(c => c.slug)).size !== items.length) ctx.addIssue({ code: 'custom', message: 'duplicate source slug' }); });
export function readSourceConfigs(file: string): SourceConfig[] {
  const data = statSync(file).isDirectory() ? readdirSync(file,{withFileTypes:true}).filter(entry=>entry.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)).map(entry=>{const config=JSON.parse(readFileSync(resolve(file,entry.name,'config.json'),'utf8'));if(config.slug!==entry.name)throw new Error('source_directory_slug_mismatch:'+entry.name);return config;}) : JSON.parse(readFileSync(file,'utf8'));
  return SourceConfigsSchema.parse(Array.isArray(data)?data:[data]);
}
const querySchema = { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false };
export type Fetcher = typeof fetch;
function resultError(error: unknown, signal: AbortSignal, provenance: 'live' | 'fixture' = 'live'): RetrievalResult {
  return { status: signal.aborted ? (signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'unknown', signals: [], raw: '', error: String(error), provenance };
}
export function parseOfficial(config: SourceConfig, url: string, raw: string, retrievedAt = now()): RetrievalResult['signals'] {
  const blocks = [...raw.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const signals: RetrievalResult['signals'] = [];
  for (const [, json] of blocks) {
    const decoded = JSON.parse(json); const nodes = Array.isArray(decoded) ? decoded : decoded['@graph'] ?? [decoded];
    for (const value of nodes) {
      const node = z.object({ headline: z.string().optional(), name: z.string().optional(), datePublished: z.string().nullable().optional(), identifier: z.string().optional(), version: z.string().optional(), offers: z.object({ price: z.union([z.number(), z.string()]), priceCurrency: z.string() }).optional() }).passthrough().parse(value);
      const tag = node.version ?? node.identifier;
      if (!tag && !node.offers) continue;
      const price = node.offers ? `${node.offers.price} ${node.offers.priceCurrency}` : undefined;
      signals.push(SignalSchema.parse({ entity: { id: config.entityId ?? null, name: config.entityName ?? '', domain: config.domain ?? null }, product: config.product ?? '', signalType: price ? 'price' : 'release', sourceSlug: config.slug, url, eventKey: price ? 'price:' + (node.identifier ?? config.product) : 'release:' + tag, content: { title: node.headline ?? node.name ?? tag ?? '', value: price ?? tag!, polarity: 'supports' }, published_at: node.datePublished ?? null, retrieved_at: retrievedAt, collectionStatus: 'success_with_data' }));
    }
  }
  // Node.js public release articles: narrowly defined mapping, not generic guessed scraping.
  if (!signals.length && new URL(url).hostname === 'nodejs.org') {
    const tag = /\/blog\/release\/(v[\d.]+)\/?$/.exec(new URL(url).pathname)?.[1];
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(raw)?.[1];
    const published = /<time[^>]*(?:datetime|dateTime)=["']([^"']+)["']/i.exec(raw)?.[1];
    if (tag && title) signals.push(SignalSchema.parse({ entity: { id: config.entityId ?? null, name: config.entityName ?? '', domain: config.domain ?? null }, product: config.product ?? '', signalType: 'release', sourceSlug: config.slug, url, eventKey: 'release:' + tag, content: { title, value: tag, polarity: 'supports' }, published_at: published && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(published) ? published : null, retrieved_at: retrievedAt, collectionStatus: 'success_with_data' }));
  }
  if (!signals.length) throw new Error('no_supported_structured_signal: configure a site-specific parser');
  return signals;
}
export class FixtureSource implements SourceClient {
  constructor(readonly config: SourceConfig, readonly definitions: ToolDefinition[], readonly root: string, readonly adapter?: SourceClient) {}
  get guide(): SourceGuidePort | undefined { return this.adapter?.guide; }
  resolveAction(name: string, args: Record<string, unknown>, task: AgentTask) { return this.adapter?.resolveAction?.(name,args,task) ?? this.definitions.find(t=>t.name===name)?.action ?? 'modify'; }
  checkPrerequisites(name: string, args: Record<string, unknown>) { return this.adapter?.checkPrerequisites?.(name,args); }
  validateScope(name: string, args: Record<string, unknown>, task: AgentTask) { return this.adapter?.validateScope?.(name,args,task); }
  async listTools(): Promise<ToolDefinition[]> { return this.definitions; }
  async callTool(_name: string, _args: Record<string, unknown>, signal: AbortSignal): Promise<RetrievalResult> { signal.throwIfAborted(); if (this.guide?.check()) throw new Error(this.guide.check()); if (this.config.kind === 'api' && (!this.config.fixtureRequest || hash((({ _intent, ...request }) => request)(ApiRequestSchema.parse(_args))) !== hash((({ _intent, ...request }) => request)(this.config.fixtureRequest)))) throw new Error('fixture_request_mismatch'); const result = RetrievalSchema.parse(JSON.parse(readFileSync(resolve(this.root, this.config.fixture!), 'utf8'))); if (result.provenance !== 'fixture' || result.signals.some(s => s.sourceSlug !== this.config.slug)) throw new Error('fixture_source_mismatch'); return result; }
  async close(): Promise<void> {}
}
export class McpSource implements SourceClient {
  private client = new Client({ name: 'cwatch', version: '0.1.0' });
  private transport?: StdioClientTransport;
  private connected = false;
  constructor(readonly config: SourceConfig, readonly cwd: string) {}
  async listTools(signal: AbortSignal): Promise<ToolDefinition[]> {
    if (!this.connected) {
      assertMcpIntegrationAllowed(this.config.slug, this.config.command, this.config.args);
      if (!this.config.command || !this.config.args) throw new Error('mcp_missing_command');
      // Only operator-authored configuration launches a server; no shell or model-supplied argv.
      const env = processEnvironment().env;
      this.transport = new StdioClientTransport({ command: this.config.command, args: this.config.args, cwd: this.cwd, env, stderr: 'pipe', maxBufferSize: 2_000_000 });
      this.transport.stderr?.on('data', () => {});
      try { await abortable(this.client.connect(this.transport), signal); this.connected = true; } catch (e) { await this.close(); throw e; }
    }
    const listed = await this.client.listTools({}, { signal });
    return listed.tools.map(t => {
      const action = this.config.toolSemantics?.[t.name];
      if (!action) throw new Error('undeclared_mcp_tool_semantics:' + t.name);
      return { name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema as Record<string, unknown>, action };
    });
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<RetrievalResult> {
    try {
      const request = () => this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 15_000 });
      const result = await (context ? context.stage('mcp.stdio.tools_call', request) : request());
      if (result.isError) return { status: 'unknown', signals: [], raw: JSON.stringify(result.content), error: 'MCP tool error', provenance: 'live' };
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      try { return RetrievalSchema.parse(JSON.parse(text)); } catch (e) { return { status: 'parse_failed', signals: [], raw: text, error: String(e), provenance: 'live' }; }
    } catch (e) { return resultError(e, signal); }
  }
  async close(): Promise<void> { await this.client.close().catch(() => {}); await this.transport?.close().catch(() => {}); this.connected = false; }
}
export class SourceServerBuilder {
  constructor(readonly root: string, readonly mcpPool = new McpConnectionPool()) {}
  async build(config: SourceConfig, mode: 'live' | 'replay', signal: AbortSignal): Promise<{ client: SourceClient; channel: 'builtin' | 'mcp' }> {
    config = sourceSchema.parse(config);
    let client: SourceClient; const channel = ['mcp','api'].includes(config.kind) ? 'mcp' : 'builtin';
    if (config.kind === 'web') {
      if (!config.allowedDomains?.length) throw new Error('web_allowed_domains_required');
      const { PreferredWebSource, readWebOptions } = await import('./web.ts');
      // An explicit API configuration is independent of the planner's model credentials.
      const options = config.webApi || config.searchMcp?.type === 'api' ? { slug: config.slug, allowedDomains: config.allowedDomains } as import('./web.ts').WebOptions : readWebOptions(config.slug, config.allowedDomains);
      if (config.webApi && mode === 'live') options.webApi = readWebApi(config.webApi, process.env);
      if (config.searchMcp && mode === 'live') options.searchMcp = readSearchMcp(config.searchMcp, process.env);
      options.urls = config.urls;
      client = new PreferredWebSource(options);
    }
    else if (config.kind === 'browser') { const { BrowserSource } = await import("./browser.ts"); client = new BrowserSource(config); }
    else if (config.kind === 'api') { if (!config.api) throw new Error('api_config_required'); client = new PlatformApiAdapter(config.slug, config.api, config.entityId, config.product, fetch, process.env, {guide:new PrerequisiteManager(this.root,config.slug)}); }
    else client = this.mcpPool.acquire('source:' + hash(config), () => new McpSource(config, this.root));
    if (mode === 'replay') {
      if (!config.fixture) throw new Error('fixture_required:' + config.slug);
      const definitions = config.kind === 'mcp' ? [{ name: 'search.news', description: 'Replay third party news snapshot', inputSchema: querySchema, action: 'collect' as const }] : await client.listTools(signal);
      await client.close();
      client = new FixtureSource(config, definitions, this.root, config.kind === 'api' ? client : undefined);
    }
    if (config.kind === 'api') {
      const adapter = client;
      client = this.mcpPool.acquire('api:' + mode + ':' + hash(config), () => new ApiMcpSource(config.slug, adapter, () => config.api ? apiSecrets(config.api) : []));
    }
    return { client, channel };
  }
  async register(configs: SourceConfig[], mode: 'live' | 'replay', registry: ToolRegistry, signal: AbortSignal): Promise<string[]> {
    const gaps: string[] = [];
    for (const config of configs) {
      let client: SourceClient | undefined;
      try {
        if (!config.active) {
          const channel = ['mcp','api'].includes(config.kind) ? 'mcp' : 'builtin';
          await registry.register(config.slug, channel, { listTools: async () => [], callTool: async () => { throw new Error('inactive_source'); }, close: async () => {} }, signal);
          registry.setActive(config.slug, false); continue;
        }
        const built = await this.build(config, mode, signal); client = built.client; await registry.register(config.slug, built.channel, client, signal); registry.setActive(config.slug, config.active); }
      catch (e) { await client?.close(); gaps.push('source_unavailable:' + config.slug + ':' + String(e)); }
    }
    return gaps;
  }
}
