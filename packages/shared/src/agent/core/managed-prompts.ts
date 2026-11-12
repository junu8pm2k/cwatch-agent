import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseSkill, type SkillBundle } from '../../skills/storage.ts';

/** Only authored Agent guidance is managed here. Host policy and Case oracles are never templates. */
export const AGENT_PROMPT_SOURCES = [
  { key: 'general-agent', name: 'cwatch/agent/general-agent', file: 'skills/general-agent/SKILL.md', skill: 'general-agent', resource: null },
  { key: 'competitor-investigation', name: 'cwatch/agent/competitor-investigation', file: 'skills/competitor-investigation/SKILL.md', skill: 'competitor-investigation', resource: null },
  { key: 'competitor-review', name: 'cwatch/agent/competitor-review', file: 'skills/competitor-review/SKILL.md', skill: 'competitor-review', resource: null },
  { key: 'review-checklist', name: 'cwatch/agent/review-checklist', file: 'skills/competitor-review/references/checklist.md', skill: 'competitor-review', resource: 'references/checklist.md' },
] as const;
export const promptDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const entry = z.object({ key: z.string(), name: z.string(), version: z.number().int().positive(),
  text: z.string().min(1).max(65536), sha256: digest }).strict();
export const AgentPromptSnapshotSchema = z.object({ schemaVersion: z.literal('cwatch.agent-prompts.v1'),
  projectId: z.string().min(1), source: z.string().url(), label: z.string().min(1), entries: z.array(entry).length(4), sha256: digest,
}).strict().superRefine((snapshot, ctx) => {
  for (const source of AGENT_PROMPT_SOURCES) {
    const matches = snapshot.entries.filter(e => e.key === source.key && e.name === source.name);
    if (matches.length !== 1) { ctx.addIssue({ code: 'custom', message: 'agent_prompt_identity_mismatch: ' + source.key }); continue; }
    const value = matches[0];
    if (promptDigest(value.text) !== value.sha256 || Buffer.byteLength(value.text) > 65536) ctx.addIssue({ code: 'custom', message: 'agent_prompt_digest_or_size_mismatch' });
    if (!source.resource) {
      try { if (parseSkill(value.text).name !== source.skill) throw Error(); }
      catch { ctx.addIssue({ code: 'custom', message: 'agent_prompt_invalid_skill: ' + source.key }); }
    } else if (value.text.length > 24000) ctx.addIssue({ code: 'custom', message: 'agent_prompt_resource_too_large' });
  }
  if (promptDigest(JSON.stringify(snapshot.entries)) !== snapshot.sha256) ctx.addIssue({ code: 'custom', message: 'agent_prompt_snapshot_digest_mismatch' });
});
export type AgentPromptSnapshot = z.infer<typeof AgentPromptSnapshotSchema>;
export function readAgentPromptSnapshot(file?: string): AgentPromptSnapshot | undefined {
  if (!file) return undefined;
  const bytes = readFileSync(file); if (bytes.length > 400000) throw Error('agent_prompt_snapshot_too_large');
  return AgentPromptSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
}
export function agentPromptReferences(snapshot: AgentPromptSnapshot, keys: string[]) {
  return snapshot.entries.filter(e => keys.includes(e.key)).map(({ key, name, version, sha256 }) => ({ key, name, version, sha256 }));
}
/** Override only Skills already selected by the host; never turn a Prompt into a new tool/permission. */
export function applyAgentPromptSnapshot(snapshot: AgentPromptSnapshot, builtinName: string, selected?: SkillBundle) {
  const pinned = AgentPromptSnapshotSchema.parse(snapshot);
  const base = pinned.entries.find(e => e.key === builtinName); if (!base) throw Error('agent_prompt_builtin_not_managed');
  const used = [builtinName];
  const resources = new Map<string, string>();
  const documents = selected?.documents.map(document => {
    const source = AGENT_PROMPT_SOURCES.find(s => s.skill === document.name && !s.resource);
    if (!source) return document;
    const entry = pinned.entries.find(e => e.key === source.key)!; used.push(entry.key);
    for (const resource of AGENT_PROMPT_SOURCES.filter(s => s.skill === document.name && s.resource && document.resources.includes(s.resource))) {
      const value = pinned.entries.find(e => e.key === resource.key)!;
      resources.set(document.name + '/' + resource.resource, value.text); used.push(value.key);
    }
    const parsed = parseSkill(entry.text);
    return { ...document, description: parsed.description, body: parsed.body, hash: entry.sha256 };
  });
  const userSkills: SkillBundle | undefined = selected && documents ? { documents,
    readResource: (name, path, offset, limit) => {
      const text = resources.get(name + '/' + path);
      if (text === undefined) return selected.readResource(name, path, offset, limit);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw Error('skill_resource_range_invalid');
      return { text: text.slice(offset, offset + limit), hash: promptDigest(text), totalChars: text.length, truncated: offset + limit < text.length };
    } } : undefined;
  return { builtinBody: parseSkill(base.text).body, userSkills,
    provenance: { snapshotSha256: pinned.sha256, projectId: pinned.projectId, source: pinned.source,
      primary: { name: base.name, version: base.version }, references: agentPromptReferences(pinned, used) } };
}
