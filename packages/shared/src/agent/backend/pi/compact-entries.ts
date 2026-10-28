import { buildContextEntries, sessionEntryToContextMessages, type SessionManager } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { rejectedEntryIds } from './provider-rejections.ts';

export const COMPACT_COMMIT = 'cwatch.compact_commit';
export const COMPACT_ATTACHMENT = 'cwatch.post_compact_attachment';
export const COMPACT_HOOK_RESULT = 'cwatch.post_compact_hook_result';
const commitSchema = z.object({ boundaryId: z.string(), keptEntryIds: z.array(z.string()).min(1), attachmentEntryIds: z.array(z.string()), hookResultEntryIds: z.array(z.string()) }).strict();

/** A failed append can leave a boundary on disk. It becomes active only with its complete commit. */
export function getCommittedContextEntries(manager: SessionManager) {
  const entries = manager.getEntries();
  const rejected = rejectedEntryIds(manager);
  let leafId = manager.getLeafId();
  for (;;) {
    const active = buildContextEntries(entries, leafId).filter(entry => !rejected.has(entry.id));
    const boundary = active.find(entry => entry.type === 'compaction');
    if (!boundary || boundary.type !== 'compaction' || (boundary.details as { transactionVersion?: number } | undefined)?.transactionVersion !== 1) return active;
    const commit = active.find(entry => entry.type === 'custom' && entry.customType === COMPACT_COMMIT && (entry.data as { boundaryId?: string } | undefined)?.boundaryId === boundary.id);
    if (!commit) { leafId = boundary.parentId; continue; }
    if (commit.type !== 'custom') throw new Error('context_compaction_invalid_commit');
    const data = commitSchema.parse(commit.data);
    const expected = [...data.attachmentEntryIds.map(id => ({ id, type: COMPACT_ATTACHMENT })), ...data.hookResultEntryIds.map(id => ({ id, type: COMPACT_HOOK_RESULT }))];
    const boundaryIndex = entries.findIndex(entry => entry.id === boundary.id), commitIndex = entries.findIndex(entry => entry.id === commit.id);
    const firstKeptIndex = entries.findIndex(entry => entry.id === boundary.firstKeptEntryId);
    const actualKeptIds = entries.slice(firstKeptIndex, boundaryIndex).filter(entry => !rejected.has(entry.id) && sessionEntryToContextMessages(entry).length).map(entry => entry.id);
    if (firstKeptIndex < 0 || firstKeptIndex >= boundaryIndex || JSON.stringify(actualKeptIds) !== JSON.stringify(data.keptEntryIds) || JSON.stringify((boundary.details as { keptEntryIds?: string[] }).keptEntryIds) !== JSON.stringify(data.keptEntryIds)) throw new Error('context_compaction_invalid_commit');
    let previousIndex = boundaryIndex;
    for (const { id, type } of expected) {
      const index = entries.findIndex(entry => entry.id === id), item = entries[index];
      if (index <= previousIndex || index >= commitIndex || item?.type !== 'custom_message' || item.customType !== type || (item.details as { boundaryId?: string } | undefined)?.boundaryId !== boundary.id) throw new Error('context_compaction_invalid_commit');
      previousIndex = index;
    }
    if (new Set([...data.keptEntryIds, ...expected.map(item => item.id)]).size !== data.keptEntryIds.length + expected.length || data.keptEntryIds.some(id => !active.some(entry => entry.id === id))) throw new Error('context_compaction_invalid_commit');
    return active;
  }
}
