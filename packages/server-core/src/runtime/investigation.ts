import { parseTask, type Plan } from '@cwatch/core/types';
import { loadInvestigationSkill } from '@cwatch/shared/agent/core/prompt-builder';
import { runTask, type AgentRuntimeOptions } from './task-runtime.ts';
import { InvestigationWorkflow } from './investigation-workflow.ts';
export { replayState, type RunResult } from './task-runtime.ts';
export interface RuntimeOptions extends AgentRuntimeOptions { onPlanSubmitted?: (plan: Plan, path: string) => Promise<void> }
/** The investigation is an optional domain template over the common task runtime. */
export function runInvestigation(rawTask: unknown, model: Parameters<typeof runTask>[1], registry: Parameters<typeof runTask>[2], store: Parameters<typeof runTask>[3], mode: 'live' | 'replay', options: RuntimeOptions = {}, signal = new AbortController().signal, policy?: Parameters<typeof runTask>[8], approvals?: Parameters<typeof runTask>[9]) {
  const task = parseTask(rawTask);
  return runTask(task, model, registry, store, mode, options, context => {
    const workflow = new InvestigationWorkflow(task, context.state, registry, store, context.trace, mode, { ...options, ...context.options }, context.transcript, context.workingState, context.memory);
    return { slug: 'workflow', channel: 'workflow', client: workflow, gaps: workflow.gaps, checkpoint: workflow,
      skill: () => loadInvestigationSkill(options.skillPath), skillPath: options.skillPath ?? 'skills/competitor-investigation/SKILL.md', skillName: 'competitor-investigation',
      completionInstruction: 'Do not finish before workflow__draft succeeded.',
      checkPrerequisites: binding => binding.action === 'collect' && !workflow.submitted ? { allowed: false, blockReason: 'plan_required_before_collection' }
        : binding.action === 'collect' && workflow.analyzed ? { allowed: false, blockReason: 'collection_after_analysis_requires_new_run' } : { allowed: true },
      finish: () => { if (!workflow.drafted) throw new Error('no_progress: response_before_verified_draft');
        return { status: workflow.gaps.length || workflow.review.decision !== 'accept' ? 'partial' : 'complete', report: workflow.report }; },
    };
  }, signal, policy, approvals);
}
