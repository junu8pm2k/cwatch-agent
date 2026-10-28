import type { AgentTask } from './domain.ts';
import type { Mode } from './permissions.ts';

export type RunStatus = 'preparing' | 'running' | 'awaiting_approval' | 'awaiting_user' | 'cancelling' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'unknown';
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface RunMessageInput { messageId: string; text: string }
export interface RunActivity { sequence: number; timestamp: string; kind: 'system' | 'plan' | 'tool' | 'approval' | 'analysis' | 'error'; message: string; detail?: string; tool?: string; state?: string }
export interface PendingRunApproval { requestId: string; taskId: string; tool: string; argsHash: string; argsSummary: string; createdAt: string; expiresAt: string }
export interface RunClaim { id: string; text: string; evidence: Array<{ source: string; url: string; title: string; publishedAt: string | null; provenance: string }> }
export interface RunSnapshot {
  id: string; task: AgentTask; profile: string; mode: 'live' | 'replay'; permission: Mode; status: RunStatus;
  createdAt: string; updatedAt: string; endedAt?: string; traceRunId?: string; error?: string;
  activities: RunActivity[]; approvals: PendingRunApproval[]; gaps: string[]; claims: RunClaim[];
  toolCalls: number; modelTurns: number; totalTokens: number; reportReady: boolean; stage: number;
  conversation?: boolean; messages?: ConversationMessage[]; revision?: number;
}
export interface RunProfile { id: string; name: string; description: string; task: AgentTask; sources: Array<{ slug: string; name: string; channel: string; active: boolean }> }
export interface RunStartInput { profile: string; mode: 'live' | 'replay'; permission: Mode; conversation?: boolean; task?: AgentTask; skills?: string[]; limits?: { timeoutMs?: number; toolTimeoutMs?: number; maxTokens?: number } }
export interface WorkbenchBootstrap { csrfToken: string; model: { configured: boolean; provider: string; id: string }; profiles: RunProfile[]; skills: Array<{ name: string; description: string; enabled: boolean }>; runs: RunSnapshot[] }
