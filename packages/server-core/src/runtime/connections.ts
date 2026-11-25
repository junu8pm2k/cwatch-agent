import { z } from 'zod';
import type { RunModelChoice, SearchConnectionSummary, WorkbenchModel } from '@cwatch/core/types/runs';
import { readModelConfig, workbenchModelIds, type ModelConfig } from '@cwatch/shared/config/models';
import { mcpEndpoint, readSearchMcp, type RemoteMcpOptions } from '@cwatch/shared/sources/web-mcp';
import { readWebOptions } from '@cwatch/shared/sources/web';
import { ManagedWorkspace } from '@cwatch/shared/workspaces/managed-workspace';

export const providerId = z.string().trim().regex(/^[a-z][a-z0-9-]{0,39}$/, '供应商标识请使用小写字母、数字或短横线。');
const credential = z.string().trim().min(1).max(4096);
const endpoint = z.string().trim().min(1).max(2048);
const providerSchema = z.object({
  provider: providerId, baseUrl: endpoint, apiKey: credential,
  modelIds: z.array(z.string().trim().min(1).max(256)).min(1).max(32),
  supportsReasoningEffort: z.boolean().default(false),
}).strict();
const searchSchema = z.object({
  url: endpoint, token: credential.optional(), protocol: z.enum(['auto', 'mcp', 'rest']).default('auto'),
  fetchUrl: endpoint.optional(), fetchToken: credential.optional(),
}).strict().refine(config => !config.fetchToken || config.fetchUrl, '请先填写网页读取地址。');
const mcpSlug = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const schema = z.object({
  providers: z.array(providerSchema).max(24),
  search: searchSchema.optional(),
  mcpTokens: z.record(mcpSlug, credential).optional(),
}).strict();
const file = 'connections.json';

function environmentModel(): ModelConfig | undefined {
  try { return readModelConfig(); } catch { return undefined; }
}

function providerModel(provider: z.infer<typeof providerSchema>, modelId: string): ModelConfig {
  return readModelConfig({ MODEL_PROVIDER: provider.provider, MODEL_ID: modelId, API_KEY: provider.apiKey, BASE_URL: provider.baseUrl });
}

export class WorkbenchConnections {
  private readonly files: ManagedWorkspace;

  constructor(root: string) { this.files = new ManagedWorkspace(root); }

  private read() { return schema.parse(this.files.read(file, { providers: [] })); }

  modelSummary(): WorkbenchModel {
    const legacy = environmentModel();
    const providers = this.read().providers.map(({ provider, modelIds, supportsReasoningEffort }) => ({ provider, modelIds, supportsReasoningEffort }));
    return {
      configured: Boolean(legacy || providers.length), provider: legacy?.provider ?? '', id: legacy?.modelId ?? '',
      availableIds: legacy ? workbenchModelIds(legacy.modelId) : [],
      supportsReasoningEffort: Boolean(legacy?.baseUrl), providers,
    };
  }

  resolveModel(choice?: RunModelChoice): ModelConfig {
    const legacy = environmentModel();
    const providers = this.read().providers;
    const selected = choice?.provider ? providers.find(entry => entry.provider === choice.provider) : !choice && !legacy ? providers[0] : undefined;
    if (choice?.provider && !selected) throw Error('所选模型供应商未配置。');
    const modelId = choice?.id ?? selected?.modelIds[0] ?? legacy?.modelId;
    const available = selected?.modelIds ?? (legacy ? workbenchModelIds(legacy.modelId) : []);
    if (!modelId || !available.includes(modelId)) throw Error('所选模型未在本机配置，请重新选择模型。');
    if (choice?.reasoningEffort && !(selected ? selected.supportsReasoningEffort : legacy?.baseUrl)) {
      throw Error('当前模型连接仅支持默认思考强度。');
    }
    const config = selected ? providerModel(selected, modelId) : { ...legacy!, modelId };
    return { ...config, reasoningEffort: choice?.reasoningEffort };
  }

