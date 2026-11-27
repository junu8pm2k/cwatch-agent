import { readFileSync } from 'node:fs';
import { hash, PageSnapshotIdSchema, type RetrievalResult } from '@cwatch/core/types';
import { z } from 'zod';
import type { FileStore } from './storage.ts';

export const readPageSnapshotTool = 'session__read_page_snapshot';
export const ReadPageSnapshotSchema = z.object({
  snapshotId: PageSnapshotIdSchema,
  offset: z.number().int().safe().nonnegative().default(0),
  limit: z.number().int().min(1).max(4096).default(1024),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();

function snapshotPath(runId: string, snapshotId: string): string {
  return `page-snapshots/${runId}/${PageSnapshotIdSchema.parse(snapshotId)}.txt`;
}

const previewChars = 8_000;
type Page = NonNullable<RetrievalResult['pages']>[number];

export function previewFetchedPage(store: FileStore, runId: string, page: Page): Page {
  const { text } = page;
  if (text.length <= previewChars || page.truncated) return page;
  const id = hash(text);
  store.text(snapshotPath(runId, id), text);
  const marker = '\n[...page middle omitted...]\n';
  const available = previewChars - marker.length;
  return { ...page,
    text: text.slice(0, Math.ceil(available / 2)) + marker + text.slice(-Math.floor(available / 2)),
    truncated: true, textSnapshot: { id, totalChars: text.length },
  };
}

export function loadPageSnapshot(store: FileStore, runId: string, snapshotId: string): string {
  const path = store.path(snapshotPath(runId, snapshotId));
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch { throw Error('page_snapshot_not_found_in_current_run'); }
  if (hash(text) !== snapshotId) throw Error('page_snapshot_integrity_mismatch');
  return text;
}

export function readPageSnapshot(store: FileStore, runId: string, args: unknown) {
  const { snapshotId, offset, limit, query } = ReadPageSnapshotSchema.parse(args);
  const text = loadPageSnapshot(store, runId, snapshotId);
  if (offset > text.length) throw Error('page_snapshot_offset_out_of_range');
  const match = query ? text.indexOf(query, offset) : undefined;
  const padding = query ? Math.floor(Math.max(0, limit - query.length) / 2) : 0;
  const start = match === undefined || match === -1 ? offset : Math.max(offset, match - padding);
  const content = match === -1 ? '' : text.slice(start, start + limit);
  const end = start + content.length;
  return { snapshotId, offset: start, content, totalChars: text.length, nextOffset: match !== -1 && end < text.length ? end : null,
    ...(match === undefined ? {} : { matchOffset: match === -1 ? null : match }), untrusted: true };
}
