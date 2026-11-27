export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment: string;
  timeoutMs: number;
  projectId?: string;
}

export function langfuseTraceUrl(baseUrl: string, traceId: string, projectId?: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return projectId ? `${root}/project/${encodeURIComponent(projectId)}/traces/${traceId}` : `${root}/trace/${traceId}`;
}

/** Host-only credentials; never pass this configuration to the model or a worker. */
export function readLangfuseConfig(env: NodeJS.ProcessEnv = process.env): LangfuseConfig | undefined {
  if (env.LANGFUSE_ENABLED?.trim() === 'false') return undefined;
  if (env.LANGFUSE_ENABLED && !['true', 'false'].includes(env.LANGFUSE_ENABLED.trim())) throw Error('langfuse_config: LANGFUSE_ENABLED must be true or false');
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim(), secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey && !secretKey && env.LANGFUSE_ENABLED?.trim() !== 'true') return undefined;
  if (!publicKey || !secretKey) throw Error('langfuse_config: fill both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
  let url: URL;
  try { url = new URL(env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com'); }
  catch { throw Error('langfuse_config: LANGFUSE_BASE_URL must be an absolute URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('langfuse_config: use an HTTP(S) base URL without credentials, query or fragment');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('langfuse_config: use HTTPS except for localhost');
  if (/\/api\/public(?:\/|$)/.test(url.pathname)) throw Error('langfuse_config: LANGFUSE_BASE_URL is the instance root, without /api/public');
  const environment = env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || 'development';
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(environment) || environment.startsWith('langfuse')) throw Error('langfuse_config: invalid LANGFUSE_TRACING_ENVIRONMENT');
  const timeoutMs = Number(env.LANGFUSE_TIMEOUT_MS?.trim() || 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('langfuse_config: LANGFUSE_TIMEOUT_MS must be 1..30000');
  const projectId = env.LANGFUSE_PROJECT_ID?.trim() || undefined;
  if (projectId && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw Error('langfuse_config: invalid LANGFUSE_PROJECT_ID');
  return { baseUrl: url.toString().replace(/\/+$/, ''), publicKey, secretKey, environment, timeoutMs, ...(projectId ? { projectId } : {}) };
}
