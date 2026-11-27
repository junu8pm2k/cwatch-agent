import { z } from 'zod';
import { canonical, DecisionSchema, id, now, parseAgentTask, isInvestigationTask, abortable, type Decision, type AgentTask, type AgentSessionHooks, type AgentState, type ModelPort, type SourceClient, type ToolBinding, type ToolAdmission, type ToolBudgetSnapshot } from '@cwatch/core/types';
import { ContextPipeline } from '@cwatch/shared/agent/core/prompt-builder';
import { ProviderRejectionSchema } from '@cwatch/shared/agent/events';
import { applyAgentPromptSnapshot, readAgentPromptSnapshot, type AgentPromptSnapshot } from '@cwatch/shared/agent/core/managed-prompts';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Trace, Redactor, type TraceEvent } from '@cwatch/shared/sessions/trace';
import { exportToLangfuse, type LangfuseExportResult } from '@cwatch/shared/sessions/langfuse';
import { SessionTranscript } from '@cwatch/shared/sessions/transcript';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { ToolExecutor } from '@cwatch/shared/tools/executor';
import { ActionPolicy, ApprovalManager, type Mode } from '@cwatch/shared/agent/core/permission-manager';
import type { SkillBundle } from '@cwatch/shared/skills/storage';
import { BudgetError, isCompletionTool, isFailedToolResult, resolveLimits, reportedTokens, toolBudgetSkip, type LimitOptions } from '@cwatch/shared/agent/core/budgets';
import { PostCompactResultSchema, type CompactAttachment, type CompactRequest } from '@cwatch/core/types/compaction';
import { WorkingStateTracker, type WorkflowCheckpoint } from './working-state.ts';
import { SessionMemoryPolicySchema, type SessionMemoryPolicy } from '@cwatch/core/types/session-memory';
import { SessionMemoryStore } from '@cwatch/shared/sessions/memory';
import { PromptCacheStats } from '@cwatch/shared/agent/core/prompt-cache';
import { PiBuiltinSource, PI_BUILTIN_SOURCE } from '@cwatch/shared/tools/pi-builtins';
const decisionContent = (decision: Decision | undefined): string => canonical(decision?.kind === 'call_tools' ? { kind: decision.kind, calls: decision.calls.map(({ name, args }) => ({ name, args })) } : decision);
export interface AgentRuntimeOptions extends LimitOptions {
  initialGaps?: string[];
  skillPath?: string; secrets?: string[]; userSkills?: SkillBundle;
  /** Frozen before a run/batch; includes no Langfuse credentials or evaluation rubric. */
  agentPrompts?: AgentPromptSnapshot;
  onEvent?: (event:TraceEvent)=>void;
  onPostCompact?: (request: CompactRequest, signal: AbortSignal) => Promise<CompactAttachment[]>;
  sessionMemory?: false | Partial<SessionMemoryPolicy>;
  promptCache?: 'none' | 'short';
  /** SDK tools run through the same host policy/trace as business tools. */
  builtinTools?: boolean;
  workspaceRoot?: string;
  /** Host-controlled continuation. Waiting does not consume active execution time. */
  nextUserMessage?: (answer: RunResult, signal: AbortSignal) => Promise<string | null>;
}
export interface RunResult { taskId: string; runId: string; permissionMode: Mode; status: 'complete' | 'partial' | 'failed' | 'cancelled'; report?: string; response?: string; error?: string; gaps: string[];
  langfuse?: LangfuseExportResult;
  traceArtifacts?:{eventsPath:string;structuredPath:string;available:boolean;error?:string}; }

