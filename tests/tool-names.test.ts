import assert from 'node:assert/strict';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { proxyToolName } from '@cwatch/shared/tools/tool-names';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import { buildProxyTools } from '@cwatch/shared/agent/backend/pi/tool-hooks';
import type { AgentSessionHooks } from '@cwatch/core/types';
import { check, CountingClient, emptySchema, executionHarness } from './harness.ts';

const live = new AbortController().signal;
const tool = (name: string) => ({ name, action: 'collect' as const, description: 'Read tool', inputSchema: emptySchema });

check('contract', 'only MCP channels use the MCP prefix; local namespaces distinguish workflow, session and sources', async () => {
  const registry = new ToolRegistry();
  try {
    await registry.register('web', 'builtin', new CountingClient(createWebToolDefinitions()), live);
    await registry.register('workflow', 'workflow', new CountingClient([tool('save_plan'), { ...tool('read_transcript'), namespace: 'session' }]), live);
    await registry.register('browser', 'builtin', new CountingClient([{ ...tool('browser_tool'), namespace: 'session' }]), live);
    await registry.register('catalog', 'builtin', new CountingClient([tool('read.item')]), live);
    await registry.register('github', 'mcp', new CountingClient([tool('api_github')]), live);
    assert.deepEqual(registry.list().map(binding => binding.proxy_name).sort(), ['web_search', 'web_fetch', 'workflow__save_plan', 'session__read_transcript', 'session__browser_tool', 'catalog__read_item', 'mcp__github__api_github'].sort());
    for (const binding of registry.list()) assert.equal(binding.proxy_name.startsWith('mcp__'), binding.channel === 'mcp');
    const binding = registry.binding('workflow__save_plan');
    assert.equal(binding.source_slug, 'workflow'); assert.equal(binding.original_name, 'save_plan');
    assert.deepEqual(binding.backendNames, { pi: binding.proxy_name, replay: binding.proxy_name });
  } finally { await registry.close(); }
});

check('contract', 'opaque MCP proxy names dispatch untouched names containing dots and double underscores', async () => {
  const h = await executionHarness(), slug = 'official__nested', original = 'read.a__b';
  const client = new CountingClient([tool(original)]);
  try {
    h.executor.task.allowedSources.push(slug);
    await h.registry.register(slug, 'mcp', client, live);
    const name = proxyToolName(slug, original);
    assert.equal(name, 'mcp__official__nested__read_a__b');
    await h.executor.execute(name, {}, live);
    assert.deepEqual(client.calls, [{ name: original, args: {} }]);
  } finally { await h.registry.close(); }
});

check('contract', 'local sources dispatch original names without decoding their sanitized registration keys', async () => {
  const h = await executionHarness(), slug = 'local__nested', original = 'read.a__b';
  const client = new CountingClient([tool(original)]);
  try {
    h.executor.task.allowedSources.push(slug);
    await h.registry.register(slug, 'builtin', client, live);
    await h.executor.execute('local__nested__read_a__b', {}, live);
    assert.deepEqual(client.calls, [{ name: original, args: {} }]);
  } finally { await h.registry.close(); }
});

check('contract', 'local native tools and local source slugs cannot impersonate MCP registration names', async () => {
  const registry = new ToolRegistry();
  try {
    await registry.register('web', 'builtin', new CountingClient(createWebToolDefinitions()), live);
    const before = registry.list();
    for (const channel of ['builtin', 'workflow'] as const) {
      // A dot also sanitizes to an underscore, so checking raw spelling is insufficient.
      await assert.rejects(registry.register('web', channel, new CountingClient([
        tool('first'), { ...tool('mcp..remote__search'), namespace: 'native' },
      ]), live), /reserved_mcp_tool_prefix/);
      assert.deepEqual(registry.list(), before);
    }
    await assert.rejects(registry.register('mcp', 'builtin', new CountingClient([tool('search')]), live), /reserved_mcp_tool_prefix/);
    assert.equal(registry.known('mcp'), false);
  } finally { await registry.close(); }
});

check('contract', 'external MCP definitions cannot claim native or session namespaces', async () => {
  const registry = new ToolRegistry();
  try {
    for (const namespace of ['native', 'session'] as const) {
      await registry.register('remote', 'mcp', new CountingClient([{ ...tool('web_search'), namespace }]), live);
      assert.equal(registry.list()[0].proxy_name, 'mcp__remote__web_search');
    }
  } finally { await registry.close(); }
});

check('contract', 'native tool collisions reject atomically and preserve the first source binding', async () => {
  const registry = new ToolRegistry(), first = new CountingClient(createWebToolDefinitions());
  try {
    await registry.register('web', 'builtin', first, live);
    const before = registry.list();
    await assert.rejects(registry.register('secondweb', 'builtin', new CountingClient(createWebToolDefinitions()), live), /collision/);
    assert.deepEqual(registry.list(), before); assert.equal(first.closed, 0); assert.equal(registry.known('secondweb'), false);
  } finally { await registry.close(); }
});

check('contract', 'Pi proxies derive Craft labels and bounded prompt snippets without mutating host schemas', async () => {
  const registry = new ToolRegistry(), description = 'x'.repeat(220);
  try {
    await registry.register('linear', 'mcp', new CountingClient([{ ...tool('createIssue'), description, inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', ...emptySchema } }]), live);
    const binding = registry.list()[0];
    const proxy = buildProxyTools([binding], {} as AgentSessionHooks)[0];
    assert.equal(proxy.name, 'mcp__linear__createIssue'); assert.equal(proxy.label, 'create Issue');
    assert.equal(proxy.promptSnippet, 'x'.repeat(197) + '...'); assert.equal(proxy.description, description);
    assert.equal('$schema' in proxy.parameters, false); assert.ok('$schema' in binding.inputSchema);
  } finally { await registry.close(); }
});
