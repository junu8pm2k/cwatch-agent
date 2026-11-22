import type { AgentTask, Plan } from './domain.ts';
import type { Mode } from './permissions.ts';

export type RunStatus = 'preparing' | 'running' | 'awaiting_approval' | 'awaiting_user' | 'cancelling' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'unknown';
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface RunMessageInput { messageId: string; text: string }
export interface RunActivity { sequence: number; timestamp: string; kind: 'system' | 'plan' | 'tool' | 'approval' | 'analysis' | 'error'; message: string; detail?: string; tool?: string; state?: string }
export interface PendingRunApproval { requestId: string; taskId: string; tool: string; argsHash: string; argsSummary: string; createdAt: string; expiresAt: string }
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
export interface RunComparisonSummary { eventId: string; status: 'new' | 'unchanged' | 'updated'; previousVersions: string[]; currentVersions: string[]; title?: string; signalType?: string }
export interface RunSnapshot {
  id: string; task: AgentTask; profile: string; mode: 'live' | 'replay'; permission: Mode; status: RunStatus;
  createdAt: string; updatedAt: string; endedAt?: string; traceRunId?: string; error?: string;
  activities: RunActivity[]; approvals: PendingRunApproval[]; gaps: string[]; claims: RunClaim[];
  toolCalls: number; modelTurns: number; totalTokens: number; reportReady: boolean; stage: number;
  conversation?: boolean; messages?: ConversationMessage[]; revision?: number;
  plan?: Plan; review?: RunReviewSummary; comparisons?: RunComparisonSummary[]; reworkCount?: number;
}
export interface RunProfile { id: string; name: string; description: string; task: AgentTask; sources: Array<{ slug: string; name: string; channel: string; active: boolean }> }
export interface RunStartInput { profile: string; mode: 'live' | 'replay'; permission: Mode; conversation?: boolean; task?: AgentTask; skills?: string[]; webDomains?: string[]; limits?: { timeoutMs?: number; toolTimeoutMs?: number; maxTokens?: number; maxSteps?: number; maxToolCalls?: number; maxSameToolCalls?: number } }
export interface BuiltinSourceSummary { slug: string; name: string; channel: string; active: boolean; profiles: string[] }
export interface McpServerSummary { slug: string; enabled: boolean; transport: string; endpoint?: string; defaultAction: string; resultFormat: string; toolSemanticsCount: number; hasAuth: boolean }
export interface BuiltinSkillSummary { name: string; description: string; resources: string[] }
export interface UserSkillSummary { name: string; description: string; enabled: boolean; originKind: 'local' | 'github'; installedAt: string; fileCount: number }
export interface WorkbenchExtensions { builtinSources: BuiltinSourceSummary[]; mcpServers: McpServerSummary[]; builtinSkills: BuiltinSkillSummary[]; userSkills: UserSkillSummary[] }
export interface SkillDetail { name: string; kind: 'builtin' | 'user'; description: string; enabled: boolean; body: string; resources: string[]; installedAt?: string; origin?: { kind: 'local' } | { kind: 'github'; repo: string; ref: string; path: string; commit: string } }
export interface McpTestResult { slug: string; ok: boolean; durationMs: number; tools: Array<{ name: string; description: string; action: string }>; error?: string }
export interface WorkbenchBootstrap { csrfToken: string; model: { configured: boolean; provider: string; id: string }; profiles: RunProfile[]; skills: Array<{ name: string; description: string; enabled: boolean }>; runs: RunSnapshot[]; maxConcurrentRuns?: number }
