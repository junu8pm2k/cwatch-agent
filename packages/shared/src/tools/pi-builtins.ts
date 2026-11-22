import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { id, type SourceClient, type ToolDefinition, type ToolExecutionContext } from '@cwatch/core/types';
import { processEnvironment } from '../utils/process-environment.ts';

export const PI_BUILTIN_SOURCE = 'pi';
export const PI_BUILTIN_NAMES = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] as const;
type PiResult = Awaited<ReturnType<PiToolDefinition['execute']>>;
export type PiBuiltinResult = PiResult & { kind: 'pi_builtin_result'; raw: string };
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};
const STORE_READABLE_DIRS = new Set(['retrievals', 'plans', 'reports', 'claims', 'reviews', 'comparisons']);
const invalidSegment = (part: string) => part.includes(':') || process.platform === 'win32' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

/** File-tool scope checks; an approved arbitrary shell is not an OS sandbox. */
export class BuiltinFileScope {
  readonly root: string;
  constructor(root: string, private readonly protectedRoots: string[] = []) {
    this.root = realpathSync(resolve(root));
    this.protectedRoots = protectedRoots.map(path => realpathSync(resolve(path)));
  }
  private resolveProtectedRead(input: string): string | undefined {
    if (input.includes('\0')) return undefined;
    for (const storeRoot of this.protectedRoots) {
      const target = isAbsolute(input) ? resolve(input) : resolve(storeRoot, input);
      if (!inside(storeRoot, target)) continue;
      const parts = relative(storeRoot, target).split(sep).filter(Boolean);
      if (!parts.length || !STORE_READABLE_DIRS.has(parts[0].toLowerCase()) || parts.some(invalidSegment)) continue;
      if (parts.some(part => /^\.env(?:\.|$)/i.test(part))) continue;
      if (!lstatSync(target, { throwIfNoEntry: false })) continue;
      let ancestor = target;
      while (!lstatSync(ancestor, { throwIfNoEntry: false }) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
      if (!inside(storeRoot, realpathSync(ancestor))) throw Error('builtin_symlink_outside_workspace');
      let prefix = storeRoot;
      for (const part of parts) {
        prefix = resolve(prefix, part);
        if (!lstatSync(prefix, { throwIfNoEntry: false })) break;
        if (!inside(storeRoot, realpathSync(prefix))) throw Error('builtin_symlink_outside_workspace');
      }
      return target;
    }
    return undefined;
  }
  path(input: string, writing = false): string {
    if (isAbsolute(input) || !lstatSync(resolve(this.root, input), { throwIfNoEntry: false })) {
      const storeTarget = this.resolveProtectedRead(input);
      if (storeTarget) {
        if (writing) throw Error('builtin_protected_path');
        return storeTarget;
      }
    }
    const target = resolve(this.root, input), parts = relative(this.root, target).split(sep).filter(Boolean);
    if (!inside(this.root, target) || input.includes('\0') || parts.some(invalidSegment)) throw Error('builtin_path_outside_workspace');
    if (parts.some(part => /^\.env(?:\.|$)/i.test(part)) || ['.ssh', '.aws', '.cwatch'].includes(parts[0]?.toLowerCase())) throw Error('builtin_private_path');
    if (writing && (['.git', '.codex', '.agents', 'sources', 'skills'].includes(parts[0]?.toLowerCase()) || this.protectedRoots.some(root => inside(resolve(root), target)))) throw Error('builtin_protected_path');
    // Resolve the nearest existing parent too, so new files cannot escape through a junction.
    let ancestor = target;
    while (!lstatSync(ancestor, { throwIfNoEntry: false }) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
    if (!inside(this.root, realpathSync(ancestor))) throw Error('builtin_symlink_outside_workspace');
    // Check each existing prefix: even an in-workspace link cannot alias private/config paths.
    let prefix = this.root;
    for (const part of parts) {
      prefix = resolve(prefix, part);
      if (!lstatSync(prefix, { throwIfNoEntry: false })) break;
      const actual = realpathSync(prefix), actualParts = relative(this.root, actual).split(sep);
      if (!inside(this.root, actual)) throw Error('builtin_symlink_outside_workspace');
      if (actualParts.some(p => /^\.env(?:\.|$)/i.test(p)) || ['.ssh', '.aws', '.cwatch'].includes(actualParts[0]?.toLowerCase())) throw Error('builtin_private_path');
      if (writing && (['.git', '.codex', '.agents', 'sources', 'skills'].includes(actualParts[0]?.toLowerCase()) || this.protectedRoots.some(root => inside(resolve(root), actual)))) throw Error('builtin_protected_path');
    }
    return target;
  }
}

/** Real Pi implementations, explicitly registered and executed through the host ToolExecutor. */
export class PiBuiltinSource implements SourceClient {
  readonly scope: BuiltinFileScope;
  private readonly tools: Map<string, PiToolDefinition>;
  private readonly lifetime = new AbortController();
  constructor(root: string, protectedRoots: string[] = []) {
    this.scope = new BuiltinFileScope(root, protectedRoots);
    const guardedRead = (path: string) => readFile(this.scope.path(path));
    const guardedWrite = (path: string, content: string) => writeFile(this.scope.path(path, true), content, 'utf8');
    const tools = [
      createReadToolDefinition(this.scope.root),
      createWriteToolDefinition(this.scope.root, { operations: { writeFile: guardedWrite, mkdir: async path => { await mkdir(this.scope.path(path, true), { recursive: true }); } } }),
      createEditToolDefinition(this.scope.root, { operations: { readFile: guardedRead, writeFile: guardedWrite, access: path => access(this.scope.path(path, true), constants.R_OK | constants.W_OK) } }),
      createBashToolDefinition(this.scope.root, { exposeSessionEnvironment: false, spawnHook: context => ({ ...context, env: processEnvironment({}, {}, context.env).env }) }),
      createGrepToolDefinition(this.scope.root, { operations: { isDirectory: path => statSync(this.scope.path(path)).isDirectory(), readFile: async path => (await guardedRead(path)).toString('utf8') } }),
      createFindToolDefinition(this.scope.root),
      createLsToolDefinition(this.scope.root),
    ];
    this.tools = new Map(tools.map(tool => [tool.name, tool as PiToolDefinition]));
  }
  async listTools(): Promise<ToolDefinition[]> {
    return [...this.tools.values()].map(tool => ({
      name: tool.name, namespace: 'native', description: tool.description,
      inputSchema: { ...tool.parameters, additionalProperties: false },
      action: ['write', 'edit', 'bash'].includes(tool.name) ? 'modify' : 'analyze',
    }));
  }
  validateScope(name: string, args: Record<string, unknown>): string | undefined {
    if (!this.tools.has(name)) return 'unknown_pi_builtin';
    if (name === 'bash') return undefined; // Always a modify action; do not guess shell semantics.
    try { this.scope.path(String(args.path ?? '.'), name === 'write' || name === 'edit'); }
    catch (error) { return error instanceof Error ? error.message : 'builtin_invalid_path'; }
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext): Promise<PiBuiltinResult> {
    if (!context) throw Error('pi_builtin_execution_context_required');
    const combined = AbortSignal.any([signal, this.lifetime.signal]); combined.throwIfAborted();
    const tool = this.tools.get(name); if (!tool) throw Error('unknown_pi_builtin');
    return context.stage('pi.builtin.' + name, async () => {
      const reason = this.validateScope(name, args); if (reason) throw Error(reason);
      const input = name === 'bash' ? args : { ...args, path: this.scope.path(String(args.path ?? '.'), name === 'write' || name === 'edit') };
      const result = await tool.execute(id(), input, combined, undefined, undefined as never);
      combined.throwIfAborted();
      // Keep IPC bounded, including binary/image content blocks.
      const raw = JSON.stringify(result);
      if (raw.length > 700_000) throw Error('pi_builtin_result_too_large');
      return { ...result, kind: 'pi_builtin_result', raw };
    });
  }
  async close(): Promise<void> { this.lifetime.abort(new Error('pi_builtin_source_closed')); }
}
