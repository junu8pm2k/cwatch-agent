import { apiEndpoint, type ResolvedApiEndpoint, type WebApiOptions } from './web-api-config.ts';

export interface AutoRestInput {
  url: string;
  token?: string;
  fetchUrl?: string;
  fetchToken?: string;
  authHeader?: string;
  authScheme?: 'bearer' | 'raw';
  explicitAuth?: boolean;
  requestTimeoutMs?: number;
  googleCx?: string;
}

const DEFAULT_RESPONSE = { format: 'json' as const, emptyResultsWhenMissing: false };

function makeEndpoint(
  endpoint: string,
  token: string | undefined,
  overrides: Partial<ResolvedApiEndpoint> = {},
): ResolvedApiEndpoint {
  const validated = apiEndpoint(endpoint).toString();
  return {
    method: 'POST',
    urlAsArray: false,
    fixedParams: {},
    paramsFromEnv: {},
    headers: {},
    response: DEFAULT_RESPONSE,
    ...overrides,
    endpoint: validated,
    token,
    envParams: overrides.envParams ?? {},
  };
}

function headerAuth(
  input: AutoRestInput,
  token: string | undefined,
  defaultName = 'Authorization',
  defaultScheme: 'bearer' | 'raw' = 'bearer',
): ResolvedApiEndpoint['auth'] {
  if (!token) return undefined;
  return {
    tokenEnv: 'SEARCH_MCP_TOKEN',
    location: 'header',
    name: input.explicitAuth ? (input.authHeader ?? defaultName) : defaultName,
    scheme: input.explicitAuth ? (input.authScheme ?? defaultScheme) : defaultScheme,
  };
}

function isExplicitMcpUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  return host.startsWith('mcp.') || host.includes('.mcp.') || /(?:^|\/)(?:mcp|sse)$/.test(path);
}

