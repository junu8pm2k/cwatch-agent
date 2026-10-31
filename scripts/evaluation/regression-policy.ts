export const REGRESSION_POLICY = { trials: 5, minimumScore: 100, requireAllRubricPass: true, requireConfirmedBaseline: true } as const;

interface Trial {
  attempt: number; runId: string | null; runStatus: string | null;
  automatic: { complete: boolean; passed: boolean; score: number | null; dimensions: Array<{ llm: string }> } | null;
  codeChecks: Array<{ required: boolean; hardFail: boolean; outcome: string }>;
  judge: { status: string; answer: { findings: Array<{ verdict: string }> } | null } | null;
  human: { answer: { judgments: Array<{ verdict: string }>; processChecks: Array<{ verdict: string }> } | null } | null;
  adjudications?:Array<{input:{findings:Array<{verdict:string}>}}>;
}
interface CaseRow { caseId: string; baseline: { status: string }; trials: Trial[] }
/** CI checks only the explicitly assigned automatic range; it never invents human approvals. */
export function assessRegressionBatch(report: { cases: CaseRow[] }) {
  const cases = report.cases.map(c => {
    const scheduled = c.trials.length === REGRESSION_POLICY.trials && new Set(c.trials.map(t => t.attempt)).size === REGRESSION_POLICY.trials &&
      new Set(c.trials.map(t => t.runId).filter(Boolean)).size === REGRESSION_POLICY.trials &&
      Array.from({ length: REGRESSION_POLICY.trials }, (_, i) => i + 1).every(attempt => c.trials.some(t => t.attempt === attempt));
    const trials = c.trials.map(t => {
      const reasons: string[] = [];
      const required = t.codeChecks.filter(check => check.required || check.hardFail);
      const needsJudge = t.automatic?.dimensions.some(d => d.llm !== 'not_applicable') ?? false;
      const findings = t.judge?.answer?.findings ?? [];
      const humanFindings = [...(t.human?.answer?.judgments ?? []), ...(t.human?.answer?.processChecks ?? [])];
      const humanRejected=t.adjudications?.some(r=>r.input.findings.some(f=>f.verdict==='fail'))??false;
      const knownFailure = t.runStatus === 'failed' || t.runStatus === 'cancelled' || required.some(check => check.outcome === 'fail') ||
        findings.some(f => f.verdict === 'fail') || humanFindings.some(f => f.verdict === 'fail') || humanRejected ||
        (typeof t.automatic?.score === 'number' && t.automatic.score < REGRESSION_POLICY.minimumScore);
      if (t.runStatus !== 'complete') reasons.push('execution_not_complete');
      if (!t.automatic?.complete || !t.automatic.passed || t.automatic.score !== REGRESSION_POLICY.minimumScore) reasons.push('automatic_score_must_be_100');
      if (!required.length || required.some(check => check.outcome !== 'pass')) reasons.push('code_checks_not_all_pass');
      if (needsJudge && (t.judge?.status !== 'completed' || !findings.length || findings.some(f => f.verdict !== 'pass'))) reasons.push('rubric_not_all_pass');
      if (humanFindings.some(f => f.verdict === 'fail')) reasons.push('human_review_failed');
      if (humanRejected) reasons.push('human_criterion_rejected');
      return { attempt: t.attempt, runId: t.runId, score: t.automatic?.score ?? null, passed: reasons.length === 0, knownFailure, reasons };
    });
    const baselineConfirmed = c.baseline.status === 'confirmed';
    const passed = scheduled && baselineConfirmed && trials.every(t => t.passed);
    const knownFailure = trials.some(t => t.knownFailure) || ['invalid', 'incompatible'].includes(c.baseline.status);
    return { caseId: c.caseId, scheduled, baselineConfirmed, passed, score: passed ? 100 : knownFailure ? 0 : null,
      passedTrials: trials.filter(t => t.passed).length, failedTrials: trials.filter(t => t.knownFailure).length,
      pendingTrials: trials.filter(t => !t.passed && !t.knownFailure).length, trials };
  });
  const passed = cases.length > 0 && cases.every(c => c.passed);
  return { schemaVersion: 'cwatch.regression-gate.v1', scope: 'automatic_regression', policy: REGRESSION_POLICY,
    passed, score: passed ? 100 : cases.some(c => c.score === 0) ? 0 : null, cases,
    note: 'Automatic regression gate only. No human review is requested; historical records are retained. One failing trial makes this case score zero.' };
}
