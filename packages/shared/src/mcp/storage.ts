import { z } from 'zod';
import { ManagedWorkspace } from "../workspaces/managed-workspace.ts";
import { assertNetworkUrlAllowed, assertMcpIntegrationAllowed } from '../sources/network-policy.ts';

export const actionSchema = z.enum(['collect', 'analyze', 'local_draft', 'modify', 'send', 'publish']);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export function validateMcpUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('mcp_url_invalid'); }
  assertNetworkUrlAllowed(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /key|token|secret|password|credential|auth/i.test(key))) throw new Error('mcp_url_requires_https_or_localhost_without_credentials');
  return url;
}
export const UserMcpSchema = z.object({
  slug: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).refine(value => !['workflow', 'skills'].includes(value), 'reserved MCP slug'),
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'auto', 'streamable-http', 'sse']),
  url: z.string().optional(), tokenEnv: envName.optional(),
  authHeader: z.string().regex(/^[a-zA-Z0-9-]+$/).default('Authorization'), authScheme: z.enum(['bearer', 'raw']).default('bearer'),
  command: z.string().min(1).optional(), args: z.array(z.string()).max(100).default([]),
  env: z.record(envName, envName).default({}),
  publicEnv: z.record(envName, envName).default({}),
  defaultAction: actionSchema.default('modify'), toolSemantics: z.record(z.string(), actionSchema).default({}),
  resultFormat: z.enum(['raw', 'retrieval']).default('raw'),
  toolResultFormats: z.record(z.string(), z.enum(['raw', 'retrieval'])).default({}),
}).strict().superRefine((value, ctx) => {
  try { assertMcpIntegrationAllowed(value.slug, value.command, value.args); } catch { ctx.addIssue({code:'custom',message:'github_api_disabled_by_project_policy'}); }
  if ([value.tokenEnv, ...Object.keys(value.env), ...Object.values(value.env), ...Object.keys(value.publicEnv), ...Object.values(value.publicEnv)]
    .some(name => name && /^(?:GITHUB_|GH_(?:TOKEN|ENTERPRISE_TOKEN)$)/i.test(name))) {
    ctx.addIssue({code:'custom',message:'github_credentials_disabled_by_project_policy'});
  }
  if (value.transport === 'stdio') {
    if (!value.command || value.url || value.tokenEnv) ctx.addIssue({ code: 'custom', message: 'stdio requires command; use env references for credentials' });
    if ([...Object.keys(value.env), ...Object.keys(value.publicEnv)].some(key => key.toUpperCase() === 'NODE_OPTIONS')) ctx.addIssue({ code: 'custom', message: 'NODE_OPTIONS is not a server credential' });
    if (Object.keys(value.env).some(key => Object.hasOwn(value.publicEnv, key))) ctx.addIssue({ code: 'custom', message: 'duplicate private/public environment mapping' });
  } else {
    if (!value.url || value.command || value.args.length || Object.keys(value.env).length || Object.keys(value.publicEnv).length) ctx.addIssue({ code: 'custom', message: 'remote MCP requires url and does not accept stdio options' });
    if (value.url) try { validateMcpUrl(value.url); } catch { ctx.addIssue({ code: 'custom', message: 'remote URL requires HTTPS or local HTTP and no embedded credentials' }); }
  }
});
export type UserMcpConfig = z.infer<typeof UserMcpSchema>;
const ConfigSchema = z.object({ version: z.literal(1), servers: z.array(UserMcpSchema).max(64) }).strict().superRefine((value, ctx) => {
  if (new Set(value.servers.map(server => server.slug)).size !== value.servers.length) ctx.addIssue({ code: 'custom', message: 'duplicate MCP slug' });
});
export class UserMcpStore {
  readonly files: ManagedWorkspace;
  constructor(workspace = process.cwd()) { this.files = new ManagedWorkspace(workspace); }
  list(): UserMcpConfig[] { return ConfigSchema.parse(this.files.read('mcp.json', { version: 1, servers: [] })).servers; }
  add(raw: unknown): UserMcpConfig {
    const config = UserMcpSchema.parse(raw);
    return this.files.locked(() => {
      const servers = this.list();
      if (servers.some(server => server.slug === config.slug)) throw new Error('mcp_already_exists: remove the entry before replacing it');
      this.files.write('mcp.json', { version: 1, servers: [...servers, config] }); return config;
    });
  }
  change(slug: string, enabled: boolean | 'remove'): void {
    this.files.locked(() => {
      const servers = this.list();
      if (!servers.some(server => server.slug === slug)) throw new Error('mcp_not_found');
      this.files.write('mcp.json', { version: 1, servers: enabled === 'remove' ? servers.filter(server => server.slug !== slug) : servers.map(server => server.slug === slug ? { ...server, enabled } : server) });
    });
  }
  select(names: string[]): UserMcpConfig[] {
    const all = this.list();
    return [...new Set(names)].flatMap(name => {
      const server = all.find(item => item.slug === name);
      if (!server) throw new Error('mcp_not_found:' + name);
      if (!server.enabled) throw new Error('mcp_disabled:' + name);
      return [server];
    });
  }
}
export function mcpSecrets(config: UserMcpConfig, env: NodeJS.ProcessEnv): string[] {
  return [...new Set([...(config.tokenEnv ? [config.tokenEnv] : []), ...Object.values(config.env)].map(key => env[key]).filter((value): value is string => Boolean(value)))];
}
