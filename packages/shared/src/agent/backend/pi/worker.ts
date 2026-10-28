import { id, hash, type AgentSessionHooks, type ModelInput } from "@cwatch/core/types";
import { PostCompactResultSchema } from '@cwatch/core/types/compaction';
import { SessionMemoryStateSchema } from '@cwatch/core/types/session-memory';
import { type ModelConfig } from "../../../config/models.ts";
import { createPiRuntime } from './model-runtime.ts';
import { runPiSession } from "./session.ts";
import { MAX_FRAME_CHARS, parseFrame, PROTOCOL_VERSION, toolIdentity, type Frame, type HostMessage, type WorkerMessage } from './protocol.ts';
import { Redactor } from "../../../sessions/trace.ts";

if (!process.send) throw new Error('agent_worker_requires_ipc');
const controller = new AbortController();
let sessionId = '', taskId = '', incoming = 0, outgoing = 0, initialized = false;
let redactor = new Redactor();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
function send(body: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error('agent_host_disconnected'));
    const frame: Frame = { version: PROTOCOL_VERSION, sessionId, taskId, sequence: ++outgoing, body };
    if (JSON.stringify(frame).length > MAX_FRAME_CHARS) return reject(new Error('agent_protocol: frame_too_large'));
    process.send(frame, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve());
  });
}
function stop(error: unknown) {
  if (!controller.signal.aborted) controller.abort(error);
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}
async function request(key: string, body: WorkerMessage): Promise<unknown> {
  controller.signal.throwIfAborted();
  const promise = new Promise<unknown>((resolve, reject) => pending.set(key, { resolve, reject }));
  try { await send(body); } catch (error) { pending.get(key)?.reject(error); pending.delete(key); }
  return promise;
}
const hook = (type: 'before_model' | 'decision' | 'usage' | 'observation' | 'transcript' | 'before_request' | 'post_compact' | 'session_memory' | 'next_user_message', data: Record<string, unknown> = {}) => {
  const requestId = id();
  return request('hook:' + requestId, { type, requestId, ...data } as WorkerMessage);
};
async function run(config: ModelConfig, input: ModelInput) {
  redactor = new Redactor([config.apiKey]);
  try {
    await send({ type: 'ready', pid: process.pid });
    const hooks: AgentSessionHooks = {
      beforeModel: async () => await hook('before_model') as ModelInput,
      onDecision: async decision => { await hook('decision', { decision }); },
      onObservation: async (name, result, sdkToolCallId) => { await hook('observation', { name, result, ...(sdkToolCallId ? { sdkToolCallId } : {}) }); },
      onUsage: async (usage, purpose) => { await hook('usage', { usage, purpose }); },
      onTranscript: async entries => { await hook('transcript', { entries }); },
      beforeRequest: async purpose => await hook('before_request', { purpose }) as { maxOutputTokens: number },
      afterCompact: async request => PostCompactResultSchema.parse(await hook('post_compact', { request }) ?? { attachments: [], hookResults: [] }),
      sessionMemory: async request => { const value = await hook('session_memory', { request }); return value ? SessionMemoryStateSchema.parse(value) : null; },
      ...(input.conversation ? { nextUserMessage: async () => {
        const value = await hook('next_user_message');
        if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 24000)) throw new Error('agent_protocol: invalid_user_message');
        return value as string | null;
      } } : {}),
      executeTool: async (toolName, args, signal, binding, sdkToolCallId) => {
        signal.throwIfAborted(); if (!binding || !sdkToolCallId) throw new Error('agent_protocol: missing_tool_identity');
        const pre = { type: 'pre_tool_use_request' as const, requestId: id(), taskId, toolName, bindingId: binding.id, argsHash: hash(args), input: args, sdkToolCallId };
        const response = await request('pre:' + pre.requestId, { type: 'pre_tool_use_request', request: pre }) as import('../../pre-tool-use.ts').PreToolUseResponse;
        if (response.action !== 'allow') throw new Error(response.reason);
        signal.throwIfAborted();
        return request('tool:' + pre.requestId, { type: 'tool_execute_request', request: toolIdentity(pre) });
      },
    };
    const { runtime, model } = await createPiRuntime(config.provider, config.modelId, config, controller.signal);
    await runPiSession(runtime, model, input, hooks, controller.signal);
    controller.signal.throwIfAborted();
    await send({ type: 'completed' });
    process.exit(0);
  } catch (error) {
    if (process.connected) { try { await send({ type: 'failed', error: redactor.clean(String(error)).slice(0, 16_000) }); } catch {} }
    process.exit(1);
  }
}
process.on('message', raw => {
  try {
    if (!initialized) {
      const first = raw as Frame;
      if (!first || typeof first.sessionId !== 'string' || typeof first.taskId !== 'string') throw new Error('agent_protocol: invalid_init');
      sessionId = first.sessionId; taskId = first.taskId;
    }
    const frame = parseFrame(raw, sessionId, taskId, ++incoming), message = frame.body as HostMessage;
    if (!initialized) {
      if (message.type !== 'init' || message.input.state.task.taskId !== taskId) throw new Error('agent_protocol: invalid_init');
      initialized = true; void run(message.config, message.input); return;
    }
    if (message.type === 'abort') { stop(new Error(message.reason)); return; }
    let key: string, value: unknown, error: string | undefined;
    if (message.type === 'hook_response') { key = 'hook:' + message.requestId; value = message.value; if (!message.ok) error = message.error ?? 'host_hook_failed'; }
    else if (message.type === 'pre_tool_use_response') { key = 'pre:' + message.response.requestId; value = message.response; }
    else if (message.type === 'tool_execute_response') { key = 'tool:' + message.requestId; value = message.value; if (!message.ok) error = message.error ?? 'host_tool_failed'; }
    else throw new Error('agent_protocol: unexpected_host_message');
    const waiter = pending.get(key);
    if (!waiter) throw new Error('agent_protocol: orphan_host_response');
    pending.delete(key); if (error) waiter.reject(new Error(error)); else waiter.resolve(value);
  } catch (error) { stop(error); }
});
process.on('disconnect', () => { stop(new Error('agent_host_disconnected')); process.exit(1); });
process.on('SIGTERM', () => stop(new Error('agent_worker_terminated')));