  addProvider(raw: unknown): void {
    const entry = providerSchema.parse(raw);
    const config = providerModel(entry, entry.modelIds[0]);
    this.files.locked(() => {
      const settings = this.read();
      if (settings.providers.some(item => item.provider === entry.provider) || environmentModel()?.provider === entry.provider) {
        throw Error('该供应商已存在，请使用不同标识。');
      }
      this.files.write(file, schema.parse({ ...settings, providers: [...settings.providers, {
        ...entry, baseUrl: config.baseUrl!, modelIds: [...new Set(entry.modelIds)],
      }] }));
    });
  }

  removeProvider(rawProvider: string): void {
    const provider = providerId.parse(rawProvider);
    this.files.locked(() => {
      const settings = this.read();
      const next = settings.providers.filter(item => item.provider !== provider);
      if (next.length === settings.providers.length) throw Error('provider_not_found');
      this.files.write(file, schema.parse({ ...settings, providers: next }));
    });
  }

  saveSearch(raw: unknown): void {
    const input = searchSchema.parse(raw);
    const search = { ...input, url: mcpEndpoint(input.url).toString(), fetchUrl: input.fetchUrl && mcpEndpoint(input.fetchUrl).toString() };
    this.files.locked(() => this.files.write(file, { ...this.read(), search }));
  }

  clearSearch(): void {
    this.files.locked(() => {
      const settings = this.read();
      const next = { ...settings };
      delete next.search;
      this.files.write(file, schema.parse(next));
    });
  }

  setMcpToken(rawSlug: string, rawToken: string): void {
    const slug = mcpSlug.parse(rawSlug);
    const token = credential.parse(rawToken);
    this.files.locked(() => {
      const settings = this.read();
      this.files.write(file, schema.parse({ ...settings, mcpTokens: { ...(settings.mcpTokens ?? {}), [slug]: token } }));
    });
  }

  deleteMcpToken(rawSlug: string): void {
    const slug = mcpSlug.parse(rawSlug);
    this.files.locked(() => {
      const settings = this.read();
      if (!settings.mcpTokens || !Object.hasOwn(settings.mcpTokens, slug)) return;
      const mcpTokens = { ...settings.mcpTokens };
      delete mcpTokens[slug];
      const next = { ...settings };
      if (Object.keys(mcpTokens).length) next.mcpTokens = mcpTokens;
      else delete next.mcpTokens;
      this.files.write(file, schema.parse(next));
    });
  }

  mcpToken(slug: string): string | undefined {
    return this.read().mcpTokens?.[slug];
  }

  searchOptions(): RemoteMcpOptions | undefined {
    const search = this.read().search;
    if (!search) return undefined;
    return readSearchMcp({ url: search.url, protocol: search.protocol, fetchUrl: search.fetchUrl,
      tokenEnv: 'SEARCH_TOKEN', fetchTokenEnv: 'FETCH_TOKEN' }, { SEARCH_TOKEN: search.token, FETCH_TOKEN: search.fetchToken });
  }

  searchSummary(): SearchConnectionSummary {
    const search = this.read().search;
    if (search) return { source: 'workbench', url: search.url, fetchUrl: search.fetchUrl, protocol: search.protocol, hasToken: Boolean(search.token) };
    try {
      const remote = readSearchMcp({}, process.env);
      if (remote) return { source: 'environment', url: remote.url, fetchUrl: remote.fetchUrl, protocol: remote.protocol, hasToken: Boolean(remote.token) };
      if (readWebOptions('web', ['*']).native) return { source: 'environment' };
    } catch { /* The form can repair invalid host setup by configuring an explicit connection. */ }
    return { source: 'none' };
  }

  secrets(): string[] {
    const { providers, search, mcpTokens } = this.read();
    return [...providers.map(provider => provider.apiKey), search?.token, search?.fetchToken, ...Object.values(mcpTokens ?? {})].filter((secret): secret is string => Boolean(secret));
  }
}