/** Detect mainstream search/fetch REST API endpoints from URL alone, zero extra roundtrips. */
export function detectKnownRestPreset(input: AutoRestInput): { preset: string; options: WebApiOptions } | undefined {
  const parsed = apiEndpoint(input.url);
  if (isExplicitMcpUrl(parsed)) return undefined;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  const fetchToken = input.fetchToken ?? input.token;
  const secrets = [input.token, input.fetchToken, input.googleCx].filter((v): v is string => Boolean(v));
  const common = { type: 'api' as const, secrets, ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}) };

  const resolveFetchEndpoint = (fallbackSameOriginPath?: string): { url: string; token?: string } | undefined => {
    if (input.fetchUrl) return { url: apiEndpoint(input.fetchUrl).toString(), token: fetchToken };
    if (fallbackSameOriginPath) return { url: new URL(fallbackSameOriginPath, parsed.origin).toString(), token: input.token };
    return undefined;
  };

  // Tavily: https://api.tavily.com/search & /extract
  if (host === 'api.tavily.com') {
    const searchUrl = !path || path === '/extract' ? undefined : parsed.toString();
    const fetchInfo = path === '/extract'
      ? { url: parsed.toString(), token: input.token }
      : resolveFetchEndpoint('/extract');
    return {
      preset: 'tavily',
      options: {
        ...common,
        ...(searchUrl ? { search: makeEndpoint(searchUrl, input.token, { method: 'POST', queryParam: 'query', limitParam: 'max_results', auth: headerAuth(input, input.token) }) } : !path ? { search: makeEndpoint(new URL('/search', parsed.origin).toString(), input.token, { method: 'POST', queryParam: 'query', limitParam: 'max_results', auth: headerAuth(input, input.token) }) } : {}),
        ...(fetchInfo ? { fetch: makeEndpoint(fetchInfo.url, fetchInfo.token, { method: 'POST', urlParam: 'urls', urlAsArray: true, auth: headerAuth(input, fetchInfo.token) }) } : {}),
      },
    };
  }

  // Exa: https://api.exa.ai/search & /contents
  if (host === 'api.exa.ai') {
    const searchUrl = path === '/contents' ? undefined : (!path ? new URL('/search', parsed.origin).toString() : parsed.toString());
    const fetchInfo = path === '/contents'
      ? { url: parsed.toString(), token: input.token }
      : resolveFetchEndpoint('/contents');
    return {
      preset: 'exa',
      options: {
        ...common,
        ...(searchUrl ? { search: makeEndpoint(searchUrl, input.token, { method: 'POST', queryParam: 'query', limitParam: 'numResults', auth: headerAuth(input, input.token, 'x-api-key', 'raw') }) } : {}),
        ...(fetchInfo ? { fetch: makeEndpoint(fetchInfo.url, fetchInfo.token, { method: 'POST', urlParam: 'urls', urlAsArray: true, fixedParams: { text: true }, auth: headerAuth(input, fetchInfo.token, 'x-api-key', 'raw') }) } : {}),
      },
    };
  }

  // Brave Search: https://api.search.brave.com/res/v1/web/search
  if (host === 'api.search.brave.com') {
    const searchUrl = !path ? new URL('/res/v1/web/search', parsed.origin).toString() : parsed.toString();
    return {
      preset: 'brave',
      options: {
        ...common,
        search: makeEndpoint(searchUrl, input.token, { method: 'GET', queryParam: 'q', limitParam: 'count', headers: { Accept: 'application/json' }, auth: headerAuth(input, input.token, 'X-Subscription-Token', 'raw') }),
        ...(input.fetchUrl ? { fetch: makeEndpoint(input.fetchUrl, fetchToken, { method: 'POST', urlParam: 'url', auth: headerAuth(input, fetchToken), allowGetFallback: true }) } : {}),
      },
    };
  }

  // Serper: https://google.serper.dev/search
  if (host === 'google.serper.dev') {
    const searchUrl = !path ? new URL('/search', parsed.origin).toString() : parsed.toString();
    return {
      preset: 'serper',
      options: {
        ...common,
        search: makeEndpoint(searchUrl, input.token, { method: 'POST', queryParam: 'q', limitParam: 'num', auth: headerAuth(input, input.token, 'X-API-KEY', 'raw') }),
        ...(input.fetchUrl ? { fetch: makeEndpoint(input.fetchUrl, fetchToken, { method: 'POST', urlParam: 'url', auth: headerAuth(input, fetchToken, 'X-API-KEY', 'raw') }) } : {}),
      },
    };
  }

  // SerpAPI: https://serpapi.com/search.json
  if (host === 'serpapi.com' || host === 'www.serpapi.com') {
    const searchUrl = !path ? new URL('/search.json', parsed.origin).toString() : parsed.toString();
    return {
      preset: 'serpapi',
      options: {
        ...common,
        search: makeEndpoint(searchUrl, input.token, {
          method: 'GET', queryParam: 'q', limitParam: 'num',
          auth: input.token ? (input.explicitAuth ? headerAuth(input, input.token) : { tokenEnv: 'SEARCH_MCP_TOKEN', location: 'query', name: 'api_key', scheme: 'raw' }) : undefined,
        }),
      },
    };
  }

  // Bocha: https://api.bochaai.com/v1/web-search
  if (host === 'api.bochaai.com') {
    const searchUrl = !path ? new URL('/v1/web-search', parsed.origin).toString() : parsed.toString();
    return {
      preset: 'bocha',
      options: {
        ...common,
        search: makeEndpoint(searchUrl, input.token, { method: 'POST', queryParam: 'query', limitParam: 'count', auth: headerAuth(input, input.token) }),
        ...(input.fetchUrl ? { fetch: makeEndpoint(input.fetchUrl, fetchToken, { method: 'POST', urlParam: 'url', auth: headerAuth(input, fetchToken), allowGetFallback: true }) } : {}),
      },
    };
  }

  // Firecrawl: https://api.firecrawl.dev/v1/search & /v1/scrape (or /v2/...)
  if (host === 'api.firecrawl.dev') {
    const version = /^\/(v\d+)\b/.exec(path)?.[1] ?? 'v1';
    const isScrapeOnly = path.endsWith('/scrape');
    const searchUrl = isScrapeOnly ? undefined : (!path ? new URL(`/${version}/search`, parsed.origin).toString() : parsed.toString());
    const fetchInfo = isScrapeOnly
      ? { url: parsed.toString(), token: input.token }
      : resolveFetchEndpoint(`/${version}/scrape`);
    return {
      preset: 'firecrawl',
      options: {
        ...common,
        ...(searchUrl ? { search: makeEndpoint(searchUrl, input.token, { method: 'POST', queryParam: 'query', limitParam: 'limit', auth: headerAuth(input, input.token) }) } : {}),
        ...(fetchInfo ? { fetch: makeEndpoint(fetchInfo.url, fetchInfo.token, { method: 'POST', urlParam: 'url', fixedParams: { formats: ['markdown'] }, auth: headerAuth(input, fetchInfo.token) }) } : {}),
      },
    };
  }

  // Jina Search (s.jina.ai) & Jina Reader (r.jina.ai)
  if (host === 's.jina.ai' || host === 'r.jina.ai') {
    const isReader = host === 'r.jina.ai';
    return {
      preset: 'jina',
      options: {
        ...common,
        ...(!isReader ? { search: makeEndpoint(parsed.toString(), input.token, { method: 'POST', queryParam: 'q', limitParam: '', headers: { Accept: 'application/json' }, auth: headerAuth(input, input.token) }) } : {}),
        ...(isReader
          ? { fetch: makeEndpoint(parsed.toString(), input.token, { method: 'POST', urlParam: 'url', headers: { Accept: 'application/json' }, auth: headerAuth(input, input.token) }) }
          : input.fetchUrl
            ? { fetch: makeEndpoint(input.fetchUrl, fetchToken, { method: 'POST', urlParam: 'url', headers: { Accept: 'application/json' }, auth: headerAuth(input, fetchToken), allowGetFallback: true }) }
            : {}),
      },
    };
  }

  // Google Custom Search: https://www.googleapis.com/customsearch/v1
  if (host === 'www.googleapis.com' && path.startsWith('/customsearch/')) {
    return {
      preset: 'google-custom-search',
      options: {
        ...common,
        search: makeEndpoint(parsed.toString(), input.token, {
          method: 'GET', queryParam: 'q', limitParam: 'num',
          envParams: input.googleCx ? { cx: input.googleCx } : {},
          auth: input.token ? (input.explicitAuth ? headerAuth(input, input.token) : { tokenEnv: 'SEARCH_MCP_TOKEN', location: 'query', name: 'key', scheme: 'raw' }) : undefined,
          response: { format: 'json', resultsPath: 'items', urlField: 'link', titleField: 'title', snippetField: 'snippet', emptyResultsWhenMissing: true },
        }),
      },
    };
  }

  // Perplexity Search API: https://api.perplexity.ai/search
  if (host === 'api.perplexity.ai' && path.includes('/search')) {
    return {
      preset: 'perplexity',
      options: {
        ...common,
        search: makeEndpoint(parsed.toString(), input.token, { method: 'POST', queryParam: 'query', limitParam: 'max_results', auth: headerAuth(input, input.token) }),
      },
    };
  }

  // Metaso Search API: https://metaso.cn/api/v1/search
  if (host === 'metaso.cn' || host.endsWith('.metaso.cn')) {
    const searchUrl = !path ? new URL('/api/v1/search', parsed.origin).toString() : parsed.toString();
    return {
      preset: 'metaso',
      options: {
        ...common,
        search: makeEndpoint(searchUrl, input.token, { method: 'POST', queryParam: 'q', limitParam: 'size', auth: headerAuth(input, input.token) }),
      },
    };
  }

  return undefined;
}

