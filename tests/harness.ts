import { mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CompetitorTask, type SourceClient, type ToolDefinition, parseTask, id } from "@cwatch/core/types";
import { FileStore } from "@cwatch/shared/sessions/storage";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { ToolExecutor } from "@cwatch/shared/tools/executor";
import { ActionPolicy, ApprovalManager, type ApprovalResponder, type Mode } from "@cwatch/shared/agent/core/permission-manager";
import { Trace } from "@cwatch/shared/sessions/trace";
export const json = <T = any>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8'));
export const task = (): CompetitorTask => parseTask(json('examples/task.json'));
export const fixture = (name = 'official') => json<import("@cwatch/core/types").RetrievalResult>('fixtures/' + name + '.json');
export const signal = () => structuredClone(fixture().signals[0]);
export function store(): FileStore { const base = resolve('artifacts/test-work'); new FileStore(base); return new FileStore(mkdtempSync(resolve(base, 'case-'))); }
export function deferred<T>() { let resolve!: (v: T) => void; let reject!: (v: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export const waitTick = () => new Promise<void>(r => setTimeout(r, 5));
export const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
export class CountingClient implements SourceClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = []; closed = 0;
  constructor(readonly definitions: ToolDefinition[] = [{ name: 'search.news', description: 'test read', action: 'collect', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }], readonly handler: (signal: AbortSignal) => Promise<unknown> = async () => ({ ok: true })) {}
  async listTools() { return this.definitions; }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) { this.calls.push({ name, args }); return this.handler(signal); }
  async close() { this.closed++; }
}
export async function executionHarness(options: { action?: ToolDefinition['action']; mode?: Mode; responder?: ApprovalResponder; ttl?: number; handler?: (signal: AbortSignal) => Promise<unknown> } = {}) {
  const registry = new ToolRegistry(), data = store(), trace = new Trace(data, task().taskId, id());
  const client = new CountingClient([{ name: 'op', description: 'host declared semantics', action: options.action ?? 'collect', inputSchema: { type: 'object', properties: { destination: { type: 'string' }, incoming_mode: { type: 'string' } }, additionalProperties: false } }], options.handler);
  await registry.register('official', 'mcp', client, new AbortController().signal);
  const policy = new ActionPolicy(options.mode ?? 'explore'), approvals = new ApprovalManager(options.responder, options.ttl ?? 30_000);
  const executor = new ToolExecutor(registry, policy, approvals, data, trace, task(), 500);
  return { registry, data, trace, client, policy, approvals, executor };
}
export interface EvalCase { name: string; group: 'contract' | 'semantic' | 'integration'; critical: boolean; run: () => Promise<void> | void }
export const cases: EvalCase[] = [];
export function check(group: EvalCase['group'], name: string, run: EvalCase['run'], critical = true) { cases.push({ name, group, run, critical }); }
