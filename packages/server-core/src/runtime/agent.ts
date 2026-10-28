import { GenericTaskSchema, type RetrievalResult } from '@cwatch/core/types';
import { loadAgentSkill } from '@cwatch/shared/agent/core/prompt-builder';
import { runTask, type AgentRuntimeOptions } from './task-runtime.ts';
import { SessionTools } from './session-tools.ts';
export { replayState, type AgentRuntimeOptions, type RunResult } from './task-runtime.ts';

/** A task and selected Skills drive the loop; no investigation milestones are required. */
export function runAgent(rawTask: unknown, model: Parameters<typeof runTask>[1], registry: Parameters<typeof runTask>[2], store: Parameters<typeof runTask>[3], mode: 'live' | 'replay', options: AgentRuntimeOptions = {}, signal = new AbortController().signal, policy?: Parameters<typeof runTask>[8], approvals?: Parameters<typeof runTask>[9]) {
  const task = GenericTaskSchema.parse(rawTask);
  return runTask(task, model, registry, store, mode, options, context => {
    const gaps = [...(options.initialGaps ?? [])];
    const client = new SessionTools(task, registry, options.userSkills, context.transcript, context.workingState, context.memory);
    return { slug: 'session', channel: 'builtin', client, gaps,
      skill: () => loadAgentSkill(options.skillPath), skillPath: options.skillPath ?? 'skills/general-agent/SKILL.md', skillName: 'general-agent',
      onObservation: (name, value) => {
        const result = value as Partial<RetrievalResult> & { isError?: boolean; status?: string } | null;
        if (result && (result.isError === true || ['tool_failed', 'auth_failed', 'rate_limited', 'timeout', 'parse_failed', 'cancelled', 'unknown'].includes(String(result.status)))) gaps.push('tool_failed:' + name);
      },
      finish: text => {
        const report = 'responses/' + context.trace.runId + '.md';
        store.text(report, text);
        return { status: gaps.length ? 'partial' : 'complete', response: text, report };
      },
    };
  }, signal, policy, approvals);
}
