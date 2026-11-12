import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readLangfuseConfig } from '@cwatch/shared/config/langfuse';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { ToolRegistry } from '@cwatch/shared/tools/registry';
import { runAgent } from '@cwatch/server-core/runtime/agent';
import type { ModelPort } from '@cwatch/core/types';

if (existsSync('.env')) process.loadEnvFile('.env');
async function main(): Promise<void> {
  if (!readLangfuseConfig()) throw Error('Fill LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env first; LANGFUSE_ENABLED must not be false.');
  const registry = new ToolRegistry();
  await registry.register('probe', 'mcp', {
    async listTools() { return [{ name: 'echo', description: 'Local Langfuse connection probe', action: 'collect', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]; },
    async callTool(_name, _args, _signal, context) { return context!.stage('probe.local', async () => ({ ok: true, synthetic: true })); }, async close() {},
  }, new AbortController().signal);
  let round = 0;
  const model: ModelPort = {
    traceModel: { provider: 'fixture', id: 'cwatch-langfuse-probe' },
    usage: { input: 1, output: 1, totalTokens: 2 },
    async decide() { return round++ === 0 ? { kind: 'call_tool', name: 'mcp__probe__echo', args: {} } : { kind: 'respond', text: 'Langfuse connection probe completed (synthetic; no model API request).' }; },
  };
  try {
    const data = new FileStore(resolve('.runtime/langfuse-probe'));
    const result = await runAgent({ kind: 'agent', taskId: 'langfuse-probe-' + Date.now(), instruction: 'Synthetic Langfuse connection probe', allowedSources: ['probe'] }, model, registry, data, 'live', { builtinTools: false });
    console.log(JSON.stringify({ runId: result.runId, taskStatus: result.status, langfuse: result.langfuse, localTrace: data.path('traces/' + result.runId + '.json'), synthetic: true }, null, 2));
    if (result.status !== 'complete' || result.langfuse?.status !== 'exported') process.exitCode = 1;
  } finally { await registry.close(); }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
