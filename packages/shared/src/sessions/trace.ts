import { FileStore } from "./storage.ts";
import { now, canonical, DecisionSchema, type ToolCallIntent } from "@cwatch/core/types";
import { z } from 'zod';
import { PERMISSION_MODES } from "../agent/core/permission-manager.ts";
import { AgentEventSchema, AGENT_EVENT_TYPES, ProviderRejectionSchema } from "../agent/events.ts";
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { projectStructuredTrace, type StructuredTrace } from './structured-trace.ts';
export { AgentEventSchema } from "../agent/events.ts";

// Historical safe-mode logs remain readable; current policies emit canonical explore.
const traceModes: readonly string[] = [...PERMISSION_MODES, 'safe'];

export const TraceSchema = z.object({ schemaVersion: z.literal(2).optional(), taskId: z.string().min(1), runId: z.string().min(1), sequence: z.number().int().positive(), timestamp: z.string().datetime({ offset: true }), type: z.enum(AGENT_EVENT_TYPES), data: z.record(z.string(), z.unknown()) }).strict().superRefine((event, ctx) => {
  if (event.schemaVersion === 2 && !AgentEventSchema.safeParse({ type: event.type, data: event.data }).success) ctx.addIssue({ code: 'custom', message: 'invalid AgentEvent payload' });
});
function sensitiveKey(key: string): boolean { return /^(authorization|apikey|password|secret|token|accesstoken|refreshtoken|clientsecret|privatekey)$/.test(key.replace(/[_-]/g, '').toLowerCase()) || /_(?:TOKEN|KEY|SECRET|PASSWORD)$/i.test(key); }

