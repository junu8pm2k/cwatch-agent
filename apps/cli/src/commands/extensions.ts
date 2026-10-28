import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redactor } from "@cwatch/shared/sessions/trace";
import { UserMcpStore, UserMcpSchema, mcpSecrets } from "@cwatch/shared/mcp/storage";
import { UserMcpSource } from "@cwatch/shared/mcp/source";
import { SkillStore, githubSkill } from "@cwatch/shared/skills/storage";

function parseArgs(args: string[]) {
  const positionals: string[] = [], flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2), next = args[++index];
    if (!name || name in flags || !next || next.startsWith('--')) throw new Error('extension_cli: flag requires one value');
    flags[name] = next;
  }
  return { positionals, flags };
}
const readJson = (path: string) => JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, unknown>;
export async function handleExtensionCommand(command: string | undefined, args: string[]): Promise<boolean> {
  if (command !== 'mcp' && command !== 'skills') return false;
  const [verb, ...tail] = args, { positionals, flags } = parseArgs(tail);
  const allowed = new Set(['workspace', ...(command === 'mcp' && verb === 'add' ? ['config', 'url', 'transport', 'token-env', 'auth-header', 'auth-scheme', 'command', 'args-json', 'env-map', 'action', 'tool-actions', 'result-format'] : []), ...(command === 'skills' && verb === 'install' ? ['repo', 'path', 'ref'] : [])]);
  if (Object.keys(flags).some(key => !allowed.has(key)) || positionals.length > 1) throw new Error('extension_cli: unknown option or extra argument');
  const workspace = resolve(flags.workspace ?? process.cwd()), name = positionals[0];
  const emit = (value: unknown, secrets: string[] = []) => {
    const envSecrets = Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? '');
    console.log(JSON.stringify(new Redactor([...envSecrets, ...secrets]).clean(value), null, 2));
  };
  const controller = new AbortController(), cancel = () => controller.abort(new Error('user_cancelled'));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (command === 'mcp') {
      const store = new UserMcpStore(workspace);
      if (verb === 'list') { if (name) throw new Error('mcp list takes no name'); const servers = store.list(); emit(servers, servers.flatMap(server => mcpSecrets(server, process.env))); return true; }
      if (verb === 'add') {
        if (!name) throw new Error('usage: mcp add <slug> --url URL | --command COMMAND | --config FILE');
        const raw = flags.config ? readJson(flags.config) : {};
        if (raw.slug && raw.slug !== name) throw new Error('mcp_config_slug_mismatch');
        const config = UserMcpSchema.parse({
          ...raw, slug: name,
          ...(flags.url ? { url: flags.url } : {}),
          ...(flags.command ? { command: flags.command } : {}),
          transport: flags.transport ?? raw.transport ?? (flags.command ? 'stdio' : 'auto'),
          ...(flags['token-env'] ? { tokenEnv: flags['token-env'] } : {}),
          ...(flags['auth-header'] ? { authHeader: flags['auth-header'] } : {}),
          ...(flags['auth-scheme'] ? { authScheme: flags['auth-scheme'] } : {}),
          ...(flags['args-json'] ? { args: JSON.parse(flags['args-json']) } : {}),
          ...(flags['env-map'] ? { env: JSON.parse(flags['env-map']) } : {}),
          ...(flags.action ? { defaultAction: flags.action } : {}),
          ...(flags['tool-actions'] ? { toolSemantics: readJson(flags['tool-actions']) } : {}),
          ...(flags['result-format'] ? { resultFormat: flags['result-format'] } : {}),
        });
        store.add(config); emit({ added: config.slug, defaultAction: config.defaultAction, path: store.files.path('mcp.json') }); return true;
      }
      if (!name) throw new Error('mcp command requires a configured server name');
      if (['enable', 'disable', 'remove'].includes(verb)) { store.change(name, verb === 'remove' ? 'remove' : verb === 'enable'); emit({ name, action: verb }); return true; }
      if (verb === 'test') {
        const config = store.select([name])[0], source = new UserMcpSource(config, workspace);
        try { emit({ server: name, connected: true, tools: await source.listTools(signal), note: 'Discovery only; no tools/call executed.' }, mcpSecrets(config, process.env)); }
        finally { await source.close(); }
        return true;
      }
      throw new Error('usage: mcp add|list|test|enable|disable|remove');
    }
    const store = new SkillStore(workspace);
    if (verb === 'list') { if (name) throw new Error('skills list takes no name'); emit(store.list()); return true; }
    if (verb === 'install') {
      if (flags.repo && name) throw new Error('choose a local path/URL or --repo');
      const installed = flags.repo || name?.startsWith('https://')
        ? await store.installGithub(githubSkill(flags.repo ?? name!, flags.path, flags.ref), signal)
        : name ? store.installDirectory(name) : undefined;
      if (!installed) throw new Error('usage: skills install <DIRECTORY|GITHUB_TREE_URL> | --repo OWNER/REPO --path PATH [--ref BRANCH_OR_TAG]');
      emit({ installed: installed.name, description: installed.description, files: installed.files.length, origin: installed.origin }); return true;
    }
    if (!name) throw new Error('skills command requires an installed skill name');
    if (verb === 'show') { emit(store.select([name], true).documents[0]); return true; }
    if (['enable', 'disable', 'remove'].includes(verb)) { store.change(name, verb === 'remove' ? 'remove' : verb === 'enable'); emit({ name, action: verb }); return true; }
    throw new Error('usage: skills install|list|show|enable|disable|remove');
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
