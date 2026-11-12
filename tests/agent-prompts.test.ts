import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AGENT_PROMPT_SOURCES, AgentPromptSnapshotSchema, promptDigest, applyAgentPromptSnapshot, type AgentPromptSnapshot } from '@cwatch/shared/agent/core/managed-prompts';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { langfusePayload } from '@cwatch/shared/sessions/langfuse';
import { Trace } from '@cwatch/shared/sessions/trace';
import { LangfuseClient } from '../scripts/evaluation/langfuse-client.ts';
import { pushAgentPrompts, pullAgentPrompts, saveAgentPromptSnapshot } from '../scripts/evaluation/agent-prompts.ts';
import { frozenSkillBundle } from '../scripts/evaluation/skill-snapshots.ts';
import { loadDataset } from '../scripts/evaluation/dataset.ts';
import { runBatch } from '../scripts/evaluation/runner.ts';
import { prepareQualitySubject } from '../scripts/evaluation/quality.ts';

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
function output(): string { const root = resolve('artifacts/test-agent-prompts'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'case-')); }
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

test('Agent prompt sync publishes actual Skill sources idempotently, preserves remote edits and freezes exact versions', async () => {
  const f = fixture(); await pushAgentPrompts(f.client, resolve('.'));
  assert.equal(f.writes(), 4); assert((await pushAgentPrompts(f.client, resolve('.'))).every(p => p.action === 'reused')); assert.equal(f.writes(), 4);
  const first = await pullAgentPrompts(f.client), versions = f.prompts.get('cwatch/agent/competitor-review')!;
  const original = versions[0]; versions.push({ ...original, prompt: String(original.prompt) + '\nPlatform edit\n', version: 2 });
  await assert.rejects(pushAgentPrompts(f.client, resolve('.')), /agent_prompt_remote_differs/); assert.equal(f.writes(), 4);
  const current = await pullAgentPrompts(f.client); assert.notEqual(current.sha256, first.sha256);
  const pinned = await pullAgentPrompts(f.client, { pins: { 'competitor-review': 1 } }); assert.equal(pinned.sha256, first.sha256);
  const file = saveAgentPromptSnapshot(first, output()); assert.equal(saveAgentPromptSnapshot(first, resolve(file, '../../../..')), file);
  assert.throws(() => AgentPromptSnapshotSchema.parse({ ...first, entries: first.entries.map((p, i) => i ? p : { ...p, text: p.text + 'tampered' }) }), /digest/);
});

test('managed Agent prompts change real model context and Skill resource readback without exposing a Case oracle', async () => {
  const pinned = variant(), c = loadDataset('evals/cwatch/dataset.json').entries.find(e => e.value.id === 'core-001')!.value;
  assert.equal(c.input.scenario.driver, 'runtime'); if (c.input.scenario.driver !== 'runtime') return;
  const selected = frozenSkillBundle(c.input.scenario.selectedSkills), applied = applyAgentPromptSnapshot(pinned, 'general-agent', selected);
  assert.match(applied.userSkills!.readResource('competitor-review', 'references/checklist.md', 0, 24000).text, /PROMPT_VARIANT_review-checklist/);
  assert.equal(applied.provenance.references.length, 3); assert(!applied.provenance.references.some(r => r.key === 'competitor-investigation'));
  const store = new FileStore(output()), registry = new ToolRegistry(); let inspected = false;
  try {
    const result = await runAgent({ kind: 'agent', taskId: 'prompt-variant-fixture', instruction: 'Synthetic test task', allowedSources: [] }, {
      decide: async input => {
        inspected = true; assert.match(input.stable, /PROMPT_VARIANT_general-agent/); assert.match(input.stable, /PROMPT_VARIANT_competitor-review/);
        assert(!input.stable.includes('passAll')); assert(!input.stable.includes('failAny')); assert(!input.stable.includes('PROMPT_VARIANT_competitor-investigation'));
        return { kind: 'respond', text: 'Synthetic integration test, not a real model evaluation.' };
      },
    }, registry, store, 'replay', { builtinTools: false, userSkills: selected, agentPrompts: pinned });
    assert(inspected); assert.equal(result.status, 'complete');
    const trace = new Trace(store, result.taskId, result.runId), document = trace.exportStructured();
    const spans = langfusePayload(document, { environment: 'test' }).spans;
    const generation = spans.find(span => span.attributes.some(a => a.key === 'langfuse.observation.type' && a.value.stringValue === 'generation'))!;
    assert.equal(generation.attributes.find(a => a.key === 'langfuse.observation.prompt.name')!.value.stringValue, 'cwatch/agent/general-agent');
    assert.equal(generation.attributes.find(a => a.key === 'langfuse.observation.prompt.version')!.value.intValue, '2');
    assert(!spans.some(s => s.name === 'model.memory' && s.attributes.some(a => a.key === 'langfuse.observation.prompt.name')));
  } finally { await registry.close(); }
});

test('permission-restricted eval worker uses a frozen Agent variant while retaining the original Case and rubric', async () => {
  const root = output(), pinned = variant(), file = saveAgentPromptSnapshot(pinned, root);
  const c = structuredClone(loadDataset('evals/cwatch/dataset.json').entries.find(e => e.value.id === 'core-001')!.value);
  c.scope.executionMode = 'deterministic'; if (c.input.scenario.driver !== 'runtime') throw Error();
  c.input.scenario.modelMode = 'scripted'; c.input.scenario.steps = [{ kind: 'respond', text: 'M1说明console支持，desktop是否支持无法确定。' }];
  const caseFile = join(root, 'case.json'); writeFileSync(caseFile, JSON.stringify(c));
  const dataset = join(root, 'dataset.json'); writeFileSync(dataset, JSON.stringify({ schemaVersion: 'cwatch.eval-dataset.v5', id: 'prompt-variant-fixture', version: '1', cases: [{ id: c.id, revision: c.revision, file: 'case.json', sha256: promptDigest(readFileSync(caseFile, 'utf8')) }] }));
  const result = await runBatch({ dataset, out: join(root, 'runs'), agentPrompts: file });
  assert.notEqual(result.report.results[0].verdict, 'invalid');
  const subject = prepareQualitySubject(result.path, c.id), observed = JSON.parse(readFileSync(join(subject.archive.directory, 'observed.json'), 'utf8'));
  assert.equal(observed.facts.agentPromptSnapshot, pinned.sha256); assert.equal(observed.facts.skillSetupValid, true);
  assert.deepEqual(subject.packet.rubric, c.rubric);
  assert.equal((subject.packet.task as {selectedSkills:Array<{sha256:string}>}).selectedSkills[0].sha256, c.input.scenario.selectedSkills[0].sha256);
  assert.equal((subject.packet.agentPromptVariant!.actualSelectedSkills as Array<{sha256:string}>)[0].sha256, pinned.entries.find(e => e.key === 'competitor-review')!.sha256);
  assert.equal(JSON.parse(readFileSync(join(subject.archive.directory, 'boundary.json'), 'utf8')).privateReadDenied, true);
  assert(!readFileSync(join(subject.archive.directory, 'input.json'), 'utf8').includes('passAll'));
});
