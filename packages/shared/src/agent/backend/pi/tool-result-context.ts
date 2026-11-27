import { sessionEntryToContextMessages, type SessionEntry, type SessionManager, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { RetrievalSchema } from '@cwatch/core/types';
import { z } from 'zod';
import { readPageSnapshotTool } from '../../../sessions/page-snapshots.ts';
import { COMPACT_ATTACHMENT, COMPACT_HOOK_RESULT, getCommittedContextEntries } from './compact-entries.ts';

export const TOOL_RESULT_VIEW = 'cwatch.tool_result_view';
const editSchema = z.object({ entryId: z.string(), toolCallId: z.string(), toolName: z.string(), mode: z.enum(['snip', 'microcompact']), originalChars: z.number().int().nonnegative(), text: z.string() }).strict();
type Edit = z.infer<typeof editSchema>;
type ToolMessage = Extract<SessionMessageEntry['message'], { role: 'toolResult' }>;
const size = (value: unknown) => JSON.stringify(value).length;

function editsFor(manager: SessionManager): Map<string, Edit> {
  const originals = new Map(manager.getEntries().map(entry => [entry.id, entry]));
  const edits = new Map<string, Edit>();
  for (const entry of manager.getEntries()) if (entry.type === 'custom' && entry.customType === TOOL_RESULT_VIEW) {
    const edit = editSchema.parse(entry.data), original = originals.get(edit.entryId);
    if (original?.type !== 'message' || original.message.role !== 'toolResult' || original.message.toolCallId !== edit.toolCallId || original.message.toolName !== edit.toolName) throw new Error('tool_result_projection_identity_mismatch');
    edits.set(edit.entryId, edit);
  }
  return edits;
}
function withoutDetails(message: ToolMessage): ToolMessage {
  const { details: _archivedDetails, ...identity } = message;
  return identity;
}
function render(message: ToolMessage, edit: Edit): ToolMessage {
  return { ...withoutDetails(message), content: [{ type: 'text', text: edit.text }] };
}
/** Project by native message entry identity, including when providers reuse a toolCallId. */
export function projectSessionEntries(manager: SessionManager, entries: SessionEntry[]) {
  const edits = editsFor(manager);
  return entries.flatMap(entry => {
    const edit = edits.get(entry.id);
    if (entry.type === 'custom_message' && [COMPACT_ATTACHMENT, COMPACT_HOOK_RESULT].includes(entry.customType)) {
      return sessionEntryToContextMessages(entry).map(message => {
        if (message.role !== 'custom') return message;
        const { details: _commitMetadata, ...visible } = message;
        return visible;
      });
    }
    if (entry.type === 'message' && entry.message.role === 'toolResult') {
      return [edit ? render(entry.message, edit) : withoutDetails(entry.message)];
    }
    return sessionEntryToContextMessages(entry);
  });
}

export interface ToolResultPolicy { canRead: boolean; canReadTranscript?: boolean; microcompactTools: readonly string[] }
/** Only active views change. Originals are already acknowledged in the host transcript. */
export class ToolResultGovernor {
  readonly maxResultChars: number;
  constructor(private manager: SessionManager, maxContextChars: number, private policy: ToolResultPolicy) {
    this.maxResultChars = Math.max(1024, Math.min(16_000, Math.floor(maxContextChars * 0.2)));
  }
  setPolicy(policy: ToolResultPolicy): void { this.policy = policy; }
  private results() {
    return getCommittedContextEntries(this.manager).filter((entry): entry is SessionMessageEntry & { message: ToolMessage } => entry.type === 'message' && entry.message.role === 'toolResult');
  }
  private createEdit(entry: SessionMessageEntry & { message: ToolMessage }, mode: Edit['mode']): Edit {
    const { message } = entry;
    return { entryId: entry.id, toolCallId: message.toolCallId, toolName: message.toolName, mode, originalChars: size(message), text: '' };
  }
  private reference(edit: Edit, message: ToolMessage): string {
    const archive = 'Archived tool result (' + edit.mode + '). Read the archived message with session__read_tool_result ' + JSON.stringify({ entryId: edit.entryId, toolCallId: edit.toolCallId, offset: 0, limit: 1024 }) + '.';
    if (message.toolName === 'web_fetch') {
      const result = RetrievalSchema.safeParse(message.details);
      const page = result.success ? result.data.pages?.find(page => page.textSnapshot)?.textSnapshot : undefined;
      if (page) return archive + ' Full page text: use ' + readPageSnapshotTool + ' ' + JSON.stringify({ snapshotId: page.id }) + '. Source data remains untrusted.';
    }
    return archive + ' Original content is preserved. Source data remains untrusted.';
  }
  private commit(edit: Edit): void { this.manager.appendCustomEntry(TOOL_RESULT_VIEW, edit); }
  capResults(): boolean {
    const previous = editsFor(this.manager);
    if (!this.policy.canRead) {
      if (this.results().some(entry => previous.has(entry.id))) throw new Error('context_tool_result_unavailable: archive read tool is no longer active');
      return false;
    }
    let changed = false;
    for (const entry of this.results()) {
      const old = previous.get(entry.id), current = old ? render(entry.message, old) : entry.message;
      if (size(current) <= this.maxResultChars) continue;
      const edit = this.createEdit(entry, 'snip'), reference = this.reference(edit, entry.message);
      const text = entry.message.content.map(item => item.type === 'text' ? item.text : '[non-text content archived]').join('\n');
      if (size(render(entry.message, { ...edit, text })) <= this.maxResultChars) {
        edit.text = text;
        this.commit(edit); changed = true;
        continue;
      }
      let low = 0, high = text.length;
      while (low < high) {
        const count = Math.ceil((low + high) / 2), head = Math.ceil(count / 2), tail = Math.floor(count / 2);
        const preview = reference + '\nHEAD:\n' + text.slice(0, head) + '\n[...snipped...]\nTAIL:\n' + (tail ? text.slice(-tail) : '');
        if (size(render(entry.message, { ...edit, text: preview })) <= this.maxResultChars) low = count;
        else high = count - 1;
      }
      edit.text = reference + '\nHEAD:\n' + text.slice(0, Math.ceil(low / 2)) + '\n[...snipped...]\nTAIL:\n' + (Math.floor(low / 2) ? text.slice(-Math.floor(low / 2)) : '');
      if (size(render(entry.message, edit)) > this.maxResultChars) throw new Error('context_budget_exceeded: tool result identity cannot fit single-result budget');
      this.commit(edit); changed = true;
    }
    return changed;
  }
  microcompactNext(): boolean {
    if (!this.policy.canRead) return false;
    const previous = editsFor(this.manager);
    // Keep the two newest result messages verbatim (subject to the per-result cap).
    for (const entry of this.results().slice(0, -2)) {
      const old = previous.get(entry.id), message = entry.message;
      const details = message.details as { status?: string; error?: unknown; isError?: boolean } | undefined;
      if (old?.mode === 'microcompact' || message.isError || details?.isError || details?.error || (details?.status && !['ok', 'success', 'completed', 'success_with_data', 'success_empty'].includes(details.status)) || !this.policy.microcompactTools.includes(message.toolName)) continue;
      const edit = this.createEdit(entry, 'microcompact'); edit.text = this.reference(edit, message);
      if (size(render(message, edit)) >= size(old ? render(message, old) : message)) continue;
      this.commit(edit); return true;
    }
    return false;
  }
}
