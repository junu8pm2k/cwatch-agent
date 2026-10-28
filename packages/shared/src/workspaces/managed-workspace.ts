import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Operator-owned project configuration; never passed to the model as a filesystem capability. */
export class ManagedWorkspace {
  readonly workspace: string;
  readonly root: string;
  constructor(workspace = process.cwd()) { this.workspace = realpathSync(resolve(workspace)); this.root = join(this.workspace, '.cwatch'); }
  path(key = ''): string {
    if (key && (isAbsolute(key) || key.includes('\\') || key.includes(':') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('managed_path_outside_workspace');
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new Error('managed_path_outside_workspace');
    let current = this.root;
    for (const part of ['', ...relative(this.root, target).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('managed_symlink_not_allowed');
    }
    return target;
  }
  read<T>(key: string, fallback: T): T { const target = this.path(key); return existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) as T : fallback; }
  write(key: string, value: unknown): void {
    const target = this.path(key), temporary = this.path(key + '.' + randomUUID() + '.tmp');
    mkdirSync(join(target, '..'), { recursive: true });
    try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temporary, target); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  locked<T>(operation: () => T): T {
    mkdirSync(this.path(), { recursive: true });
    const lock = this.path('.config.lock'); let fd: number;
    try { fd = openSync(lock, 'wx'); } catch { throw new Error('extension_config_locked: another management command is running'); }
    try { return operation(); } finally { closeSync(fd); unlinkSync(lock); }
  }
  staging(): string { const key = 'tmp/' + randomUUID(); mkdirSync(this.path(key), { recursive: true }); return key; }
  removeTree(key: string): void {
    // Recursive deletes must resolve to one exact managed skill or staging directory.
    if (!/^(?:skills|tmp)\/[a-zA-Z0-9_-]+$/.test(key)) throw new Error('managed_delete_target_invalid');
    const target = this.path(key), expected = join(this.root, ...key.split('/'));
    if (target !== expected || !target.startsWith(this.root + sep)) throw new Error('managed_delete_outside_workspace');
    if (existsSync(target)) rmSync(target, { recursive: true });
  }
}
