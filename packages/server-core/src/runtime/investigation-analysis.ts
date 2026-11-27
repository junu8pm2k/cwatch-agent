import { z } from 'zod';
import type { Plan } from '@cwatch/core/types';
import type { Claim, Review } from '@cwatch/shared/intelligence/evidence';
import { recheckSchema } from './investigation-progress.ts';

export const reviewDimensions = ['scope', 'source_identity', 'citation', 'evidence_support', 'conflicts_and_gaps', 'report_consistency'] as const;
const findingSchema = z.object({ questionId: z.string(), status: z.enum(['verified', 'conflict', 'insufficient']), conclusion: z.string().trim().min(1).max(700), claimIds: z.array(z.string()).max(24) }).strict();
export const submitAnalysisSchema = z.object({ findings: z.array(findingSchema).min(1).max(12) }).strict();
export type Finding = z.infer<typeof findingSchema>;
const checkSchema = z.object({ dimension: z.enum(reviewDimensions), status: z.enum(['pass', 'not_applicable', 'issue']), correction: z.string().trim().min(1).max(500).optional() }).strict();
export const reviewAnalysisSchema = z.object({ assessments: z.array(z.object({ questionId: z.string(), checks: z.array(checkSchema).length(reviewDimensions.length) }).strict()).min(1).max(12), recheck: recheckSchema.optional() }).strict();
export type ReviewAssessment = z.infer<typeof reviewAnalysisSchema>['assessments'][number];

function requireExactly(actual: string[], expected: string[], error: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) throw Error(error);
}

export function submitFindings(plan: Plan, claims: Claim[], raw: unknown): Finding[] {
  const { findings } = submitAnalysisSchema.parse(raw);
  requireExactly(findings.map(finding => finding.questionId), plan.questions!.map(question => question.id), 'analysis_requires_every_plan_question');
  const known = new Map(claims.map(claim => [claim.id, claim]));
  for (const finding of findings) {
    if (new Set(finding.claimIds).size !== finding.claimIds.length || finding.claimIds.some(id => !known.has(id))) throw Error('analysis_unknown_or_duplicate_claim');
    if (finding.status === 'verified' && (!finding.claimIds.length || finding.claimIds.some(id => !known.get(id)?.evidenceIds.length))) throw Error('analysis_verified_requires_evidence');
  }
  return findings;
}

export function inspectFindings(raw: unknown, findings: Finding[], claims: Claim[], structuralReview: Review) {
  const { assessments, recheck } = reviewAnalysisSchema.parse(raw);
  requireExactly(assessments.map(assessment => assessment.questionId), findings.map(finding => finding.questionId), 'review_requires_every_plan_question');
  const inspected = findings.map(finding => {
    const { checks } = assessments.find(assessment => assessment.questionId === finding.questionId)!;
    requireExactly(checks.map(check => check.dimension), [...reviewDimensions], 'review_requires_every_dimension');
    const linked = claims.filter(claim => finding.claimIds.includes(claim.id));
    const evidenceIds = [...new Set(linked.flatMap(claim => claim.evidenceIds))];
    const machineIssues = structuralReview.issues.filter(issue => linked.some(claim => [claim.id, claim.eventId, ...claim.evidenceIds].includes(issue.slice(issue.indexOf(':') + 1))));
    for (const check of checks) {
      if (check.status === 'issue' && !check.correction) throw Error('review_issue_requires_correction');
      if (finding.status === 'verified' && check.status === 'not_applicable') throw Error('review_verified_requires_all_dimensions');
    }
    const flagged = checks.filter(check => check.status === 'issue');
    const fixes = [
      ...flagged.map(check => ({ dimension: check.dimension, correction: check.correction!, claimIds: finding.claimIds, evidenceIds })),
      ...machineIssues.map(issue => ({ dimension: (issue.startsWith('counter_') || issue.startsWith('conflicting_') ? 'conflicts_and_gaps' : /^(?:community_only|forum_identity_unverified):/.test(issue) ? 'source_identity' : 'citation') as typeof reviewDimensions[number], correction: issue, claimIds: finding.claimIds, evidenceIds })),
    ];
    const effective = fixes.length
      ? { ...finding, status: finding.status === 'conflict' || machineIssues.some(issue => /counter_evidence|conflicting_supported/.test(issue)) ? 'conflict' as const : 'insufficient' as const,
        claimIds: [], conclusion: '暂缓原结论。' + fixes.map(fix => fix.correction).join('。') }
      : finding;
    return { questionId: finding.questionId, checks, fixes, finding: effective };
  });
  if (recheck && !inspected.some(row => row.questionId === recheck.questionId && (row.finding.status !== 'verified' || row.fixes.length))) throw Error('recheck_requires_unresolved_question');
  const approvedIds = new Set(inspected.filter(row => row.finding.status === 'verified' && !row.fixes.length).flatMap(row => row.finding.claimIds));
  for (const row of inspected.filter(row => row.fixes.length)) for (const fix of row.fixes) for (const id of fix.claimIds) approvedIds.delete(id);
  const effective = inspected.map(row => row.finding.status === 'verified' && row.finding.claimIds.some(id => !approvedIds.has(id))
    ? { ...row.finding, status: 'insufficient' as const, claimIds: [], conclusion: '关联主张存在未解决的审查问题。' } : row.finding);
  const ids = new Set(effective.filter(finding => finding.status === 'verified').flatMap(finding => finding.claimIds));
  const issues = [...structuralReview.issues, ...inspected.flatMap(row => row.fixes.map(fix => `${row.questionId}:${fix.dimension}:${fix.correction}`)),
    ...effective.filter(finding => finding.status !== 'verified').map(finding => `${finding.questionId}:${finding.status}`)];
  const review: Review = { ...structuralReview, decision: issues.length ? 'needs_evidence' : 'accept', issues: [...new Set(issues)] };
  return { review, assessments: inspected.map(({ finding: _finding, ...row }) => row), findings: effective, claimIds: claims.filter(claim => ids.has(claim.id)).map(claim => claim.id), recheck };
}
