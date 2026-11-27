import { parseTask, type Plan } from '@cwatch/core/types';
import { loadInvestigationSkill } from '@cwatch/shared/agent/core/prompt-builder';
import { runTask, type AgentRuntimeOptions } from './task-runtime.ts';
import { InvestigationWorkflow } from './investigation-workflow.ts';
export { replayState, type RunResult } from './task-runtime.ts';
export interface RuntimeOptions extends AgentRuntimeOptions { onPlanSubmitted?: (plan: Plan, path: string, signal: AbortSignal) => Promise<void | { feedback: string }> }
const trackedGuidance = `

## Tracked investigation

In save_plan, give each required evidence question a unique ID. Split current and historical facts or other distinct comparisons. Set candidatesRequired to the number of distinct useful URLs the question needs. The host copies specified sources and their policy into the saved plan.

Fetch the specified entry URLs before wider collection. In only mode include one matching site:HOST/PATH per search. Pass questionId and strategy in web_search. Assess each successful search with results using workflow__assess_search and the exact query. Select only returned URLs relevant to the question. Empty results count automatically. To count a useful previously read URL, omit query. Stop searching the question at candidate coverage or after two different successful strategies yielded no new useful URLs. Read chosen candidates, then analyze. Use workflow__collection_status for any pending work. Keep unavailable entries as gaps. Classify forum authorship and retain a verbatim byline for any known role.

After analyze, call submit_analysis with exactly one finding for each required question. Give verified findings claim IDs from the current analysis. For conflicts or insufficient evidence, say what remains unresolved. Comparisons must have matching plans, currency, periods and other material terms. Use review to check scope, source identity, citations, evidence support, conflicts and gaps, and report consistency on every question. For an issue give the necessary correction. Propose one concrete in-scope URL or new query only when it addresses an unresolved question and could materially change the answer. After recheck, repeat analyze, submit_analysis and review. In draft, pass exactly the approvedClaimIds from review. The host uses the reviewed findings as the narrative.`;
/** The investigation is an optional domain template over the common task runtime. */
export function runInvestigation(rawTask: unknown, model: Parameters<typeof runTask>[1], registry: Parameters<typeof runTask>[2], store: Parameters<typeof runTask>[3], mode: 'live' | 'replay', options: RuntimeOptions = {}, signal = new AbortController().signal, policy?: Parameters<typeof runTask>[8], approvals?: Parameters<typeof runTask>[9]) {
  const task = parseTask(rawTask);
  return runTask(task, model, registry, store, mode, options, context => {
    const workflow = new InvestigationWorkflow(task, context.state, registry, store, context.trace, mode, { ...options, ...context.options }, context.transcript, context.workingState, context.memory, context.toolBudgets);
    return { slug: 'workflow', channel: 'workflow', client: workflow, gaps: workflow.gaps, checkpoint: workflow,
      skill: () => loadInvestigationSkill(options.skillPath), skillPath: options.skillPath ?? 'skills/competitor-investigation/SKILL.md', skillName: 'competitor-investigation',
      ...(task.evidencePolicy ? { skillAppendix: trackedGuidance } : {}),
      completionInstruction: 'Do not collect evidence until workflow__save_plan returns submitted=true. If that host tool returns revision_requested, apply its feedback field as the user’s plan revision request within the confirmed task scope, then resubmit the revised plan for approval. Do not finish before workflow__draft succeeded.' + (task.evidencePolicy ? ' Use the tracked workflow: save_plan with questions, directly fetch specified sources, search with questionId and strategy, assess candidate URLs, analyze, submit_analysis, review all six dimensions, and draft exactly the approvedClaimIds.' : ''),
      checkPrerequisites: (binding, input) => {
        if (binding.action !== 'collect') return { allowed: true };
        const reason = !workflow.submitted ? 'plan_required_before_collection'
          : workflow.analyzed && !workflow.canReworkCollect() ? 'collection_after_analysis_requires_new_run'
            : workflow.guardCollection(binding.proxy_name, input);
        return reason ? { allowed: false, blockReason: reason } : { allowed: true };
      },
      onObservation: (name, result, args) => workflow.observeCollection(name, result, args),
      stage: () => workflow.stage(),
      ...(task.evidencePolicy ? { savedDraft: () => workflow.drafted ? workflow.report : undefined } : {}),
      finish: () => { if (!workflow.drafted) throw new Error('no_progress: response_before_verified_draft');
        return { status: workflow.gaps.length || workflow.review.decision !== 'accept' ? 'partial' : 'complete', report: workflow.report }; },
    };
  }, signal, policy, approvals);
}
