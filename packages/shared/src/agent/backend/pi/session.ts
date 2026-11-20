import { createAgentSession, SessionManager, SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ExplicitResourceLoader } from './explicit-resources.ts';
import { decodePiMessage } from "../../models.ts";
import { type AgentSessionHooks, type ModelInput } from "@cwatch/core/types";
import { buildProxyTools, wrapToolsWithHooks } from "./tool-hooks.ts";
import { PiContextManager, getMessagesAfterCompactBoundary } from './context.ts';
import { assertCompleteApiRounds } from './api-rounds.ts';
import { isContextRejection, PROVIDER_REJECTION, ReactiveCompactCircuit } from './provider-rejections.ts';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

/** SDK owns the live loop. Host callbacks own business meaning and execution policy. */
export async function runPiSession(runtime: ModelRuntime, model: Model, input: ModelInput, hooks: AgentSessionHooks, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    defaultTools: [], enableAnalytics: false, enableInstallTelemetry: false,
  });
  const cwd = process.cwd();
  const executionRule = '\nTool calls execute sequentially in listed order, each subject to host authorization. Calls that need earlier results must use a later turn.' + (input.completionInstruction ? '\n' + input.completionInstruction : '');
  const initialHostPrompt = input.stable + executionRule;
  const loader = new ExplicitResourceLoader(initialHostPrompt);
  await loader.reload();
  signal.throwIfAborted();
  const bindings = new Map(input.tools.map(binding => [binding.proxy_name, structuredClone(binding)]));
  let fatal: unknown;
  let outputTokens = input.maxOutputTokens ?? 4096;
  let responseChars = 0;
  let terminal = false;
  const responseCharacterLimit = !('kind' in input.state.task) ? undefined : input.state.task.responseCharacterLimit;
  let revisionLength: number | undefined;
  let revisingResponse = false;
  let currentStable = input.stable, prepareUserPrompt = false;
  let pendingRejection = false;
  const circuit = new ReactiveCompactCircuit();
  let eventQueue: Promise<void> = Promise.resolve();
  const customTools = wrapToolsWithHooks(buildProxyTools([...bindings.values()], { ...hooks, executeTool: async (...args) => { await eventQueue; if (fatal) throw fatal; return hooks.executeTool(...args); } }), {
    signal, throwIfStopped: () => { if (fatal) throw fatal; },
  });
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, modelRuntime: runtime, model, thinkingLevel: 'off',
    // Disable only implicit unwrapped registration. Host-registered SDK builtins are customTools.
    noTools: 'builtin', tools: [...bindings.keys()], customTools,
    sessionManager: SessionManager.inMemory(cwd, { id: input.sessionId }), settingsManager: settings, resourceLoader: loader,
  });
  // ResourceLoader adds a static cwd suffix. Preserve it on every refresh, including retries.
  if (!session.systemPrompt.startsWith(initialHostPrompt)) { session.dispose(); throw new Error('sdk_system_prompt_contract_changed'); }
  const sdkSystemSuffix = session.systemPrompt.slice(initialHostPrompt.length);
  const systemPromptFor = (stable: string) => stable + executionRule + sdkSystemSuffix;
  const resultPolicy = (tools: ModelInput['tools']) => ({
    canRead: tools.some(binding => binding.proxy_name === 'session__read_tool_result'),
    canReadTranscript: tools.some(binding => binding.proxy_name === 'session__read_transcript'),
    microcompactTools: tools.filter(binding => (binding.action === 'collect' && !binding.dynamicAction) || binding.source_slug === 'pi' && binding.action === 'analyze' || ['session__read_source_guide', 'session__read_skill_resource', 'session__read_tool_result', 'workflow__read_plan', 'session__read_transcript', 'session__read_session_memory'].includes(binding.proxy_name)).map(binding => binding.proxy_name),
  });
  const contextManager = new PiContextManager(session.sessionManager, hooks, input.contextChars ?? 150_000, input.maxResponseChars ?? 32_000, resultPolicy(input.tools), input.sessionMemoryPolicy);
  const fail = (error: unknown) => { fatal ??= error; session.agent.abort(); };
  const abort = () => session.agent.abort();
  signal.addEventListener('abort', abort, { once: true });
  const guardContext = (context: unknown) => contextManager.guard(context);
  const unsubscribe = session.subscribe(event => {
    if ((fatal || signal.aborted) && event.type !== 'message_end') return;
    if (event.type === 'message_start' && event.message.role === 'assistant') responseChars = 0;
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      // Count generated deltas once, excluding the SDK's duplicate partial argument buffers.
      if (update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta') responseChars += update.delta.length;
      if (responseChars > (input.maxResponseChars ?? 32_000)) {
        fail(new Error('budget_response_chars: ' + responseChars + '/' + (input.maxResponseChars ?? 32_000))); return;
      }
    }
    if (event.type !== 'tool_execution_end' && event.type !== 'message_end') return;
    // A final answer must stop the SDK loop synchronously, before the host acknowledgement arrives.
    if (event.type === 'message_end' && event.message.role === 'assistant' && (revisingResponse || !event.message.content.some(item => item.type === 'toolCall'))) terminal = !isContextRejection(event.message);
    eventQueue = eventQueue.then(async () => {
      await contextManager.flush();
      if (fatal || signal.aborted) return;
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (isContextRejection(event.message)) {
          pendingRejection = true;
          await hooks.onUsage(event.message.usage, 'rejected');
          return;
        }
        contextManager.recordUsage(event.message.usage);
        await hooks.onUsage(event.message.usage);
        const decision = decodePiMessage(event.message);
        circuit.success();
        if (revisingResponse && decision.kind !== 'respond') throw new Error('response_revision_requires_text');
        if (responseCharacterLimit !== undefined && decision.kind === 'respond') {
          // Match Python str.isspace() in the benchmark, and count Unicode code points.
          const length = [...decision.text].filter(character => !/[\p{White_Space}\u001c-\u001f]/u.test(character)).length;
          if (length > responseCharacterLimit) {
            if (revisingResponse) throw new Error(`response_character_limit: ${length}/${responseCharacterLimit} after one revision`);
            revisionLength = length;
            return;
          }
        }
        await hooks.onDecision(decision);
        terminal = decision.kind === 'respond';
      }
      if (event.type === 'tool_execution_end') {
        // Unknown tools and SDK schema errors never enter custom execute; they still need an Observation.
        const result = event.result as { details?: unknown; content?: Array<{ type: string; text?: string }> };
        const observation = event.isError
          ? { status: 'tool_failed', error: (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') }
          : result.details;
        await hooks.onObservation(event.toolName, observation, event.toolCallId);
      }
    }).catch(fail);
  });
  session.agent.toolExecution = 'sequential';
  const originalStream = session.agent.streamFunction;
  session.agent.streamFunction = (selected, originalContext, options) => {
    // SDK prompt() resets its base prompt. Always use current host rules on user follow-ups too.
    const context = { ...originalContext, systemPrompt: systemPromptFor(currentStable) };
    assertCompleteApiRounds(context.messages);
    contextManager.guardWindow(context, selected, outputTokens);
    contextManager.markRequest(context);
    return originalStream(selected, context, { ...options, cacheRetention: input.promptCache ?? 'short', sessionId: input.sessionId ?? session.agent.sessionId, maxTokens: Math.min(outputTokens, selected.maxTokens) });
  };
  const originalPayload = session.agent.onPayload;
  session.agent.onPayload = async (payload, selected) => {
    try {
      signal.throwIfAborted();
      if (fatal) throw fatal;
      const transformed = originalPayload ? await originalPayload(payload, selected) : payload;
      guardContext(transformed ?? payload);
      await contextManager.archive('cwatch.model_request', { model: selected.id, payload: transformed ?? payload,
        promptCache: { requestedRetention: input.promptCache ?? 'short', controlOwner: 'sdk', providerApi: selected.api, providerSupport: 'not_asserted' } });
      return transformed;
    } catch (error) { fail(error); throw error; }
  };
  const originalPrepare = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, sdkSignal) => {
    try {
      await eventQueue;
      if (fatal || signal.aborted || terminal) return undefined;
      const next = await hooks.beforeModel();
      currentStable = next.stable;
      outputTokens = next.maxOutputTokens ?? 4096;
      // New/replaced bindings are not silently granted within an existing session.
      const activeBindings = revisingResponse ? [] : next.tools.filter(binding => bindings.get(binding.proxy_name)?.id === binding.id);
      session.setActiveToolsByName(activeBindings.map(binding => binding.proxy_name));
      contextManager.setToolResultPolicy(resultPolicy(activeBindings));
      const update = await originalPrepare?.(turn, sdkSignal);
      const refreshed = { ...(update?.context ?? turn.context), systemPrompt: systemPromptFor(next.stable) };
      const active = await contextManager.prepare(refreshed, runtime, model, outputTokens, signal);
      if (active !== refreshed) session.agent.state.messages = active.messages;
      const allowance = await hooks.beforeRequest?.('turn');
      outputTokens = Math.min(outputTokens, allowance?.maxOutputTokens ?? outputTokens);
      guardContext(active);
      contextManager.guardWindow(active, model, outputTokens);
      return { ...update, context: active };
    } catch (error) { fail(error); return undefined; }
  };
  const originalTransform = session.agent.transformContext;
  session.agent.transformContext = async (messages, sdkSignal) => {
    const transformed = originalTransform ? await originalTransform(messages, sdkSignal) : messages;
    if (!prepareUserPrompt) return transformed;
    prepareUserPrompt = false;
    await eventQueue;
    if (fatal) throw fatal;
    signal.throwIfAborted();
    const active = await contextManager.prepare({ systemPrompt: systemPromptFor(currentStable), tools: session.agent.state.tools, messages: transformed }, runtime, model, outputTokens, signal);
    // The SDK loop retains this array; update it together with agent state so a later tool
    // round cannot reintroduce the pre-compact history.
    if (messages !== active.messages) messages.splice(0, messages.length, ...active.messages);
    session.agent.state.messages = [...active.messages];
    const allowance = await hooks.beforeRequest?.('turn');
    outputTokens = Math.min(outputTokens, allowance?.maxOutputTokens ?? outputTokens);
    return active.messages;
  };
  session.agent.shouldStopAfterTurn = () => Boolean(fatal || signal.aborted || terminal);
  try {
    let userPrompt = input.volatile;
    while (true) {
      terminal = false;
      signal.throwIfAborted();
      await contextManager.flush();
      const allowance = await hooks.beforeRequest?.('turn');
      outputTokens = Math.min(outputTokens, allowance?.maxOutputTokens ?? outputTokens);
      guardContext({ systemPrompt: systemPromptFor(currentStable), messages: [{ role: 'user', content: userPrompt }], tools: session.agent.state.tools });
      await session.prompt(userPrompt, { expandPromptTemplates: false });
      await eventQueue;
      while (pendingRejection && !fatal) {
        signal.throwIfAborted();
        const failed = session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1);
        if (!failed || failed.type !== 'message' || failed.message.role !== 'assistant' || !isContextRejection(failed.message)) throw new Error('context_recovery_identity_mismatch');
        await contextManager.archive(PROVIDER_REJECTION, { entryId: failed.id, reason: 'context_length_exceeded' });
        try {
          circuit.begin();
          await contextManager.archive('cwatch.reactive_compact', { stage: 'started', rejectedEntryId: failed.id, ...circuit.snapshot() });
          const next = await hooks.beforeModel();
          currentStable = next.stable;
          outputTokens = next.maxOutputTokens ?? 4096;
          const activeBindings = revisingResponse ? [] : next.tools.filter(binding => bindings.get(binding.proxy_name)?.id === binding.id);
          session.setActiveToolsByName(activeBindings.map(binding => binding.proxy_name));
          contextManager.setToolResultPolicy(resultPolicy(activeBindings));
          session.agent.state.systemPrompt = systemPromptFor(next.stable);
          const before = { systemPrompt: session.agent.state.systemPrompt, tools: session.agent.state.tools, messages: getMessagesAfterCompactBoundary(session.sessionManager) };
          const active = await contextManager.prepare(before, runtime, model, outputTokens, signal, true);
          if (JSON.stringify(active).length >= JSON.stringify(before).length) throw new Error('context_recovery_unavailable: no reducible history; refusing an identical retry');
          session.agent.state.messages = active.messages;
          const allowance = await hooks.beforeRequest?.('turn');
          outputTokens = Math.min(outputTokens, allowance?.maxOutputTokens ?? outputTokens);
          guardContext(active); contextManager.guardWindow(active, model, outputTokens);
          await contextManager.archive('cwatch.reactive_compact', { stage: 'retry', charsBefore: JSON.stringify(before).length, charsAfter: JSON.stringify(active).length, ...circuit.snapshot() });
          pendingRejection = false;
          // SDK continuation resumes the unfulfilled provider request; completed tools stay completed.
          await session.agent.continue();
          await eventQueue;
          if (fatal) throw fatal;
          if (!pendingRejection) await contextManager.archive('cwatch.reactive_compact', { stage: 'recovered', ...circuit.snapshot() });
        } catch (error) {
          circuit.failed();
          await contextManager.archive('cwatch.reactive_compact', { stage: 'stopped', error: String(error), ...circuit.snapshot() });
          throw error;
        }
      }
      signal.throwIfAborted();
      if (fatal) throw fatal;
      if (!terminal) throw new Error('no_progress: session ended without a verified response');
      await contextManager.flush();
      if (revisionLength !== undefined && responseCharacterLimit !== undefined) {
        await contextManager.archive('cwatch.response_revision', { length: revisionLength, limit: responseCharacterLimit });
        const next = await hooks.beforeModel();
        currentStable = next.stable;
        outputTokens = next.maxOutputTokens ?? 4096;
        session.setActiveToolsByName([]);
        contextManager.setToolResultPolicy(resultPolicy([]));
        const target = Math.max(1, Math.floor(responseCharacterLimit * 0.7));
        userPrompt = `The previous draft has ${revisionLength} non-whitespace characters. Rewrite it to fit the user's maximum of ${responseCharacterLimit}; aim for ${target}. Preserve every requested part, language, format, and essential evidence. State each value and scope once. Return only the revised answer, without calling tools.`;
        revisionLength = undefined;
        revisingResponse = true;
        prepareUserPrompt = true;
        continue;
      }
      if (!hooks.nextUserMessage) break;
      const message = await hooks.nextUserMessage();
      signal.throwIfAborted();
      if (message === null) break;
      if (!message.trim() || message.length > 24000) throw new Error('invalid_user_message');
      const next = await hooks.beforeModel();
      currentStable = next.stable; outputTokens = next.maxOutputTokens ?? 4096;
      const activeBindings = next.tools.filter(binding => bindings.get(binding.proxy_name)?.id === binding.id);
      session.setActiveToolsByName(activeBindings.map(binding => binding.proxy_name));
      contextManager.setToolResultPolicy(resultPolicy(activeBindings));
      userPrompt = message; prepareUserPrompt = true; revisingResponse = false;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await session.abort();
      await eventQueue;
      await contextManager.flush();
    } finally { unsubscribe(); session.dispose(); }
  }
}
