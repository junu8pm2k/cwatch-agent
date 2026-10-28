import { readFileSync } from 'node:fs';
import { DecisionSchema, abortable, type AgentSessionHooks, type Decision, type ModelInput, type ModelPort } from "@cwatch/core/types";
import { readModelConfig, type ModelConfig } from "../config/models.ts";

export class ReplayModel implements ModelPort {
  private cursor = 0;
  constructor(private steps: unknown[]) {}
  static fromFile(path: string): ReplayModel { return new ReplayModel(JSON.parse(readFileSync(path, 'utf8'))); }
  async decide(input: ModelInput, signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    const raw = structuredClone(this.steps[this.cursor++]);
    const step = raw as { kind?: string; name?: string; args?: Record<string, unknown> } | undefined;
    if (!step) throw new Error('replay_script_exhausted');
    if (step.kind === 'call_tool' && step.name === 'workflow__draft' && step.args?.claimIds === '$analyzed_claim_ids') {
      const analysis = input.state.observations.find(o => o.name === 'workflow__analyze')?.result as { claims?: Array<{ id: string }> } | undefined;
      step.args.claimIds = analysis?.claims?.map(c => c.id) ?? [];
    }
    return DecisionSchema.parse(step);
  }
}
export function decodePiMessage(message: { content: Array<{ type: string; id?: string; name?: string; arguments?: unknown; text?: string }>; stopReason: string; errorMessage?: string }): Decision {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error('provider_unavailable:' + (message.errorMessage ?? message.stopReason));
  if (message.stopReason === 'length') throw new Error('provider_unavailable: truncated_response');
  const calls = message.content.filter(c => c.type === 'toolCall');
  if (calls.length > 1) return DecisionSchema.parse({ kind: 'call_tools', calls: calls.map(call => ({ sdkToolCallId: call.id, name: call.name, args: call.arguments })) });
  if (calls.length === 1) return DecisionSchema.parse({ kind: 'call_tool', name: calls[0].name, args: calls[0].arguments });
  return DecisionSchema.parse({ kind: 'respond', text: message.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') });
}
export function encodePiRequest(input: ModelInput) {
  return { systemPrompt: input.stable + '\nTool calls execute sequentially in listed order, each subject to host authorization. Calls that need earlier results must use a later turn.' + (input.completionInstruction ? '\n' + input.completionInstruction : ''), messages: [{ role: 'user' as const, content: input.volatile, timestamp: Date.now() }], tools: input.tools.map(t => ({ name: t.proxy_name, description: t.description, parameters: t.inputSchema })) };
}
export class PiModel implements ModelPort {
  get traceModel(){return{provider:this.provider,id:this.modelId};}
  readonly tokenUsageRequired = true;
  usage?: unknown;
  private runtime?: import('@earendil-works/pi-coding-agent').ModelRuntime;
  constructor(readonly provider: string, readonly modelId: string, private onUsage?: (value: unknown) => void, runtime?: import('@earendil-works/pi-coding-agent').ModelRuntime, private config?: Pick<ModelConfig, 'apiKey' | 'baseUrl'>) { this.runtime = runtime; }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): PiModel {
    const config = readModelConfig(env);
    return new PiModel(config.provider, config.modelId, undefined, undefined, config);
  }
  private async configuredRuntime(signal: AbortSignal) {
    const { createPiRuntime } = await import("./backend/pi/model-runtime.ts");
    const configured = await createPiRuntime(this.provider, this.modelId, this.config, signal, this.runtime);
    this.runtime = configured.runtime;
    return configured;
  }
  private recordUsage(usage: unknown): unknown {
    if (usage === undefined) return undefined;
    if (this.config?.baseUrl && usage && typeof usage === 'object') {
      const { cost: _unknownPrice, ...tokens } = usage as Record<string, unknown>;
      this.usage = { ...tokens, costSource: 'unavailable_for_custom_endpoint' };
    } else this.usage = usage;
    this.onUsage?.(this.usage);
    return this.usage;
  }
  /** Actual investigation entry: Pi owns the multi-turn session and tool-result feedback. */
  async runSession(input: ModelInput, hooks: AgentSessionHooks, signal: AbortSignal): Promise<void> {
    if (!this.config?.apiKey) throw new Error('model_config: subprocess sessions require explicit credentials');
    const { runPiSubprocess } = await import("./backend/pi/subprocess.ts");
    await runPiSubprocess({ provider: this.provider, modelId: this.modelId, ...this.config, apiKey: this.config.apiKey }, input, { ...hooks, onUsage: async (usage, purpose) => { const normalized = this.recordUsage(usage); if (normalized !== undefined) await hooks.onUsage(normalized, purpose); } }, signal);
  }
  /** Isolated connectivity/codec probe only; investigations use runSession. */
  async decide(input: ModelInput, signal: AbortSignal): Promise<Decision> {
    const { runtime, model } = await this.configuredRuntime(signal);
    const encoded = encodePiRequest(input);
    const response = await abortable(runtime.completeSimple(model, encoded as Parameters<typeof runtime.completeSimple>[1], { signal, maxTokens: Math.min(input.maxOutputTokens ?? 4096, model.maxTokens), cacheRetention: 'none' }), signal);
    this.recordUsage(response.usage);
    return decodePiMessage(response);
  }
}
