import { hash, now } from '@cwatch/core/types';
import { SessionMemoryRequestSchema, SessionMemoryStateSchema, type SessionMemoryPolicy, type SessionMemoryRequest, type SessionMemoryState } from '@cwatch/core/types/session-memory';
import { FileStore } from './storage.ts';
import { Redactor } from './trace.ts';
import { SessionTranscript } from './transcript.ts';

/** A separate host-owned checkpoint, never a replacement for the append-only transcript. */
export class SessionMemoryStore {
  readonly key: string;
  private expectedHash?: string;
  constructor(private store: FileStore, private transcript: SessionTranscript, private taskId: string, private policy: SessionMemoryPolicy, private redactor: Redactor) {
    this.key = 'session-memory/' + transcript.sessionId + '.json';
  }
  load(): SessionMemoryState | null {
    const saved = this.store.read<{ memory: unknown; contentHash: string } | null>(this.key, null);
    if (!saved) { if (this.expectedHash) throw new Error('session_memory_missing'); return null; }
    const memory = SessionMemoryStateSchema.parse(saved.memory), digest = hash(memory);
    if (memory.sessionId !== this.transcript.sessionId || memory.taskId !== this.taskId || digest !== saved.contentHash || this.expectedHash && digest !== this.expectedHash || hash(memory.policy) !== hash(this.policy)) throw new Error('session_memory_snapshot_mismatch');
    const checkpoint = this.transcript.messageCheckpoint(memory.lastMessageId);
    if (checkpoint.messageCount !== memory.messageCount || checkpoint.toolCallCount !== memory.toolCallCount) throw new Error('session_memory_cursor_mismatch');
    this.expectedHash = digest;
    return memory;
  }
  handle(raw: SessionMemoryRequest): SessionMemoryState | null {
    const request = SessionMemoryRequestSchema.parse(raw), previous = this.load();
    if (request.operation === 'load') return previous;
    const update = request.update;
    if (update.expectedRevision !== (previous?.revision ?? 0)) throw new Error('session_memory_revision_conflict');
    const checkpoint = this.transcript.messageCheckpoint(update.lastMessageId);
    if (checkpoint.messageCount <= (previous?.messageCount ?? 0)) throw new Error('session_memory_cursor_not_advanced');
    const { expectedRevision, ...content } = update;
    const memory = SessionMemoryStateSchema.parse(this.redactor.clean({ ...content, version: 1,
      sessionId: this.transcript.sessionId, taskId: this.taskId, revision: update.expectedRevision + 1, policy: this.policy,
      ...checkpoint, toolCallsSinceUpdate: checkpoint.toolCallCount - (previous?.toolCallCount ?? 0), transcript: this.transcript.reference(), updatedAt: now() }));
    const contentHash = hash(memory);
    this.store.write(this.key, { memory, contentHash });
    const saved = this.store.read<{ memory: unknown; contentHash: string }>(this.key, null!);
    if (!saved || saved.contentHash !== contentHash || hash(saved.memory) !== contentHash) throw new Error('session_memory_writeback_mismatch');
    this.expectedHash = contentHash;
    return memory;
  }
}