export interface TraceEvent { schemaVersion?: 2; taskId: string; runId: string; sequence: number; timestamp: string; type: string; data: Record<string, unknown> }
export class Redactor {
  constructor(private secrets: string[] = []) {}
  clean<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') { let s = v.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]'); for (const secret of this.secrets.filter(Boolean)) s = s.split(secret).join('[REDACTED]'); return s; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, sensitiveKey(k) ? '[REDACTED]' : walk(item)]));
      return v;
    };
    return walk(value) as T;
  }
}
export class Trace {
  private sequence = 0;
  readonly key: string;
  readonly structuredKey:string;
  structuredError?:string;
  constructor(readonly store: FileStore, readonly taskId: string, readonly runId: string, readonly redactor = new Redactor(), private readonly onEvent?: (event:TraceEvent)=>void) {
    this.key = 'traces/' + runId + '.jsonl';
    this.structuredKey='traces/'+runId+'.json';
    this.sequence = store.lines<TraceEvent>(this.key).at(-1)?.sequence ?? 0;
  }
  emit(type: string, data: Record<string, unknown> = {}): void {
    const payload = AgentEventSchema.parse(this.redactor.clean({ type, data }));
    const event = TraceSchema.parse({ schemaVersion: 2, taskId: this.taskId, runId: this.runId, sequence: this.sequence + 1, timestamp: now(), ...payload });
    this.store.append(this.key, event);
    this.sequence = event.sequence;
    if(['run_completed','run_failed','run_cancelled'].includes(type)){
      try{this.exportStructured();}catch(error){this.structuredError=this.redactor.clean(String(error));}
    }
    try { this.onEvent?.(structuredClone(event)); } catch { /* Observers cannot invalidate the durable audit event. */ }
  }
  exportStructured():StructuredTrace {
    const bytes=readFileSync(this.store.path(this.key)),events=this.redactor.clean(this.store.lines<TraceEvent>(this.key));
    if(events.some(event=>event.runId!==this.runId||event.taskId!==this.taskId))throw Error('trace_identity_mismatch');
    const document=projectStructuredTrace(events,validateTrace(events),{path:this.key,sha256:createHash('sha256').update(bytes).digest('hex')});
    this.store.write(this.structuredKey,document);this.structuredError=undefined;return document;
  }
}
export function validateTrace(events: TraceEvent[], forbiddenSecrets: string[] = []): string[] {
  const errors: string[] = []; const calls = new Map<string, { decision: string; approved: boolean; started: boolean; finished: boolean }>(); let terminal = false; let expectingDecision = false;
  if (events[0]?.type !== 'run_started') errors.push('missing run_started');
  const versioned = events.some(event => event.schemaVersion === 2);
  if (versioned && events.some(event => event.schemaVersion !== 2)) errors.push('trace schema downgrade');
  const requiresPreToolUse = events[0]?.data.toolPipeline === 'pre-tool-use-v1';
  const preToolUses = new Map<string, { taskId: unknown; toolName: unknown; bindingId: unknown; argsHash: unknown; sdkToolCallId: unknown; action?: string }>();
  const processes = new Map<string, { pid: unknown; ready: boolean; stopping: boolean; exited: boolean }>();
  const stages = new Map<string, { allowed: boolean; started: boolean; finished: boolean }>();
  const rejectedEntries = new Set<unknown>();
  let queuedCalls: ToolCallIntent[] = [];
  let requestedIteration: unknown;
  events.forEach((e, i) => {
    if (!TraceSchema.safeParse(e).success || e.sequence !== i + 1 || e.taskId !== events[0].taskId || e.runId !== events[0].runId) errors.push('invalid envelope ' + i);
    if (terminal) errors.push('event after run terminal');
    if (e.type === 'agent_process') {
      const key = String(e.data.sessionId ?? ''), child = processes.get(key);
      if (!key) errors.push('invalid agent process identity');
      if (e.data.state === 'started') {
        if (child) errors.push('duplicate agent process');
        processes.set(key, { pid: e.data.pid, ready: false, stopping: false, exited: false });
      } else if (!child || child.exited || child.pid !== e.data.pid) errors.push('invalid agent process lifecycle');
      else if (e.data.state === 'ready') {
        if (child.ready || child.stopping || !Number.isInteger(e.data.pid)) errors.push('invalid agent readiness');
        child.ready = true;
      } else if (e.data.state === 'stopping') {
        if (child.stopping) errors.push('duplicate agent stop');
        child.stopping = true;
      } else if (e.data.state === 'exited') child.exited = true;
      else errors.push('unknown agent process state');
    }
    const requestId = e.data.requestId as string;
    if (e.type === 'model_requested') { if (expectingDecision) errors.push('overlapping model request'); if (queuedCalls.length) errors.push('model request with unfinished tool batch'); expectingDecision = true; requestedIteration = e.data.iteration; }
    if (e.type === 'provider_rejected') {
      if (!expectingDecision || requestedIteration !== e.data.iteration || rejectedEntries.has(e.data.entryId) ||
        !ProviderRejectionSchema.safeParse({ entryId: e.data.entryId, reason: e.data.reason }).success) errors.push('invalid provider rejection');
      rejectedEntries.add(e.data.entryId); expectingDecision = false;
    }
    if (e.type === 'response_revision_requested') {
      if (!expectingDecision || requestedIteration !== e.data.iteration || queuedCalls.length) errors.push('invalid response revision request');
      expectingDecision = false;
    }
    if (e.type === 'decision_made') {
      if (!expectingDecision) errors.push('decision without request');
      if (queuedCalls.length) errors.push('decision with unfinished tool batch');
      expectingDecision = false;
      const decision = DecisionSchema.safeParse(e.data.decision);
      if (decision.success && decision.data.kind === 'call_tools') queuedCalls = [...decision.data.calls];
    }
    if (e.type === 'observation_added' && queuedCalls.length) {
      const call = queuedCalls[0];
      if (call.sdkToolCallId !== e.data.sdkToolCallId || call.name !== e.data.name) errors.push('batch observation identity mismatch');
      queuedCalls.shift();
    }
    if (e.type === 'pre_tool_use_request') {
      if (queuedCalls.length) {
        const call = queuedCalls[0];
        if (call.sdkToolCallId !== e.data.sdkToolCallId || call.name !== e.data.toolName || canonical(call.args) !== canonical(e.data.input)) errors.push('batch pre-tool identity mismatch');
      }
      if (!requestId || preToolUses.has(requestId) || e.data.taskId !== e.taskId || !e.data.toolName || !e.data.bindingId || !e.data.argsHash || !e.data.input || typeof e.data.input !== 'object') errors.push('invalid pre-tool request');
      preToolUses.set(requestId, { taskId: e.data.taskId, toolName: e.data.toolName, bindingId: e.data.bindingId, argsHash: e.data.argsHash, sdkToolCallId: e.data.sdkToolCallId });
    }
    if (e.type === 'pre_tool_use_response') {
      const pending = preToolUses.get(requestId), call = calls.get(requestId);
      if (!pending || pending.action || !call || call.started || call.finished || pending.taskId !== e.data.taskId || pending.toolName !== e.data.toolName || pending.bindingId !== e.data.bindingId || pending.argsHash !== e.data.argsHash || pending.sdkToolCallId !== e.data.sdkToolCallId || !traceModes.includes(String(e.data.effectiveMode)) || !['allow', 'block'].includes(String(e.data.action))) errors.push('invalid pre-tool response');
      if (e.data.action === 'allow' && (!call || call.decision === 'BLOCK' || (call.decision === 'APPROVAL' && !call.approved))) errors.push('pre-tool allow without permission');
      if (pending) pending.action = String(e.data.action);
    }
    if (e.type === 'execution_started') {
      const pre = preToolUses.get(requestId);
      if ((requiresPreToolUse || pre) && (!pre || pre.action !== 'allow' || pre.bindingId !== e.data.bindingId || pre.sdkToolCallId !== e.data.sdkToolCallId)) errors.push('execution without pre-tool allow');
    }
    if (e.type === 'policy_decision' && preToolUses.has(requestId)) {
      const pre = preToolUses.get(requestId)!;
      if (pre.bindingId !== (e.data.binding as { id?: string } | undefined)?.id || pre.argsHash !== e.data.argsHash) errors.push('policy/pre-tool binding mismatch');
    }
    if (e.type === 'policy_decision') { if (!requestId || calls.has(requestId) || !e.data.binding || !traceModes.includes(String(e.data.effectiveMode)) || !['ALLOW', 'BLOCK', 'APPROVAL'].includes(String(e.data.decision)) || !e.data.argsHash) errors.push('policy fields missing or duplicate'); calls.set(requestId, { decision: String(e.data.decision), approved: false, started: false, finished: false }); }
    if (e.type === 'execution_started') { const call = calls.get(requestId); if (!call || call.finished || call.started || call.decision === 'BLOCK' || (call.decision === 'APPROVAL' && !call.approved)) errors.push('execution without permission'); if (call) call.started = true; }
    if (e.type === 'approval_resolved') { const call = calls.get(requestId); if (!call || call.decision !== 'APPROVAL' || call.started || call.finished) errors.push('approval without pending policy'); if (call) call.approved = e.data.decision === 'approved'; }
    if (e.type === 'execution_finished') { const call = calls.get(requestId); if (!call || call.finished || !['completed', 'failed', 'cancelled', 'unknown'].includes(String(e.data.state)) || (e.data.state === 'completed' && !call.started)) errors.push('invalid execution terminal'); if (call) call.finished = true; }
    if (e.type === 'backend_policy') { const call = calls.get(requestId); if (!call?.started || call.finished || !e.data.stageId || !e.data.backend || !traceModes.includes(String(e.data.effectiveMode))) errors.push('backend without active execution'); stages.set(String(e.data.stageId), { allowed: e.data.decision === 'ALLOW' || (e.data.decision === 'APPROVAL' && call?.approved === true), started: false, finished: false }); }
    if (e.type === 'backend_started') { const stage = stages.get(String(e.data.stageId)); if (!stage?.allowed || stage.started || stage.finished) errors.push('backend without authorization'); if (stage) stage.started = true; }
    if (e.type === 'backend_finished') { const stage = stages.get(String(e.data.stageId)); if (!stage?.started || stage.finished) errors.push('orphan backend terminal'); if (stage) stage.finished = true; }
    if (e.type === 'web_route' || e.type === 'provider_tool_event') { const call = calls.get(requestId); if (!call?.started || call.finished) errors.push('web event outside execution'); }
    if (['run_completed', 'run_failed', 'run_cancelled'].includes(e.type)) { if (e.type === 'run_completed' && expectingDecision) errors.push('run completed with pending model request'); if (e.type === 'run_completed' && queuedCalls.length) errors.push('run completed with unfinished tool batch'); terminal = true; if ([...processes.values()].some(child => !child.exited)) errors.push('run terminal with active agent process'); if ([...calls.values()].some(c => !c.finished)) errors.push('run terminal with pending execution'); if ([...preToolUses.values()].some(call => !call.action)) errors.push('run terminal with pending pre-tool request'); }
    const serialized = JSON.stringify(e);
    if (forbiddenSecrets.some(secret => secret && serialized.includes(secret))) errors.push('unredacted sensitive value');
    const inspect = (value: unknown): void => { if (Array.isArray(value)) value.forEach(inspect); else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (sensitiveKey(key) && child !== '[REDACTED]') errors.push('unredacted sensitive key'); inspect(child); } };
    inspect(e.data);
  });
  if (!terminal) errors.push('missing terminal');
  return errors;
}
