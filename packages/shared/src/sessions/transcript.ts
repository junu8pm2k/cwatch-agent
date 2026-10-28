import { z } from 'zod';
import { resolve } from 'node:path';
import { FileStore } from './storage.ts';
import { Redactor } from './trace.ts';
import { hash } from '@cwatch/core/types';
import { TranscriptReferenceSchema } from '@cwatch/core/types/compaction';

const header = z.object({ type: z.literal('session'), id: z.string(), version: z.number(), timestamp: z.string(), cwd: z.string() }).passthrough();
const entry = z.object({ type: z.string(), id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.string() }).passthrough();
const resultMessage = z.object({ role: z.literal('toolResult'), toolCallId: z.string().min(1), toolName: z.string().min(1), content: z.array(z.object({ type: z.string() }).passthrough()) }).passthrough();
export const ReadToolResultSchema = z.object({ entryId: z.string().min(1).max(512), toolCallId: z.string().min(1).max(512), offset: z.number().int().safe().nonnegative().default(0), limit: z.number().int().min(1).max(4096).default(1024) }).strict();
export const ReadTranscriptSchema = z.object({
  throughEntryId: z.string().min(1).max(512), entryId: z.string().min(1).max(512).optional(), query: z.string().min(1).max(200).optional(),
  offset: z.number().int().safe().nonnegative().default(0), limit: z.number().int().min(1).max(4096).default(1024),
}).strict().refine(value => !(value.entryId && value.query), 'choose entryId or literal query, not both');

