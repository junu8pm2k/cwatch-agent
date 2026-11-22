import '../tests/run-service.test.ts';
import '../tests/generic-agent.test.ts';
import '../tests/web-server.test.ts';
import '../tests/contracts.test.ts';
import '../tests/tool-names.test.ts';
import '../tests/pi-builtins.test.ts';
import '../tests/permissions.test.ts';
import '../tests/pre-tool-use.test.ts';
import '../tests/semantics.test.ts';
import '../tests/pi-protocol.test.ts';
import '../tests/pi-session.test.ts';
import '../tests/session-context.test.ts';
import '../tests/working-state.test.ts';
import '../tests/transcript-lookup.test.ts';
import '../tests/session-memory.test.ts';
import '../tests/badcase-session-memory-multicall.test.ts';
import '../tests/badcase-session-memory-output-limit.test.ts';
import '../tests/badcase-budget-same-tool-web-search.test.ts';
import '../tests/provider-rejections.test.ts';
import '../tests/prompt-cache.test.ts';
import '../tests/api-rounds.test.ts';
import '../tests/pi-subprocess.test.ts';
import '../tests/config.test.ts';
import '../tests/budgets.test.ts';
import '../tests/backend-contracts.test.ts';
import '../tests/api-mcp.test.ts';
import '../tests/api-http.test.ts';
import '../tests/source-coverage.test.ts';
import '../tests/structured-trace.test.ts';
import '../tests/langfuse.test.ts';
import '../tests/agent-prompts.test.ts';
import '../tests/browser-source.test.ts';
import '../tests/domain-dataset.test.ts';
import '../tests/extensions.test.ts';
import '../tests/web.test.ts';
import '../tests/web-mcp.test.ts';
import '../tests/web-api.test.ts';
import '../tests/conversation.test.ts';
import '../tests/investigation-enhancements.test.ts';
import { cases } from '../tests/harness.ts';
import { FileStore } from "@cwatch/shared/sessions/storage";
// Live provider fixtures must never upload to the operator's real Langfuse project.
// Langfuse integration cases explicitly scope their own local test configuration.
process.env.LANGFUSE_ENABLED = 'false';
delete process.env.CWATCH_AGENT_PROMPT_SNAPSHOT;
const startedAt = new Date().toISOString();
const results: Array<{ name: string; group: string; critical: boolean; passed: boolean; durationMs: number; error?: string }> = [];
for (const entry of cases) {
  const started = Date.now();
  try { await entry.run(); results.push({ name: entry.name, group: entry.group, critical: entry.critical, passed: true, durationMs: Date.now() - started }); console.log('PASS [' + entry.group + '] ' + entry.name); }
  catch (e) { results.push({ name: entry.name, group: entry.group, critical: entry.critical, passed: false, durationMs: Date.now() - started, error: e instanceof Error ? e.stack : String(e) }); console.error('FAIL [' + entry.group + '] ' + entry.name + '\n' + String(e)); }
}
const groups = Object.fromEntries(['contract', 'semantic', 'integration'].map(group => { const items = results.filter(r => r.group === group); return [group, { total: items.length, passed: items.filter(r => r.passed).length }]; }));
const report = { startedAt, endedAt: new Date().toISOString(), command: 'npm run verify', dataset: 'synthetic-nodejs-regression-v1', datasets: [{ id: 'synthetic-nodejs-regression-v1', labels: 'fixtures/labels.json' }], metrics: { definition: 'passing independently asserted fixed regression cases / all executed cases; not model generation accuracy', total: results.length, passed: results.filter(r => r.passed).length, groups }, releaseGate: results.every(r => r.passed), results };
const store = new FileStore('artifacts/eval'); store.write('latest.json', report);
store.text('latest.md', `# 本次测试与评测\n\n执行 ${startedAt}\n\n通过 ${report.metrics.passed}/${report.metrics.total}；门禁 ${report.releaseGate ? 'PASS' : 'FAIL'}\n\n| 类别 | 通过 | 分母 |\n|---|---:|---:|\n` + Object.entries(groups).map(([k, v]) => `| ${k} | ${v.passed} | ${v.total} |`).join('\n') + '\n\n' + results.map(r => `- ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`).join('\n') + '\n\n合成固定样本，只证明这些回归用例；不代表真实模型准确率、生产覆盖率或线上效果。\n');
console.log(JSON.stringify({ passed: report.metrics.passed, total: report.metrics.total, groups, releaseGate: report.releaseGate }));
if (!report.releaseGate) process.exitCode = 1;
