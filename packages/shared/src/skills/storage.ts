import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ManagedWorkspace } from "../workspaces/managed-workspace.ts";

const slugSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(value => !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value), 'reserved skill name');
const MAX_BYTES = 10_000_000, MAX_FILES = 512;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fileSchema = z.object({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }).strict();
const originSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('github'), repo: z.string(), ref: z.string(), path: z.string(), commit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
]);
const manifestSchema = z.object({ version: z.literal(1), name: slugSchema, description: z.string().min(1).max(2048), enabled: z.boolean(), installedAt: z.string(), origin: originSchema, files: z.array(fileSchema).min(1).max(MAX_FILES) }).strict();
export type InstalledSkill = z.infer<typeof manifestSchema>;
export interface SkillDocument { name: string; description: string; body: string; hash: string; resources: string[] }
export interface SkillBundle { documents: SkillDocument[]; readResource(name: string, path: string, offset: number, limit: number): { text: string; hash: string; totalChars: number; truncated: boolean } }
export function parseSkill(content: string): { name: string; description: string; body: string } {
  if (Buffer.byteLength(content) > 65_536) throw new Error('skill_document_too_large');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw new Error('skill_requires_yaml_frontmatter');
  const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
  if (document.errors.length) throw new Error('skill_invalid_yaml');
  let metadata: unknown;
  try { metadata = document.toJS({ maxAliasCount: 20 }); } catch { throw new Error('skill_invalid_yaml'); }
  const parsed = z.object({ name: slugSchema, description: z.string().trim().min(1).max(2048) }).passthrough().safeParse(metadata);
  if (!parsed.success || !match[2].trim()) throw new Error('skill_requires_name_description_and_body');
  return { name: parsed.data.name, description: parsed.data.description, body: match[2].trim() };
}
function safeRelative(path: string): string {
  if (!path || path.includes('\\') || path.includes(':') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) throw new Error('skill_resource_path_invalid');
  return path;
}
function readRegular(root: string, key: string): Buffer {
  safeRelative(key);
  let current = root;
  for (const part of key.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('skill_symlink_not_allowed'); }
  if (!current.startsWith(root + sep) || !lstatSync(current).isFile()) throw new Error('skill_resource_not_regular');
  return readFileSync(current);
}
const excluded = (name: string) => ['.git', 'node_modules', '.cwatch-install.json'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
export type GitRunner = (args: string[], cwd: string, signal: AbortSignal) => Promise<Buffer>;
const execute = promisify(execFile);
const runGit: GitRunner = async (args, cwd, signal) => {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|GIT_SSL_CAINFO)$/i.test(key) && value !== undefined));
    const result = await execute('git', ['-c', 'protocol.file.allow=never', '-c', 'submodule.recurse=false', ...args], { cwd, signal, encoding: 'buffer', maxBuffer: MAX_BYTES, windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
    return result.stdout;
  } catch { signal.throwIfAborted(); throw new Error('skill_git_failed: check repository, branch/tag, path and Git connectivity'); }
};
export interface GithubSkill { repo: string; path: string; ref: string }
export function githubSkill(source: string, path?: string, ref = 'main'): GithubSkill {
  let repo = source;
  if (source.startsWith('https://')) {
    const url = new URL(source), parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || parts.length < 2) throw new Error('skill_github_url_invalid');
    repo = parts.slice(0, 2).join('/');
    if (parts.length > 2) {
      if (parts[2] !== 'tree' || parts.length < 4) throw new Error('skill_github_url_invalid');
      ref = decodeURIComponent(parts[3]); path = parts.slice(4).map(decodeURIComponent).join('/') || '.';
    }
  }
  repo = repo.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..')) throw new Error('skill_github_requires_repo_and_branch_or_tag');
  path = path === 'SKILL.md' ? '.' : (path ?? '.').replace(/\/SKILL\.md$/, '');
  if (path !== '.') {
    safeRelative(path);
    if (path.split('/').some(part => part.startsWith('-') || /[*?\[\]]/.test(part))) throw new Error('skill_github_path_invalid');
  }
  return { repo, path, ref };
}

