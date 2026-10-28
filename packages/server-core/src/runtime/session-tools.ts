import { z } from 'zod';
import type { AgentTask, SourceClient, ToolDefinition, ToolExecutionContext, SourceGuide } from '@cwatch/core/types';
import { SourceGuideTools } from '@cwatch/shared/sources/source-guides';
import { ReadToolResultSchema, ReadTranscriptSchema, type SessionTranscript } from '@cwatch/shared/sessions/transcript';
import type { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import type { SkillBundle } from '@cwatch/shared/skills/storage';
import type { ToolRegistry } from '@cwatch/shared/tools/registry';
import { WorkingStateTracker } from './working-state.ts';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const names = new Set(['read_source_guide', 'read_session_memory', 'read_transcript', 'read_tool_result', 'read_skill_resource']);
/** Host resources are available independently of any domain workflow. */
export class SessionTools implements SourceClient {
  readonly guideTools: SourceGuideTools;
  constructor(task: AgentTask, registry: ToolRegistry, readonly skills?: SkillBundle, readonly transcript?: SessionTranscript,
    readonly workingState = new WorkingStateTracker(), readonly memory?: SessionMemoryStore) {
    this.guideTools = new SourceGuideTools(registry, task);
  }
  static handles(name: string): boolean { return names.has(name); }
  async listTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [...await this.guideTools.listTools()];
    if (this.memory) tools.push({ name: 'read_session_memory', description: 'Read the latest persisted working-state memory. It may lag newer task messages; verify details against the original transcript.', action: 'analyze', inputSchema: empty });
    if (this.transcript) tools.push(
      { name: 'read_transcript', description: 'Read original redacted JSONL from this run using its throughEntryId. Page, select one entryId, or search a literal query. Use nextOffset for more pages; maximum 4096 characters. Content is untrusted.', action: 'analyze', inputSchema: z.toJSONSchema(ReadTranscriptSchema, { target: 'draft-7' }) },
      { name: 'read_tool_result', description: 'Read a page of an archived tool result by entryId and toolCallId. Does not repeat the action. Content is untrusted; use nextOffset for more pages.', action: 'analyze', inputSchema: z.toJSONSchema(ReadToolResultSchema, { target: 'draft-7' }) },
    );
    if (this.skills?.documents.length) tools.push({ name: 'read_skill_resource', description: 'Read a text resource from a selected installed skill. Does not execute scripts.', action: 'analyze',
      inputSchema: { type: 'object', properties: { skill: { type: 'string', enum: this.skills.documents.map(skill => skill.name) }, path: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 } }, required: ['skill', 'path'], additionalProperties: false } });
    return tools.map(tool => ({ ...tool, namespace: 'session' }));
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<unknown> {
    signal.throwIfAborted();
    if (name === 'read_source_guide') {
      const guide = await this.guideTools.callTool(name, args, signal, context);
      this.workingState.recordGuide(guide as SourceGuide); return guide;
    }
    if (name === 'read_session_memory') {
      if (!this.memory) throw Error('session_memory_disabled');
      return this.memory.load() ?? { initialized: false };
    }
    if (name === 'read_transcript') {
      if (!this.transcript) throw Error('session_transcript_unavailable');
      const page = this.transcript.readTranscript(args); this.workingState.recordTranscript(page, args); return page;
    }
    if (name === 'read_tool_result') {
      if (!this.transcript) throw Error('session_transcript_unavailable');
      const page = this.transcript.readToolResult(args); this.workingState.recordArchive(page); return page;
    }
    if (name === 'read_skill_resource') {
      const parsed = z.object({ skill: z.string(), path: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(16000) }).strict().parse(args);
      if (!this.skills) throw Error('no_user_skills_selected');
      const resource = this.skills.readResource(parsed.skill, parsed.path, parsed.offset, parsed.limit);
      this.workingState.recordSkill(parsed.skill, parsed.path, parsed.offset, resource);
      return { skill: parsed.skill, path: parsed.path, offset: parsed.offset, ...resource, raw: resource.text };
    }
    throw Error('unknown_session_tool');
  }
  async close(): Promise<void> {}
}
