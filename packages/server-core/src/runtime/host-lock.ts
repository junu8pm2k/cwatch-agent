import { closeSync, ftruncateSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { id, now } from '@cwatch/core/types';

export interface HostLockMeta {
  pid: number;
  token: string;
  startedAt: string;
  origin?: string;
}

export interface HostLock {
  readonly path: string;
  setOrigin(origin: string): void;
  release(): void;
}

export class HostLockError extends Error {
  readonly code = 'EEXIST';
  readonly path: string;
  readonly pid?: number;
  readonly origin?: string;

  constructor(lockPath: string, owner?: Partial<HostLockMeta>) {
    const ownerInfo = owner?.pid
      ? ` (PID ${owner.pid}${owner.origin ? `, ${owner.origin}` : ''})`
      : '';
    super(`EEXIST: host output lease is held by an active process${ownerInfo}: ${lockPath}`);
    this.name = 'HostLockError';
    this.path = lockPath;
    this.pid = owner?.pid;
    this.origin = owner?.origin;
  }
}

const activeHostLocks = new Set<string>();
const STALE_UNPARSED_LOCK_GRACE_MS = 2000;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseHostLock(raw: string): Partial<HostLockMeta> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
    const token = typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined;
    const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined;
    const origin = typeof parsed.origin === 'string' && parsed.origin.length > 0 ? parsed.origin : undefined;
    return { pid, token, startedAt, origin };
  } catch {
    return undefined;
  }
}

function readExistingLock(lockPath: string): Partial<HostLockMeta> | undefined {
  try {
    return parseHostLock(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function tryRemoveStaleLock(lockPath: string): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, 'utf8');
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }

  const meta = parseHostLock(raw);
  if (meta?.pid !== undefined) {
    if (isPidAlive(meta.pid)) throw new HostLockError(lockPath, meta);
  } else if (Date.now() - mtimeMs < STALE_UNPARSED_LOCK_GRACE_MS) {
    throw new HostLockError(lockPath);
  }

  try {
    if (readFileSync(lockPath, 'utf8') !== raw) return true;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function acquireHostLock(outputRoot: string): HostLock {
  const lockPath = resolve(outputRoot, '.host.lock');
  if (activeHostLocks.has(lockPath)) {
    throw new HostLockError(lockPath, readExistingLock(lockPath) ?? { pid: process.pid });
  }

  let fd: number | undefined;
  let meta: HostLockMeta | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fd = openSync(lockPath, 'wx');
      meta = { pid: process.pid, token: id(), startedAt: now() };
      const bytes = Buffer.from(JSON.stringify(meta), 'utf8');
      writeSync(fd, bytes, 0, bytes.length, 0);
      break;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
        try { unlinkSync(lockPath); } catch { /* ignore */ }
        fd = undefined;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 2 || !tryRemoveStaleLock(lockPath)) {
        throw new HostLockError(lockPath, readExistingLock(lockPath));
      }
    }
  }

  if (fd === undefined || !meta) {
    throw new HostLockError(lockPath, readExistingLock(lockPath));
  }

  const ownedFd = fd;
  let ownedMeta = meta;
  let released = false;
  activeHostLocks.add(lockPath);

  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    activeHostLocks.delete(lockPath);
    try { closeSync(ownedFd); } catch { /* ignore */ }
    try {
      const current = readExistingLock(lockPath);
      if (!current?.token || current.token === ownedMeta.token) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { unlinkSync(lockPath); } catch { /* ignore */ }
      }
    }
  };

  process.once('exit', release);

  return {
    path: lockPath,
    setOrigin(origin: string) {
      if (released) return;
      ownedMeta = { ...ownedMeta, origin };
      const bytes = Buffer.from(JSON.stringify(ownedMeta), 'utf8');
      try {
        ftruncateSync(ownedFd, 0);
        writeSync(ownedFd, bytes, 0, bytes.length, 0);
      } catch { /* keep active lock even if origin metadata update fails */ }
    },
    release,
  };
}
