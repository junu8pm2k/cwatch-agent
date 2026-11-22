import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, hash, id, abortable, type AgentSessionHooks, type ModelInput, type ToolBudgetSkip } from "@cwatch/core/types";
import { type ModelConfig } from "../../../config/models.ts";
import { Redactor } from "../../../sessions/trace.ts";
import { MAX_FRAME_CHARS, parseFrame, PROTOCOL_VERSION, toolIdentity, WorkerMessageSchema, type Frame, type HostMessage, type WorkerMessage } from './protocol.ts';
import { type PreToolUseRequest } from '../../pre-tool-use.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** Inherit OS/network plumbing only. Model credentials go through private IPC, source tokens stay in the host. */
export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.test(key) && value !== undefined));
}
interface PendingTool {
  request: PreToolUseRequest; phase: 'checking' | 'blocked' | 'allowed' | 'executing' | 'finished';
  execute: ReturnType<typeof deferred<void>>;
}
export interface SubprocessOptions { workerPath?: URL; shutdownMs?: number; startupMs?: number }

/** Host owns tool implementations, approvals and durability. A worker can only submit intents. */
export async function runPiSubprocess(config: ModelConfig, input: ModelInput, hooks: AgentSessionHooks, signal: AbortSignal, options: SubprocessOptions = {}): Promise<void> {
  signal.throwIfAborted();
  const sessionId = input.sessionId ?? id(), taskId = input.state.task.taskId, stopped = deferred<void>();
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const pending = new Map<string, PendingTool>(), operations = new Set<Promise<void>>(), seen = new Set<string>();
  const bindings = new Map(input.tools.map(binding => [binding.proxy_name, structuredClone(binding)]));
  const redactor = new Redactor([config.apiKey]);
  const beforeTool = hooks.beforeTool?.bind(hooks);
  const toolAdmission = beforeTool ? true : undefined;
  let outgoing = 0, incoming = 0, ready = false, completed = false, closed = false, awaitingInput = false, fatal: unknown;
  const intents: Array<{ name: string; args: Record<string, unknown>; sdkToolCallId?: string }> = [];
  let intentConsumed = false, intentExecuted = false;
  let intentAdmission: 'checking' | 'decided' | undefined, intentSkip: ToolBudgetSkip | undefined;
  let answerReady = false;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const child = fork(fileURLToPath(options.workerPath ?? new URL('./worker.ts', import.meta.url)), [], {
    cwd: process.cwd(), execArgv: ['--use-env-proxy', '--experimental-transform-types'],
    env: workerEnvironment(process.env), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
  });
  const processEvent = (state: 'started' | 'ready' | 'stopping' | 'exited', extra: Record<string, unknown> = {}) => hooks.onProcessEvent?.({ state, pid: child.pid, sessionId, ...extra });
  const send = (body: HostMessage) => {
    if (closed || !child.connected) throw new Error('agent_subprocess_disconnected');
    const frame: Frame = { version: PROTOCOL_VERSION, sessionId, taskId, sequence: ++outgoing, body };
    if (JSON.stringify(frame).length > MAX_FRAME_CHARS) throw new Error('agent_protocol: frame_too_large');
    child.send(frame, error => { if (error && !closed) stop(error); });
  };
  const stop = (error: unknown) => {
    if (fatal || closed) return;
    fatal = error;
    clearTimeout(shutdownTimer);
    controller.abort(error); // This also settles host approvals and executing tools before run terminal.
    processEvent('stopping', { reason: redactor.clean(String(error)) });
    try { send({ type: 'abort', reason: 'host_stopped' }); } catch {}
    shutdownTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, options.shutdownMs ?? 1_000);
  };
  const startupTimer = setTimeout(() => stop(new Error('agent_subprocess_startup_timeout')), options.startupMs ?? 15_000);
  const onAbort = () => stop(signal.reason ?? new Error('cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  const track = (operation: Promise<void>) => {
    operations.add(operation);
    void operation.catch(stop).finally(() => operations.delete(operation));
  };
  const claimId = (requestId: string) => {
    if (seen.has(requestId) || seen.size >= 8192) throw new Error('agent_protocol: duplicate_or_excess_request');
    seen.add(requestId);
  };
  const handle = async (message: WorkerMessage): Promise<void> => {
    combined.throwIfAborted();
    if (message.type === 'ready') {
      if (ready || message.pid !== child.pid) throw new Error('agent_protocol: invalid_ready');
      if (message.toolAdmission !== toolAdmission) throw new Error('agent_protocol: tool_admission_version_mismatch. Restart the Cwatch host from the current checkout.');
      ready = true; clearTimeout(startupTimer); processEvent('ready'); return;
    }
    if (!ready || completed) throw new Error('agent_protocol: unexpected_message');
    if (awaitingInput && message.type !== 'failed') throw new Error('agent_protocol: work_while_waiting_for_user');
    if (message.type === 'pre_tool_use_request') {
      const request = message.request; claimId(request.requestId);
      const binding = bindings.get(request.toolName);
      const intent = intents[0];
      if (request.taskId !== taskId || !binding || binding.id !== request.bindingId || hash(request.input) !== request.argsHash || !request.sdkToolCallId ||
          !intent || intentConsumed || intentAdmission === 'checking' || intentSkip || intent.name !== request.toolName || canonical(intent.args) !== canonical(request.input) ||
          (intent.sdkToolCallId !== undefined && intent.sdkToolCallId !== request.sdkToolCallId) || pending.size) throw new Error('agent_protocol: invalid_tool_intent');
      intentConsumed = true;
      const call: PendingTool = { request: structuredClone(request), phase: 'checking', execute: deferred<void>() };
      pending.set(request.requestId, call);
      try {
        const result = await hooks.executeTool(request.toolName, request.input, combined, binding, request.sdkToolCallId, {
          request: call.request,
          onResponse: async response => {
            combined.throwIfAborted();
            if (canonical(toolIdentity(response)) !== canonical(toolIdentity(request))) throw new Error('agent_protocol: mismatched_pre_tool_response');
            call.phase = response.action === 'allow' ? 'allowed' : 'blocked';
            send({ type: 'pre_tool_use_response', response });
            if (response.action === 'allow') await abortable(call.execute.promise, combined);
          },
        });
        combined.throwIfAborted();
        if (call.phase === 'executing') send({ type: 'tool_execute_response', requestId: request.requestId, ok: true, value: result });
        else if (call.phase !== 'blocked') throw new Error('agent_protocol: execution_handshake_missing');
      } catch (error) {
        if (!combined.aborted && call.phase === 'executing') send({ type: 'tool_execute_response', requestId: request.requestId, ok: false, error: redactor.clean(String(error)) });
        else if (!combined.aborted && call.phase !== 'blocked') throw error;
      } finally { call.phase = 'finished'; pending.delete(request.requestId); }
      return;
    }
    if (message.type === 'tool_execute_request') {
      const call = pending.get(message.request.requestId);
      if (!call || call.phase !== 'allowed' || canonical(toolIdentity(call.request)) !== canonical(message.request)) throw new Error('agent_protocol: execution_without_matching_allow');
      call.phase = 'executing'; intentExecuted = true; call.execute.resolve(); return;
    }
    if (message.type === 'failed') throw new Error(redactor.clean(message.error));
    if (message.type === 'completed') {
      if (pending.size || intents.length) throw new Error('agent_protocol: completed_with_pending_work');
      completed = true;
      // A worker that reports completion but keeps handles open is still reaped.
      shutdownTimer = setTimeout(() => { if (!closed) { fatal = new Error('agent_subprocess_shutdown_timeout'); child.kill('SIGKILL'); } }, options.shutdownMs ?? 1_000);
      return;
    }
    claimId(message.requestId);
    try {
      let value: unknown;
      if (message.type === 'next_user_message') {
        if (!input.conversation || !hooks.nextUserMessage || pending.size || intents.length || !answerReady) throw new Error('agent_protocol: unexpected_user_input_request');
        awaitingInput = true; answerReady = false;
        try { value = await abortable(Promise.resolve().then(() => hooks.nextUserMessage!()), combined); }
        finally { awaitingInput = false; }
      } else if (message.type === 'before_model') {
        if (pending.size || intents.length) throw new Error('agent_protocol: model_during_tool_execution');
        value = await hooks.beforeModel(); intentConsumed = false; intentExecuted = false; answerReady = false;
      } else if (message.type === 'decision') {
        if (pending.size || intents.length) throw new Error('agent_protocol: decision_with_pending_work');
        if (message.decision.kind === 'call_tools') intents.push(...structuredClone(message.decision.calls));
        else if (message.decision.kind === 'call_tool') intents.push(structuredClone(message.decision));
        await hooks.onDecision(message.decision);
        answerReady = message.decision.kind === 'respond';
        intentConsumed = false; intentExecuted = false;
      } else if (message.type === 'before_tool') {
        const intent = intents[0];
        if (!beforeTool || pending.size || intentConsumed || intentAdmission || !intent || intent.name !== message.name ||
            (intent.sdkToolCallId !== undefined && intent.sdkToolCallId !== message.sdkToolCallId)) throw new Error('agent_protocol: invalid_tool_admission');
        intent.sdkToolCallId ??= message.sdkToolCallId;
        intentAdmission = 'checking';
        const admission = await beforeTool(message.name, message.sdkToolCallId);
        intentSkip = admission?.skipped;
        intentAdmission = 'decided';
        value = admission;
      } else if (message.type === 'observation') {
        const intent = intents[0];
        if (pending.size || intentAdmission === 'checking' || !intent || intent.name !== message.name || (intent.sdkToolCallId !== undefined && intent.sdkToolCallId !== message.sdkToolCallId)) throw new Error('agent_protocol: unexpected_observation');
        const sdkFailure = message.result !== null && typeof message.result === 'object' && 'status' in message.result && message.result.status === 'tool_failed';
        if (!intentExecuted && !sdkFailure && !intentSkip) throw new Error('agent_protocol: observation_without_execution');
        await hooks.onObservation(message.name, intentSkip ?? message.result, message.sdkToolCallId);
        intents.shift(); intentConsumed = false; intentExecuted = false; intentAdmission = undefined; intentSkip = undefined;
      } else if (message.type === 'transcript') await hooks.onTranscript?.(message.entries);
      else if (message.type === 'before_request') value = await hooks.beforeRequest?.(message.purpose);
      else if (message.type === 'post_compact') {
        if (pending.size || intents.length) throw new Error('agent_protocol: compaction_during_tool_execution');
        value = await hooks.afterCompact?.(message.request);
      }
      else if (message.type === 'session_memory') {
        if (pending.size || intents.length) throw new Error('agent_protocol: memory_during_tool_execution');
        value = await hooks.sessionMemory?.(message.request) ?? null;
      }
      else await hooks.onUsage(message.usage, message.purpose);
      combined.throwIfAborted(); send({ type: 'hook_response', requestId: message.requestId, ok: true, value });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('agent_protocol:')) throw error;
      if (!combined.aborted) send({ type: 'hook_response', requestId: message.requestId, ok: false, error: redactor.clean(String(error)) });
    }
  };
  child.on('message', raw => {
    if (fatal || closed) return;
    try {
      const frame = parseFrame(raw, sessionId, taskId, ++incoming);
      track(handle(WorkerMessageSchema.parse(frame.body)));
    } catch (error) { stop(new Error('agent_protocol: ' + (error instanceof Error ? error.message : String(error)))); }
  });
  child.on('error', stop);
  child.on('disconnect', () => { if (!completed && !fatal) stop(new Error('agent_subprocess_disconnected')); });
  child.on('exit', (code, exitSignal) => {
    if (!completed && !fatal) stop(new Error('agent_subprocess_exit: code=' + code + ' signal=' + exitSignal));
    controller.abort(fatal ?? new Error('agent_session_closed'));
  });
  child.on('close', (code, argumentsSignal) => {
    exitCode = code; exitSignal = argumentsSignal;
    closed = true; clearTimeout(startupTimer); clearTimeout(shutdownTimer);
    if (!fatal && (!completed || code !== 0)) fatal = new Error('agent_subprocess_exit: code=' + code + ' signal=' + argumentsSignal);
    stopped.resolve();
  });
  try {
    processEvent('started');
    send({ type: 'init', config, input, ...(toolAdmission ? { toolAdmission } : {}) });
    if (signal.aborted) onAbort();
    await stopped.promise;
    await Promise.allSettled([...operations]); // No late execution/approval records after run terminal.
    if (fatal) throw fatal;
  } finally {
    clearTimeout(startupTimer); clearTimeout(shutdownTimer);
    signal.removeEventListener('abort', onAbort);
    if (!closed) { controller.abort(new Error('agent_session_disposed')); child.kill('SIGKILL'); await stopped.promise; await Promise.allSettled([...operations]); }
    processEvent('exited', { failed: Boolean(fatal), exitCode, exitSignal });
  }
}
