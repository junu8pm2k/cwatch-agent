import { createAgentSession, SessionManager, SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ExplicitResourceLoader } from './explicit-resources.ts';
import { decodePiMessage } from "../../models.ts";
import { type AgentSessionHooks, type ModelInput } from "@cwatch/core/types";
import { buildProxyTools, wrapToolsWithHooks } from "./tool-hooks.ts";
import { PiContextManager, getMessagesAfterCompactBoundary } from './context.ts';
import { assertCompleteApiRounds } from './api-rounds.ts';
import { providerRejectionReason, PROVIDER_REJECTION, ReactiveCompactCircuit } from './provider-rejections.ts';
import { type ProviderRejectionReason } from '../../events.ts';
import { remainingToolBudget, reportedTokens, toolBudgetSkip } from '../../core/budgets.ts';
import { STEP5_INITIAL_OUTPUT_TOKENS, usesStep5ReasoningEffort } from './stepfun.ts';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
const TRUNCATION_RETRY_INSTRUCTION = '\nThe previous attempt reached its output token limit. Use brief reasoning and emit only the next necessary tool action with concise arguments, or the complete answer if the task is ready. Preserve the task scope and all workflow requirements.';

/** SDK owns the live loop. Host callbacks own business meaning and execution policy. */
export async function runPiSession(runtime: ModelRuntime, model: Model, input: ModelInput, hooks: AgentSessionHooks, signal: AbortSignal, providerMaxRetries = 0): Promise<void> {
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
  let currentToolBudgets = input.toolBudgets ? structuredClone(input.toolBudgets) : undefined;
  let pendingRejection: ProviderRejectionReason | undefined;
  let retryingTruncatedResponse = false;
  const formatBudgetNotice = (toolName: string): string | undefined => {
    const budget = currentToolBudgets;
    if (!budget) return undefined;
    const parts: string[] = [];
    const used = budget.callsByTool[toolName] ?? 0;
    const { sameTool: remSame, available } = remainingToolBudget(budget, toolName);
    const remTotal = Math.max(0, budget.maxToolCalls - budget.toolCalls);
    const lowSame = budget.maxSameToolCalls < budget.maxToolCalls && remSame <= 3;
    if (lowSame || available <= 5) {
      const guidance = remSame === 0
        ? `Do NOT call ${toolName} again; it has reached its per-tool cap. Proceed with other tools or analysis/review/draft.`
        : available === 0
          ? 'Proceed with the available evidence. Any reserved calls are for analysis, review and drafting.'
          : `At most ${Math.min(remSame, available)} more call(s) of ${toolName} are available.`;
      parts.push(`Tool ${toolName}: ${used}/${budget.maxSameToolCalls} used (${remSame} remaining); total tools: ${budget.toolCalls}/${budget.maxToolCalls} (${remTotal} remaining). ${guidance}`);
    }
    if (toolName !== 'workflow__draft' && budget.maxTokens && budget.tokensUsed !== undefined && budget.tokensUsed / budget.maxTokens >= 0.75) {
      const pct = Math.min(100, Math.round((budget.tokensUsed / budget.maxTokens) * 100));
      const remainingTokens = Math.max(0, budget.maxTokens - budget.tokensUsed);
      parts.push(`Token budget: ${budget.tokensUsed}/${budget.maxTokens} (${pct}% used, ${remainingTokens} remaining). Stop extra searches or snapshot reads and proceed directly to analysis/review/draft with current evidence.`);
    }
    return parts.length ? parts.join(' ') : undefined;
  };
  const resolveBindings = (nextTools: ModelInput['tools'], revising: boolean) =>
    revising ? [] : nextTools.filter(binding => bindings.get(binding.proxy_name)?.id === binding.id);
  const circuit = new ReactiveCompactCircuit();
  let eventQueue: Promise<void> = Promise.resolve();
  const customTools = wrapToolsWithHooks(buildProxyTools([...bindings.values()], { ...hooks, executeTool: async (...args) => {
    await eventQueue;
    if (fatal) throw fatal;
    const admission = await hooks.beforeTool?.(args[0], args[4]);
    if (admission) currentToolBudgets = admission.toolBudgets;
    return admission?.skipped ?? hooks.executeTool(...args);
  } }, { formatBudgetNotice }), {
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
  const systemPromptFor = (stable: string) => stable + executionRule + sdkSystemSuffix +
    (retryingTruncatedResponse ? TRUNCATION_RETRY_INSTRUCTION : '');
  const resultPolicy = (tools: ModelInput['tools']) => ({
    canRead: tools.some(binding => binding.proxy_name === 'session__read_tool_result'),
    canReadTranscript: tools.some(binding => binding.proxy_name === 'session__read_transcript'),
    microcompactTools: tools.filter(binding => (binding.action === 'collect' && !binding.dynamicAction) || binding.source_slug === 'pi' && binding.action === 'analyze' || ['session__read_source_guide', 'session__read_skill_resource', 'session__read_tool_result', 'session__read_page_snapshot', 'workflow__read_plan', 'session__read_transcript', 'session__read_session_memory'].includes(binding.proxy_name)).map(binding => binding.proxy_name),
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
    const rejection = event.type === 'message_end' && event.message.role === 'assistant' ? providerRejectionReason(event.message) : undefined;
    // A final answer must stop the SDK loop synchronously, before the host acknowledgement arrives.
    if (event.type === 'message_end' && event.message.role === 'assistant' && (revisingResponse || !event.message.content.some(item => item.type === 'toolCall'))) terminal = !rejection;
    eventQueue = eventQueue.then(async () => {
      await contextManager.flush();
      if (fatal || signal.aborted) return;
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (rejection) {
          pendingRejection = rejection;
          await hooks.onUsage(event.message.usage, 'rejected');
          if (rejection === 'output_token_limit' && reportedTokens(event.message.usage) === undefined) {
            throw new Error('budget_usage_unavailable: truncated response did not report positive token usage');
          }
          return;
        }
        contextManager.recordUsage(event.message.usage);
        await hooks.onUsage(event.message.usage);
        const decision = decodePiMessage(event.message);
        circuit.success();
        retryingTruncatedResponse = false;
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
    // Keep budget-blocked tools available to the dispatcher so it can return the host's
    // skip receipt if a provider emits a call even after the tool was removed from its schema.
    const budget = currentToolBudgets;
    const tools = budget ? originalContext.tools?.filter(tool => !toolBudgetSkip(budget, tool.name)) : originalContext.tools;
    const context = { ...originalContext, systemPrompt: systemPromptFor(currentStable), tools };
    const step5 = usesStep5ReasoningEffort(selected);
    const requestOutputTokens = step5 && !retryingTruncatedResponse ? Math.min(outputTokens, STEP5_INITIAL_OUTPUT_TOKENS) : outputTokens;
    assertCompleteApiRounds(context.messages);
    contextManager.guardWindow(context, selected, requestOutputTokens);
    contextManager.markRequest(context);
    // The provider SDK retries before consuming a response stream, within the same host deadline.
    return originalStream(selected, context, { ...options, maxRetries: providerMaxRetries, maxRetryDelayMs: 5000,
      cacheRetention: input.promptCache ?? 'short', sessionId: input.sessionId ?? session.agent.sessionId,
      ...(retryingTruncatedResponse && step5
        ? { samplingParams: { ...options?.samplingParams, reasoning_effort: 'low' } } : {}),
      maxTokens: Math.min(requestOutputTokens, selected.maxTokens) });
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
      if (fatal || signal.aborted || terminal || pendingRejection) return undefined;
      const next = await hooks.beforeModel();
      currentStable = next.stable;
      outputTokens = next.maxOutputTokens ?? 4096;
      if (next.toolBudgets) currentToolBudgets = structuredClone(next.toolBudgets);
      // New/replaced bindings are not silently granted within an existing session.
      const permitted = resolveBindings(next.tools, revisingResponse);
      session.setActiveToolsByName(permitted.map(binding => binding.proxy_name));
      contextManager.setToolResultPolicy(resultPolicy(permitted));
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
  session.agent.shouldStopAfterTurn = () => Boolean(fatal || signal.aborted || terminal || pendingRejection);
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
        const reason = pendingRejection;
        const failed = session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1);
        if (!failed || failed.type !== 'message' || failed.message.role !== 'assistant' || providerRejectionReason(failed.message) !== reason) throw new Error('provider_recovery_identity_mismatch');
        await contextManager.archive(PROVIDER_REJECTION, { entryId: failed.id, reason });
        const compact = reason === 'context_length_exceeded';
        try {
          if (compact) {
            circuit.begin();
            await contextManager.archive('cwatch.reactive_compact', { stage: 'started', rejectedEntryId: failed.id, ...circuit.snapshot() });
          } else {
            if (retryingTruncatedResponse) throw new Error('model_response_truncated: truncated_response after one recovery attempt (output token limit reached)');
            retryingTruncatedResponse = true;
          }
          const next = await hooks.beforeModel();
          currentStable = next.stable;
          outputTokens = next.maxOutputTokens ?? 4096;
          if (next.toolBudgets) currentToolBudgets = structuredClone(next.toolBudgets);
          const permitted = resolveBindings(next.tools, revisingResponse);
          session.setActiveToolsByName(permitted.map(binding => binding.proxy_name));
          contextManager.setToolResultPolicy(resultPolicy(permitted));
          session.agent.state.systemPrompt = systemPromptFor(next.stable);
          const before = { systemPrompt: session.agent.state.systemPrompt, tools: session.agent.state.tools, messages: getMessagesAfterCompactBoundary(session.sessionManager) };
          const active = compact ? await contextManager.prepare(before, runtime, model, outputTokens, signal, true) : before;
          if (compact && JSON.stringify(active).length >= JSON.stringify(before).length) throw new Error('context_recovery_unavailable: no reducible history; refusing an identical retry');
          session.agent.state.messages = active.messages;
          const allowance = await hooks.beforeRequest?.('turn');
          outputTokens = Math.min(outputTokens, allowance?.maxOutputTokens ?? outputTokens);
          guardContext(active); contextManager.guardWindow(active, model, outputTokens);
          if (compact) await contextManager.archive('cwatch.reactive_compact', { stage: 'retry', charsBefore: JSON.stringify(before).length, charsAfter: JSON.stringify(active).length, ...circuit.snapshot() });
          pendingRejection = undefined;
          // SDK continuation resumes the unfulfilled provider request; completed tools stay completed.
          await session.agent.continue();
          await eventQueue;
          if (fatal) throw fatal;
          if (compact && !pendingRejection) await contextManager.archive('cwatch.reactive_compact', { stage: 'recovered', ...circuit.snapshot() });
        } catch (error) {
          if (compact) {
            circuit.failed();
            await contextManager.archive('cwatch.reactive_compact', { stage: 'stopped', error: String(error), ...circuit.snapshot() });
          }
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
      if (next.toolBudgets) currentToolBudgets = structuredClone(next.toolBudgets);
      const permitted = resolveBindings(next.tools, false);
      session.setActiveToolsByName(permitted.map(binding => binding.proxy_name));
      contextManager.setToolResultPolicy(resultPolicy(permitted));
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
