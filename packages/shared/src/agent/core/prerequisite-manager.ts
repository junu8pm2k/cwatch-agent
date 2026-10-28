import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash, type SourceGuide, type SourceGuidePort } from '@cwatch/core/types';

/** Source-specific prerequisite, kept separately from permission decisions. */
export class PrerequisiteManager implements SourceGuidePort {
  readonly path: string;
  private readonly root: string;
  private readHash?: string;
  constructor(workspace: string, readonly sourceSlug: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sourceSlug)) throw new Error('invalid_source_slug');
    this.root = realpathSync(resolve(workspace));
    this.path = 'sources/' + sourceSlug + '/guide.md';
  }
  private snapshot(): SourceGuide {
    let target = this.root;
    for (const part of ['sources', this.sourceSlug, 'guide.md']) {
      target = join(target, part);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (!stat) throw new Error('source_guide_missing:' + this.path);
      if (stat.isSymbolicLink()) throw new Error('source_guide_symlink_not_allowed');
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > 64_000) throw new Error('source_guide_invalid_size');
    const text = readFileSync(target, 'utf8');
    if (!text.trim() || text.includes('\0') || text.length > 32_000) throw new Error('source_guide_invalid_content');
    return { sourceSlug: this.sourceSlug, path: this.path, hash: hash(text), text };
  }
  async read(signal: AbortSignal): Promise<SourceGuide> {
    signal.throwIfAborted();
    const snapshot = this.snapshot();
    signal.throwIfAborted();
    this.readHash = snapshot.hash;
    return snapshot;
  }
  check(): string | undefined {
    if (!this.readHash) return 'source_guide_required:' + this.path;
    try { return this.snapshot().hash === this.readHash ? undefined : 'source_guide_changed:' + this.path; }
    catch (error) { return String(error); }
  }
  reset(): void { this.readHash = undefined; }
}
