import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import { hash, type Action, type AgentTask, type SourceGuide, type SourceClient, type ToolBinding, type ToolExecutionContext } from "@cwatch/core/types";
import { registeredToolName } from './tool-names.ts';
const Ajv = AjvModule as unknown as typeof import('ajv').default;

export class ToolRegistry {
  private entries = new Map<string, { binding: ToolBinding; client: SourceClient; validate: (v: unknown) => boolean }>();
  private sources = new Map<string, { active: boolean; revision: number; client: SourceClient }>();
  async register(slug: string, channel: ToolBinding['channel'], client: SourceClient, signal: AbortSignal): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error('invalid source slug');
    const definitions = await client.listTools(signal); signal.throwIfAborted();
    const revision = (this.sources.get(slug)?.revision ?? 0) + 1;
    const batch: Array<{ binding: ToolBinding; client: SourceClient; validate: (v: unknown) => boolean }> = [];
    const names = new Set<string>();
    for (const tool of definitions) {
      const proxy_name = registeredToolName(slug, channel, tool);
      if (!proxy_name || proxy_name.length > 64) throw new Error('invalid_tool_name_length: ' + proxy_name);
      if (names.has(proxy_name) || (this.entries.has(proxy_name) && this.entries.get(proxy_name)!.binding.source_slug !== slug)) throw new Error('tool name collision: ' + proxy_name);
      names.add(proxy_name);
      const binding: ToolBinding = Object.freeze({ ...tool, id: hash({ slug, tool, revision }), source_slug: slug, original_name: tool.name, proxy_name, backendNames: { pi: proxy_name, replay: proxy_name }, channel, revision });
      if (tool.inputSchema.$async) throw new Error('async_tool_schema_not_supported');
      const Validator = /2020-12/.test(String(tool.inputSchema.$schema ?? '')) ? Ajv2020Module as unknown as typeof import('ajv').default : Ajv;
      const ajv = new Validator({ allErrors: true, strict: false });
      ajv.addFormat('date-time', { type: 'string', validate: (s: string) => /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s)) });
      const validate = ajv.compile(tool.inputSchema);
      batch.push({ binding, client, validate });
    }
    const previous = this.sources.get(slug);
    for (const [key, entry] of this.entries) if (entry.binding.source_slug === slug) this.entries.delete(key);
    if (previous && previous.client !== client) await previous.client.close();
    for (const entry of batch) this.entries.set(entry.binding.proxy_name, entry);
    this.sources.set(slug, { client, revision, active: true });
  }
  list(): ToolBinding[] { return [...this.entries.values()].filter(e => this.active(e.binding.source_slug)).map(e => structuredClone(e.binding)); }
  binding(name: string): ToolBinding { const e = this.entries.get(name); if (!e) throw new Error('unknown_tool: ' + name); return structuredClone(e.binding); }
  active(slug: string): boolean { return this.sources.get(slug)?.active === true; }
  known(slug: string): boolean { return this.sources.has(slug); }
  setActive(slug: string, active: boolean): void { const s = this.sources.get(slug); if (!s) throw new Error('unknown_source: ' + slug); s.active = active; }
  validate(binding: ToolBinding, args: Record<string, unknown>, task: AgentTask): string | undefined {
    const entry = this.entries.get(binding.proxy_name);
    if (!entry || entry.binding.id !== binding.id) return 'stale_binding';
    if (!this.active(binding.source_slug)) return 'inactive_source';
    if (!entry.validate(args)) return 'invalid_tool_arguments';
    return entry.client.validateScope?.(binding.original_name, args, task);
  }
  availableActions(binding: ToolBinding): Action[] { const entry = this.entries.get(binding.proxy_name); if (!entry || entry.binding.id !== binding.id) return []; return entry.binding.dynamicAction && entry.client.resolveAction ? entry.binding.availableActions ?? [entry.binding.action] : [entry.binding.action]; }
  resolveAction(binding: ToolBinding, args: Record<string, unknown>, task: AgentTask): Action { const entry = this.entries.get(binding.proxy_name); if (!entry || entry.binding.id !== binding.id) throw new Error('stale_binding'); return entry.binding.dynamicAction && entry.client.resolveAction ? entry.client.resolveAction(binding.original_name, args, task) : entry.binding.action; }
  checkPrerequisites(binding: ToolBinding, args: Record<string, unknown>): string | undefined { const entry = this.entries.get(binding.proxy_name); return entry?.client.checkPrerequisites?.(binding.original_name, args); }
  sourceGuides(task: AgentTask): Array<{sourceSlug: string; path: string}> { return [...this.sources].filter(([slug, source]) => source.active && task.allowedSources.includes(slug) && source.client.guide).map(([sourceSlug, source]) => ({sourceSlug, path: source.client.guide!.path})); }
  sourceGuideStates(task: AgentTask) {
    return [...this.sources].filter(([slug, source]) => task.allowedSources.includes(slug) && source.client.guide).map(([sourceSlug, source]) => {
      let reason: string | undefined;
      try { reason = source.active ? source.client.guide!.check() : 'source_inactive'; } catch { reason = 'source_guide_unavailable'; }
      const state = !source.active ? 'inactive' : !reason ? 'current' : reason.startsWith('source_guide_required:') ? 'unread' : reason.startsWith('source_guide_changed:') ? 'changed' : 'unavailable';
      return { sourceSlug, path: source.client.guide!.path, state, ...(reason ? { reason } : {}) };
    });
  }
  async readSourceGuide(slug: string, task: AgentTask, signal: AbortSignal): Promise<SourceGuide> { const source=this.sources.get(slug); if (!source?.active || !task.allowedSources.includes(slug) || !source.client.guide) throw new Error('source_guide_outside_scope'); return source.client.guide.read(signal); }
  resetSourceGuides(): void { for (const source of this.sources.values()) source.client.guide?.reset(); }
  // Dispatch is private to the executor capability. Clients are never exposed by list/binding.
  dispatcher(): (binding: ToolBinding, args: Record<string, unknown>, signal: AbortSignal, context?: ToolExecutionContext) => Promise<unknown> {
    return async (binding, args, signal, context) => { signal.throwIfAborted(); const e = this.entries.get(binding.proxy_name); if (!e || e.binding.id !== binding.id || !this.active(binding.source_slug)) throw new Error('stale_or_inactive_binding'); return e.client.callTool(binding.original_name, args, signal, context); };
  }
  async revoke(slug: string): Promise<void> { this.setActive(slug, false); const s = this.sources.get(slug)!; for (const [k, e] of this.entries) if (e.binding.source_slug === slug) this.entries.delete(k); await s.client.close(); }
  async close(): Promise<void> { await Promise.all([...this.sources.values()].map(s => s.client.close())); }
}
