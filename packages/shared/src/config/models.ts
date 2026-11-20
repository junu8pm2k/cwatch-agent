export interface ModelConfig {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  providerMaxRetries?: number;
}

/** Parse host-only configuration; never include this object in model context or traces. */
export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error('model_config: missing ' + name + ' in environment or .env');
    return value;
  };
  const provider = required('MODEL_PROVIDER'), modelId = required('MODEL_ID'), apiKey = required('API_KEY');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(provider)) throw new Error('model_config: invalid MODEL_PROVIDER');
  const configuredUrl = env.BASE_URL?.trim();
  if (!configuredUrl) return { provider, modelId, apiKey };
  let url: URL;
  try { url = new URL(configuredUrl); } catch { throw new Error('model_config: BASE_URL must be an absolute API base URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('model_config: BASE_URL requires HTTPS (HTTP allowed only for local tests)');
  if (url.username || url.password || url.search || url.hash) throw new Error('model_config: keep credentials and query parameters out of BASE_URL');
  if (/\/(chat\/completions|responses)\/?$/.test(url.pathname)) throw new Error('model_config: BASE_URL is the API root, without /chat/completions or /responses');
  return { provider, modelId, apiKey, baseUrl: url.toString().replace(/\/+$/, '') };
}
