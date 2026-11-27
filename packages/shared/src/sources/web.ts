import { isIP } from 'node:net';
import { isInvestigationTask, type AgentTask, type RetrievalResult, type SourceClient, type ToolDefinition, type ToolExecutionContext } from "@cwatch/core/types";
import { WebFailure } from './web-errors.ts';
import { RemoteSearchMcp, type RemoteMcpOptions, type SearchMcpOptions } from './web-mcp.ts';
import type { WebApiOptions } from './web-api-config.ts';
import { createWebToolDefinitions } from './web-tools.ts';
import { assertNetworkUrlAllowed } from './network-policy.ts';
import { callNativeWeb, readNativeWebConfig, type NativeWebConfig } from './web-native.ts';
import { buildGenericRestApiOptions, detectKnownRestPreset, isLikelyMcpEndpoint } from './web-rest-presets.ts';
export { WebFailure } from './web-errors.ts';

export interface WebOptions {
  slug: string; allowedDomains: string[];
  urls?: string[];
  restrictToUrls?: boolean;
  native?: NativeWebConfig;
  nativeUnavailableReason?: string;
  searchMcp?: SearchMcpOptions;
  webApi?: WebApiOptions;
}
function isPublicHostname(host: string): boolean {
  if (!host || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host.replace(/[\[\]]/g, ''))) return false;
  return true;
}
function hostMatchesDomains(host: string, domains: string[]): boolean {
  return domains.some(raw => {
    const allowed = raw.trim().toLowerCase();
    if (!allowed) return false;
    if (allowed === '*') return true;
    return host === allowed || host.endsWith('.' + allowed);
  });
}
function queryReferencesDomain(query: string, domain: string): boolean {
  const clean = domain.trim().toLowerCase();
  if (!clean || clean === '*') return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s.:/@])${escaped}(?:$|[\\s/?#,;])`, 'i').test(query);
}
export function allowedUrl(value: string, domains: string[]): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('web_scope: invalid URL'); }
  assertNetworkUrlAllowed(url);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !isPublicHostname(host) || !hostMatchesDomains(host, domains)) throw new Error('web_scope: URL must be HTTPS on an explicitly allowed public hostname');
  if ([...url.searchParams.keys()].some(key => /^(api[_-]?key|access[_-]?token|password|secret)$/i.test(key))) throw new Error('web_scope: credentials forbidden in URL');
  url.hash = ''; return url;
}
export function allowedScopedUrl(value: string, domains: string[], entries: readonly string[] = []): URL {
  const url = allowedUrl(value, domains);
  if (!entries.length) return url;
  if (/%(?:2f|5c|25)/i.test(url.pathname)) throw Error('web_url_outside_specified_sources');
  const matches = entries.some(entry => {
    const anchor = allowedUrl(entry, domains);
    if (url.origin !== anchor.origin) return false;
    if (anchor.search) return url.pathname === anchor.pathname && url.search === anchor.search;
    const root = anchor.pathname.replace(/\/$/, '');
    return url.pathname === root || url.pathname.startsWith(root + '/');
  });
  if (!matches) throw Error('web_url_outside_specified_sources');
  return url;
}

export function specifiedSearchScope(query: string, urls: readonly string[]): boolean {
  const scopes = [...query.matchAll(/(?:^|\s)site:([^\s)]+)/gi)].map(match => match[1]);
  return scopes.length === 1 && urls.some(value => {
    const anchor = new URL(value), path = anchor.pathname.replace(/\/$/, '');
    return scopes[0].replace(/\/$/, '') === anchor.host + path;
  });
}
export interface WebDependencies { fetcher?: typeof fetch }
export function readWebOptions(slug: string, allowedDomains: string[], env: NodeJS.ProcessEnv = process.env): WebOptions {
  const { native, nativeUnavailableReason } = readNativeWebConfig(env);
  return {
    slug, allowedDomains,
    ...(native ? { native } : {}),
    ...(nativeUnavailableReason ? { nativeUnavailableReason } : {}),
  };
}

function canAutoFallbackToRest(remote: RemoteMcpOptions): boolean {
  if (remote.protocol === 'mcp') return false;
  if (remote.tools) return false;
  if (remote.transport && remote.transport !== 'auto') return false;
  return !isLikelyMcpEndpoint(remote.url);
}

