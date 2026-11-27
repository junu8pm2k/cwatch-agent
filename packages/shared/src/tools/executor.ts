import { abortable, hash, id, now, RetrievalSchema, type AgentTask, type ExecutionRecord, type ToolBinding } from "@cwatch/core/types";
import { ToolRegistry } from './registry.ts';
import { ActionPolicy, ApprovalManager } from "../agent/core/permission-manager.ts";
import { FileStore } from "../sessions/storage.ts";
import { Trace } from "../sessions/trace.ts";
import { previewFetchedPage } from '../sessions/page-snapshots.ts';
import { runPreToolUseChecks, toPolicyVerdict, type PrerequisiteManagerLike } from "../agent/core/pre-tool-use.ts";
import { requestPreToolUseApproval, type PreToolUseRequest, type ToolCallHandshake } from "../agent/pre-tool-use.ts";

export class ToolExecutor {
  private dispatch: ReturnType<ToolRegistry['dispatcher']>;
  constructor(readonly registry: ToolRegistry, readonly policy: ActionPolicy, readonly approvals: ApprovalManager, readonly store: FileStore, readonly trace: Trace, readonly task: AgentTask, readonly toolTimeoutMs = 15_000, readonly prerequisiteManager?: PrerequisiteManagerLike) { this.dispatch = registry.dispatcher(); }
  async execute(name: string, rawArgs: Record<string, unknown>, signal: AbortSignal, expectedBinding?: ToolBinding, sdkToolCallId?: string, handshake?: ToolCallHandshake): Promise<unknown> {
    signal.throwIfAborted();
    const binding = structuredClone(expectedBinding ?? this.registry.binding(name));
    if (binding.proxy_name !== name) throw new Error('binding_name_mismatch');
    // Snapshot arguments before awaiting approval; external callers cannot mutate approved semantics.
    const args = structuredClone(rawArgs);
    if (binding.dynamicAction) { try { binding.action = this.registry.resolveAction(binding, args, this.task); } catch {} }
    const requestId = handshake?.request.requestId ?? id();
    if (handshake && (handshake.request.taskId !== this.task.taskId || handshake.request.toolName !== name || handshake.request.bindingId !== binding.id || handshake.request.argsHash !== hash(args) || hash(handshake.request.input) !== hash(args) || handshake.request.sdkToolCallId !== sdkToolCallId)) throw new Error('pre_tool_request_mismatch');
    if (handshake && this.store.read('executions/' + requestId + '.json', null)) throw new Error('pre_tool_request_already_recorded');
    const record: ExecutionRecord = { requestId, taskId: this.task.taskId, runId: this.trace.runId, sourceSlug: binding.source_slug, toolBinding: binding, argsHash: hash(args), state: 'awaiting_permission', startedAt: now(), execute_count: 0, ...(sdkToolCallId ? { sdkToolCallId } : {}) };
    const write = () => this.store.execution(this.trace.redactor.clean(record));
    write();
    const checkInput = { toolName: name, input: args, task: this.task, binding, registry: this.registry, policy: this.policy, prerequisiteManager: this.prerequisiteManager };
    const timeout = new AbortController();
    const timeoutHandle = setTimeout(() => timeout.abort(new DOMException('tool timeout', 'TimeoutError')), this.toolTimeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      const request: PreToolUseRequest = {
        type: 'pre_tool_use_request', requestId, taskId: this.task.taskId, toolName: name,
        bindingId: binding.id, argsHash: record.argsHash, input: args,
        ...(sdkToolCallId ? { sdkToolCallId } : {}),
      };
      const response = await requestPreToolUseApproval(request, { ...checkInput, approvals: this.approvals, trace: this.trace }, combined);
      if (handshake) { combined.throwIfAborted(); await abortable(handshake.onResponse(response), combined); }
      combined.throwIfAborted();
      if (response.requestId !== requestId || response.taskId !== this.task.taskId || response.toolName !== name || response.bindingId !== binding.id || response.argsHash !== hash(args) || response.sdkToolCallId !== sdkToolCallId) throw new Error('pre_tool_response_mismatch');
      if (response.action !== 'allow') throw new Error(response.reason);
      const approvedHash = response.approvedArgsHash;
      const recheck = toPolicyVerdict(runPreToolUseChecks(checkInput));
      if (recheck.decision === 'BLOCK' || (recheck.decision === 'APPROVAL' && approvedHash !== hash(args))) throw new Error('policy_changed_or_unapproved');
      record.state = 'executing'; record.execute_count = 1; write();
      this.trace.emit('execution_started', { requestId, bindingId: binding.id, ...(sdkToolCallId ? { sdkToolCallId } : {}) });
      let stageSequence = 0;
      const result = await abortable(this.dispatch(binding, args, combined, {
        event: (type, data) => { combined.throwIfAborted(); this.trace.emit(type, { ...data, requestId, bindingId: binding.id }); },
        stage: async (backend, operation) => {
          combined.throwIfAborted();
          const stageId = requestId + ':' + ++stageSequence;
          const current = toPolicyVerdict(runPreToolUseChecks(checkInput));
          this.trace.emit('backend_policy', { requestId, stageId, backend, bindingId: binding.id, argsHash: record.argsHash, effectiveMode: this.policy.mode, ...current });
          if (current.decision === 'BLOCK' || (current.decision === 'APPROVAL' && approvedHash !== hash(args))) throw new Error('backend_policy_block');
          this.trace.emit('backend_started', { requestId, stageId, backend });
          try { const value = await abortable(operation(), combined); combined.throwIfAborted(); this.trace.emit('backend_finished', { requestId, stageId, backend, state: 'completed' }); return value; }
          catch (e) { this.trace.emit('backend_finished', { requestId, stageId, backend, state: combined.aborted ? 'cancelled' : 'failed', error: String(e) }); throw e; }
        },
      }), combined);
      combined.throwIfAborted();
      let observation = result;
      if (result && typeof result === 'object' && 'raw' in result && typeof result.raw === 'string') {
        const raw = this.trace.redactor.clean(result.raw), snapshotHash = hash(raw), path = 'retrievals/' + snapshotHash + '.txt';
        this.store.text(path, raw);
        const archived = { ...result, raw: raw.slice(0, 16_000), rawTruncated: raw.length > 16_000, snapshot: { path, hash: snapshotHash } };
        observation = archived;
        if (name === 'web_fetch') {
          const fetched = RetrievalSchema.safeParse(result);
          if (fetched.success && fetched.data.status === 'success_with_data' && fetched.data.pages?.length) {
            const pages = fetched.data.pages.map(page => previewFetchedPage(this.store, this.trace.runId, this.trace.redactor.clean(page)));
            observation = { ...archived, pages };
          }
        }
      }
      record.state = 'completed'; record.endedAt = now(); write();
      this.trace.emit('execution_finished', { requestId, state: record.state, result: this.trace.redactor.clean(observation) });
      return observation;
    } catch (error) {
      record.state = combined.aborted ? (record.execute_count > 0 && ['send', 'publish', 'modify'].includes(binding.action) ? 'unknown' : 'cancelled') : 'failed';
      record.endedAt = now(); record.error = String(error); write();
      if (timeout.signal.aborted) this.trace.emit('budget_exceeded', { budget: 'tool_timeout', limit: this.toolTimeoutMs, actual: this.toolTimeoutMs, tool: name, requestId });
      this.trace.emit('execution_finished', { requestId, state: record.state, error: String(error), execute_count: record.execute_count });
      throw error;
    } finally { clearTimeout(timeoutHandle); }
  }
}
