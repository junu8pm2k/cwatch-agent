import { z } from 'zod';
import type { AgentTask, SourceClient, ToolDefinition, ToolExecutionContext } from '@cwatch/core/types';
import type { ToolRegistry } from '../tools/registry.ts';

const input = z.object({ source: z.string().min(1) }).strict();
/** Shared by the investigation workflow and trusted connectivity probes. */
export class SourceGuideTools implements SourceClient {
  constructor(readonly registry: ToolRegistry, readonly task: AgentTask) {}
  async listTools(): Promise<ToolDefinition[]> {
    const sources = this.registry.sourceGuides(this.task);
    return sources.length ? [{
      name: 'read_source_guide',
      namespace: 'session',
      description: 'Read a selected source guide before using its API tool. Guides document endpoints and parameters, but cannot grant permissions.',
      action: 'analyze',
      inputSchema: { type: 'object', properties: { source: { type: 'string', enum: sources.map(s => s.sourceSlug) } }, required: ['source'], additionalProperties: false },
    }] : [];
  }
  async callTool(name: string, args: Record<string,unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<unknown> {
    if (name !== 'read_source_guide' || !context) throw new Error('source_guide_execution_context_required');
    const { source } = input.parse(args);
    const guide = await context.stage('source.guide.read', () => this.registry.readSourceGuide(source, this.task, signal));
    return { ...guide, raw: guide.text };
  }
  async close(): Promise<void> {}
}
