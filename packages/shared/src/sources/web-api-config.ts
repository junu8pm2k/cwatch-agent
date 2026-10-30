import { z } from 'zod';
import { assertNetworkUrlAllowed } from './network-policy.ts';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v));
const path = z.string().regex(/^[A-Za-z0-9_.-]+$/).refine(v => v.split('.').every(k => !['__proto__', 'prototype', 'constructor'].includes(k)));
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ApiEndpointSchema = z.object({
  url: z.string().url().optional(), urlEnv: envName.optional(), method: z.enum(['GET', 'POST']).default('POST'),
  queryParam: name.optional(), limitParam: name.optional(), urlParam: name.optional(), urlAsArray: z.boolean().default(false),
  fixedParams: z.record(name, z.union([scalar, z.array(scalar)])).default({}), paramsFromEnv: z.record(name, envName).default({}),
  headers: z.record(name, z.string()).default({}),
  auth: z.object({ tokenEnv: envName, location: z.enum(['header', 'query', 'body']).default('header'), name: name.optional(), scheme: z.enum(['bearer', 'raw']).optional() }).strict().optional(),
  response: z.object({ format: z.enum(['json', 'text']).default('json'), resultsPath: path.optional(), pagePath: path.optional(), urlField: path.optional(), titleField: path.optional(), snippetField: path.optional(), textField: path.optional(), emptyResultsWhenMissing: z.boolean().default(false) }).strict().default({ format: 'json', emptyResultsWhenMissing: false }),
}).strict().refine(c => Boolean(c.url || c.urlEnv), 'API endpoint needs url or urlEnv').refine(c => !(c.method === 'GET' && c.auth?.location === 'body'), 'GET cannot use body authentication');
const operations = { search: ApiEndpointSchema.optional(), fetch: ApiEndpointSchema.optional() };
export const WebApiConfigSchema = z.object(operations).strict().refine(c => Boolean(c.search || c.fetch), 'configure at least one API operation');
/** Legacy configuration shape; execution now uses a local API adapter. */
export const ApiMcpConfigSchema = z.object({ type: z.literal('api'), ...operations }).strict().refine(c => Boolean(c.search || c.fetch), 'configure at least one API operation');
export type WebApiConfig = z.input<typeof WebApiConfigSchema>;
export type ApiMcpConfig = z.input<typeof ApiMcpConfigSchema>;
export type ApiEndpoint = z.output<typeof ApiEndpointSchema>;
export type ResolvedApiEndpoint = ApiEndpoint & { endpoint: string; token?: string; envParams: Record<string, string> };
export interface WebApiOptions { type: 'api'; search?: ResolvedApiEndpoint; fetch?: ResolvedApiEndpoint; secrets: string[] }
export type ApiMcpOptions = WebApiOptions;
export function apiEndpoint(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('invalid_search_API_endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(k => /key|token|secret|password|credential|auth/i.test(k))) throw new Error('search_API_endpoint_requires_HTTPS_without_embedded_credentials');
  assertNetworkUrlAllowed(url);
  return url;
}
export function readWebApi(config: WebApiConfig, env: NodeJS.ProcessEnv): WebApiOptions {
  const parsed = WebApiConfigSchema.parse(config), options: WebApiOptions = { type: 'api', secrets: [] };
  for (const operation of ['search', 'fetch'] as const) {
    const item = parsed[operation]; if (!item) continue;
    const value = item.url ?? env[item.urlEnv!]?.trim(); if (!value) throw new Error('search_API_endpoint_environment_missing:' + operation);
    const endpoint = apiEndpoint(value).toString();
    const token = item.auth ? env[item.auth.tokenEnv]?.trim() : undefined;
    if (item.auth && !token) throw new Error('search_API_credential_environment_missing:' + item.auth.tokenEnv);
    const envParams: Record<string, string> = {};
    for (const [key, variable] of Object.entries(item.paramsFromEnv)) {
      const value = env[variable]?.trim(); if (!value) throw new Error('search_API_parameter_environment_missing:' + variable);
      envParams[key] = value; options.secrets.push(value);
    }
    if (token) options.secrets.push(token);
    options[operation] = { ...item, endpoint, token, envParams };
  }
  return options;
}
/** @deprecated Use webApi + readWebApi. Kept for existing source configurations. */
export function readApiMcp(config: ApiMcpConfig, env: NodeJS.ProcessEnv): ApiMcpOptions {
  const { type: _type, ...operations } = ApiMcpConfigSchema.parse(config);
  return readWebApi(operations, env);
}
