import type { CompetitorTask, Decision } from '@cwatch/core/types';

export const releaseUrl = 'https://nodejs.org/en/blog/release/v24.0.0';
export const reviewChecks = ['scope', 'source_identity', 'citation', 'evidence_support', 'conflicts_and_gaps', 'report_consistency'].map(dimension => ({ dimension, status: 'pass' }));

export function investigationDecisions(task: CompetitorTask): Decision[] {
  const tracked = Boolean(task.evidencePolicy), url = task.evidencePolicy?.sources[0]?.url ?? releaseUrl;
  return [
    { kind: 'call_tool', name: 'workflow__save_plan', args: { taskId: task.taskId, objective: 'Protocol fixture investigation', sources: task.allowedSources, queries: ['Node.js releases'], evidenceRequirements: ['URL', 'publication time', 'fixture provenance'], window: { start: task.window.start, end: task.window.end }, ...(tracked ? { questions: [{ id: 'release', question: '哪个版本已发布？', candidatesRequired: 1 }] } : {}) } },
    { kind: 'call_tool', name: 'web_fetch', args: { url } },
    ...(tracked ? [{ kind: 'call_tool' as const, name: 'workflow__assess_search', args: { questionId: 'release', candidateUrls: [url] } }] : []),
    { kind: 'call_tool', name: 'workflow__analyze', args: {} },
    ...(tracked ? [{ kind: 'call_tool' as const, name: 'workflow__submit_analysis', args: {} }] : []),
    { kind: 'call_tool', name: 'workflow__review', args: tracked ? { assessments: [{ questionId: 'release', checks: reviewChecks }] } : {} },
    { kind: 'call_tool', name: 'workflow__draft', args: { narrative: 'Synthetic real-SDK web investigation.', claimIds: [] } },
    { kind: 'respond', text: 'Fixture report saved.' },
  ];
}

export function resolveInvestigationDecision(decision: Decision, tracked: boolean, observation: (name: string) => unknown): Decision {
  if (decision.kind !== 'call_tool' || !['workflow__submit_analysis', 'workflow__draft'].includes(decision.name)) return decision;
  const analyzed = observation('workflow__analyze') as { claims: Array<{ id: string }> };
  const ids = analyzed.claims.map(claim => claim.id);
  const reviewed = observation('workflow__review') as { approvedClaimIds?: string[] } | undefined;
  return { ...decision, args: decision.name === 'workflow__submit_analysis'
    ? { findings: [{ questionId: 'release', status: ids.length ? 'verified' : 'insufficient', conclusion: ids.length ? '已核验 Node.js 24 发布。' : '缺少证据。', claimIds: ids }] }
    : { ...decision.args, claimIds: tracked ? reviewed?.approvedClaimIds ?? [] : ids } };
}