export interface TaskRuntimeContext {
  task: AgentTask; state: AgentState; registry: ToolRegistry; store: FileStore; trace: Trace;
  mode: 'live' | 'replay'; options: AgentRuntimeOptions; transcript?: SessionTranscript;
  workingState: WorkingStateTracker; memory?: SessionMemoryStore;
  toolBudgets(): ToolBudgetSnapshot;
}
export interface TaskExtension {
  slug: 'workflow' | 'session'; channel: 'workflow' | 'builtin'; client: SourceClient; gaps: string[];
  skill: () => string; skillPath: string; skillName: string; completionInstruction?: string; checkpoint?: WorkflowCheckpoint;
  skillAppendix?: string;
  checkPrerequisites?(binding: ToolBinding, input: Record<string, unknown>): { allowed: boolean; blockReason?: string };
  onObservation?(name: string, result: unknown, args: Record<string, unknown>): void;
  stage?(): string;
  savedDraft?(): string | undefined;
  finish(text: string): Pick<RunResult, 'status' | 'report' | 'response'>;
}
export type TaskExtensionFactory = (context: TaskRuntimeContext) => TaskExtension;
export async function runTask(rawTask: unknown, model: ModelPort, registry: ToolRegistry, store: FileStore, mode: 'live' | 'replay', options: AgentRuntimeOptions, createExtension: TaskExtensionFactory, callerSignal = new AbortController().signal, policy = new ActionPolicy(), approvals = new ApprovalManager()): Promise<RunResult> {
  const limits = resolveLimits({ ...options, maxOutputTokens: options.maxOutputTokens ?? model.defaultMaxOutputTokens });
  const promptCache = z.enum(['none', 'short']).parse(options.promptCache ?? 'short');
  const cacheStats = new PromptCacheStats();
  const task = parseAgentTask(rawTask), runId = id(), startedAt = Date.now();
  const promptSnapshot = options.agentPrompts ?? (mode === 'live' ? readAgentPromptSnapshot(process.env.CWATCH_AGENT_PROMPT_SNAPSHOT) : undefined);
  if (promptSnapshot && options.skillPath && !options.skillPath.replaceAll('\\', '/').endsWith('/skills/' + (isInvestigationTask(task) ? 'competitor-investigation' : 'general-agent') + '/SKILL.md')) throw Error('agent_prompt_snapshot_conflicts_with_custom_skill_path');
  const managedPrompts = promptSnapshot ? applyAgentPromptSnapshot(promptSnapshot, isInvestigationTask(task) ? 'competitor-investigation' : 'general-agent', options.userSkills) : undefined;
  if (managedPrompts) options = { ...options, userSkills: managedPrompts.userSkills };
  if (options.nextUserMessage && isInvestigationTask(task)) throw new Error('conversation_requires_generic_agent');
  const redactor = new Redactor(options.secrets ?? Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, v]) => v ?? ''));
  const trace = new Trace(store, task.taskId, runId, redactor, options.onEvent);
  const transcript = model.runSession ? new SessionTranscript(store, runId, redactor) : undefined;
  const memoryPolicy = options.sessionMemory === false ? undefined : SessionMemoryPolicySchema.parse(options.sessionMemory ?? {});
  const memory = transcript && memoryPolicy ? new SessionMemoryStore(store, transcript, task.taskId, memoryPolicy, redactor) : undefined;
  const state: AgentState = { task, observations: [], decisions: [], iteration: 0, ...(options.nextUserMessage && !isInvestigationTask(task) ? { userMessages: [task.instruction] } : {}) };
  registry.resetSourceGuides();
  const workingState = new WorkingStateTracker(value => redactor.clean(value));
  let toolCalls = 0, skippedToolCalls = 0, totalTokens = 0, usageMissing = false;
  const completionReserve = isInvestigationTask(task) ? Math.min(task.evidencePolicy ? 8 : 6, Math.floor(limits.maxToolCalls / 3)) : 0;
  let reservedForCompletion = completionReserve;
  const callsByTool = new Map<string, number>();
  const failuresByTool = new Map<string, number>();
  let iteration = 0;
  const budgetSnapshot = (steps = iteration) => ({
    steps, maxSteps: limits.maxSteps, maxToolCalls: limits.maxToolCalls, maxSameToolCalls: limits.maxSameToolCalls,
    maxConsecutiveToolFailures: limits.maxConsecutiveToolFailures, toolCalls, reservedForCompletion,
    callsByTool: Object.fromEntries(callsByTool), failuresByTool: Object.fromEntries(failuresByTool),
  });
  const extension = createExtension({ task, state, registry, store, trace, mode, options, transcript, workingState, memory, toolBudgets: budgetSnapshot });
  const timeoutController = new AbortController();
  let remainingMs = limits.timeoutMs, activeSince = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const abortOnTimeout = () => timeoutController.abort(new DOMException('run timeout', 'TimeoutError'));
  const resumeTimeout = () => {
    if (!limits.timeoutMs) return;
    activeSince = Date.now();
    timeoutHandle = setTimeout(abortOnTimeout, Math.max(0, remainingMs));
  };
  const pauseTimeout = () => {
    if (!limits.timeoutMs) return;
    clearTimeout(timeoutHandle);
    remainingMs -= Date.now() - activeSince;
    if (remainingMs <= 0) abortOnTimeout();
  };
  resumeTimeout();
  const modelTimeout = new AbortController();
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutController.signal, signal = AbortSignal.any([callerSignal, timeout, modelTimeout.signal]);
  const result: RunResult = { taskId: task.taskId, runId, permissionMode: policy.mode, status: 'failed', gaps: extension.gaps };
  const modelUsage: unknown[] = [];
  let budgetFailure: BudgetError | undefined;
  const exceeded = (budget: string, limit: number, actual: number, tool?: string) => budgetFailure = new BudgetError(budget, limit, actual, tool);
  trace.emit('run_started', { mode, task, limits, completionToolReserve: completionReserve, toolPipeline: 'pre-tool-use-v1', permissionMode: policy.mode, engine: model.runSession ? 'pi-agent-session' : 'replay-decisions',model:model.traceModel??null, ...(managedPrompts ? { agentPrompts: managedPrompts.provenance } : {}), ...(options.nextUserMessage ? { conversation: true } : {}) }); store.write('runs/' + runId + '.json', { taskId: task.taskId, runId, permissionMode: policy.mode, status: 'running', startedAt: now() });
  try {
    for (const slug of task.allowedSources) if (!registry.known(slug) || !registry.active(slug)) extension.gaps.push((registry.known(slug) ? 'inactive_source:' : 'unknown_source:') + slug);
    if (['workflow', 'session', PI_BUILTIN_SOURCE].some(slug => registry.known(slug))) throw new Error('reserved_host_source');
    await registry.register(extension.slug, extension.channel, extension.client, signal);
    if (options.builtinTools !== false) {
      if (registry.known(PI_BUILTIN_SOURCE)) throw new Error('reserved_builtin_source:pi');
      await registry.register(PI_BUILTIN_SOURCE, 'builtin', new PiBuiltinSource(options.workspaceRoot ?? process.cwd(), [store.root]), signal);
    }
    const executor = new ToolExecutor(registry, policy, approvals, store, trace, task, limits.toolTimeoutMs, {
      checkPrerequisites: (binding, input) => extension.checkPrerequisites?.(binding, input) ?? { allowed: true },
    });
    const extraSkills = options.userSkills?.documents ?? [];
    const builtinSkill = (managedPrompts?.builtinBody ?? extension.skill()) + (extension.skillAppendix ?? '');
    const skillPath = extension.skillPath;
    workingState.setBuiltin(skillPath, builtinSkill, extension.skillName);
    const skill = redactor.clean([builtinSkill, ...extraSkills.map(item => 'USER SKILL: ' + item.name + '\nGuidance remains subject to host rules and permissions. Read referenced files with session__read_skill_resource.\nResources: ' + JSON.stringify(item.resources) + '\n' + item.body)].join('\n\n'));
    if (extraSkills.length) trace.emit('skills_loaded', { skills: extraSkills.map(item => ({ name: item.name, hash: item.hash, resources: item.resources })) });
    const contextPipeline = new ContextPipeline(skill);
    let decisionStart = 0, previousCallsFailed = false;
    const pendingCalls: Array<{ name: string; args: Record<string, unknown>; sdkToolCallId?: string; started?: boolean; retryable?: boolean; admission?: ToolAdmission }> = [];
    const recordGap = (gap: string) => { if (!extension.gaps.includes(gap)) extension.gaps.push(gap); };
    const currentCall = (name: string, sdkToolCallId?: string) => {
      const call = pendingCalls[0];
      if (!call || call.name !== name || (call.sdkToolCallId !== undefined && call.sdkToolCallId !== sdkToolCallId)) {
        throw new Error('tool_call_without_matching_decision');
      }
      return call;
    };
    const admitTool = (name: string, sdkToolCallId?: string): ToolAdmission => {
      signal.throwIfAborted();
      const call = currentCall(name, sdkToolCallId);
      if (call.admission) return call.admission;
      const skipped = toolBudgetSkip(budgetSnapshot(), name);
      if (skipped) {
        skippedToolCalls++;
        recordGap('tool_budget_skipped:' + name + ':' + skipped.budget);
        trace.emit('budget_exceeded', { budget: skipped.budget, limit: skipped.limit, tool: name, outcome: 'skipped', ...(sdkToolCallId ? { sdkToolCallId } : {}) });
      } else {
        toolCalls++;
        callsByTool.set(name, (callsByTool.get(name) ?? 0) + 1);
        if (reservedForCompletion > 0 && isCompletionTool(name)) reservedForCompletion--;
      }
      call.admission = { toolBudgets: budgetSnapshot(), ...(skipped ? { skipped } : {}) };
      return call.admission;
    };
    const hooks: AgentSessionHooks = {
      beforeModel: () => {
        signal.throwIfAborted();
        if (iteration >= limits.maxSteps) throw exceeded('iterations', limits.maxSteps, iteration + 1);
        if (totalTokens >= limits.maxTokens) throw exceeded('tokens', limits.maxTokens, totalTokens);
        usageMissing = model.tokenUsageRequired === true;
        state.iteration = iteration++;
        const context = contextPipeline.prepareTurn(state, registry, policy, limits.contextChars, Boolean(model.runSession), { ...limits, completionReserve });
        trace.emit('context_prepared', { iteration: state.iteration, permissionMode: policy.mode, contextHash: context.contextHash, skillHash: context.skillHash, prefixHash: context.prefixHash, toolsetHash: context.toolsetHash, promptCache: { requestedRetention: promptCache, controlOwner: 'sdk', providerSupport: 'not_asserted' }, tools: context.tools.map(tool => ({ proxyName: tool.proxy_name, sourceSlug: tool.source_slug, originalName: tool.original_name, channel: tool.channel, action: tool.action, bindingId: tool.id, ...(tool.dynamicAction ? { dynamicAction: true, availableActions: registry.availableActions(tool) } : {}) })) });
        clearTimeout(modelTimer);
        modelTimer = setTimeout(() => modelTimeout.abort(exceeded('model_timeout', limits.modelTimeoutMs, limits.modelTimeoutMs)), limits.modelTimeoutMs);
        trace.emit('model_requested', { iteration: state.iteration, contextChars: context.stable.length + context.volatile.length });
        const toolBudgets = budgetSnapshot(state.iteration);
        return { state: structuredClone(model.runSession ? { ...state, observations: [], decisions: [], userMessages: undefined } : state), sessionId: runId, ...(options.nextUserMessage ? { conversation: true } : {}), ...context, tools: context.tools, completionInstruction: extension.completionInstruction, contextChars: limits.contextChars, maxOutputTokens: Math.min(limits.maxOutputTokens, limits.maxTokens - totalTokens), maxResponseChars: limits.maxResponseChars, promptCache, toolBudgets, ...(memory ? { sessionMemoryPolicy: memoryPolicy } : {}) };
      },
      onDecision: raw => {
        signal.throwIfAborted();
        clearTimeout(modelTimer);
        if (model.tokenUsageRequired && usageMissing) throw new Error('budget_usage_unavailable: provider did not report positive token usage');
        const length = JSON.stringify(raw).length;
        if (length > limits.maxResponseChars) throw exceeded('response_chars', limits.maxResponseChars, length);
        const decision = DecisionSchema.parse(raw);
        if (pendingCalls.length) throw new Error('decision_with_pending_tool_calls');
        // Let read-only collection retries reach their failure limit and receive
        // one skip receipt. An unchanged retry after the skip is still a loop.
        if (!previousCallsFailed && state.decisions.length - decisionStart >= 2 && decisionContent(state.decisions.at(-1)) === decisionContent(decision) && decisionContent(state.decisions.at(-2)) === decisionContent(decision)) throw new Error('no_progress: repeated identical decision');
        previousCallsFailed = decision.kind !== 'respond';
        state.decisions.push(decision); trace.emit('decision_made', { decision });
        if (decision.kind === 'respond') {
          Object.assign(result, extension.finish(redactor.clean(decision.text)));
        } else if (decision.kind === 'call_tools') {
          pendingCalls.push(...decision.calls.map(({ name, args, sdkToolCallId }) => ({ name, args, sdkToolCallId })));
        } else pendingCalls.push({ name: decision.name, args: decision.args });
      },
      beforeTool: admitTool,
      executeTool: async (name, args, toolSignal, disclosedBinding, sdkToolCallId, handshake) => {
        signal.throwIfAborted(); toolSignal.throwIfAborted();
        const call = currentCall(name, sdkToolCallId);
        if (call.started) throw new Error('tool_call_already_started');
        const { skipped } = admitTool(name, sdkToolCallId);
        if (skipped) return skipped;
        call.started = true;
        const combined = AbortSignal.any([signal, toolSignal]);
        try {
          const binding = disclosedBinding ?? registry.binding(name);
          if (!contextPipeline.isDisclosed(binding)) throw new Error('undisclosed_tool_binding');
          call.retryable = binding.action === 'collect' && !binding.dynamicAction;
          return redactor.clean(await executor.execute(name, args, combined, binding, sdkToolCallId, handshake));
        } catch (e) {
          combined.throwIfAborted();
          return redactor.clean({ error: String(e), status: 'tool_failed' });
        }
      },
      onObservation: (name, result, sdkToolCallId) => {
        signal.throwIfAborted();
        const call = currentCall(name, sdkToolCallId);
        const { skipped } = admitTool(name, sdkToolCallId);
        pendingCalls.shift();
        const observation = redactor.clean(skipped ?? result);
        const failed = !skipped && isFailedToolResult(observation);
        previousCallsFailed &&= call.retryable === true && failed;
        if (failed) {
          const failures = (failuresByTool.get(name) ?? 0) + 1;
          failuresByTool.set(name, failures);
          if (failures === limits.maxConsecutiveToolFailures) {
            recordGap('tool_failure_limit:' + name);
            trace.emit('budget_exceeded', { budget: 'tool_failures', limit: failures, actual: failures, tool: name, outcome: 'deactivated' });
          }
        } else if (!skipped) failuresByTool.delete(name);
        state.observations.push({ name, result: observation });
        extension.onObservation?.(name, observation, redactor.clean(call.args));
        trace.emit('observation_added', { name, observation, ...(sdkToolCallId ? { sdkToolCallId } : {}) });
      },
      onUsage: (usage, purpose = 'turn') => {
        clearTimeout(modelTimer);
        if (usage !== undefined) modelUsage.push(usage);
        const cache = cacheStats.observe(usage, purpose);
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) trace.emit('model_usage', { iteration: state.iteration, purpose, usage, cache });
        const tokens = reportedTokens(usage); usageMissing = tokens === undefined;
        if (tokens !== undefined) {
          totalTokens += tokens;
          if (totalTokens > limits.maxTokens) throw exceeded('tokens', limits.maxTokens, totalTokens);
        }
      },
      onProcessEvent: event => { workingState.processEvent(event); trace.emit('agent_process', event); },
      onTranscript: entries => {
        transcript?.append(entries);
        for (const entry of entries) if (entry.type === 'custom' && entry.customType === 'cwatch.provider_rejection') {
          const data = ProviderRejectionSchema.parse(entry.data);
          trace.emit('provider_rejected', { iteration: state.iteration, ...data });
        } else if (entry.type === 'custom' && entry.customType === 'cwatch.response_revision') {
          const data = z.object({ length: z.int().positive(), limit: z.int().positive() }).strict().parse(entry.data);
          trace.emit('response_revision_requested', { iteration: state.iteration, ...data });
        }
      },
      sessionMemory: request => {
        signal.throwIfAborted();
        if (!memory) throw new Error('session_memory_disabled');
        const saved = memory.handle(request);
        if (request.operation === 'commit' && saved) trace.emit('session_memory_updated', { revision: saved.revision, lastMessageId: saved.lastMessageId, path: memory.key, windowTokens: saved.windowTokens, windowGrowthTokens: saved.windowGrowthTokens, toolCallCount: saved.toolCallCount });
        return saved;
      },
      beforeRequest: () => {
        signal.throwIfAborted();
        if (totalTokens >= limits.maxTokens) throw exceeded('tokens', limits.maxTokens, totalTokens);
        clearTimeout(modelTimer);
        modelTimer = setTimeout(() => modelTimeout.abort(exceeded('model_timeout', limits.modelTimeoutMs, limits.modelTimeoutMs)), limits.modelTimeoutMs);
        return { maxOutputTokens: Math.min(limits.maxOutputTokens, limits.maxTokens - totalTokens) };
      },
      afterCompact: async request => {
        signal.throwIfAborted();
        const hookResults = options.onPostCompact ? await abortable(options.onPostCompact(redactor.clean(structuredClone(request)), signal), signal) : [];
        signal.throwIfAborted();
        const attachments = workingState.attachments({ task, runId, state, workflow: extension.checkpoint, store, registry, permissionMode: policy.mode,
          visibleTools: policy.visibleTools(task, registry).filter(tool => contextPipeline.isDisclosed(tool)), userSkills: options.userSkills, transcript,
          budgets: budgetSnapshot() })
          .map(attachment => ({ ...attachment, content: JSON.stringify(redactor.clean(JSON.parse(attachment.content))) }));
        const savedMemory = memory?.load();
        if (savedMemory) attachments.push({ name: 'Session memory', content: JSON.stringify({ path: memory!.key, ...savedMemory,
          freshness: 'State as of lastMessageId; newer host workflow state and messages take precedence.' }) });
        if (transcript && !policy.visibleTools(task, registry).some(tool => tool.proxy_name === 'session__read_transcript' && contextPipeline.isDisclosed(tool))) throw new Error('context_transcript_unavailable: transcript lookup tool is no longer active');
        return PostCompactResultSchema.parse(redactor.clean({ attachments, hookResults, ...(transcript ? { transcript: transcript.reference() } : {}) }));
      },
      ...(options.nextUserMessage ? { nextUserMessage: async () => {
        signal.throwIfAborted();
        if (result.status !== 'complete' && result.status !== 'partial' || !result.response) throw new Error('conversation_without_completed_answer');
        clearTimeout(modelTimer); pauseTimeout();
        signal.throwIfAborted();
        store.write('states/' + runId + '.json', redactor.clean(state));
        store.write('runs/' + runId + '.json', redactor.clean({ ...result, status: 'awaiting_user' }));
        trace.emit('conversation_turn_completed', { turn: state.userMessages!.length, response: result.response, status: result.status });
        const answer = redactor.clean({ ...result, gaps: [...new Set(extension.gaps)] });
        const text = await abortable(Promise.resolve().then(() => options.nextUserMessage!(answer, signal)), signal);
        signal.throwIfAborted();
        if (text === null) return null;
        const message = redactor.clean(z.string().trim().min(1).max(24000).parse(text));
        state.userMessages!.push(message); decisionStart = state.decisions.length;
        trace.emit('user_message_received', { turn: state.userMessages!.length, text: message });
        result.status = 'failed'; delete result.error;
        store.write('runs/' + runId + '.json', { taskId: task.taskId, runId, permissionMode: policy.mode, status: 'running', startedAt: now() });
        resumeTimeout();
        return message;
      } } : {}),
    };
    if (model.runSession) {
      await model.runSession(await hooks.beforeModel(), hooks, signal);
    } else {
      // Deterministic fixtures and single-step test doubles do not require an SDK session.
      do {
        while (result.status === 'failed') {
          const decision = DecisionSchema.parse(await abortable(model.decide(await hooks.beforeModel(), signal), signal));
          await hooks.onUsage(model.usage); await hooks.onDecision(decision);
          if (decision.kind === 'respond') break;
          for (const call of decision.kind === 'call_tools' ? decision.calls : [decision]) {
            const sdkToolCallId = 'sdkToolCallId' in call ? call.sdkToolCallId : undefined;
            const observation = await hooks.executeTool(call.name, call.args, signal, undefined, sdkToolCallId);
            await hooks.onObservation(call.name, observation, sdkToolCallId);
          }
        }
      } while (hooks.nextUserMessage && await hooks.nextUserMessage() !== null);
    }
    if (result.status === 'failed') throw new Error('budget_iterations');
  } catch (e) {
    const error = modelTimeout.signal.aborted ? modelTimeout.signal.reason : budgetFailure ?? e;
    result.status = callerSignal.aborted ? 'cancelled' : 'failed'; result.error = String(error);
    const draft = extension.savedDraft?.();
    if (draft) result.report = draft;
    if (timeout.aborted) result.error = 'budget_timeout: ' + String(e);
    if (error instanceof BudgetError || /budget_|context_budget_exceeded/.test(result.error)) trace.emit('budget_exceeded', {
      ...(error instanceof BudgetError ? { budget: error.budget, limit: error.limit, actual: error.actual, ...(error.tool ? { tool: error.tool } : {}) } : {}), error: result.error,
    });
  }
  finally {
    clearTimeout(timeoutHandle); clearTimeout(modelTimer);
    result.gaps = [...new Set(extension.gaps)];
    result.permissionMode = policy.mode;
    trace.emit('usage_reported', { toolCalls, skippedToolCalls, callsByTool: Object.fromEntries(callsByTool), totalTokens, limits, durationMs: Date.now() - startedAt, modelUsage, cacheUsage: cacheStats.snapshot(), usageAvailable: totalTokens > 0, mode });
    trace.emit(result.status === 'cancelled' ? 'run_cancelled' : result.status === 'failed' ? 'run_failed' : 'run_completed', { ...result, ...(extension.stage ? { stage: extension.stage() } : {}) });
    result.traceArtifacts={eventsPath:trace.key,structuredPath:trace.structuredKey,available:!trace.structuredError,...(trace.structuredError?{error:trace.structuredError}:{})};
    if (mode === 'live') result.langfuse = await exportToLangfuse(trace);
    store.write('runs/' + runId + '.json', redactor.clean({ ...result, endedAt: now() }));
    // Durable event stream reconstructs state; this snapshot is a convenience cache only.
    store.write('states/' + runId + '.json', redactor.clean(state));
    await model.close?.();
  }
  return redactor.clean(result);
}
export function replayState(store: FileStore, runId: string): AgentState {
  const events = store.lines<import("@cwatch/shared/sessions/trace").TraceEvent>('traces/' + runId + '.jsonl');
  const first = events[0]; if (!first || first.type !== 'run_started') throw new Error('invalid_run_log');
  const initialTask = parseAgentTask(first.data.task);
  const state: AgentState = { task: initialTask, decisions: [], observations: [], iteration: 0, ...(first.data.conversation && !isInvestigationTask(initialTask) ? { userMessages: [initialTask.instruction] } : {}) };
  for (const event of events) {
    if (event.type === 'model_requested') state.iteration = Number(event.data.iteration);
    if (event.type === 'decision_made') state.decisions.push(DecisionSchema.parse(event.data.decision));
    if (event.type === 'observation_added') state.observations.push({ name: String(event.data.name), result: event.data.observation });
    if (event.type === 'user_message_received') state.userMessages?.push(String(event.data.text));
  }
  return state;
}
