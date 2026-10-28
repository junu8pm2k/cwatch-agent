import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { id, now, type ExecutionRecord } from "@cwatch/core/types";

export class FileStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }); }
  path(name: string): string {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('invalid storage key');
    return join(this.root, name);
  }
  read<T>(name: string, fallback: T): T { const p = this.path(name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : fallback; }
  write(name: string, value: unknown): void {
    const p = this.path(name); mkdirSync(join(p, '..'), { recursive: true });
    const temp = p + '.' + id() + '.tmp'; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, p); break; }
      catch (error) {
        // Windows indexers can briefly lock the target during atomic replacement.
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt >= 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  }
  text(name: string, content: string): void { const p = this.path(name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content, 'utf8'); }
  append(name: string, value: unknown): void { const p = this.path(name); mkdirSync(join(p, '..'), { recursive: true }); appendFileSync(p, JSON.stringify(value) + '\n', 'utf8'); }
  lines<T>(name: string): T[] { const p = this.path(name); return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s) as T) : []; }
  execution(record: ExecutionRecord): void { this.write('executions/' + record.requestId + '.json', record); }
  executions(): ExecutionRecord[] { const p = this.path('executions'); return existsSync(p) ? readdirSync(p).filter(n => n.endsWith('.json')).map(n => this.read<ExecutionRecord>('executions/' + n, null!)) : []; }
  recover(): number {
    let count = 0;
    for (const record of this.executions()) if (record.state === 'awaiting_permission' || record.state === 'executing') {
      this.execution({ ...record, state: 'unknown', endedAt: now(), error: 'process_interrupted: no automatic replay' }); count++;
    }
    // Run records are snapshots. Never silently describe a crashed investigation as running forever.
    const runs = this.path('runs');
    if (existsSync(runs)) for (const name of readdirSync(runs).filter(n => n.endsWith('.json'))) {
      const run = this.read<Record<string, unknown>>('runs/' + name, {});
      if (run.status === 'running') this.write('runs/' + name, { ...run, status: 'unknown', endedAt: now(), error: 'process_interrupted' });
    }
    return count;
  }
}
