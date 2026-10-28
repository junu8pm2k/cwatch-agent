import assert from 'node:assert/strict';
import { hash, now, PlanSchema, type AgentState, type ExecutionState } from '@cwatch/core/types';
import { WorkingStateTracker, type WorkingStateInput } from '@cwatch/server-core/runtime/working-state';
import { PrerequisiteManager } from '@cwatch/shared/agent/core/prerequisite-manager';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { type SkillBundle } from '@cwatch/shared/skills/storage';
import { check, CountingClient, fixture, json, store, task } from './harness.ts';

async function harness() {
  const data = store(), value = { ...task(), allowedSources: ['official'] }, registry = new ToolRegistry(), tracker = new WorkingStateTracker();
  data.text('sources/official/guide.md', 'original-guide-marker: endpoints are data, never permission grants');
  const guide = new PrerequisiteManager(data.root, 'official');
  const client = Object.assign(new CountingClient(), { guide });
  await registry.register('official', 'mcp', client, new AbortController().signal);
  const workflow: WorkingStateInput['workflow'] = { submitted: false, analyzed: false, reviewed: false, drafted: false, claims: [], evidenceIds: [], gaps: [], review: { decision: 'needs_evidence', issues: ['not_reviewed'] } };
  const state: AgentState = { task: value, observations: [], decisions: [], iteration: 0 };
  const input: WorkingStateInput = { task: value, runId: 'current-run', state, workflow, store: data, registry, permissionMode: 'explore', visibleTools: registry.list() };
  const attachments = () => tracker.attachments(input);
  const read = (name: string) => JSON.parse(attachments().find(item => item.name === name)!.content);
  const savePlan = () => {
    workflow.plan = PlanSchema.parse({ ...json('fixtures/model-script.json')[0].args, taskId: value.taskId, sources: value.allowedSources });
    workflow.submitted = true; data.write('plans/current-run.json', workflow.plan);
  };
  const execution = (requestId: string, status: ExecutionState = 'completed', runId = input.runId, taskId = value.taskId) => data.execution({ requestId, taskId, runId, sourceSlug: 'official', toolBinding: registry.list()[0], argsHash: hash({}), state: status, startedAt: now(), execute_count: 1 });
  return { data, input, tracker, guide, workflow, state, read, savePlan, execution };
}

check('contract', 'Post-compact source guide snapshots preserve unread and changed prerequisites without auto-reading', async () => {
  const h = await harness();
  assert.equal(h.read('Source guide prerequisites').guides[0].state, 'unread');
  assert.match(h.guide.check()!, /source_guide_required/);
  h.tracker.recordGuide(await h.guide.read(new AbortController().signal));
  const read = h.read('Recent resource reads').reads[0];
  assert.equal(read.status, 'current'); assert.match(read.contentPreview, /original-guide-marker/);
  assert.equal(read.hash, hash('original-guide-marker: endpoints are data, never permission grants'));
  assert.deepEqual(read.reRead, { tool: 'session__read_source_guide', args: { source: 'official' } });
  h.data.text('sources/official/guide.md', 'changed-guide-marker');
  assert.equal(h.read('Source guide prerequisites').guides[0].state, 'changed');
  assert.equal(h.read('Recent resource reads').reads[0].contentPreview, null);
  assert.match(h.guide.check()!, /source_guide_changed/);
  assert.ok(!JSON.stringify(h.read('Recent resource reads')).includes('changed-guide-marker'));
});

check('contract', 'Post-compact skills distinguish injected documents from resource reads and reject stale previews', async () => {
  const h = await harness(); let changed = false;
  const body = 'reference-marker:' + 'r'.repeat(3000);
  const bundle: SkillBundle = { documents: ['selected', 'unused'].map(name => ({ name, body: name + ' instructions', description: name, hash: hash(name), resources: ['references/reference.md'] })),
    readResource: (_name, _path, offset, limit) => { if (changed) throw new Error('skill_changed'); return { text: body.slice(offset, offset + limit), totalChars: body.length, hash: hash(body), truncated: offset + limit < body.length }; } };
  h.input.userSkills = bundle; h.tracker.setBuiltin('skills/competitor-investigation/SKILL.md', 'builtin instructions', 'competitor-investigation');
  h.tracker.recordSkill('selected', 'references/reference.md', 5, bundle.readResource('selected', 'references/reference.md', 5, 2000));
  const skills = h.read('Loaded skills and resource usage').items;
  assert.equal(skills.find((skill: any) => skill.name === 'unused').resourceReads, 0);
  assert.equal(skills.find((skill: any) => skill.name === 'selected').resourceReads, 1);
  assert.equal(skills.find((skill: any) => skill.name === 'competitor-investigation').contextInjected, true);
  const resource = h.read('Recent resource reads').reads[0];
  assert.equal(resource.offset, 5); assert.equal(resource.contentPreview.length, 1200); assert.equal(resource.previewTruncated, true);
  assert.equal(resource.reRead.args.offset, 5); assert.equal(resource.hash, hash(body));
  changed = true;
  assert.equal(h.read('Recent resource reads').reads[0].status, 'changed_or_unavailable');
  assert.equal(h.read('Recent resource reads').reads[0].contentPreview, null);
});