/** Generic REST fallback for custom self-hosted or unlisted HTTP search/fetch endpoints. */
export function buildGenericRestApiOptions(input: AutoRestInput): WebApiOptions {
  const fetchToken = input.fetchToken ?? input.token;
  const secrets = [input.token, input.fetchToken, input.googleCx].filter((v): v is string => Boolean(v));
  const search = makeEndpoint(input.url, input.token, {
    method: 'POST', queryParam: 'query', limitParam: 'limit',
    headers: { Accept: 'application/json' },
    auth: headerAuth(input, input.token, input.authHeader ?? 'Authorization', input.authScheme ?? 'bearer'),
    allowGetFallback: true,
  });
  const fetch = input.fetchUrl
    ? makeEndpoint(input.fetchUrl, fetchToken, {
      method: 'POST', urlParam: 'url',
      headers: { Accept: 'application/json' },
      auth: headerAuth(input, fetchToken, input.authHeader ?? 'Authorization', input.authScheme ?? 'bearer'),
      allowGetFallback: true,
    })
    : makeEndpoint(input.url, input.token, {
      method: 'POST', urlParam: 'url',
      headers: { Accept: 'application/json' },
      auth: headerAuth(input, input.token, input.authHeader ?? 'Authorization', input.authScheme ?? 'bearer'),
      allowGetFallback: true,
    });
  return {
    type: 'api', search, fetch, secrets,
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
  };
}

export function isLikelyMcpEndpoint(url: string): boolean {
  try { return isExplicitMcpUrl(new URL(url)); } catch { return false; }
}
