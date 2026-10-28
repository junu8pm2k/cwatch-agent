import { type AgentTask, type ToolBinding } from "@cwatch/core/types";
import { type ActionPolicy, type Verdict } from "./permission-manager.ts";
import { type ToolRegistry } from "../../tools/registry.ts";

export interface PrerequisiteManagerLike {
  checkPrerequisites(binding: ToolBinding, input: Record<string, unknown>): { allowed: boolean; blockReason?: string };
}
export interface PreToolUseInput {
  toolName: string;
  input: Record<string, unknown>;
  task: AgentTask;
  binding: ToolBinding;
  registry: ToolRegistry;
  policy: ActionPolicy;
  prerequisiteManager?: PrerequisiteManagerLike;
}
export type PreToolUseCheckResult =
  | { type: 'allow'; reason: string }
  | { type: 'block'; reason: string; source: 'binding' | 'policy' | 'prerequisite' }
  | { type: 'prompt'; reason: string; promptType: 'mutation'; description: string };

/** Craft-style shared synchronous pipeline. It never executes tools or grants approvals. */
export function runPreToolUseChecks(ctx: PreToolUseInput): PreToolUseCheckResult {
  if (ctx.binding.proxy_name !== ctx.toolName) return { type: 'block', source: 'binding', reason: 'binding_name_mismatch' };
  try {
    // ActionPolicy reads the host mode and validates schema, source state, binding and task scope.
    const verdict = ctx.policy.decide(ctx.task, ctx.binding, ctx.input, ctx.registry);
    if (verdict.decision === 'BLOCK') return { type: 'block', source: 'policy', reason: verdict.reason };
    const sourcePrerequisite = ctx.registry.checkPrerequisites(ctx.binding, ctx.input);
    if (sourcePrerequisite) return { type: 'block', source: 'prerequisite', reason: sourcePrerequisite };
    const effective = { ...ctx.binding, action: ctx.registry.resolveAction(ctx.binding, ctx.input, ctx.task) };
    const prerequisite = ctx.prerequisiteManager?.checkPrerequisites(effective, ctx.input);
    if (prerequisite && !prerequisite.allowed) return { type: 'block', source: 'prerequisite', reason: prerequisite.blockReason ?? 'prerequisite_required' };
    if (verdict.decision === 'APPROVAL') return { type: 'prompt', reason: verdict.reason, promptType: 'mutation', description: effective.action + ': ' + ctx.toolName };
    return { type: 'allow', reason: verdict.reason };
  } catch (error) {
    return { type: 'block', source: 'policy', reason: 'pre_tool_check_failed: ' + String(error) };
  }
}
export function toPolicyVerdict(result: PreToolUseCheckResult): Verdict {
  return { decision: result.type === 'allow' ? 'ALLOW' : result.type === 'prompt' ? 'APPROVAL' : 'BLOCK', reason: result.reason };
}
