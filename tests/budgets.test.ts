import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLimits, reportedTokens } from "@cwatch/shared/agent/core/budgets";
import { runInvestigation, type RuntimeOptions } from "@cwatch/server-core/runtime/investigation";
import { ReplayModel } from "@cwatch/shared/agent/models";
import { ToolRegistry } from "@cwatch/shared/tools/registry";
import { type Decision, type ModelPort } from "@cwatch/core/types";
import { validateTrace, type TraceEvent } from "@cwatch/shared/sessions/trace";
import { check, CountingClient, json, store, task } from './harness.ts';

check('contract', 'Run limits reject non-integers, non-finite values and unsafe timer delays', () => {
  for (const options of [{ maxTokens: NaN }, { maxOutputTokens: 0 }, { maxSameToolCalls: -1 }, { maxSteps: 1.5 }, { timeoutMs: 2_147_483_648 }, { contextChars: Infinity }]) assert.throws(() => resolveLimits(options), /invalid_limit/);
  assert.equal(resolveLimits({ maxSameToolCalls: 0 }).maxSameToolCalls, 0);
});
check('contract', 'Token totals include caches once and do not double-count reasoning subsets', () => {
  assert.equal(reportedTokens({ input: 100, output: 30, cacheRead: 40, cacheWrite: 50, cacheWrite1h: 20, reasoning: 10, totalTokens: 220 }), 220);
  assert.equal(reportedTokens({ input: 100, output: 30, cacheRead: 40, cacheWrite: 50, totalTokens: 130 }), 220);
  assert.equal(reportedTokens({ totalTokens: 12 }), 12);
  for (const usage of [undefined, {}, { totalTokens: 0 }, { totalTokens: -1 }, { totalTokens: Infinity }]) assert.equal(reportedTokens(usage), undefined);
});

async function replayLimited(options: RuntimeOptions, model?: ModelPort) {
  const data = store(), registry = new ToolRegistry(), source = new CountingClient();
  const value = { ...task(), allowedSources: ['official'] };
  await registry.register('official','mcp',source,new AbortController().signal);
  const initial = json<Decision[]>('fixtures/model-script.json')[0] as Extract<Decision,{kind:'call_tool'}>;
  const plan = { ...initial, args: { ...initial.args, sources: ['official'] } };
  const steps: Decision[] = [plan, ...['alpha','beta','gamma'].map(query => ({kind:'call_tool' as const,name:'mcp__official__search_news',args:{query}}))];
  try {
    const result = await runInvestigation(value, model ?? new ReplayModel(steps),registry,data,'replay',options);
    const events = data.lines<TraceEvent>('traces/' + result.runId + '.jsonl');
    assert.deepEqual(validateTrace(events),[]);
    return {result,events,data,source};
  } finally { await registry.close(); }
}
check('contract', 'Per-tool budget counts changed arguments across a run before the next side effect', async () => {
  const actual = await replayLimited({maxSameToolCalls:2});
  assert.match(actual.result.error!,/budget_same_tool/);
  assert.equal(actual.source.calls.length,2);
  assert.equal(actual.data.executions().length,3);
  const stop = actual.events.find(e=>e.type==='budget_exceeded')!;
  assert.equal(stop.data.tool,'mcp__official__search_news');
  assert.equal(stop.data.actual,3);
  assert.equal(stop.data.limit,2);
});
check('contract', 'A zero per-tool budget prevents even the first workflow write', async () => {
  const actual = await replayLimited({maxSameToolCalls:0});
  assert.match(actual.result.error!,/budget_same_tool/);
  assert.equal(actual.data.executions().length,0);
});
check('contract', 'Model response character budget blocks an oversized decision without executing tools', async () => {
  const actual = await replayLimited({maxResponseChars:40});
  assert.match(actual.result.error!,/budget_response_chars/);
  assert.equal(actual.data.executions().length,0);
  assert.ok(actual.events.some(e=>e.type==='budget_exceeded'));
});
check('contract', 'The host model deadline stops a model which ignores cancellation and persists its reason', async () => {
  const actual = await replayLimited({modelTimeoutMs:20,timeoutMs:1000},{decide:async()=>new Promise(()=>{})});
  assert.match(actual.result.error!,/budget_model_timeout/);
  assert.equal(actual.data.executions().length,0);
  assert.ok(actual.events.some(e=>e.type==='budget_exceeded'));
});
check('contract', 'CLI rejects missing and invalid limit arguments before creating output directories', () => {
  for (const args of [['--max-tokens','NaN'],['--model-timeout','0'],['--max-same-tool-calls','-1'],['--max-output-tokens']]) {
    const out=resolve(store().root,'invalid-cli-out');
    const result=spawnSync(process.execPath,['--experimental-transform-types',"apps/cli/src/index.ts",'run','--out',out,...args],{encoding:'utf8'});
    assert.equal(result.status,1);
    assert.match(result.stderr,/invalid_limit/);
    assert.equal(existsSync(out),false);
  }
});
