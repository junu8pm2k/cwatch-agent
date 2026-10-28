import assert from 'node:assert/strict';
import { ContextPipeline, buildCacheableContextParts } from '@cwatch/shared/agent/core/prompt-builder';
import { cacheUsage, PromptCacheStats } from '@cwatch/shared/agent/core/prompt-cache';
import { ActionPolicy } from '@cwatch/shared/agent/core/permission-manager';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { createPiRuntime } from '@cwatch/shared/agent/backend/pi/model-runtime';
import { reportedTokens } from '@cwatch/shared/agent/core/budgets';
import { type AgentState } from '@cwatch/core/types';
import { check, CountingClient, task, emptySchema } from './harness.ts';

check('contract', 'Reusable prompt prefix stays before current permissions and source state while observations stay outside the system prompt', async () => {
  const registry = new ToolRegistry(), state: AgentState = { task: { ...task(), allowedSources: ['official'] }, observations: [], decisions: [], iteration: 0 };
  await registry.register('official', 'mcp', new CountingClient(), new AbortController().signal);
  const pipeline = new ContextPipeline('static-skill-marker'), policy = new ActionPolicy('ask');
  const first = pipeline.prepareTurn(state, registry, policy);
  const prefix = buildCacheableContextParts(state, 'static-skill-marker').join('\n\n');
  assert.ok(first.stable.startsWith(prefix)); assert.ok(first.stable.indexOf('static-skill-marker') < first.stable.indexOf('PERMISSION MODE:'));
  state.observations.push({ name: 'mcp__official__search_news', result: 'changing-observation-marker' }); state.iteration++;
  const next = pipeline.prepareTurn(state, registry, policy);
  assert.equal(next.stable, first.stable); assert.equal(next.prefixHash, first.prefixHash);
  assert.ok(!next.stable.includes('changing-observation-marker')); assert.match(next.volatile, /changing-observation-marker/);
  policy.setMode('explore'); registry.setActive('official', false);
  const revoked = pipeline.prepareTurn(state, registry, policy);
  assert.equal(revoked.prefixHash, first.prefixHash); assert.deepEqual(revoked.tools, []);
  assert.notEqual(revoked.toolsetHash, first.toolsetHash); assert.notEqual(revoked.contextHash, first.contextHash);
  assert.match(revoked.stable, /PERMISSION MODE: explore/);
  assert.notEqual(new ContextPipeline('updated-skill-marker').prepareTurn(state, registry, policy).prefixHash, first.prefixHash);
});

check('contract', 'Tool wire definitions have deterministic ordering and schema keys without hiding revoked or replaced bindings', async () => {
  const state: AgentState = { task: { ...task(), allowedSources: ['official'] }, observations: [], decisions: [], iteration: 0 };
  const definitions = ['z', 'a'].map(name => ({ name, description: name, action: 'collect' as const, inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } }, additionalProperties: false, $comment: undefined } }));
  const a = new ToolRegistry(), b = new ToolRegistry();
  await a.register('official', 'mcp', new CountingClient(definitions), new AbortController().signal);
  await b.register('official', 'mcp', new CountingClient([...definitions].reverse().map(tool => ({ ...tool, inputSchema: { additionalProperties: false, properties: { a: { type: 'string' }, z: { type: 'string' } }, type: 'object' } }))), new AbortController().signal);
  const pipeline = new ContextPipeline('static skill'), first = pipeline.prepareTurn(state, a, new ActionPolicy()), second = new ContextPipeline('static skill').prepareTurn(state, b, new ActionPolicy());
  const wire = (tools: typeof first.tools) => JSON.stringify(tools.map(tool => ({ name: tool.proxy_name, description: tool.description, parameters: tool.inputSchema })));
  assert.equal(wire(first.tools), wire(second.tools)); assert.equal(first.toolsetHash, second.toolsetHash);
  assert.deepEqual(first.tools.map(tool => tool.proxy_name), ['mcp__official__a', 'mcp__official__z']);
  await a.register('official', 'mcp', new CountingClient([{ name: 'a', description: 'changed', action: 'collect', inputSchema: emptySchema }]), new AbortController().signal);
  assert.deepEqual(pipeline.prepareTurn(state, a, new ActionPolicy()).tools, []);
});

check('contract', 'Cache telemetry distinguishes reported reuse from normalized zero and missing data without discounting token budgets', () => {
  const usage = { input: 30, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 120 };
  const observed = cacheUsage(usage);
  assert.equal(observed.readTokens, 60); assert.equal(observed.creationTokens, 10); assert.equal(observed.inputTokens, 100);
  assert.equal(observed.reportedCacheReadInputShare, .6); assert.equal(observed.observation, 'reuse_reported');
  assert.equal(reportedTokens(usage), 120);
  assert.equal(cacheUsage({ input: 100, cacheRead: 0, cacheWrite: 0 }).observation, 'no_positive_reuse_reported');
  assert.equal(cacheUsage(undefined).readTokens, null); assert.equal(cacheUsage(undefined).observation, 'unavailable');
  assert.equal(cacheUsage({ cacheRead: -1, cacheWrite: 1.5 }).creationTokens, null);
  const stats = new PromptCacheStats(); stats.observe(usage, 'turn'); stats.observe(undefined, 'summary'); stats.observe({ input: 4, cacheRead: 0, cacheWrite: 0 }, 'memory');
  const report = stats.snapshot(); assert.equal(report.byPurpose.turn!.readTokens, 60); assert.equal(report.byPurpose.memory!.readTokens, 0);
  assert.equal(report.byPurpose.summary!.unavailableReadResponses, 1); assert.equal(report.financialSavings, 'not_estimated');
});

check('contract', 'Native SDK emits supported Anthropic cache markers for short retention and omits them for none without making a network request', async () => {
  const { runtime } = await createPiRuntime('fixture-cache', 'fixture', { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1/unused' }, new AbortController().signal);
  runtime.registerProvider('fixture-anthropic-cache', { name: 'fixture', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1/unused', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });
  await runtime.setRuntimeApiKey('fixture-anthropic-cache', 'fixture-key');
  const model = runtime.getModel('fixture-anthropic-cache', 'fixture')!;
  for (const cacheRetention of ['none', 'short'] as const) {
    let payload: any, fetched = false;
    await runtime.completeSimple(model, { systemPrompt: 'stable system', messages: [{ role: 'user', content: 'task', timestamp: Date.now() }], tools: [{ name: 'read', description: 'stable tool', parameters: emptySchema }] }, {
      cacheRetention, maxTokens: 32, onPayload: value => { payload = value; throw new Error('capture-before-network'); },
      fetch: async () => { fetched = true; throw new Error('unexpected network'); },
    });
    assert.equal(fetched, false); assert.ok(payload);
    if (cacheRetention === 'short') { assert.equal(payload.system[0].cache_control.type, 'ephemeral'); assert.equal(payload.tools.at(-1).cache_control.type, 'ephemeral'); }
    else assert.ok(!JSON.stringify(payload).includes('cache_control'));
  }
});
