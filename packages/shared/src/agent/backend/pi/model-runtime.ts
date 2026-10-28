import { type ModelConfig } from "../../../config/models.ts";

/** Explicit in-memory credentials; used in the worker and the standalone connectivity probe. */
export async function createPiRuntime(provider: string, modelId: string, config: Pick<ModelConfig, 'apiKey' | 'baseUrl'> | undefined, signal: AbortSignal, supplied?: import('@earendil-works/pi-coding-agent').ModelRuntime) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  let runtime = supplied;
  if (!runtime) {
    const credentials: NonNullable<import('@earendil-works/pi-coding-agent').CreateModelRuntimeOptions['credentials']> = { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} };
    runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal });
    if (config?.baseUrl) runtime.registerProvider(provider, {
      name: provider, api: 'openai-completions', baseUrl: config.baseUrl,
      models: [{
        id: modelId, name: modelId, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
      }],
    });
    if (config?.apiKey) await runtime.setRuntimeApiKey(provider, config.apiKey, { signal });
  }
  signal.throwIfAborted();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error('provider_unavailable: unknown configured model ' + provider + '/' + modelId + '; set BASE_URL for an OpenAI-compatible custom endpoint');
  return { runtime, model };
}
