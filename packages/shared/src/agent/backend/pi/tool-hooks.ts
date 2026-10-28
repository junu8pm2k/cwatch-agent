import { type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type AgentSessionHooks, type ToolBinding } from "@cwatch/core/types";
import type { PiBuiltinResult } from '../../../tools/pi-builtins.ts';

export interface ToolHookContext { signal: AbortSignal; throwIfStopped(): void }
/** Proxy bodies delegate to the host executor; raw SourceClient implementations stay private. */
export function buildProxyTools(bindings: readonly ToolBinding[], hooks: AgentSessionHooks): ToolDefinition[] {
  return bindings.map(disclosed => {
    const binding = structuredClone(disclosed);
    const { $schema: _metaSchema, ...parameters } = binding.inputSchema;
    return {
      name: binding.proxy_name,
      label: binding.original_name.replace(/[^a-zA-Z0-9-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'),
      description: binding.description,
      promptSnippet: binding.description.length > 200 ? binding.description.slice(0, 197) + '...' : binding.description,
      parameters: parameters as ToolDefinition['parameters'], executionMode: 'sequential',
      execute: async (toolCallId, params, signal) => {
        if (!signal) throw new Error('tool_signal_required');
        const observation = await hooks.executeTool(binding.proxy_name, params as Record<string, unknown>, signal, binding, toolCallId);
        if (binding.source_slug === 'pi' && binding.channel === 'builtin' && observation && typeof observation === 'object' && 'kind' in observation && observation.kind === 'pi_builtin_result') {
          return { content: (observation as PiBuiltinResult).content, details: observation };
        }
        return { content: [{ type: 'text', text: JSON.stringify(observation) }], details: observation };
      },
    };
  });
}
/** Preserve the SDK tool contract, including progress and extension context. */
export function wrapSingleTool(tool: ToolDefinition, hooks: ToolHookContext): ToolDefinition {
  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, sdkSignal, onUpdate, context) => {
      hooks.throwIfStopped(); hooks.signal.throwIfAborted();
      const signal = sdkSignal ? AbortSignal.any([hooks.signal, sdkSignal]) : hooks.signal;
      signal.throwIfAborted();
      const result = await originalExecute.call(tool, toolCallId, params, signal, onUpdate, context);
      hooks.throwIfStopped(); signal.throwIfAborted();
      return result;
    },
  };
}
export { wrapSingleTool as wrapTool };
export function wrapToolsWithHooks(tools: readonly ToolDefinition[], hooks: ToolHookContext): ToolDefinition[] {
  return tools.map(tool => wrapSingleTool(tool, hooks));
}
