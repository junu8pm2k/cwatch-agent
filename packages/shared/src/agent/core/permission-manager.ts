import { hash, id, now, abortable, type AgentTask, type ToolBinding } from "@cwatch/core/types";
import { ToolRegistry } from "../../tools/registry.ts";

import { PERMISSION_MODES, type Mode } from '@cwatch/core/types/permissions';
export { PERMISSION_MODES, type Mode } from '@cwatch/core/types/permissions';
/** safe is accepted only as a legacy input alias; state and new Trace use explore. */
export function parsePermissionMode(value: unknown = 'explore'): Mode {
  if (value === 'safe') return 'explore';
  if (typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)) return value as Mode;
  throw new Error('permission must be explore, ask, or allow-all');
}
export interface Verdict { decision: 'ALLOW' | 'APPROVAL' | 'BLOCK'; reason: string }
const hostTool = (binding: ToolBinding) => binding.source_slug === 'workflow' && binding.channel === 'workflow' || binding.source_slug === 'session' && binding.channel === 'builtin' && binding.namespace === 'session' || binding.source_slug === 'pi' && binding.channel === 'builtin' && binding.namespace === 'native';
export class ActionPolicy {
  private effectiveMode: Mode;
  constructor(mode: Mode | 'safe' = 'explore') { this.effectiveMode = parsePermissionMode(mode); }
  get mode(): Mode { return this.effectiveMode; }
  setMode(mode: Mode | 'safe'): void { this.effectiveMode = parsePermissionMode(mode); }
  visibleTools(task: AgentTask, registry: ToolRegistry): ToolBinding[] {
    return registry.list().filter(binding => (hostTool(binding) || task.allowedSources.includes(binding.source_slug)) &&
      registry.availableActions(binding).some(action => ['collect', 'analyze', 'local_draft'].includes(action) || (this.mode !== 'explore' && ['modify', 'send', 'publish'].includes(action))));
  }
  decide(task: AgentTask, binding: ToolBinding, args: Record<string, unknown>, registry: ToolRegistry): Verdict {
    const fail = (reason: string): Verdict => ({ decision: 'BLOCK', reason });
    if (!hostTool(binding) && !task.allowedSources.includes(binding.source_slug)) return fail('source_outside_task');
    const scopeError = registry.validate(binding, args, task); if (scopeError) return fail(scopeError);
    const action = registry.resolveAction(binding, args, task);
    if (['collect', 'analyze', 'local_draft'].includes(action)) return { decision: 'ALLOW', reason: 'declared_semantics_and_valid_scope' };
    if (['modify', 'send', 'publish'].includes(action)) {
      if (this.mode === 'explore') return fail('write_action_forbidden_in_explore');
      if (this.mode === 'ask') return { decision: 'APPROVAL', reason: 'human_required_for_write_action' };
      return { decision: 'ALLOW', reason: 'host_allow_all_with_valid_scope' };
    }
    return fail('unknown_semantics');
  }
}
export interface ApprovalRequest { requestId: string; taskId: string; tool: string; argsHash: string; argsSummary: string; createdAt: string; expiresAt?: string }
export type ApprovalResponder = (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
export class ApprovalManager {
  readonly pending = new Map<string, ApprovalRequest>();
  constructor(private responder?: ApprovalResponder, readonly ttlMs = 0) {}
  async wait(requestId: string, taskId: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, summarize: (v: unknown) => string): Promise<string> {
    const hasTtl = Number.isFinite(this.ttlMs) && this.ttlMs > 0;
    const request: ApprovalRequest = Object.freeze({
      requestId, taskId, tool, argsHash: hash(args), argsSummary: summarize(args), createdAt: now(),
      ...(hasTtl ? { expiresAt: new Date(Date.now() + this.ttlMs).toISOString() } : {}),
    });
    this.pending.set(requestId, request);
    const controller = new AbortController();
    const timeout = hasTtl ? setTimeout(() => controller.abort(new Error('approval_expired')), this.ttlMs) : undefined;
    const combined = hasTtl ? AbortSignal.any([signal, controller.signal]) : signal;
    try {
      if (!this.responder) throw new Error('approval_unavailable');
      const answer = await abortable(this.responder(request, combined), combined);
      if (!answer) throw new Error('approval_denied');
      if ((request.expiresAt && Date.now() >= Date.parse(request.expiresAt)) || this.pending.get(requestId) !== request || hash(args) !== request.argsHash) throw new Error('approval_invalid');
      return request.argsHash;
    } finally { if (timeout) clearTimeout(timeout); this.pending.delete(requestId); }
  }
}
