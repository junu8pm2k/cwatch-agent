import { type ModelRuntime } from '@earendil-works/pi-coding-agent';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

export const STEP5_MAX_OUTPUT_TOKENS = 64_000;
export const STEP5_INITIAL_OUTPUT_TOKENS = 8192;
export const STEP5_DEFAULT_OUTPUT_TOKENS = 12_288;

/** Apply StepFun parameters only on endpoints that document them. */
export function isStep5Endpoint(modelId: string, baseUrl?: string): boolean {
  if (modelId !== 'step-5-preview' || !baseUrl) return false;
  const endpoint = new URL(baseUrl);
  return endpoint.protocol === 'https:' && ['api.stepfun.com', 'api.stepfun.ai'].includes(endpoint.hostname) && !endpoint.port;
}

export function usesStep5ReasoningEffort(model: Model): boolean {
  return model.api === 'openai-completions' && isStep5Endpoint(model.id, model.baseUrl);
}
