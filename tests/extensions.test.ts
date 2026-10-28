import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check, deferred, emptySchema, fixture, json, store, task, waitTick } from './harness.ts';
import { ManagedWorkspace } from "@cwatch/shared/workspaces/managed-workspace";
import { UserMcpStore, UserMcpSchema, validateMcpUrl } from "@cwatch/shared/mcp/storage";
import { UserMcpSource } from "@cwatch/shared/mcp/source";
import { SkillStore, githubSkill, parseSkill, type GitRunner } from "@cwatch/shared/skills/storage";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager, type Mode } from "@cwatch/shared/agent/core/permission-manager";
import { Trace, validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { runInvestigation } from "@cwatch/server-core/runtime/investigation";
import { loadAgentSkill, loadInvestigationSkill } from '@cwatch/shared/agent/core/prompt-builder';

const live = new AbortController().signal, exec = promisify(execFile);
const endpoint = 'https://custom-mcp.example/mcp', sampleSkill = resolve('examples/skills/competitor-review');
const skillText = '---\nname: sample-skill\ndescription: >\n  A folded description\n  for tests.\n---\nUse host tools only.\n';
check('contract', 'standard built-in skills are installable and inject instructions without YAML; explicit legacy overrides still load', () => {
  const data = store(), skills = new SkillStore(data.root);
  for (const [directory, load] of [['general-agent', loadAgentSkill], ['competitor-investigation', loadInvestigationSkill]] as const) {
    const path = resolve('skills', directory, 'SKILL.md'), parsed = parseSkill(readFileSync(path, 'utf8'));
    const installed = skills.installDirectory(resolve('skills', directory));
    assert.equal(installed.name, directory);
    assert.equal(skills.select([directory]).documents[0].body, parsed.body);
    assert.equal(load(), parsed.body);
    assert.ok(!load().startsWith('---'));
  }
  data.text('custom.md', 'An explicit legacy SOP.');
  assert.equal(loadAgentSkill(data.path('custom.md')), 'An explicit legacy SOP.');
  data.text('invalid/SKILL.md', 'Missing required frontmatter.');
  assert.throws(() => loadAgentSkill(data.path('invalid/SKILL.md')), /skill_requires_yaml_frontmatter/);
});
const remoteTool = { name: 'read.notes', description: 'Custom notes', inputSchema: { ...emptySchema, $schema: 'https://json-schema.org/draft/2020-12/schema' }, annotations: { readOnlyHint: true } };
function rpc(options: { onCall?: (name: string, args: any) => unknown | Promise<unknown>; auth?: string | null; tools?: any[]; isError?: boolean } = {}): typeof fetch {
  return async (_target, init) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(new Headers(init?.headers).get('authorization'), options.auth === undefined ? 'Bearer custom-fixture-secret' : options.auth);
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'custom-fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: options.tools ?? [remoteTool] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(await options.onCall?.(message.params.name, message.params.arguments) ?? { note: 'hello' }) }], ...(options.isError ? { isError: true } : {}) };
    else throw new Error('Unexpected fixture method:' + message.method);
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
}
async function mcpHarness(options: { mode?: Mode; action?: 'collect' | 'modify'; args?: any; fetcher?: typeof fetch; approvals?: ApprovalManager } = {}) {
  const data = store(), registry = new ToolRegistry(), value = { ...task(), allowedSources: ['custom'] };
  const source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'streamable-http', url: endpoint, tokenEnv: 'MY_AUTH', ...(options.action ? { defaultAction: options.action } : {}) }), process.cwd(), { MY_AUTH: 'custom-fixture-secret' }, options.fetcher ?? rpc());
  await registry.register('custom', 'mcp', source, live);
  const trace = new Trace(data, value.taskId, 'user-mcp-' + Date.now()), policy = new ActionPolicy(options.mode ?? 'explore');
  trace.emit('run_started', { task: value, toolPipeline: 'pre-tool-use-v1' });
  const executor = new ToolExecutor(registry, policy, options.approvals ?? new ApprovalManager(), data, trace, value, 300);
  const finish = () => { trace.emit('run_completed'); const events = data.lines<TraceEvent>(trace.key); assert.deepEqual(validateTrace(events, ['custom-fixture-secret']), []); return events; };
  return { source, registry, trace, data, executor, finish };
}
check('contract', 'User MCP store persists only configuration references and supports enable/disable/remove', () => {
  const data = store(), mcp = new UserMcpStore(data.root);
  assert.deepEqual(mcp.list(), []); assert.equal(existsSync(join(data.root, '.cwatch')), false);
  const config = mcp.add({ slug: 'custom', transport: 'auto', url: endpoint, tokenEnv: 'MY_AUTH' });
  assert.equal(config.defaultAction, 'modify'); assert.equal(config.tokenEnv, 'MY_AUTH');
  assert.throws(() => mcp.add(config), /already_exists/);
  mcp.change('custom', false); assert.throws(() => mcp.select(['custom']), /disabled/);
  mcp.change('custom', true); assert.equal(mcp.select(['custom']).length, 1);
  mcp.change('custom', 'remove'); assert.deepEqual(mcp.list(), []);
});
check('contract', 'User MCP rejects embedded credentials, unknown transports and mixed stdio/remote configuration', () => {
  for (const value of [
    { slug: 'workflow', transport: 'auto', url: endpoint },
    { slug: 'x', transport: 'stdio' }, { slug: 'x', transport: 'stdio', command: 'node', tokenEnv: 'TOKEN' },
    { slug: 'x', transport: 'auto', url: 'https://user:password@host.example/mcp' },
    { slug: 'x', transport: 'auto', url: 'https://host.example/mcp?token=secret' },
    { slug: 'x', transport: 'auto', url: endpoint, token: 'literal-secret' },
    { slug: 'x', transport: 'auto', url: endpoint, command: 'node' },
    { slug: 'x', transport: 'stdio', command: 'node', env: { NODE_OPTIONS: 'SECRET' } },
  ]) assert.equal(UserMcpSchema.safeParse(value).success, false);
  assert.throws(() => validateMcpUrl('http://remote.example/mcp'));
  assert.equal(validateMcpUrl('http://127.0.0.1:4444/mcp').protocol, 'http:');
});
check('contract', 'Unclassified custom MCP tools remain modifying despite server readOnlyHint and never execute in explore', async () => {
  let calls = 0; const h = await mcpHarness({ fetcher: rpc({ onCall: () => { calls++; } }) });
  try { await assert.rejects(h.executor.execute('mcp__custom__read_notes', {}, live), /forbidden/); assert.equal(calls, 0); assert.equal(h.data.executions()[0].execute_count, 0); h.finish(); }
  finally { await h.registry.close(); }
});
for (const mode of ['ask', 'allow-all'] as const) check('integration', 'Custom MCP ' + mode + ' uses the existing one-shot gate and original remote tool name', async () => {
  let calls = 0, prompts = 0;
  const h = await mcpHarness({ mode, approvals: new ApprovalManager(async () => { prompts++; return true; }), fetcher: rpc({ onCall: (name, args) => { assert.equal(name, 'read.notes'); assert.deepEqual(args, {}); calls++; return { note: 'ok' }; } }) });
  try {
    const result = await h.executor.execute('mcp__custom__read_notes', {}, live) as any;
    assert.equal(result.kind, 'mcp_tool_result'); assert.equal(result.status, 'success'); assert.equal(calls, 1); assert.equal(prompts, mode === 'ask' ? 1 : 0);
    const events = h.finish(); assert.ok(events.some(event => event.type === 'backend_started' && event.data.backend === 'mcp.custom.call'));
  } finally { await h.registry.close(); }
});
check('contract', 'Custom MCP schema and task scope violations have zero tools/call requests', async () => {
  let calls = 0; const h = await mcpHarness({ action: 'collect', fetcher: rpc({ onCall: () => { calls++; } }) });
  try {
    await assert.rejects(h.executor.execute('mcp__custom__read_notes', { unexpected: true }, live), /invalid_tool_arguments/);
    h.registry.setActive('custom', false); await assert.rejects(h.executor.execute('mcp__custom__read_notes', {}, live), /inactive_source/);
    assert.equal(calls, 0); h.finish();
  } finally { await h.registry.close(); }
});
check('contract', 'Custom MCP credentials are redacted from observations and rejected when exposed during discovery', async () => {
  const h = await mcpHarness({ action: 'collect', fetcher: rpc({ onCall: () => ({ echoed: 'custom-fixture-secret' }) }) });
  try { const result = await h.executor.execute('mcp__custom__read_notes', {}, live); assert.ok(!JSON.stringify(result).includes('custom-fixture-secret')); h.finish(); } finally { await h.registry.close(); }
  const source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'auto', url: endpoint, tokenEnv: 'MY_AUTH' }), process.cwd(), { MY_AUTH: 'custom-fixture-secret' }, rpc({ tools: [{ ...remoteTool, description: 'custom-fixture-secret' }] }));
  await assert.rejects(source.listTools(live), /discovery_contains_credentials/); await source.close();
});
check('contract', 'Custom MCP missing credentials fail before any connection and direct dispatch needs executor context', async () => {
  let calls = 0;
  const source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'auto', url: endpoint, tokenEnv: 'MY_AUTH' }), process.cwd(), {}, async () => { calls++; return new Response(); });
  await assert.rejects(source.listTools(live), /missing_environment:MY_AUTH/);
  await assert.rejects(source.callTool('read.notes', {}, live), /executor_context_required/); assert.equal(calls, 0); await source.close();
});
check('contract', 'Cancelled custom MCP calls cannot append late results or provider events', async () => {
  const pending = deferred<unknown>(), entered = deferred<void>(), controller = new AbortController();
  const h = await mcpHarness({ action: 'collect', fetcher: rpc({ onCall: async () => { entered.resolve(); return pending.promise; } }) });
  try {
    const running = h.executor.execute('mcp__custom__read_notes', {}, controller.signal); await entered.promise; controller.abort(new Error('cancelled'));
    await assert.rejects(running); const events = h.finish(); pending.resolve({ late: 'ignored' }); await waitTick();
    assert.deepEqual(h.data.lines(h.trace.key), events); assert.equal(h.data.executions()[0].state, 'cancelled');
  } finally { await h.registry.close(); }
});
check('integration', 'User stdio MCP discovers actual tools, maps only requested env and preserves retrieval fixture provenance', async () => {
  const config = UserMcpSchema.parse({ ...json<Record<string, unknown>>('examples/mcp-custom.json'), command: process.execPath, args: ['--experimental-transform-types', resolve('examples/user-mcp-server.ts')], env: { CUSTOM_SERVER_SECRET: 'MY_AUTH' } });
  const source = new UserMcpSource(config, process.cwd(), { MY_AUTH: 'mapped-custom-secret', API_KEY: 'host-model-key' });
  const data = store(), registry = new ToolRegistry(), value = { ...task(), allowedSources: ['custom'] }, trace = new Trace(data, value.taskId, 'stdio-user-mcp');
  try {
    await registry.register('custom', 'mcp', source, live); trace.emit('run_started', { task: value, toolPipeline: 'pre-tool-use-v1' });
    const executor = new ToolExecutor(registry, new ActionPolicy(), new ApprovalManager(), data, trace, value);
    const result = await executor.execute('mcp__custom__get_release', { query: 'Node.js' }, live) as any;
    assert.equal(result.provenance, 'fixture'); assert.equal(result.signals[0].sourceSlug, 'custom'); trace.emit('run_completed'); assert.deepEqual(validateTrace(data.lines(trace.key)), []);
  } finally { await registry.close(); }
  const raw = new UserMcpSource({ ...config, resultFormat: 'raw' }, process.cwd(), { MY_AUTH: 'mapped-custom-secret', API_KEY: 'host-model-key' });
  try {
    await raw.listTools(live);
    const result = await raw.callTool('inspect_environment', {}, live, { stage: async (_name, run) => run(), event: () => {} }) as any;
    const env = JSON.parse(result.result.content[0].text); assert.equal(env.mapped, '[REDACTED]'); assert.equal(env.hostModelKey, null);
  } finally { await raw.close(); }
});
check('contract', 'Skill parsing supports YAML folded strings and rejects missing/duplicate metadata and traversal names', () => {
  assert.equal(parseSkill(skillText).description, 'A folded description for tests.');
  for (const value of ['No metadata', skillText.replace('sample-skill', '../escape'), skillText.replace('name: sample-skill', 'name: sample-skill\nname: again'), skillText.replace('description: >\n  A folded description\n  for tests.', 'description: []')]) assert.throws(() => parseSkill(value));
});
check('integration', 'Local Skill install snapshots resources, filters credentials and never executes packaged scripts', () => {
  const data = store(), original = data.path('package'); mkdirSync(join(original, 'references'), { recursive: true }); mkdirSync(join(original, 'scripts'));
  writeFileSync(join(original, 'SKILL.md'), skillText); writeFileSync(join(original, 'references', 'guide.md'), '0123456789');
  writeFileSync(join(original, '.env'), 'should-not-copy');
  writeFileSync(join(original, 'scripts', 'install.ts'), 'throw new Error("must not execute");');
  const skills = new SkillStore(data.root), installed = skills.installDirectory(original), bundle = skills.select(['sample-skill']);
  assert.equal(installed.files.length, 3); assert.equal(existsSync(skills.files.path('skills/sample-skill/.env')), false);
  assert.equal(bundle.readResource('sample-skill', 'references/guide.md', 3, 4).text, '3456');
  assert.throws(() => skills.installDirectory(original), /already_installed/);
  skills.change('sample-skill', false); assert.throws(() => skills.select(['sample-skill']), /disabled/);
  assert.equal(skills.select(['sample-skill'], true).documents.length, 1);
  skills.change('sample-skill', true); assert.equal(skills.select(['sample-skill']).documents.length, 1);
  skills.change('sample-skill', 'remove'); assert.deepEqual(skills.list(), []); assert.equal(readFileSync(join(original, 'SKILL.md'), 'utf8'), skillText);
});
check('contract', 'Skill reads reject traversal, non-selected skills and changed files', () => {
  const data = store(), skills = new SkillStore(data.root); skills.installDirectory(sampleSkill);
  const bundle = skills.select(['competitor-review']);
  for (const path of ['../SKILL.md', '/etc/passwd', 'references/../../secret', 'C:/secret', '.cwatch-install.json']) assert.throws(() => bundle.readResource('competitor-review', path, 0, 100));
  assert.throws(() => bundle.readResource('other-skill', 'SKILL.md', 0, 100), /not_selected/);
  writeFileSync(skills.files.path('skills/competitor-review/references/checklist.md'), 'modified');
  assert.throws(() => bundle.readResource('competitor-review', 'references/checklist.md', 0, 100), /skill_changed/);
});
check('contract', 'Managed configuration and skill resources refuse directory symlinks and recursive deletion outside their roots', () => {
  const data = store(), outside = store(), files = new ManagedWorkspace(data.root);
  mkdirSync(files.path(), { recursive: true }); symlinkSync(outside.root, files.path('skills'), 'junction');
  assert.throws(() => new SkillStore(data.root).list(), /symlink/);
  assert.throws(() => files.removeTree('../outside'), /delete_target_invalid/);
  const packageDir = outside.path('package'); mkdirSync(packageDir); writeFileSync(join(packageDir, 'SKILL.md'), skillText);
  symlinkSync(data.root, join(packageDir, 'linked'), 'junction');
  const target = new SkillStore(store().root); assert.throws(() => target.installDirectory(packageDir), /symlink/);
  assert.deepEqual(target.list(), []);
});
check('contract', 'Failed GitHub Skill installs clean staging and never leave a partially installed skill', async () => {
  const skills = new SkillStore(store().root);
  await assert.rejects(skills.installGithub({ repo: 'owner/repo', path: 'skills/test', ref: 'main' }, live, async () => { throw new Error('fixture network failure'); }), /fixture network failure/);
  assert.deepEqual(skills.list(), []); assert.deepEqual(readdirSync(skills.files.path('tmp')), []);
});
check('integration', 'GitHub Skill installer reads pinned Git blobs without checkout or executing code', async () => {
  const skills = new SkillStore(store().root), contents = [Buffer.from(skillText), Buffer.from('Git resource')], ids = ['a'.repeat(40), 'b'.repeat(40)], commit = 'c'.repeat(40);
  const calls: string[][] = [];
  const git: GitRunner = async args => {
    calls.push(args);
    if (args[0] === 'clone') { assert.ok(args.includes('--no-checkout')); return Buffer.alloc(0); }
    if (args[0] === 'rev-parse') return Buffer.from(commit + '\n');
    if (args[0] === 'ls-tree') return Buffer.from(contents.map((content, index) => '100644 blob ' + ids[index] + ' ' + content.length + '\tskills/test/' + (index ? 'references/guide.md' : 'SKILL.md') + '\0').join(''));
    if (args[0] === 'cat-file') return contents[ids.indexOf(args[2])];
    throw new Error('unexpected Git command');
  };
  const installed = await skills.installGithub(githubSkill('https://github.com/owner/repo/tree/main/skills/test'), live, git);
  assert.equal(installed.origin.kind, 'github'); assert.equal((installed.origin as any).commit, commit);
  assert.equal(skills.select(['sample-skill']).readResource('sample-skill', 'references/guide.md', 0, 100).text, 'Git resource');
  assert.ok(!calls.some(args => ['checkout', 'run', 'submodule'].includes(args[0])));
});
check('contract', 'GitHub Skill source parser rejects credential URLs, traversal and option injection', () => {
  for (const source of ['https://evil.example/o/r/tree/main/skill', 'https://user:pass@github.com/o/r/tree/main/skill', 'https://github.com/o/r/tree/main/skill?token=secret']) assert.throws(() => githubSkill(source));
  for (const path of ['../secret', 'skills/../../secret', '-outside', 'skills/*']) assert.throws(() => githubSkill('owner/repo', path));
  assert.throws(() => githubSkill('owner/repo', 'skill', '--upload-pack=bad'));
});
check('integration', 'CLI installs and selects a Skill during replay without changing the investigation tool vocabulary', async () => {
  const data = store(), workspace = store().root;
  const cli = async (args: string[]) => JSON.parse((await exec(process.execPath, ['--experimental-transform-types', "apps/cli/src/index.ts", ...args, '--workspace', workspace], { cwd: process.cwd(), timeout: 30_000 })).stdout);
  assert.equal((await cli(['skills', 'install', sampleSkill])).installed, 'competitor-review');
  assert.equal((await cli(['skills', 'list'])).length, 1);
  const result = await cli(['run', '--mode', 'replay', '--task', 'examples/task.json', '--skills', 'competitor-review', '--out', data.root]);
  assert.equal(result.status, 'complete', result.error);
  const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
  assert.equal((events.find(event => event.type === 'skills_loaded')!.data.skills as any[])[0].name, 'competitor-review');
  assert.deepEqual(validateTrace(events), []);
});
check('integration', 'Installed Skill resource reads enter ToolExecutor and known credentials never reach model context', async () => {
  const data = store(), skills = new SkillStore(data.root); skills.installDirectory(sampleSkill);
  const bundle = skills.select(['competitor-review']); bundle.documents[0].body += '\nfixture-hidden-credential';
  const registry = new ToolRegistry(), source = new UserMcpSource(UserMcpSchema.parse({ ...json<Record<string, unknown>>('examples/mcp-custom.json'), command: process.execPath, args: ['--experimental-transform-types', resolve('examples/user-mcp-server.ts')] }), process.cwd());
  await registry.register('custom', 'mcp', source, live);
  const value = { ...task(), allowedSources: ['custom'] }, steps = [
    { kind: 'call_tool', name: 'session__read_skill_resource', args: { skill: 'competitor-review', path: 'references/checklist.md' } },
    { kind: 'call_tool', name: 'workflow__save_plan', args: { ...json('fixtures/model-script.json')[0].args, sources: ['custom'] } },
    { kind: 'call_tool', name: 'mcp__custom__inspect_environment', args: {} },
    { kind: 'call_tool', name: 'mcp__custom__get_release', args: { query: 'Node.js' } },
    { kind: 'call_tool', name: 'workflow__analyze', args: {} }, { kind: 'call_tool', name: 'workflow__review', args: {} },
    { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Review complete.', claimIds: '$analyzed_claim_ids' } }, { kind: 'respond', text: 'Saved.' },
  ];
  const replay = new ReplayModel(steps), decide = replay.decide.bind(replay);
  replay.decide = (input, signal) => { assert.ok(input.stable.includes('USER SKILL: competitor-review')); assert.ok(!input.stable.includes('fixture-hidden-credential')); return decide(input, signal); };
  try {
    const result = await runInvestigation(value, replay, registry, data, 'live', { userSkills: bundle, secrets: ['fixture-hidden-credential'] });
    assert.equal(result.status, 'complete', result.error);
    assert.ok(data.executions().some(record => record.toolBinding.proxy_name === 'session__read_skill_resource' && record.execute_count === 1));
    assert.deepEqual(validateTrace(data.lines('traces/' + result.runId + '.jsonl'), ['fixture-hidden-credential']), []);
  } finally { await registry.close(); }
});


function sseProtocol(crossOrigin = false) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined, closed = false;
  const encoder = new TextEncoder(), regular = rpc(), requests: string[] = [];
  const fetcher: typeof fetch = async (target, init) => {
    const url = String(target); requests.push(url);
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(encoder.encode('event: endpoint\ndata: ' + (crossOrigin ? 'https://outside.example/messages' : 'https://custom-mcp.example/messages') + '\n\n')); }, cancel() { closed = true; } });
      init?.signal?.addEventListener('abort', () => { if (!closed) { closed = true; try { controller?.close(); } catch {} } }, { once: true });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url === endpoint) return new Response(null, { status: 405 });
    const response = await regular(target, init);
    if (response.status === 202 || response.status === 204) return response;
    const result = await response.json();
    queueMicrotask(() => { if (!closed) controller!.enqueue(encoder.encode('event: message\ndata: ' + JSON.stringify(result) + '\n\n')); });
    return new Response(null, { status: 202 });
  };
  return { fetcher, requests };
}
check('integration', 'User MCP automatically negotiates legacy SSE after HTTP 405', async () => {
  const fixture = sseProtocol(), source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'auto', url: endpoint, tokenEnv: 'MY_AUTH' }), process.cwd(), { MY_AUTH: 'custom-fixture-secret' }, fixture.fetcher);
  try { assert.equal((await source.listTools(live))[0].name, 'read.notes'); assert.ok(fixture.requests.some(url => url.endsWith('/messages'))); }
  finally { await source.close(); }
});
check('contract', 'User SSE endpoint changes never send credentials to another origin', async () => {
  const fixture = sseProtocol(true), source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'sse', url: endpoint, tokenEnv: 'MY_AUTH' }), process.cwd(), { MY_AUTH: 'custom-fixture-secret' }, fixture.fetcher);
  try { await assert.rejects(source.listTools(live)); assert.ok(fixture.requests.every(url => url.startsWith('https://custom-mcp.example/'))); }
  finally { await source.close(); }
});
for (const status of [401, 429]) check('contract', 'User MCP HTTP ' + status + ' is explicit and never falls back to another transport', async () => {
  let requests = 0;
  const source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'auto', url: endpoint }), process.cwd(), {}, async () => { requests++; return new Response('do not print credentials', { status }); });
  await assert.rejects(source.listTools(live), new RegExp('mcp_HTTP_' + status)); assert.equal(requests, 1); await source.close();
});
check('contract', 'Single-skill GitHub repository roots and explicit branch names are supported', () => {
  assert.deepEqual(githubSkill('https://github.com/owner/single-skill'), { repo: 'owner/single-skill', path: '.', ref: 'main' });
  assert.deepEqual(githubSkill('owner/repo', '.', 'feature/review'), { repo: 'owner/repo', path: '.', ref: 'feature/review' });
});
check('integration', 'CLI user MCP plus installed Skill runs through a real Pi child process with audited resource and remote tool calls', async () => {
  const workspace = store(), output = store(), value = { ...task(), allowedSources: ['custom'] };
  workspace.write('task.json', value); workspace.write('sources.json', []);
  let remoteCalls = 0, protocol: typeof fetch;
  const errors: unknown[] = [], histories: any[] = [];
  const remote = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await protocol('http://127.0.0.1/', { method: req.method, headers: { authorization: String(req.headers.authorization ?? '') }, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch (error) { errors.push(error); res.writeHead(500); res.end('fixture failure'); }
  });
  const steps: any[] = [
    { kind: 'call_tool', name: 'session__read_skill_resource', args: { skill: 'competitor-review', path: 'references/checklist.md' } },
    { kind: 'call_tool', name: 'workflow__save_plan', args: { ...json('fixtures/model-script.json')[0].args, sources: ['custom'] } },
    { kind: 'call_tool', name: 'mcp__custom__get_release', args: { query: 'Node.js' } },
    { kind: 'call_tool', name: 'workflow__analyze', args: {} }, { kind: 'call_tool', name: 'workflow__review', args: {} },
    { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Fixture review complete.', claimIds: '$analyzed_claim_ids' } },
    { kind: 'respond', text: 'Saved.' },
  ];
  const model = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture-extension-model-key');
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')); histories.push(request); const index = histories.length;
      assert.ok(JSON.stringify(request).includes('USER SKILL: competitor-review')); assert.ok(!JSON.stringify(request).includes('fixture-extension-mcp-secret'));
      const step = structuredClone(steps[index - 1]); if (!step) throw new Error('extra model request');
      if (step.args?.claimIds === '$analyzed_claim_ids') {
        const analyze = request.messages.flatMap((message: any) => message.tool_calls ?? []).find((call: any) => call.function.name === 'workflow__analyze');
        step.args.claimIds = JSON.parse(request.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === analyze.id).content).claims.map((claim: any) => claim.id);
      }
      const delta = step.kind === 'call_tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'extensions-call-' + index, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { role: 'assistant', content: step.text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'extensions-' + index, object: 'chat.completion.chunk', created: 1, model: 'fixture-extensions', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'extensions-' + index, object: 'chat.completion.chunk', created: 1, model: 'fixture-extensions', choices: [{ index: 0, delta: {}, finish_reason: step.kind === 'call_tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end('fixture model failure'); }
  });
  remote.listen(0, '127.0.0.1'); model.listen(0, '127.0.0.1'); await Promise.all([once(remote, 'listening'), once(model, 'listening')]);
  const remoteAddress = remote.address(), modelAddress = model.address(); assert.ok(remoteAddress && typeof remoteAddress !== 'string' && modelAddress && typeof modelAddress !== 'string');
  const data = fixture(); data.signals.forEach(signal => { signal.sourceSlug = 'custom'; });
  protocol = rpc({ tools: [{ name: 'get_release', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }], auth: 'Bearer fixture-extension-mcp-secret', onCall: () => { remoteCalls++; return data; } });
  const env = { ...process.env, MODEL_PROVIDER: 'fixture-extensions', MODEL_ID: 'fixture-extensions', API_KEY: 'fixture-extension-model-key', BASE_URL: 'http://127.0.0.1:' + modelAddress.port + '/v1', CUSTOM_AUTH: 'fixture-extension-mcp-secret', NO_PROXY: '127.0.0.1,localhost' };
  const cli = async (args: string[]) => JSON.parse((await exec(process.execPath, ['--experimental-transform-types', "apps/cli/src/index.ts", ...args, '--workspace', workspace.root], { cwd: process.cwd(), env, timeout: 45_000, maxBuffer: 2_000_000 })).stdout);
  try {
    await cli(['mcp', 'add', 'custom', '--url', 'http://127.0.0.1:' + remoteAddress.port + '/mcp', '--token-env', 'CUSTOM_AUTH', '--action', 'collect', '--result-format', 'retrieval']);
    assert.equal((await cli(['mcp', 'list'])).length, 1);
    const discovery = await cli(['mcp', 'test', 'custom']); assert.equal(discovery.tools[0].name, 'get_release'); assert.equal(remoteCalls, 0);
    await cli(['skills', 'install', sampleSkill]);
    const result = await cli(['run', '--mode', 'live', '--task', workspace.path('task.json'), '--sources', workspace.path('sources.json'), '--out', output.root, '--mcp', 'custom', '--skills', 'competitor-review', '--timeout', '30000']);
    assert.equal(result.status, 'complete', result.error); assert.equal(histories.length, 7); assert.equal(remoteCalls, 1); assert.deepEqual(errors, []);
    const events = output.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.deepEqual(validateTrace(events, ['fixture-extension-model-key', 'fixture-extension-mcp-secret']), []);
    assert.ok(events.some(event => event.type === 'agent_process' && event.data.state === 'ready' && event.data.pid !== process.pid));
    assert.equal(events.filter(event => event.type === 'pre_tool_use_request').length, 6);
    assert.ok(output.executions().some(record => record.toolBinding.proxy_name === 'session__read_skill_resource' && record.execute_count === 1));
    assert.ok(output.executions().some(record => record.toolBinding.proxy_name === 'mcp__custom__get_release' && record.execute_count === 1));
    await cli(['mcp', 'disable', 'custom']); await assert.rejects(cli(['mcp', 'test', 'custom']), /mcp_disabled/);
    await cli(['mcp', 'remove', 'custom']); assert.deepEqual(await cli(['mcp', 'list']), []);
  } finally {
    remote.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => remote.close(() => resolve())), new Promise<void>(resolve => model.close(() => resolve()))]);
  }
});