/** Native Pi JSONL, written and redacted by the host; never rewritten during compaction. */
export class SessionTranscript {
  readonly key: string;
  private ids = new Set<string>();
  private initialized = false;
  private leaf: string | null = null;
  private results = new Map<string, { toolCallId: string; toolName: string; contentHash: string }>();
  private records = new Map<string, { line: number; hash: string }>();
  private headerHash?: string;
  constructor(private store: FileStore, readonly sessionId: string, private redactor: Redactor) {
    this.key = 'sessions/' + sessionId + '.jsonl';
    if (store.lines(this.key).length) throw new Error('transcript_already_exists');
  }
  append(entries: Record<string, unknown>[]): void {
    for (const raw of entries) {
      // Hash the persisted JSON shape: native SDK entries may contain undefined optional fields.
      const value = JSON.parse(JSON.stringify(this.redactor.clean(raw))) as Record<string, unknown>;
      if (!this.initialized) {
        const parsed = header.parse(value);
        if (parsed.id !== this.sessionId) throw new Error('transcript_session_mismatch');
        this.store.append(this.key, parsed); this.initialized = true; this.headerHash = hash(parsed);
      } else {
        const parsed = entry.parse(value);
        if (parsed.type === 'session' || this.ids.has(parsed.id) || parsed.parentId !== this.leaf) throw new Error('transcript_invalid_chain');
        const message = parsed.type === 'message' && (parsed.message as { role?: string } | undefined)?.role === 'toolResult' ? resultMessage.parse(parsed.message) : undefined;
        this.store.append(this.key, parsed); this.ids.add(parsed.id); this.leaf = parsed.id;
        this.records.set(parsed.id, { line: this.records.size + 1, hash: hash(parsed) });
        if (message) this.results.set(parsed.id, { toolCallId: message.toolCallId, toolName: message.toolName, contentHash: hash(message.content) });
      }
    }
  }
  reference() {
    if (!this.leaf || !this.headerHash) throw new Error('transcript_not_initialized');
    return TranscriptReferenceSchema.parse({ sessionId: this.sessionId, path: resolve(this.store.path(this.key)), throughEntryId: this.leaf,
      entryCount: this.records.size + 1, snapshotHash: hash([this.headerHash, ...[...this.records.values()].map(record => record.hash)]), tool: 'session__read_transcript' });
  }
  messageCheckpoint(entryId: string) {
    this.readTranscript({ throughEntryId: entryId, entryId, limit: 1 });
    const line = this.records.get(entryId)!.line;
    const messages = this.store.lines<Record<string, unknown>>(this.key).slice(1, line + 1).filter(entry => entry.type === 'message');
    if (messages.at(-1)?.id !== entryId) throw new Error('session_memory_cursor_not_message');
    let toolCallCount = 0;
    const pending = new Map<string, string>();
    for (const entry of messages) {
      const message = entry.message as { role?: string; toolCallId?: string; toolName?: string; content?: Array<{ type?: string; id?: string; name?: string }> };
      if ((message.role === 'user' || message.role === 'assistant') && pending.size) throw new Error('session_memory_incomplete_round');
      if (message.role === 'assistant' && Array.isArray(message.content)) for (const call of message.content.filter(item => item.type === 'toolCall')) {
        if (!call.id || !call.name || pending.has(call.id)) throw new Error('session_memory_invalid_round');
        pending.set(call.id, call.name); toolCallCount++;
      }
      if (message.role === 'toolResult') {
        if (!message.toolCallId || pending.get(message.toolCallId) !== message.toolName) throw new Error('session_memory_invalid_round');
        pending.delete(message.toolCallId);
      }
    }
    if (pending.size) throw new Error('session_memory_incomplete_round');
    return { messageCount: messages.length, toolCallCount };
  }
  readTranscript(input: unknown) {
    const { throughEntryId, entryId, query, offset, limit } = ReadTranscriptSchema.parse(input);
    const anchor = this.records.get(throughEntryId);
    if (!anchor) throw new Error('transcript_anchor_not_found_in_current_session');
    const selected = entryId ? this.records.get(entryId) : undefined;
    if (entryId && (!selected || selected.line > anchor.line)) throw new Error('transcript_entry_outside_snapshot');
    let lines: Record<string, unknown>[];
    try { lines = this.store.lines<Record<string, unknown>>(this.key).slice(0, anchor.line + 1); }
    catch { throw new Error('transcript_snapshot_mismatch'); }
    if (lines.length !== anchor.line + 1 || hash(lines[0]) !== this.headerHash) throw new Error('transcript_snapshot_mismatch');
    const indexed = [...this.records].slice(0, anchor.line);
    for (const [index, [id, record]] of indexed.entries()) {
      if (lines[index + 1]?.id !== id || hash(lines[index + 1]) !== record.hash) throw new Error('transcript_snapshot_mismatch');
    }
    // A fixed native entry anchor prevents reads from chasing their own newly appended responses.
    const matches = lines.filter((line, index) => entryId ? index === selected!.line : !query || JSON.stringify(line).includes(query));
    const text = matches.map(line => JSON.stringify(line)).join('\n') + (matches.length ? '\n' : '');
    if (offset > text.length) throw new Error('transcript_offset_out_of_range');
    const content = text.slice(offset, offset + limit), end = offset + content.length;
    return { sessionId: this.sessionId, path: resolve(this.store.path(this.key)), throughEntryId, format: 'jsonl', offset, totalChars: text.length, content,
      nextOffset: end < text.length ? end : null, matchedEntries: matches.length, snapshotEntryCount: lines.length,
      snapshotHash: hash([this.headerHash, ...indexed.map(([, record]) => record.hash)]), untrusted: true };
  }
  readToolResult(input: unknown) {
    const { entryId, toolCallId, offset, limit } = ReadToolResultSchema.parse(input), indexed = this.results.get(entryId);
    if (!indexed || indexed.toolCallId !== toolCallId) throw new Error('tool_result_not_found_in_current_session');
    const original = this.store.lines<Record<string, unknown>>(this.key).find(value => value.type === 'message' && value.id === entryId);
    const message = resultMessage.parse(original?.message);
    if (message.toolCallId !== toolCallId || message.toolName !== indexed.toolName || hash(message.content) !== indexed.contentHash) throw new Error('tool_result_snapshot_mismatch');
    const textOnly = message.content.every(item => item.type === 'text' && typeof item.text === 'string');
    const text = textOnly ? message.content.map(item => item.text).join('\n') : JSON.stringify(message.content);
    if (offset > text.length) throw new Error('tool_result_offset_out_of_range');
    const content = text.slice(offset, offset + limit), nextOffset = offset + content.length;
    return { entryId, toolCallId, toolName: message.toolName, format: textOnly ? 'text' : 'content-json', offset, totalChars: text.length, content, nextOffset: nextOffset < text.length ? nextOffset : null, contentHash: indexed.contentHash, untrusted: true };
  }
  references() { return [...this.results].map(([entryId, value]) => ({ entryId, ...value })); }
}
