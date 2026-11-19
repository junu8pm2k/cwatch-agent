import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENT_PROMPT_SOURCES, AgentPromptSnapshotSchema, promptDigest, applyAgentPromptSnapshot, type AgentPromptSnapshot } from '@cwatch/shared/agent/core/managed-prompts';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { langfusePayload } from '@cwatch/shared/sessions/langfuse';
import { Trace } from '@cwatch/shared/sessions/trace';
import { SkillStore } from '@cwatch/shared/skills/storage';
import { LangfuseClient } from '../scripts/langfuse-client.ts';
import { pushAgentPrompts, pullAgentPrompts, saveAgentPromptSnapshot } from '../scripts/agent-prompts.ts';
import { check, store } from './harness.ts';

function snapshot(): AgentPromptSnapshot {
  const entries = AGENT_PROMPT_SOURCES.map(source => {
    const text = readFileSync(resolve(source.file), 'utf8');
    return { key: source.key, name: source.name, version: 1, text, sha256: promptDigest(text) };
  });
  return AgentPromptSnapshotSchema.parse({ schemaVersion: 'cwatch.agent-prompts.v1', source: 'http://localhost:3000', projectId: 'fixture-project', label: 'prompt-eval', entries, sha256: promptDigest(JSON.stringify(entries)) });
}
function variant(original = snapshot()): AgentPromptSnapshot {
  const entries = original.entries.map(entry => {
    const text = entry.text + '\nPROMPT_VARIANT_' + entry.key + '\n';
    return { ...entry, text, version: 2, sha256: promptDigest(text) };
  });
  return AgentPromptSnapshotSchema.parse({ ...original, entries, sha256: promptDigest(JSON.stringify(entries)) });
}
function fixture() {
  const prompts = new Map<string, Array<Record<string, unknown>>>(); let writes = 0;
  const transport: typeof fetch = async (url, init) => {
    const request = new URL(String(url)), response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (request.pathname === '/api/public/projects') return response({ data: [{ id: 'fixture-project' }] });
    if (request.pathname === '/api/public/v2/prompts' && init?.method === 'POST') {
      writes++; const body = JSON.parse(String(init.body)), versions = prompts.get(body.name) ?? [];
      const entry = { ...body, version: versions.length + 1 }; versions.push(entry); prompts.set(body.name, versions); return response(entry);
    }
    const name = decodeURIComponent(request.pathname.slice('/api/public/v2/prompts/'.length)), versions = prompts.get(name) ?? [];
    const value = request.searchParams.has('version') ? versions.find(v => v.version === Number(request.searchParams.get('version'))) : versions.at(-1);
    return value ? response(value) : response({ message: 'Not found' }, 404);
  };
  return { client: new LangfuseClient({ baseUrl: 'http://localhost:3000', publicKey: 'fixture-pk', secretKey: 'fixture-sk', environment: 'test', timeoutMs: 1000 }, transport), prompts, writes: () => writes };
}

check('integration', 'Agent prompt sync publishes Skill sources idempotently, preserves remote edits and freezes exact versions', async () => {
  const f = fixture(); await pushAgentPrompts(f.client, resolve('.'));
  assert.equal(f.writes(), 4); assert((await pushAgentPrompts(f.client, resolve('.'))).every(p => p.action === 'reused')); assert.equal(f.writes(), 4);
  const first = await pullAgentPrompts(f.client), versions = f.prompts.get('cwatch/agent/competitor-review')!;
  const original = versions[0]; versions.push({ ...original, prompt: String(original.prompt) + '\nPlatform edit\n', version: 2 });
  await assert.rejects(pushAgentPrompts(f.client, resolve('.')), /agent_prompt_remote_differs/); assert.equal(f.writes(), 4);
  const current = await pullAgentPrompts(f.client); assert.notEqual(current.sha256, first.sha256);
  const pinned = await pullAgentPrompts(f.client, { pins: { 'competitor-review': 1 } }); assert.equal(pinned.sha256, first.sha256);
  const root = store().root, file = saveAgentPromptSnapshot(first, root);
  assert.equal(saveAgentPromptSnapshot(first, root), file);
  assert.throws(() => AgentPromptSnapshotSchema.parse({ ...first, entries: first.entries.map((p, i) => i ? p : { ...p, text: p.text + 'tampered' }) }), /digest/);
});

check('integration', 'Managed Agent prompts update Agent context, Skill resources and trace provenance', async () => {
  const pinned = variant(), output = store(), skills = new SkillStore(output.root);
  skills.installDirectory('skills/competitor-review');
  const selected = skills.select(['competitor-review']);
  const applied = applyAgentPromptSnapshot(pinned, 'general-agent', selected);
  assert.match(applied.userSkills!.readResource('competitor-review', 'references/checklist.md', 0, 24000).text, /PROMPT_VARIANT_review-checklist/);
  assert.equal(applied.provenance.references.length, 3); assert(!applied.provenance.references.some(r => r.key === 'competitor-investigation'));
  const registry = new ToolRegistry(); let inspected = false;
  try {
    const result = await runAgent({ kind: 'agent', taskId: 'prompt-variant-fixture', instruction: 'Synthetic test task', allowedSources: [] }, {
      decide: async input => {
        inspected = true; assert.match(input.stable, /PROMPT_VARIANT_general-agent/); assert.match(input.stable, /PROMPT_VARIANT_competitor-review/);
        assert(!input.stable.includes('PROMPT_VARIANT_competitor-investigation'));
        return { kind: 'respond', text: 'Synthetic integration test, not a real model evaluation.' };
      },
    }, registry, output, 'replay', { builtinTools: false, userSkills: selected, agentPrompts: pinned });
    assert(inspected); assert.equal(result.status, 'complete');
    const trace = new Trace(output, result.taskId, result.runId), document = trace.exportStructured();
    const spans = langfusePayload(document, { environment: 'test' }).spans;
    const generation = spans.find(span => span.attributes.some(a => a.key === 'langfuse.observation.type' && a.value.stringValue === 'generation'))!;
    assert.equal(generation.attributes.find(a => a.key === 'langfuse.observation.prompt.name')!.value.stringValue, 'cwatch/agent/general-agent');
    assert.equal(generation.attributes.find(a => a.key === 'langfuse.observation.prompt.version')!.value.intValue, '2');
    assert(!spans.some(s => s.name === 'model.memory' && s.attributes.some(a => a.key === 'langfuse.observation.prompt.name')));
  } finally { await registry.close(); }
});