export class PreferredWebSource implements SourceClient {
  private readonly fetcher: typeof fetch;
  private detectedRemoteProtocol?: 'mcp' | 'rest';
  constructor(readonly options: WebOptions, dependencies: WebDependencies = {}) { this.fetcher = dependencies.fetcher ?? fetch; }
  private checkUrl = (url: string) => allowedScopedUrl(url, this.options.allowedDomains, this.options.restrictToUrls ? this.options.urls : []);
  async listTools(): Promise<ToolDefinition[]> {
    for (const url of this.options.urls ?? []) allowedUrl(url, this.options.allowedDomains);
    return createWebToolDefinitions({ allowedDomains: this.options.allowedDomains, urls: this.options.urls ?? [], restrictToUrls: this.options.restrictToUrls });
  }
  validateScope(name: string, args: Record<string, unknown>, task: AgentTask): string | undefined {
    if (name === 'web_fetch') { try { this.checkUrl(String(args.url)); } catch { return 'web_url_outside_scope'; } }
    else if (name === 'web_search' && isInvestigationTask(task)) {
      if (this.options.restrictToUrls && !specifiedSearchScope(String(args.query), this.options.urls ?? [])) return 'web_query_outside_specified_sources';
      const query = String(args.query).toLowerCase();
      const matchesEntity = [task.competitor.name, task.product, ...task.competitor.aliases].some(value => value && query.includes(value.toLowerCase()));
      const matchesDomain = task.competitor.domains.some(domain => queryReferencesDomain(query, domain));
      if (!matchesEntity && !matchesDomain) return 'web_query_outside_entity_scope';
    } else if (name !== 'web_search') return 'unknown_web_operation';
    return undefined;
  }
  private async callRestApi(api: WebApiOptions, name: string, args: Record<string, unknown>, signal: AbortSignal, context: ToolExecutionContext): Promise<RetrievalResult> {
    const { WebApiAdapter } = await import('./web-api.ts');
    return await new WebApiAdapter(api, this.checkUrl, this.fetcher).call(name, args, signal, context);
  }
  private buildAutoRestOptions(remote: RemoteMcpOptions): WebApiOptions {
    const api = buildGenericRestApiOptions(remote);
    if (remote.fetchOnly) delete api.search;
    return api;
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<RetrievalResult> {
    if (!context) throw new Error('web_execution_context_required: use ToolExecutor');
    signal.throwIfAborted();
    let backend: string | undefined;
    const checkUrl = this.checkUrl;
    try {
      // Priority 1: Explicit REST API configuration (webApi or legacy searchMcp.type=api).
      const explicitApi = this.options.webApi ?? (this.options.searchMcp?.type === 'api' ? this.options.searchMcp : undefined);
      if (explicitApi) {
        backend = 'web.api';
        context.event('web_route', { route: 'api', operation: name, reason: 'host_configured_web_api' });
        return await this.callRestApi(explicitApi, name, args, signal, context);
      }

      // Priority 2: Configured search tool URL + optional key (auto-compatible with MCP and mainstream REST APIs).
      if (this.options.searchMcp) {
        if (this.options.searchMcp.type === 'api') throw new Error('legacy_web_api_route_not_resolved');
        const remote = this.options.searchMcp;
        const protocol = remote.protocol ?? 'auto';

        if (protocol === 'rest' || remote.fetchOnly) {
          backend = 'web.api';
          const preset = detectKnownRestPreset(remote);
          context.event('web_route', { route: 'api', operation: name, reason: preset ? 'host_configured_rest_preset:' + preset.preset : 'host_configured_rest_protocol' });
          return await this.callRestApi(preset ? preset.options : this.buildAutoRestOptions(remote), name, args, signal, context);
        }

        if (protocol === 'auto') {
          const preset = detectKnownRestPreset(remote);
          if (preset) {
            backend = 'web.api';
            this.detectedRemoteProtocol = 'rest';
            context.event('web_route', { route: 'api', operation: name, preset: preset.preset, reason: 'auto_detected_rest_preset' });
            return await this.callRestApi(preset.options, name, args, signal, context);
          }
          if (this.detectedRemoteProtocol === 'rest') {
            backend = 'web.api';
            context.event('web_route', { route: 'api', operation: name, reason: 'cached_auto_detected_rest' });
            return await this.callRestApi(this.buildAutoRestOptions(remote), name, args, signal, context);
          }
        }

        backend = 'mcp.remote';
        context.event('web_route', { route: 'mcp', operation: name, reason: 'host_configured_search_tool' });
        try {
          const result = await new RemoteSearchMcp(remote, checkUrl, this.fetcher).call(name, args, signal, context);
          this.detectedRemoteProtocol = 'mcp';
          return result;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WebFailure && error.protocolMismatch && protocol === 'auto' && canAutoFallbackToRest(remote)) {
            this.detectedRemoteProtocol = 'rest';
            backend = 'web.api';
            context.event('web_route', { route: 'api', operation: name, reason: 'mcp_handshake_not_supported_auto_rest' });
            return await this.callRestApi(this.buildAutoRestOptions(remote), name, args, signal, context);
          }
          throw error;
        }
      }

      // Priority 3: Only when no external search tool is configured, use the AI provider's controlled native web tool.
      if (this.options.native) {
        const provider = this.options.native.provider;
        backend = 'native.' + provider;
        context.event('web_route', { route: 'native', provider, operation: name, reason: 'no_external_search_tool_configured' });
        return await context.stage(backend + '.' + name, () => callNativeWeb(this.options.native!, name, args, this.options.allowedDomains, signal, context, this.fetcher, checkUrl));
      }

      context.event('web_route', { route: 'unavailable', operation: name, reason: this.options.nativeUnavailableReason ?? 'native_unavailable' });
      throw new WebFailure('unavailable', 'web_backend_unavailable: configure webApi, SEARCH_MCP_URL/API_SEARCH_URL, or supported native tools');
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof WebFailure)) throw error;
      context.event('web_route', { route: 'unavailable', operation: name, backend, reason: error.code });
      return { status: ['unsupported', 'unavailable'].includes(error.code) ? 'unknown' : error.code as RetrievalResult['status'], signals: [], raw: '', error: error.code + ':' + error.message, provenance: 'live', ...(backend ? { backend } : {}) };
    }
  }
  async close(): Promise<void> {}
}