check('semantic', 'Successful arbitrary MCP results stay unstructured gaps instead of being promoted to competitor facts', async () => {
  const h = await mcpHarness({ action: 'collect', fetcher: rpc({ onCall: () => ({ note: 'A claim without a structured signal or a verified publication time.' }) }) });
  // This harness is only for registration; the investigation owns a separate Trace.
  const value = { ...task(), allowedSources: ['custom'] }, data = store();
  const steps = [
    { kind: 'call_tool', name: 'workflow__save_plan', args: { ...json('fixtures/model-script.json')[0].args, sources: ['custom'] } },
    { kind: 'call_tool', name: 'mcp__custom__read_notes', args: {} },
    { kind: 'call_tool', name: 'workflow__analyze', args: {} }, { kind: 'call_tool', name: 'workflow__review', args: {} },
    { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Evidence remains unverified.', claimIds: '$analyzed_claim_ids' } }, { kind: 'respond', text: 'Saved.' },
  ];
  try {
    const result = await runInvestigation(value, new ReplayModel(steps), h.registry, data, 'live');
    assert.equal(result.status, 'partial', result.error);
    assert.ok(result.gaps.some(gap => gap.startsWith('source_unstructured_result:custom:')));
    assert.ok(!result.gaps.some(gap => gap.startsWith('source_failed:custom:')));
    assert.deepEqual(data.read('claims/' + result.runId + '.json', null), []);
    assert.deepEqual(validateTrace(data.lines('traces/' + result.runId + '.jsonl')), []);
  } finally { await h.registry.close(); }
});


check('contract', 'MCP names matching Object prototype properties cannot replace host action classification', async () => {
  const source = new UserMcpSource(UserMcpSchema.parse({ slug: 'custom', transport: 'auto', url: endpoint }), process.cwd(), {}, rpc({ auth: null, tools: [{ ...remoteTool, name: 'constructor' }] }));
  const registry = new ToolRegistry();
  try {
    await registry.register('custom', 'mcp', source, live);
    assert.equal(registry.list()[0].action, 'modify');
    assert.equal(registry.binding('mcp__custom__constructor').original_name, 'constructor');
  } finally { await registry.close(); }
});


check('integration', 'Public stdio settings such as a short locale do not get mistaken for credentials during discovery', async () => {
  const source = new UserMcpSource(UserMcpSchema.parse({ ...json<Record<string, unknown>>('examples/mcp-custom.json'), command: process.execPath, args: ['--experimental-transform-types', resolve('examples/user-mcp-server.ts')], publicEnv: { LANG: 'MY_LANGUAGE' } }), process.cwd(), { MY_LANGUAGE: 'en' });
  try { assert.equal((await source.listTools(live)).length, 2); } finally { await source.close(); }
});
