import type { AgentTask, Plan } from './domain.ts';
import type { Mode } from './permissions.ts';

export type RunStatus = 'preparing' | 'running' | 'awaiting_approval' | 'awaiting_user' | 'cancelling' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'unknown';
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface RunMessageInput { messageId: string; text: string }
export interface WorkbenchProject { id: string; name: string; createdAt: string }
export interface ReportAnnotation { id: string; quote: string; note: string; replacement?: string; createdAt: string }
export interface ReportReviewSummary { revision: number; savedRevision?: number; savedAt?: string }
export interface ReportReviewView extends ReportReviewSummary { markdown: string; annotations: ReportAnnotation[]; messages: ConversationMessage[] }
export interface ReportAnnotationInput { revision: number; quote: string; note: string; replacement?: string }
export interface RunActivity { sequence: number; timestamp: string; kind: 'system' | 'plan' | 'tool' | 'approval' | 'analysis' | 'error'; message: string; detail?: string; tool?: string; state?: string; stage?: number }
export interface PendingRunApproval { requestId: string; taskId: string; tool: string; argsHash: string; argsSummary: string; createdAt: string; expiresAt: string }
export interface PlanApprovalProgress {
  status: 'preparing' | 'pending' | 'revising' | 'approved' | 'stopped';
  feedback?: string;
}
export interface RunClaimEvidence {
  source: string;
  url: string;
  title: string;
  publishedAt: string | null;
  provenance: string;
  retrievedAt?: string;
  excerpt?: string;
  domain?: string;
  snapshotHash?: string;
  snapshotVerified?: boolean;
  attribution?: 'matched' | 'ambiguous' | 'wrong_entity';
  timeStatus?: 'in_window' | 'out_of_window' | 'unknown_time';
}
export interface RunClaim { id: string; text: string; evidence: RunClaimEvidence[] }
export interface RunReviewSummary { decision: 'accept' | 'needs_evidence' | 'reject'; issues: string[]; evidenceRefs: string[] }
export interface InvestigationAssessment {
  collection?: { specifiedCoverage: { attempted: number; total: number }; candidateCoverage: { covered: number; total: number };
    sources: Array<{ url: string; kind: string; status: string }>;
    questions: Array<{ questionId: string; question: string; required: number; stopReason: string; candidates: Array<{ url: string; status: string }>; rounds: Array<{ query: string; strategy: string; returned: number; newCandidates: number | null; failed?: boolean }> }> };
  findings?: Array<{ questionId: string; status: 'verified' | 'conflict' | 'insufficient'; conclusion: string; claimIds: string[] }>;
  analysisCoverage?: { questions: { processed: number; total: number }; evidence: { linked: number; total: number } };
  review?: Array<{ questionId: string; checks: Array<{ dimension: string; status: string; correction?: string }>; fixes: Array<{ dimension: string; correction: string; claimIds: string[]; evidenceIds: string[] }> }>;
}
export interface RunComparisonSummary { eventId: string; status: 'new' | 'unchanged' | 'updated'; previousVersions: string[]; currentVersions: string[]; title?: string; signalType?: string }
export const reasoningEfforts = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export interface RunModelChoice { id: string; provider?: string; reasoningEffort?: ReasoningEffort }
export interface TaskIntentInput { instruction: string; model?: RunModelChoice }
export type TaskIntent = { kind: 'agent'; needsWeb: boolean } | { kind: 'investigation'; competitor: string | null; product: string | null };
export interface ModelProviderSummary { provider: string; modelIds: string[]; supportsReasoningEffort: boolean }
export interface WorkbenchModel {
  configured: boolean; provider: string; id: string; availableIds: string[];
  supportsReasoningEffort: boolean; providers: ModelProviderSummary[];
}
export interface SearchConnectionSummary { source: 'workbench' | 'environment' | 'none'; url?: string; fetchUrl?: string; protocol?: 'auto' | 'mcp' | 'rest'; hasToken?: boolean }
export interface RunSnapshot {
  id: string; task: AgentTask; profile: string; mode: 'live' | 'replay'; permission: Mode; status: RunStatus;
  createdAt: string; updatedAt: string; endedAt?: string; traceRunId?: string; error?: string;
  activities: RunActivity[]; approvals: PendingRunApproval[]; gaps: string[]; claims: RunClaim[];
  toolCalls: number; modelTurns: number; totalTokens: number; reportReady: boolean; stage: number;
  conversation?: boolean; messages?: ConversationMessage[]; revision?: number;
  model?: RunModelChoice;
  projectId?: string;
  title?: string;
  reportReview?: ReportReviewSummary;
  plan?: Plan; review?: RunReviewSummary; comparisons?: RunComparisonSummary[]; reworkCount?: number;
  planApproval?: PlanApprovalProgress;
  assessment?: InvestigationAssessment;
  stoppedAtStage?: string;
}
export interface RunProfile { id: string; name: string; description: string; task: AgentTask; sources: Array<{ slug: string; name: string; channel: string; active: boolean }> }
export interface RunStartInput { profile: string; mode: 'live' | 'replay'; permission: Mode; conversation?: boolean; requirePlanApproval?: boolean; task?: AgentTask; projectId?: string; skills?: string[]; webDomains?: string[]; model?: RunModelChoice; limits?: { timeoutMs?: number; toolTimeoutMs?: number; maxTokens?: number; maxSteps?: number; maxToolCalls?: number; maxSameToolCalls?: number; maxConsecutiveToolFailures?: number } }
export interface BuiltinSourceSummary { slug: string; name: string; channel: string; active: boolean; profiles: string[] }
export interface McpServerSummary { slug: string; enabled: boolean; transport: string; endpoint?: string; defaultAction: string; resultFormat: string; toolSemanticsCount: number; hasAuth: boolean }
export interface BuiltinSkillSummary { name: string; description: string; resources: string[] }
export interface UserSkillSummary { name: string; description: string; enabled: boolean; originKind: 'local' | 'github'; installedAt: string; fileCount: number }
export interface WorkbenchExtensions { builtinSources: BuiltinSourceSummary[]; mcpServers: McpServerSummary[]; builtinSkills: BuiltinSkillSummary[]; userSkills: UserSkillSummary[]; search: SearchConnectionSummary }
export interface SkillDetail { name: string; kind: 'builtin' | 'user'; description: string; enabled: boolean; body: string; resources: string[]; installedAt?: string; origin?: { kind: 'local' } | { kind: 'github'; repo: string; ref: string; path: string; commit: string } }
export interface McpTestResult { slug: string; ok: boolean; durationMs: number; tools: Array<{ name: string; description: string; action: string }>; error?: string }
export interface WorkbenchBootstrap { csrfToken: string; model: WorkbenchModel; profiles: RunProfile[]; skills: Array<{ name: string; description: string; enabled: boolean }>; runs: RunSnapshot[]; projects: WorkbenchProject[]; maxConcurrentRuns?: number }
