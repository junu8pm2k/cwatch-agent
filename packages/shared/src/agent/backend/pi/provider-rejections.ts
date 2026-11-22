import { type SessionManager } from '@earendil-works/pi-coding-agent';
import { ProviderRejectionSchema, type ProviderRejectionReason } from '../../events.ts';

export const PROVIDER_REJECTION = 'cwatch.provider_rejection';
export function providerRejectionReason(message: { stopReason?: string; errorMessage?: string; content?: Array<{ type: string }> }): ProviderRejectionReason | undefined {
  if (isContextRejection(message)) return 'context_length_exceeded';
  // The SDK emits synthetic tool results for truncated batches. Leave those on the
  // existing failure path so recovery never treats them as completed tool rounds.
  if (message.stopReason === 'length' && !message.content?.some(item => item.type === 'toolCall')) return 'output_token_limit';
}

/** Only explicit provider input/context errors with no partial output qualify. */
export function isContextRejection(message: { stopReason?: string; errorMessage?: string; content?: unknown[] }): boolean {
  if (message.stopReason !== 'error' || message.content?.length || !message.errorMessage) return false;
  const text = message.errorMessage;
  if (/\b(?:401|403|429|5\d\d)\b|rate.?limit|throttl|too many requests|tokens per minute|\btpm\b|unauthori[sz]ed|authentication|insufficient.quota|billing|timed? ?out|connection|network|aborted/i.test(text)) return false;
  return /context[_ ]length[_ ]exceeded|prompt (?:is )?too long|input (?:is )?too long|exceeds (?:the )?context window|exceeds (?:the )?(?:model'?s )?maximum context length|maximum context length is [\d,]+|input token count.*exceeds.*maximum|maximum prompt length.*(?:request|tokens)|request_too_large|exceeds the available context size|range of input length should be/i.test(text);
}
/** Failed attempts stay in the native log; only their checked active projection is omitted. */
export function rejectedEntryIds(manager: SessionManager): Set<string> {
  const entries = manager.getEntries(), originals = new Map(entries.map((entry, index) => [entry.id, { entry, index }]));
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) if (entry.type === 'custom' && entry.customType === PROVIDER_REJECTION) {
    const { entryId, reason } = ProviderRejectionSchema.parse(entry.data), original = originals.get(entryId);
    if (!original || original.index >= index || ids.has(entryId) || original.entry.type !== 'message' || original.entry.message.role !== 'assistant' || providerRejectionReason(original.entry.message) !== reason) throw new Error('context_rejection_projection_mismatch');
    ids.add(entryId);
  }
  return ids;
}

export class ReactiveCompactCircuit {
  attempts = 0;
  consecutiveRejections = 0;
  open = false;
  begin(): void {
    this.consecutiveRejections++;
    if (this.open || this.consecutiveRejections >= 2 || this.attempts >= 2) {
      this.open = true;
      throw new Error('context_recovery_circuit_open: repeated rejection or recovery budget exhausted');
    }
    this.attempts++;
  }
  success(): void { this.consecutiveRejections = 0; }
  failed(): void { this.open = true; }
  snapshot() { return { attempts: this.attempts, consecutiveRejections: this.consecutiveRejections, open: this.open }; }
}
