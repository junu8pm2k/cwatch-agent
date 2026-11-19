import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { AGENT_PROMPT_SOURCES, AgentPromptSnapshotSchema, promptDigest, type AgentPromptSnapshot } from '@cwatch/shared/agent/core/managed-prompts';
import { parseSkill } from '@cwatch/shared/skills/storage';
import { LangfuseClient } from './langfuse-client.ts';

const remotePrompt = z.object({ name: z.string(), version: z.number().int().positive(), type: z.literal('text'), prompt: z.string().min(1),
  config: z.object({ purpose: z.literal('agent_guidance'), key: z.string(), sourceFile: z.string() }).passthrough(), labels: z.array(z.string()) }).passthrough();
const promptPath = (name: string) => '/api/public/v2/prompts/' + encodeURIComponent(name);
export async function pushAgentPrompts(client: LangfuseClient, root: string, options: { label?: string; update?: boolean } = {}) {
  const label = options.label ?? 'prompt-eval', plans = [];
  // Validate all sources and all conflicts before mutating the project.
  for (const source of AGENT_PROMPT_SOURCES) {
    const text = readFileSync(resolve(root, source.file), 'utf8');
    if (!text.trim() || Buffer.byteLength(text) > (source.resource ? 24000 : 65536)) throw Error('agent_prompt_source_invalid: ' + source.key);
    if (!source.resource && parseSkill(text).name !== source.skill) throw Error('agent_prompt_skill_name_changed');
    let previous: z.infer<typeof remotePrompt> | undefined;
    try { previous = remotePrompt.parse(await client.request(promptPath(source.name) + '?label=latest')); }
    catch (error) { if (!(error instanceof Error && error.message.startsWith('langfuse_http_404:'))) throw error; }
    if (previous && (previous.config.key !== source.key || previous.config.sourceFile !== source.file)) throw Error('agent_prompt_not_owned: ' + source.name);
    if (previous && previous.prompt !== text && !options.update) throw Error('agent_prompt_remote_differs: ' + source.name + '; use pull for platform edits, or --update to publish local edits');
    plans.push({ source, text, previous });
  }
  const results = [];
  for (const { source, text, previous } of plans) {
    if (previous?.prompt === text) { results.push({ key: source.key, name: source.name, version: previous.version, action: 'reused' }); continue; }
    const created = remotePrompt.parse(await client.request('/api/public/v2/prompts', { name: source.name, type: 'text', prompt: text,
      labels: [label], tags: ['cwatch', 'agent', 'agent-guidance'],
      config: { purpose: 'agent_guidance', key: source.key, sourceFile: source.file, skill: source.skill, resource: source.resource,
        note: 'Full Skill entry or resource used by the Agent runtime with a pinned prompt snapshot.' },
      commitMessage: 'Sync actual Agent guidance from ' + source.file }));
    results.push({ key: source.key, name: source.name, version: created.version, action: previous ? 'updated' : 'created' });
  }
  return results;
}
export async function pullAgentPrompts(client: LangfuseClient, options: { label?: string; pins?: Record<string, number> } = {}): Promise<AgentPromptSnapshot> {
  const label = options.label ?? 'prompt-eval', entries = [];
  if (Object.keys(options.pins ?? {}).some(key => !AGENT_PROMPT_SOURCES.some(source => source.key === key))) throw Error('unknown_agent_prompt_pin');
  for (const source of AGENT_PROMPT_SOURCES) {
    const version = options.pins?.[source.key];
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw Error('invalid_agent_prompt_version');
    const query = version === undefined ? new URLSearchParams({ label }) : new URLSearchParams({ version: String(version) });
    const value = remotePrompt.parse(await client.request(promptPath(source.name) + '?' + query));
    if (value.name !== source.name || value.config.key !== source.key || value.config.sourceFile !== source.file || (version !== undefined && value.version !== version)) throw Error('agent_prompt_identity_changed');
    entries.push({ key: source.key, name: source.name, version: value.version, text: value.prompt, sha256: promptDigest(value.prompt) });
  }
  return AgentPromptSnapshotSchema.parse({ schemaVersion: 'cwatch.agent-prompts.v1', projectId: await client.projectId(),
    source: client.config.baseUrl, label, entries, sha256: promptDigest(JSON.stringify(entries)) });
}
export function saveAgentPromptSnapshot(snapshot: AgentPromptSnapshot, root: string): string {
  const valid = AgentPromptSnapshotSchema.parse(snapshot), file = resolve(root, 'artifacts/agent-prompts', valid.sha256, 'snapshot.json');
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) { if (!isDeepStrictEqual(JSON.parse(readFileSync(file, 'utf8')), valid)) throw Error('agent_prompt_snapshot_conflict'); }
  else writeFileSync(file, JSON.stringify(valid, null, 2) + '\n', { flag: 'wx' });
  return file;
}