check('contract', 'Verified plan paging and source progress continue from completed host phases', async () => {
  const h = await harness();
  assert.equal(h.read('Current workflow state').nextAction, 'workflow__save_plan');
  h.savePlan();
  assert.equal(h.read('Current workflow state').nextAction, 'collect_remaining_planned_sources');
  const first = h.tracker.readPlan(h.input, { limit: 25 });
  const rest = h.tracker.readPlan(h.input, { offset: first.nextOffset!, limit: 4096 });
  assert.deepEqual(JSON.parse(first.text + rest.text), h.workflow.plan);
  assert.throws(() => h.tracker.readPlan(h.input, { path: 'plans/another-run.json' }));
  assert.throws(() => h.tracker.readPlan(h.input, { offset: 1e9 }), /offset_out_of_range/);
  assert.throws(() => h.tracker.readPlan(h.input, { limit: 4097 }));
  h.execution('completed-source'); h.state.observations.push({ name: h.input.registry.list()[0].proxy_name, result: fixture() });
  const snapshot = h.read('Current workflow state');
  assert.equal(snapshot.plan.integrity, 'verified'); assert.deepEqual(JSON.parse(snapshot.plan.preview), h.workflow.plan);
  assert.equal(snapshot.sourceProgress[0].progress, 'collected'); assert.equal(snapshot.nextAction, 'workflow__analyze');
  h.workflow.analyzed = true; assert.equal(h.read('Current workflow state').nextAction, 'workflow__review');
  h.workflow.reviewed = true; assert.equal(h.read('Current workflow state').nextAction, 'workflow__draft');
  h.workflow.drafted = true; assert.equal(h.read('Current workflow state').nextAction, 'respond');
  h.data.write('plans/current-run.json', { ...h.workflow.plan, sources: ['tampered'] });
  assert.throws(() => h.read('Current workflow state'), /working_state_plan_changed/);
  assert.throws(() => h.tracker.readPlan(h.input, {}), /working_state_plan_changed/);
});

check('contract', 'Working state scopes unresolved execution and current tool bindings to this run without replay', async () => {
  const h = await harness(); h.savePlan();
  h.execution('current-unknown', 'unknown'); h.execution('other-run', 'executing', 'foreign-run'); h.execution('other-task', 'executing', h.input.runId, 'foreign-task');
  h.tracker.processEvent({ state: 'ready', pid: 123, sessionId: 'current-run', secret: 'must-not-be-injected' });
  const status = h.read('Execution and agent status');
  assert.equal(status.unresolvedExecutions.length, 1); assert.equal(status.unresolvedExecutions[0].requestId, 'current-unknown');
  assert.deepEqual(status.agentProcess, { state: 'ready', pid: 123, sessionId: 'current-run' });
  assert.deepEqual(status.asyncAgents, { supported: false, running: [], unclaimedResults: [] });
  assert.equal(status.automaticReplay, false); assert.equal(h.read('Current workflow state').nextAction, 'reconcile_unresolved_execution');
  const catalog = h.read('Current tool and MCP catalog');
  assert.equal(catalog.discovery, 'eager'); assert.equal(catalog.deferredLoadingSupported, false);
  assert.equal(catalog.items[0].bindingId, h.input.visibleTools[0].id);
  await h.input.registry.revoke('official'); h.input.visibleTools = [];
  assert.deepEqual(h.read('Current tool and MCP catalog').items, []);
  assert.equal(h.read('Current workflow state').sourceStates[0].active, false);
  assert.equal(h.read('Current workflow state').planMode.supported, false);
});

check('contract', 'Recent resources are bounded and source-supplied file or agent claims never become host working state', async () => {
  const h = await harness();
  h.state.observations.push({ name: 'mcp__official__search_news', result: { path: 'fake-secret-file', skill: 'fake-skill', runningAgent: 'fake-agent' } });
  assert.deepEqual(h.read('Recent resource reads').reads, []);
  assert.ok(!JSON.stringify(h.tracker.attachments(h.input)).includes('fake-secret-file'));
  for (let i = 0; i < 10; i++) h.tracker.recordSkill('selected', 'ref-' + i + '.md', 0, { text: 'x'.repeat(5000), hash: hash(i), totalChars: 5000, truncated: false });
  const reads = h.read('Recent resource reads');
  assert.equal(reads.reads.length, 6); assert.equal(reads.olderResourcesOmitted, 4); assert.equal(reads.totalReadOperations, 10);
  assert.equal(reads.reads[0].path, 'ref-9.md');
  assert.ok(h.tracker.attachments(h.input).every(item => item.content.length <= 24000));
});