export class SkillStore {
  readonly files: ManagedWorkspace;
  constructor(workspace = process.cwd()) { this.files = new ManagedWorkspace(workspace); }
  private manifest(name: string): InstalledSkill {
    slugSchema.parse(name);
    const item = manifestSchema.parse(this.files.read('skills/' + name + '/.cwatch-install.json', null));
    if (item.name !== name || new Set(item.files.map(file => file.path)).size !== item.files.length) throw new Error('skill_manifest_mismatch');
    item.files.forEach(file => safeRelative(file.path));
    return item;
  }
  list(): InstalledSkill[] {
    const root = this.files.path('skills');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).map(entry => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('skill_store_invalid_entry');
      return this.manifest(entry.name);
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  installDocument(content: string): InstalledSkill {
    parseSkill(content);
    const temporary = this.files.staging();
    try {
      writeFileSync(this.files.path(temporary + '/SKILL.md'), content, { flag: 'wx' });
      return this.installDirectory(this.files.path(temporary));
    } finally { this.files.removeTree(temporary); }
  }
  installDirectory(source: string, origin: InstalledSkill['origin'] = { kind: 'local' }): InstalledSkill {
    const original = resolve(source);
    if (lstatSync(original).isSymbolicLink()) throw new Error('skill_symlink_not_allowed');
    const root = realpathSync(original);
    if (!lstatSync(root).isDirectory()) throw new Error('skill_install_requires_directory');
    const parsed = parseSkill(readRegular(root, 'SKILL.md').toString('utf8'));
    if (existsSync(this.files.path('skills/' + parsed.name))) throw new Error('skill_already_installed');
    const temporary = this.files.staging(), destination = this.files.path(temporary);
    const files: InstalledSkill['files'] = []; let bytes = 0;
    const copy = (key: string) => {
      for (const entry of readdirSync(join(root, key), { withFileTypes: true })) {
        if (excluded(entry.name)) continue;
        const file = key ? key + '/' + entry.name : entry.name; safeRelative(file);
        if (entry.isSymbolicLink()) throw new Error('skill_symlink_not_allowed');
        if (entry.isDirectory()) { copy(file); continue; }
        if (!entry.isFile()) throw new Error('skill_non_regular_file');
        const stat = lstatSync(join(root, file));
        if (bytes + stat.size > MAX_BYTES || files.length >= MAX_FILES) throw new Error('skill_package_limit');
        if (files.some(item => item.path.toLowerCase() === file.toLowerCase())) throw new Error('skill_file_case_collision');
        const data = readRegular(root, file); bytes += data.length;
        const target = join(destination, ...file.split('/')); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, data);
        files.push({ path: file, hash: sha256(data), size: data.length });
      }
    };
    try {
      copy('');
      if (!files.some(file => file.path === 'SKILL.md')) throw new Error('skill_requires_exact_SKILL_md_filename');
      const copied = parseSkill(readFileSync(join(destination, 'SKILL.md'), 'utf8'));
      if (copied.name !== parsed.name || copied.description !== parsed.description) throw new Error('skill_changed_during_install');
      const manifest = manifestSchema.parse({ version: 1, name: parsed.name, description: parsed.description, enabled: true, installedAt: new Date().toISOString(), origin, files });
      writeFileSync(join(destination, '.cwatch-install.json'), JSON.stringify(manifest, null, 2) + '\n');
      this.files.locked(() => {
        const target = this.files.path('skills/' + parsed.name);
        if (existsSync(target)) throw new Error('skill_already_installed');
        mkdirSync(this.files.path('skills'), { recursive: true });
        for (let attempt = 0; ; attempt++) {
          if (existsSync(this.files.path('skills/' + parsed.name))) throw new Error('skill_already_installed');
          try { renameSync(this.files.path(temporary), this.files.path('skills/' + parsed.name)); break; }
          catch (error) {
            // Windows scanners may briefly hold a freshly copied staging directory.
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
          }
        }
      });
      return manifest;
    } finally { this.files.removeTree(temporary); }
  }
  async installGithub(spec: GithubSkill, signal: AbortSignal, git: GitRunner = runGit): Promise<InstalledSkill> {
    signal.throwIfAborted();
    const config = githubSkill(spec.repo, spec.path, spec.ref), temporary = this.files.staging();
    const root = this.files.path(temporary), repository = join(root, 'repo'), directory = join(root, 'package');
    mkdirSync(directory); mkdirSync(repository);
    try {
      await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', config.ref, '--', 'https://github.com/' + config.repo + '.git', repository], root, signal);
      const commit = (await git(['rev-parse', 'HEAD'], repository, signal)).toString('utf8').trim();
      const entries = (await git(['ls-tree', '-r', '-z', '--long', 'HEAD', '--', config.path], repository, signal)).toString('utf8').split('\0').filter(Boolean);
      if (!entries.length || entries.length > MAX_FILES) throw new Error('skill_github_package_limit_or_missing_path');
      let total = 0; const names = new Set<string>(), prefix = config.path === '.' ? '' : config.path + '/';
      for (const entry of entries) {
        signal.throwIfAborted();
        const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(entry);
        if (!match || !['100644', '100755'].includes(match[1]) || !match[4].startsWith(prefix)) throw new Error('skill_github_non_regular_entry');
        const key = safeRelative(match[4].slice(prefix.length));
        if (names.has(key.toLowerCase())) throw new Error('skill_file_case_collision'); names.add(key.toLowerCase());
        if (key.split('/').some(excluded)) continue;
        total += Number(match[3]); if (total > MAX_BYTES) throw new Error('skill_package_limit');
        const data = await git(['cat-file', 'blob', match[2]], repository, signal);
        if (data.length !== Number(match[3])) throw new Error('skill_github_blob_size_mismatch');
        const target = join(directory, ...key.split('/')); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, data);
      }
      signal.throwIfAborted();
      return this.installDirectory(directory, { kind: 'github', ...config, commit });
    } finally { this.files.removeTree(temporary); }
  }
  change(name: string, enabled: boolean | 'remove'): void {
    this.files.locked(() => {
      const manifest = this.manifest(name);
      if (enabled === 'remove') this.files.removeTree('skills/' + name);
      else this.files.write('skills/' + name + '/.cwatch-install.json', { ...manifest, enabled });
    });
  }
  select(names: string[], includeDisabled = false): SkillBundle {
    const selected = new Map<string, InstalledSkill>();
    const read = (name: string, path: string): Buffer => {
      const manifest = selected.get(name); if (!manifest) throw new Error('skill_not_selected');
      const file = manifest.files.find(item => item.path === path); if (!file) throw new Error('skill_resource_not_installed');
      const data = readRegular(this.files.path('skills/' + name), path);
      if (data.length !== file.size || sha256(data) !== file.hash) throw new Error('skill_changed: reinstall to use modified files');
      return data;
    };
    const documents = [...new Set(names)].map(name => {
      const manifest = this.manifest(name); if (!manifest.enabled && !includeDisabled) throw new Error('skill_disabled:' + name);
      selected.set(name, manifest);
      const data = read(name, 'SKILL.md'), parsed = parseSkill(data.toString('utf8'));
      if (parsed.name !== name) throw new Error('skill_manifest_mismatch');
      return { name, description: parsed.description, body: parsed.body, hash: sha256(data), resources: manifest.files.filter(file => file.path !== 'SKILL.md').map(file => file.path) };
    });
    return {
      documents,
      readResource: (name, path, offset, limit) => {
        safeRelative(path);
        const data = read(name, path); if (data.includes(0)) throw new Error('skill_resource_is_binary');
        const text = data.toString('utf8');
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24_000) throw new Error('skill_resource_range_invalid');
        return { text: text.slice(offset, offset + limit), hash: sha256(data), totalChars: text.length, truncated: offset + limit < text.length };
      },
    };
  }
}
