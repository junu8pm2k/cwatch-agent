import { z } from 'zod';
import { hash, now, PlanSchema, RetrievalSchema, type AgentState, type AgentTask, type Plan, type SourceGuide, type ToolBinding } from '@cwatch/core/types';
import { type CompactAttachment } from '@cwatch/core/types/compaction';
import { type FileStore } from '@cwatch/shared/sessions/storage';
import { type SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { ReadTranscriptSchema } from '@cwatch/shared/sessions/transcript';
import { type ToolRegistry } from '@cwatch/shared/tools/registry';
import { type SkillBundle } from '@cwatch/shared/skills/storage';

export const ReadPlanSchema = z.object({ offset: z.number().int().safe().nonnegative().default(0), limit: z.number().int().min(1).max(4096).default(1024) }).strict();
export interface WorkflowCheckpoint {
  plan?: Plan; submitted: boolean; analyzed: boolean; reviewed: boolean; drafted: boolean;
  claims: Array<{ id: string }>; evidenceIds: string[]; report?: string; gaps: string[];
  review: { decision: string; issues: string[] };
  reworkCount?: number; reworkAvailable?: boolean;
  canReworkCollect?(): boolean;
}
interface ResourceRead {
  kind: 'source_guide' | 'skill_resource' | 'tool_result' | 'plan' | 'transcript'; path?: string; sourceSlug?: string; skill?: string;
  hash: string; offset: number; readChars: number; totalChars: number; text: string;
  reRead: { tool: string; args: Record<string, unknown> }; sequence: number;
}
export interface WorkingStateInput {
  task: AgentTask; runId: string; state: AgentState; workflow?: WorkflowCheckpoint;
  store: FileStore; registry: ToolRegistry; permissionMode: string; visibleTools: ToolBinding[];
  userSkills?: SkillBundle; transcript?: SessionTranscript;
}
function verifiedPlan(store: FileStore, runId: string, plan: Plan | undefined, submitted: boolean) {
  if (!submitted || !plan) throw new Error('plan_required');
  const path = 'plans/' + runId + '.json';
  let saved: Plan;
  try { saved = PlanSchema.parse(store.read(path, null)); } catch { throw new Error('working_state_plan_unavailable'); }
  if (hash(saved) !== hash(plan)) throw new Error('working_state_plan_changed');
  return { path, hash: hash(plan), text: JSON.stringify(plan) };
}
/** No network calls or discovery: split metadata into bounded attachments without dropping rows. */
function catalogAttachments(name: string, header: Record<string, unknown>, rows: unknown[]): CompactAttachment[] {
  const groups: unknown[][] = [[]];
  for (const row of rows) {
    const group = groups.at(-1)!;
    if (JSON.stringify({ ...header, items: [...group, row] }).length > 18_000 && group.length) groups.push([row]); else group.push(row);
  }
  return groups.map((items, index) => ({ name: name + (groups.length > 1 ? ' ' + (index + 1) + '/' + groups.length : ''), content: JSON.stringify({ ...header, items }) }));
}

/** Per-run host memory. Only successful, host-controlled read tools can record file/skill reads. */
export class WorkingStateTracker {
  constructor(private readonly clean: <T>(value: T) => T = value => value) {}
  private reads = new Map<string, ResourceRead>();
  private sequence = 0;
  private builtin?: { path: string; hash: string; name: string };
  private process?: { state: string; sessionId?: string; pid?: number };
  setBuiltin(path: string, body: string, name: string): void { this.builtin = { path, hash: hash(body), name }; }
  processEvent(event: Record<string, unknown>): void {
    this.process = { state: String(event.state), ...(typeof event.sessionId === 'string' ? { sessionId: event.sessionId } : {}), ...(typeof event.pid === 'number' ? { pid: event.pid } : {}) };
  }
  private record(value: Omit<ResourceRead, 'sequence'>): void {
    this.reads.set([value.kind, value.skill ?? '', value.path ?? JSON.stringify(value.reRead.args)].join(':'), { ...value, text: this.clean(value.text).slice(0, 1200), sequence: ++this.sequence });
  }
  recordGuide(guide: SourceGuide): void {
    this.record({ kind: 'source_guide', path: guide.path, sourceSlug: guide.sourceSlug, hash: guide.hash, offset: 0, readChars: guide.text.length, totalChars: guide.text.length, text: guide.text, reRead: { tool: 'session__read_source_guide', args: { source: guide.sourceSlug } } });
  }
  recordSkill(skill: string, path: string, offset: number, resource: ReturnType<SkillBundle['readResource']>): void {
    this.record({ kind: 'skill_resource', path, skill, hash: resource.hash, offset, readChars: resource.text.length, totalChars: resource.totalChars, text: resource.text, reRead: { tool: 'session__read_skill_resource', args: { skill, path, offset, limit: 1024 } } });
  }
  recordArchive(page: ReturnType<SessionTranscript['readToolResult']>): void {
    this.record({ kind: 'tool_result', hash: page.contentHash, offset: page.offset, readChars: page.content.length, totalChars: page.totalChars, text: page.content, reRead: { tool: 'session__read_tool_result', args: { entryId: page.entryId, toolCallId: page.toolCallId, offset: page.offset, limit: 1024 } } });
  }
  recordTranscript(page: ReturnType<SessionTranscript['readTranscript']>, args: unknown): void {
    const parsed = ReadTranscriptSchema.parse(args);
    this.record({ kind: 'transcript', path: page.path, hash: page.snapshotHash, offset: page.offset, readChars: page.content.length, totalChars: page.totalChars, text: page.content,
      reRead: { tool: 'session__read_transcript', args: { ...parsed, offset: page.offset, limit: 1024 } } });
  }
  readPlan(input: Pick<WorkingStateInput, 'store' | 'runId' | 'workflow'>, args: unknown) {
    if (!input.workflow) throw new Error('investigation_plan_unavailable');
    const { offset, limit } = ReadPlanSchema.parse(args), plan = verifiedPlan(input.store, input.runId, input.workflow.plan, input.workflow.submitted);
    plan.text = JSON.stringify(this.clean(input.workflow.plan));
    if (offset > plan.text.length) throw new Error('plan_offset_out_of_range');
    const text = plan.text.slice(offset, offset + limit), end = offset + text.length;
    this.record({ kind: 'plan', path: plan.path, hash: plan.hash, offset, readChars: text.length, totalChars: plan.text.length, text, reRead: { tool: 'workflow__read_plan', args: { offset, limit: 1024 } } });
    return { path: plan.path, hash: plan.hash, offset, text, totalChars: plan.text.length, nextOffset: end < plan.text.length ? end : null };
  }
  attachments(input: WorkingStateInput): CompactAttachment[] {
    const { task, runId, state, workflow, store, registry, permissionMode, visibleTools, userSkills, transcript } = input;
    const guideStates = registry.sourceGuideStates(task);
    const executions = store.executions().filter(record => record.runId === runId && record.taskId === task.taskId);
    const sourcesByTool = new Map(executions.filter(record => record.toolBinding.action === 'collect').map(record => [record.toolBinding.proxy_name, record.sourceSlug]));
    const sourceProgress = (workflow?.plan?.sources ?? task.allowedSources).map(source => {
      const records = executions.filter(record => record.sourceSlug === source && record.toolBinding.action === 'collect');
      const statuses = state.observations.filter(observation => sourcesByTool.get(observation.name) === source).map(observation => {
        const parsed = RetrievalSchema.safeParse(observation.result);
        if (parsed.success && parsed.data.signals.every(signal => signal.sourceSlug === source)) return parsed.data.status;
        const generic = observation.result as { kind?: string; isError?: boolean } | null;
        return generic?.kind === 'mcp_tool_result' && generic.isError === false ? 'unstructured' : 'tool_failed';
      });
      const pending = records.some(record => ['awaiting_permission', 'executing', 'unknown'].includes(record.state));
      return { source, active: registry.active(source), attempts: records.filter(record => record.execute_count > 0).length, resultStatuses: statuses,
        progress: pending ? 'unresolved' : statuses.includes('success_with_data') ? 'collected' : statuses.some(status => ['success_empty', 'unstructured'].includes(status)) ? 'attempted_with_gaps' : statuses.length ? 'failed' : 'not_started' };
    });
    const unresolved = executions.filter(record => ['awaiting_permission', 'executing', 'unknown'].includes(record.state));
    const reworkCount = workflow?.reworkCount ?? 0;
    const reworkAvailable = workflow?.canReworkCollect ? workflow.canReworkCollect() : Boolean(workflow?.reworkAvailable);
    const nextAction = unresolved.length ? 'reconcile_unresolved_execution' : !workflow ? 'continue_task_using_selected_skills' : !workflow.submitted ? 'workflow__save_plan' : !workflow?.analyzed && sourceProgress.some(source => source.progress === 'not_started' && source.active) ? 'collect_remaining_planned_sources' : !workflow?.analyzed ? 'workflow__analyze' : !workflow?.reviewed ? 'workflow__review' : reworkAvailable ? 'rework_collect_or_workflow__draft' : !workflow?.drafted ? 'workflow__draft' : 'respond';
    const plan = workflow?.submitted ? verifiedPlan(store, runId, workflow?.plan, true) : undefined;
    if (plan) plan.text = JSON.stringify(this.clean(workflow?.plan));
    const investigationSnapshot = {
      version: 1, taskId: task.taskId, runId, capturedAt: now(), permissionMode,
      phases: { planSaved: workflow?.submitted, analyzed: workflow?.analyzed, reviewed: workflow?.reviewed, drafted: workflow?.drafted },
      reworkCount, reworkAvailable,
      planPath: plan?.path ?? null,
      plan: plan ? { integrity: 'verified', path: plan.path, hash: plan.hash, preview: plan.text.slice(0, 4000), previewTruncated: plan.text.length > 4000, reRead: { tool: 'workflow__read_plan', args: { offset: 0, limit: 1024 } } } : { integrity: 'not_saved' },
      planMode: { supported: false }, sourceProgress, nextAction,
      claimIds: workflow?.claims.map(claim => claim.id), evidenceIds: workflow?.evidenceIds, reportPath: workflow?.report ?? null,
      review: workflow?.review, gaps: workflow?.gaps,
      sourceStates: task.allowedSources.map(slug => ({ slug, known: registry.known(slug), active: registry.active(slug) })),
      toolResultRefs: transcript?.references() ?? [],
      continuationRule: 'Use this current host state over historical summary. Re-read archived results when needed; do not repeat completed operations solely because context was compacted. Never automatically replay unresolved side effects.',
    };
    const snapshot = workflow ? investigationSnapshot : {
      version: 1, taskId: task.taskId, runId, capturedAt: now(), permissionMode,
      task, procedureOwner: 'selected_skills_and_model', hardWorkflowSequence: false,
      sourceProgress, nextAction, sourceStates: investigationSnapshot.sourceStates,
      toolResultRefs: investigationSnapshot.toolResultRefs, continuationRule: investigationSnapshot.continuationRule,
    };
    const recent = [...this.reads.values()].sort((a, b) => b.sequence - a.sequence).slice(0, 6).map(read => {
      let status = 'current';
      if (read.kind === 'source_guide') status = guideStates.find(guide => guide.sourceSlug === read.sourceSlug)?.state ?? 'unavailable';
      if (read.kind === 'skill_resource') {
        try { if (!userSkills || userSkills.readResource(read.skill!, read.path!, 0, 1).hash !== read.hash) status = 'changed'; }
        catch { status = 'changed_or_unavailable'; }
      }
      const { text, ...metadata } = read;
      return { ...metadata, status, contentPreview: status === 'current' ? text : null, previewTruncated: read.readChars > text.length, untrusted: true };
    });
    const skillRows = [
      ...(this.builtin ? [{ ...this.builtin, contextInjected: true, resourceReads: 0 }] : []),
      ...(userSkills?.documents ?? []).map(skill => ({ name: skill.name, hash: skill.hash, contextInjected: true, resourceReads: [...this.reads.values()].filter(read => read.kind === 'skill_resource' && read.skill === skill.name).length, resourcePathsRead: [...this.reads.values()].filter(read => read.kind === 'skill_resource' && read.skill === skill.name).map(read => read.path) })),
    ];
    return [
      { name: workflow ? 'Current workflow state' : 'Current task state', content: JSON.stringify(snapshot) },
      { name: 'Recent resource reads', content: JSON.stringify({ scope: 'host_managed_resource_tools', totalReadOperations: this.sequence, olderResourcesOmitted: Math.max(0, this.reads.size - recent.length), reads: recent }) },
      ...catalogAttachments('Loaded skills and resource usage', { invocationModel: 'host_injected_documents_and_explicit_resource_reads' }, skillRows),
      ...catalogAttachments('Current tool and MCP catalog', { discovery: 'eager', deferredLoadingSupported: false, descriptions: 'current_api_tool_definitions', catalogHash: hash(visibleTools) }, visibleTools.map(tool => ({ name: tool.proxy_name, source: tool.source_slug, channel: tool.channel, bindingId: tool.id, revision: tool.revision, action: tool.action, dynamicAction: tool.dynamicAction ?? false, descriptionHash: hash(tool.description), schemaHash: hash(tool.inputSchema) }))),
      { name: 'Source guide prerequisites', content: JSON.stringify({ guides: guideStates, rule: 'Reinjection does not mark an unread or changed guide as read. Use session__read_source_guide when required.' }) },
      { name: 'Execution and agent status', content: JSON.stringify({ agentProcess: this.process ?? { state: 'not_started' }, toolExecution: 'sequential', unresolvedExecutions: unresolved.map(record => ({ requestId: record.requestId, tool: record.toolBinding.proxy_name, state: record.state, executeCount: record.execute_count })), asyncAgents: { supported: false, running: [], unclaimedResults: [] }, automaticReplay: false }) },
    ];
  }
}
