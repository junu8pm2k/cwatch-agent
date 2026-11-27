import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { id, type CompetitorTask } from '@cwatch/core/types';
import type { RunSnapshot } from '@cwatch/core/types/runs';
import { RunService, type RunServiceOptions } from '@cwatch/server-core/runtime/run-service';
import { FileStore } from '@cwatch/shared/sessions/storage';
import { Trace } from '@cwatch/shared/sessions/trace';
import { createWebToolDefinitions } from '@cwatch/shared/sources/web-tools';
import { startWebServer } from '../apps/web/src/server.ts';
import { browserExecutable } from './browser-fixture.ts';
import { check, fixture, store, task as makeTask, type EvalCase } from './harness.ts';
import { WorkbenchPage } from './web-ui-page.ts';

const localCases: EvalCase[] = [];
function registerCase(group: EvalCase['group'], name: string, run: EvalCase['run']): void {
  localCases.push({ group, name, run, critical: true });
  check(group, name, run);
}

const VALID_SHA256 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CORRUPT_SHA256 = 'deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb';

function seedRichRun(outputRoot: string): { runId: string; traceRunId: string; snapshot: RunSnapshot } {
  const runId = id();
  const traceRunId = id();
  const task: CompetitorTask = {
    ...makeTask(),
    taskId: 'rail-trace-upgrade-01',
    competitor: { id: 'acme', name: 'Acme AI', aliases: ['Acme'], domains: ['acme.example'] },
    product: 'Acme Code Plan',
    allowedSources: ['web'],
  };

  const runStore = new FileStore(resolve(outputRoot, runId));
  const createdAt = '2026-04-10T08:00:00.000Z';
  const endedAt = '2026-04-10T08:00:18.000Z';

  const snapshot: RunSnapshot = {
    id: runId,
    task,
    profile: 'web',
    mode: 'live',
    permission: 'explore',
    status: 'complete',
    createdAt,
    updatedAt: endedAt,
    endedAt,
    traceRunId,
    langfuse: {
      status: 'exported',
      traceId: '0123456789abcdef0123456789abcdef',
      traceUrl: 'https://cloud.langfuse.com/project/proj-fixture/traces/0123456789abcdef0123456789abcdef',
    },
    activities: [
      { sequence: 1, timestamp: '2026-04-10T08:00:01.000Z', kind: 'plan', stage: 0, message: '调查计划已保存并提交。' },
      { sequence: 2, timestamp: '2026-04-10T08:00:02.000Z', kind: 'tool', stage: 1, tool: 'web_search', message: '准备调用 web_search', detail: '{"query":"Acme Code Plan pricing 2026"}', callId: 'call-1', batchId: 'batch-1', batchSize: 3 },
      { sequence: 3, timestamp: '2026-04-10T08:00:02.005Z', kind: 'tool', stage: 1, tool: 'web_fetch', message: '准备调用 web_fetch', detail: '{"url":"https://docs.acme.example/pricing/code-plan-2026"}', callId: 'call-2', batchId: 'batch-1', batchSize: 3 },
      { sequence: 4, timestamp: '2026-04-10T08:00:02.010Z', kind: 'tool', stage: 1, tool: 'web_fetch', message: '准备调用 web_fetch', detail: '{"url":"https://timeout.acme.example/old"}', callId: 'call-3', batchId: 'batch-1', batchSize: 3 },
      { sequence: 5, timestamp: '2026-04-10T08:00:04.000Z', kind: 'tool', stage: 1, tool: 'web_search', state: 'completed', message: 'web_search 已完成', callId: 'call-1' },
      { sequence: 6, timestamp: '2026-04-10T08:00:05.000Z', kind: 'tool', stage: 1, tool: 'web_fetch', state: 'completed', message: 'web_fetch 已完成', callId: 'call-2' },
      { sequence: 7, timestamp: '2026-04-10T08:00:06.000Z', kind: 'error', stage: 1, tool: 'web_fetch', state: 'failed', message: 'web_fetch 未完成', detail: 'timeout: upstream fetch timed out', callId: 'call-3' },
      { sequence: 8, timestamp: '2026-04-10T08:00:07.000Z', kind: 'analysis', stage: 1, tool: 'workflow__assess_search', message: '准备调用 workflow__assess_search', detail: '{"query":"Acme Code Plan pricing 2026"}' },
      { sequence: 9, timestamp: '2026-04-10T08:00:07.200Z', kind: 'error', stage: 1, tool: 'workflow__assess_search', state: 'failed', message: 'workflow__assess_search 未完成', detail: 'Error: search_candidate_not_observed' },
      { sequence: 10, timestamp: '2026-04-10T08:00:08.000Z', kind: 'tool', stage: 1, tool: 'web_search', message: '准备调用 web_search', detail: '{"query":"extra query"}', callId: 'call-4' },
      { sequence: 11, timestamp: '2026-04-10T08:00:08.050Z', kind: 'tool', stage: 1, tool: 'web_search', state: 'skipped', message: 'web_search 已跳过（工具额度受限）', callId: 'call-4' },
      { sequence: 12, timestamp: '2026-04-10T08:00:17.000Z', kind: 'system', stage: 4, message: '调查已完成，报告已保存。' },
    ],
    approvals: [],
    gaps: ['pricing_enterprise_tier: 未公开企业版年度折扣细则'],
    claims: [
      {
        id: 'claim-1',
        text: 'Acme Code Plan Pro 月费调整为 29 美元，并新增 2x 速率配额。',
        evidence: [
          {
            source: 'web',
            url: 'https://docs.acme.example/pricing/code-plan-2026',
            title: 'Acme Code Plan 2026 Pricing Announcement',
            publishedAt: '2026-04-08T10:00:00.000Z',
            provenance: 'live',
            retrievedAt: '2026-04-10T08:00:05.000Z',
            excerpt: 'Starting April 8, 2026, Acme Code Plan Pro is priced at $29/month with doubled rate limits and priority queue access for all subscribers across supported regions.',
            domain: 'docs.acme.example',
            snapshotHash: VALID_SHA256,
            snapshotVerified: true,
            attribution: 'matched',
            timeStatus: 'in_window',
          },
          {
            source: 'web',
            url: 'https://releases.acme.example/changelog/v2-4',
            title: 'Release Notes v2.4 (Corrupt Snapshot Fixture)',
            publishedAt: null,
            provenance: 'fixture',
            snapshotHash: CORRUPT_SHA256,
            snapshotVerified: false,
            attribution: 'ambiguous',
            timeStatus: 'out_of_window',
          },
        ],
      },
      {
        id: 'claim-2',
        text: '旧格式兼容与安全转义校验主张。',
        evidence: [
          {
            source: 'official',
            url: 'https://legacy.acme.example/notes/legacy-1',
            title: 'Legacy Minimal Evidence Card',
            publishedAt: '2026-04-02T00:00:00.000Z',
            provenance: 'fixture',
          },
          {
            source: '<b>xss-src</b>',
            url: 'javascript:alert(1)',
            title: '<img src=x onerror="window.__railXss=1">不安全标题',
            publishedAt: '2026-04-03T00:00:00.000Z',
            provenance: 'live',
            retrievedAt: '2026-04-10T08:00:09.000Z',
            excerpt: '<img src=x onerror="window.__railXss=2">摘录防注入内容',
            domain: '<svg onload="window.__railXss=3">evil.test',
            snapshotHash: '<img src=x onerror="window.__railXss=4">ff00aa11',
            snapshotVerified: true,
            attribution: 'wrong_entity',
            timeStatus: 'unknown_time',
          },
        ],
      },
    ],
    toolCalls: 7,
    modelTurns: 3,
    totalTokens: 1580,
    reportReady: true,
    stage: 5,
    revision: 4,
  };

  runStore.text('reports/' + traceRunId + '.md', [
    '# Acme AI / Acme Code Plan 调查草稿',
    '',
    '本报告用于验证右侧引用证据栏与左侧结构化 Trace 抽屉升级。',
  ].join('\n'));
  runStore.write('summary.json', { view: { ...snapshot, activities: [], approvals: [] }, reportPath: 'reports/' + traceRunId + '.md' });
  for (const act of snapshot.activities) runStore.append('activity.jsonl', act);

  // Build real Trace events so RunService.trace() projects and Zod-validates a real StructuredTrace
  const trace = new Trace(runStore, task.taskId, traceRunId);
  const emitToolStep = (
    toolName: string,
    input: Record<string, unknown>,
    result: unknown,
    sdkToolCallId?: string,
  ): void => {
    const requestId = id();
    const bindingId = 'bind-' + toolName;
    const base = {
      requestId,
      taskId: task.taskId,
      toolName,
      bindingId,
      argsHash: VALID_SHA256,
      ...(sdkToolCallId ? { sdkToolCallId } : {}),
    };
    trace.emit('pre_tool_use_request', { ...base, input });
    trace.emit('policy_decision', {
      requestId,
      binding: { id: bindingId, proxy_name: toolName },
      argsHash: VALID_SHA256,
      effectiveMode: 'explore',
      decision: 'ALLOW',
      reason: 'test_fixture_allow',
    });
    trace.emit('pre_tool_use_response', {
      ...base,
      action: 'allow',
      reason: 'test_fixture_allow',
      effectiveMode: 'explore',
    });
    trace.emit('execution_started', {
      requestId,
      bindingId,
      ...(sdkToolCallId ? { sdkToolCallId } : {}),
    });
    trace.emit('execution_finished', {
      requestId,
      state: 'completed',
      result,
    });
    trace.emit('observation_added', {
      name: toolName,
      observation: result,
      ...(sdkToolCallId ? { sdkToolCallId } : {}),
    });
  };

  trace.emit('run_started', {
    task,
    mode: 'live',
    permissionMode: 'explore',
    engine: 'pi',
    model: { provider: 'fixture-provider', id: 'fixture-model-1' },
  });

  // Model turn 1 -> call workflow__save_plan
  const planInput = {
    taskId: task.taskId,
    objective: '核验 Acme Code Plan 2026 年 4 月最新定价与功能配额变化',
    sources: ['web'],
    queries: ['site:acme.example Acme Code Plan pricing 2026', 'Acme Code Plan v2.4 changelog'],
    evidenceRequirements: ['公开 HTTPS 来源链接与 SHA-256 快照', '明确发布时间与实体归属核验'],
    window: { start: task.window.start, end: task.window.end },
  };
  trace.emit('model_requested', { iteration: 1, contextChars: 3420 });
  trace.emit('decision_made', {
    iteration: 1,
    decision: { kind: 'call_tool', name: 'workflow__save_plan', args: planInput },
  });
  trace.emit('model_usage', { iteration: 1, purpose: 'turn', usage: { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 420 } });
  emitToolStep('workflow__save_plan', planInput, { submitted: true, path: 'plans/' + traceRunId + '.json', sources: ['web'] });

  // Model turn 2 -> parallel call web_search + web_fetch
  const searchInput = { query: 'Acme Code Plan pricing 2026', limit: 5 };
  const fetchInput = { url: 'https://docs.acme.example/pricing/code-plan-2026' };
  trace.emit('model_requested', { iteration: 2, contextChars: 5120 });
  trace.emit('decision_made', {
    iteration: 2,
    decision: {
      kind: 'call_tools',
      calls: [
        { sdkToolCallId: 'sdk-1', name: 'web_search', args: searchInput },
        { sdkToolCallId: 'sdk-2', name: 'web_fetch', args: fetchInput },
      ],
    },
  });
  trace.emit('model_usage', { iteration: 2, purpose: 'turn', usage: { input: 500, output: 240, cacheRead: 0, cacheWrite: 0, totalTokens: 740 } });

  emitToolStep(
    'web_search',
    searchInput,
    {
      status: 'success_with_data',
      provenance: 'live',
      signals: [],
      raw: 'search-raw',
      searchResults: [
        {
          url: 'https://docs.acme.example/pricing/code-plan-2026',
          title: 'Acme Code Plan 2026 Official Pricing',
          snippet: 'Pro plan is $29/month with 2x rate limits.',
          published_at: '2026-04-08T10:00:00.000Z',
          retrieved_at: '2026-04-10T08:00:05.000Z',
        },
        {
          url: 'javascript:alert(1)',
          title: '<img src=x onerror="window.__traceXss=1">恶意搜索结果',
          snippet: '<script>window.__traceXss=2</script>拦截测试',
          published_at: null,
          retrieved_at: '2026-04-10T08:00:05.000Z',
        },
      ],
    },
    'sdk-1',
  );

  emitToolStep(
    'web_fetch',
    fetchInput,
    {
      status: 'success_with_data',
      provenance: 'live',
      signals: [],
      raw: 'page-raw',
      http: { status: 200 },
      pages: [
        {
          url: 'https://docs.acme.example/pricing/code-plan-2026',
          title: 'Acme Code Plan 2026 Pricing Page',
          text: 'Acme Code Plan Pro costs $29/month. '.repeat(80),
          published_at: '2026-04-08T10:00:00.000Z',
          retrieved_at: '2026-04-10T08:00:06.000Z',
          truncated: true,
        },
      ],
    },
    'sdk-2',
  );

  emitToolStep(
    'workflow__extract_signal',
    {
      signalType: 'price',
      eventKey: 'acme-code-plan-pro-2026',
      title: 'Acme Code Plan Pro 定价',
      value: '$29/月，速率配额翻倍',
      quote: 'Starting April 8, 2026, Acme Code Plan Pro is priced at $29/month with doubled rate limits.',
      url: 'https://docs.acme.example/pricing/code-plan-2026',
      polarity: 'supports',
    },
    { accepted: true, evidenceId: 'ev-acme-01' },
  );

  emitToolStep(
    'workflow__analyze',
    {},
    {
      claims: [{ id: 'claim-1', text: 'Acme Code Plan Pro 定价: $29/月' }],
      comparisons: [{ eventId: 'event-1', status: 'updated', previousVersions: ['ver-old'], currentVersions: ['ver-new'] }],
      evidenceIds: ['ev-acme-01', 'ev-acme-02'],
      gaps: ['pricing_enterprise_tier: 未公开企业版年度折扣细则'],
    },
  );

  emitToolStep(
    'workflow__review',
    {},
    {
      decision: 'needs_evidence',
      reworkAvailable: true,
      issues: ['snapshot_missing_or_corrupt:ev-acme-02', 'missing_enterprise_pricing_source'],
      evidenceRefs: ['ev-acme-01', 'ev-acme-02'],
    },
  );

  emitToolStep(
    'workflow__draft',
    { narrative: '调查草稿正文。', claimIds: ['claim-1', 'claim-2'] },
    {
      path: 'reports/' + traceRunId + '.md',
      claimIds: ['claim-1', 'claim-2'],
      review: 'accept',
      gaps: ['pricing_enterprise_tier: 未公开企业版年度折扣细则'],
    },
  );

  // Model turn 3 -> respond
  trace.emit('model_requested', { iteration: 3, contextChars: 6890 });
  trace.emit('decision_made', {
    iteration: 3,
    decision: { kind: 'respond', text: '已完成 Acme Code Plan 定价调查，已保存结构化草稿与核验证据。' },
  });
  trace.emit('model_usage', { iteration: 3, purpose: 'turn', usage: { input: 310, output: 110, cacheRead: 0, cacheWrite: 0, totalTokens: 420 } });

  trace.emit('run_completed', { status: 'complete', report: 'reports/' + traceRunId + '.md', gaps: snapshot.gaps });
  return { runId, traceRunId, snapshot };
}

async function createHarness(name: string, options: Partial<RunServiceOptions> = {}, seed = false) {
  const data = store();
  const seeded = seed ? seedRichRun(data.root) : undefined;
  const root = options.root ?? process.cwd();
  const service = new RunService({ root, outputRoot: data.root, ...options });
  const app = await startWebServer({ root, port: 0, service });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  mkdirSync('artifacts/web-eval', { recursive: true });
  try {
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
  } catch (error) {
    await browser?.close();
    await app.close();
    throw error;
  }
  return {
    app,
    service,
    page,
    ui: new WorkbenchPage(page, app.origin),
    seeded,
    pageErrors,
    consoleErrors,
    close: async () => {
      try {
        await browser!.close();
      } finally {
        await app.close();
      }
    },
  };
}

registerCase('integration', 'Evidence Rail renders enriched fields, toggles snapshot metadata without claim highlight misfire, degrades legacy data cleanly and blocks XSS', async () => {
  const h = await createHarness('rail-enriched', {}, true);
  try {
    await h.page.goto(h.app.origin);
    await h.ui.openSavedRun(h.seeded!.runId);
    await h.page.getByText('本地服务已连接', { exact: true }).waitFor();
    await h.page.locator('#evidence-rail .evidence-card').first().waitFor({ state: 'visible' });

    const cards = h.page.locator('#evidence-rail .evidence-card');
    assert.equal(await cards.count(), 4);

    // Card 1: live enriched evidence with domain, excerpt, dual timestamps & verified SHA-256
    const card1 = cards.nth(0);
    const card1Text = await card1.innerText();
    assert.ok(card1Text.includes('docs.acme.example'), 'Card 1 should show domain');
    assert.ok(card1Text.includes('实采来源'), 'Card 1 should show live provenance label');
    assert.ok(card1Text.includes('SHA-256 已核验'), 'Card 1 should show verified SHA-256 badge');
    assert.ok(card1Text.includes(VALID_SHA256.slice(0, 8)), 'Card 1 should show 8-char short hash');
    assert.ok(card1Text.includes('发布:'), 'Card 1 should show published timestamp');
    assert.ok(card1Text.includes('采集:'), 'Card 1 should show retrieved timestamp');
    assert.equal(await card1.locator('.evidence-excerpt').isVisible(), true);
    assert.ok((await card1.locator('.evidence-excerpt').innerText()).includes('$29/month'));

    // Card 2: fixture with fallback hostname extraction, null publishedAt & failed snapshot verification
    const card2 = cards.nth(1);
    const card2Text = await card2.innerText();
    assert.ok(card2Text.includes('releases.acme.example'), 'Card 2 should parse hostname from URL');
    assert.ok(card2Text.includes('合成快照'), 'Card 2 should show fixture provenance label');
    assert.ok(card2Text.includes('快照异常'), 'Card 2 should show alert badge when snapshotVerified === false');
    assert.ok(card2Text.includes('发布: 未知'), 'Card 2 should show unknown published date cleanly');
    assert.equal(await card2.locator('.evidence-snapshot-badge.tone-error').count(), 1);

    // Card 3: legacy minimal evidence degrades cleanly with zero "undefined"
    const card3 = cards.nth(2);
    const card3Text = await card3.innerText();
    assert.ok(card3Text.includes('legacy.acme.example'));
    assert.ok(card3Text.includes('合成快照'));
    assert.ok(card3Text.includes('发布:'));
    assert.equal(card3Text.includes('采集:'), false);
    assert.equal(card3Text.includes('SHA-256'), false);
    assert.equal(card3Text.includes('undefined'), false);
    await card3.locator('.evidence-detail-toggle').click();
    assert.equal(await card3.locator('.evidence-detail-panel').isVisible(), true);
    assert.equal((await card3.locator('.evidence-detail-panel').innerText()).includes('undefined'), false);
    await card3.locator('.evidence-detail-toggle').click();
    assert.equal(await card3.locator('.evidence-detail-panel').isVisible(), false);

    // Expanding/collapsing Card 1 metadata drawer MUST NOT trigger claim highlight
    assert.equal(await h.page.locator('#evidence-rail .evidence-card.highlighted').count(), 0);
    assert.equal(await h.page.locator('#report-content .claim.highlighted').count(), 0);

    const toggle1 = card1.locator('.evidence-detail-toggle');
    assert.equal(await toggle1.getAttribute('aria-expanded'), 'false');
    await toggle1.click();
    assert.equal(await toggle1.getAttribute('aria-expanded'), 'true');
    const panel1 = card1.locator('.evidence-detail-panel');
    await panel1.waitFor({ state: 'visible' });
    const panel1Text = await panel1.innerText();
    assert.ok(panel1Text.includes(VALID_SHA256), 'Expanded panel should display full 64-char SHA-256');
    assert.ok(panel1Text.includes('matched'), 'Expanded panel should display attribution');
    assert.ok(panel1Text.includes('in_window'), 'Expanded panel should display timeStatus');
    assert.ok(panel1Text.includes('priority queue access'), 'Expanded panel should display full excerpt');
    assert.equal(await panel1.locator('a.evidence-origin-link').getAttribute('href'), 'https://docs.acme.example/pricing/code-plan-2026');

    // Verify no claim highlight occurred after clicking toggle button or clicking hash text inside panel
    assert.equal(await h.page.locator('#evidence-rail .evidence-card.highlighted').count(), 0);
    assert.equal(await h.page.locator('#report-content .claim.highlighted').count(), 0);
    await panel1.locator('.evidence-hash-full').click();
    assert.equal(await h.page.locator('#evidence-rail .evidence-card.highlighted').count(), 0);

    // Clicking the card header itself SHOULD trigger bidirectional claim highlight while keeping expanded panel open
    await card1.locator('.evidence-card-top').click();
    assert.equal(await h.page.locator('#evidence-rail .evidence-card.highlighted').count(), 2);
    assert.equal(await h.page.locator('#report-content .claim[data-claim-id="claim-1"].highlighted').count(), 1);
    assert.equal(await card1.locator('.evidence-detail-panel').isVisible(), true);

    // Collapsing works cleanly and does not clear claim highlight
    await toggle1.click();
    assert.equal(await card1.locator('.evidence-detail-panel').isVisible(), false);
    assert.equal(await h.page.locator('#evidence-rail .evidence-card.highlighted').count(), 2);

    // Card 4: XSS payloads are escaped and javascript: URL is blocked
    const card4 = cards.nth(3);
    await card4.locator('.evidence-detail-toggle').click();
    assert.equal(await h.page.locator('#evidence-rail img[src=x]').count(), 0);
    assert.equal(await h.page.locator('#evidence-rail a[href^="javascript:"]').count(), 0);
    assert.equal(await h.page.evaluate(() => Reflect.get(window, '__railXss')), undefined);
    assert.ok((await card4.innerText()).includes('<img src=x'));

    assert.deepEqual(h.pageErrors, []);
    assert.deepEqual(h.consoleErrors, []);
  } finally {
    await h.close();
  }
});

registerCase('integration', 'Workbench retires custom trace drawer and renders safe external Langfuse Trace links', async () => {
  const h = await createHarness('langfuse-link', {}, true);
  try {
    await h.page.goto(h.app.origin);
    await h.ui.openSavedRun(h.seeded!.runId);
    await h.page.getByText('本地服务已连接', { exact: true }).waitFor();

    // Custom trace drawer and toggle button are retired from the workbench DOM
    assert.equal(await h.page.locator('#trace-drawer').count(), 0);
    assert.equal(await h.page.locator('#toggle-trace-drawer').count(), 0);

    // Header Langfuse Trace direct link is visible with safe external link attributes
    const lfLink = h.ui.langfuseLink();
    await lfLink.waitFor({ state: 'visible' });
    assert.equal(
      await lfLink.getAttribute('href'),
      'https://cloud.langfuse.com/project/proj-fixture/traces/0123456789abcdef0123456789abcdef',
    );
    assert.equal(await lfLink.getAttribute('target'), '_blank');
    assert.equal(await lfLink.getAttribute('rel'), 'noopener noreferrer');
    assert.match((await lfLink.innerText()).trim(), /Langfuse Trace/);

    // Collect stage shows exact tool counts (including workflow errors & skipped) and renders parallel batch as a file tree
    await h.page.locator('#pipeline [data-pipeline-stage="1"]').click();
    const collectDetail = h.page.locator('#pipeline-detail');
    const collectText = await collectDetail.innerText();
    assert.ok(collectText.includes('5 次'), 'Collect tool total should count all 5 stage-1 tools');
    assert.ok(collectText.includes('2 / 2（1 跳过）'), 'Collect success/failure/skipped counts must match stage-1 tool outcomes');
    const collectBatch = collectDetail.locator('.step-batch[data-batch-id="batch-1"]');
    await collectBatch.waitFor({ state: 'visible' });
    assert.ok((await collectBatch.locator('.step-pill.cat-batch').innerText()).includes('并行 ×3'));
    assert.equal(await collectBatch.locator('.step-tree-item').count(), 3);

    // Process tab also renders parallel tool batches as file trees with expandable error detail
    await h.page.getByRole('tab', { name: /执行轨迹/ }).click();
    const processBatch = h.page.locator('#process-content .step-batch[data-batch-id="batch-1"]');
    await processBatch.waitFor({ state: 'visible' });
    assert.equal(await processBatch.locator('.step-tree-item').count(), 3);
    assert.ok((await processBatch.locator('.step-batch-head').innerText()).includes('2 成功 · 1 异常'));
    await processBatch.locator('.step-tree-item.state-failed summary').click();
    assert.ok((await processBatch.locator('.step-tree-item.state-failed .error-pre').innerText()).includes('timeout: upstream fetch timed out'));

    // Draft pipeline stage action also links directly to Langfuse
    await h.page.locator('#pipeline [data-pipeline-stage="4"]').click();
    const draftLfLink = h.page.locator('#pipeline-detail a[href^="https://cloud.langfuse.com/"]');
    await draftLfLink.waitFor({ state: 'visible' });
    assert.equal(await draftLfLink.getAttribute('target'), '_blank');
    assert.equal(await draftLfLink.getAttribute('rel'), 'noopener noreferrer');

    assert.deepEqual(h.pageErrors, []);
    assert.deepEqual(h.consoleErrors, []);
  } finally {
    await h.close();
  }
});

registerCase('integration', 'Evidence Rail and Langfuse header maintain theme parity and zero horizontal overflow on 390px mobile plus clean real-replay degradation', async () => {
  const h = await createHarness('theme-mobile', {}, true);
  try {
    await h.page.goto(h.app.origin);
    await h.ui.openSavedRun(h.seeded!.runId);
    await h.page.getByText('本地服务已连接', { exact: true }).waitFor();
    await h.page.locator('#evidence-rail .evidence-card').first().waitFor({ state: 'visible' });

    // Expand full metadata drawer containing 64-char SHA-256 and long URL, plus stage-1 parallel file tree
    await h.page.locator('#pipeline [data-pipeline-stage="1"]').click();
    await h.page.locator('#pipeline-detail .step-batch').first().waitFor({ state: 'visible' });
    await h.page.locator('#evidence-rail .evidence-card').first().locator('.evidence-detail-toggle').click();
    await h.page.locator('#evidence-rail .evidence-detail-panel').first().waitFor({ state: 'visible' });

    // Switch to dark theme and verify
    await h.page.locator('#theme-toggle').click();
    assert.equal(await h.page.evaluate(() => document.documentElement.dataset.theme), 'dark');

    // Mobile 390px check (dark theme + expanded evidence card)
    await h.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'No horizontal overflow on 390px with expanded evidence rail in dark theme');

    // Switch back to light theme and check 390px again
    await h.page.setViewportSize({ width: 1440, height: 1080 });
    await h.page.locator('#theme-toggle').click();
    assert.equal(await h.page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await h.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'No horizontal overflow on 390px in light theme');

    assert.deepEqual(h.pageErrors, []);
    assert.deepEqual(h.consoleErrors, []);
  } finally {
    await h.close();
  }

  // Real replay run without seeded JSON to verify real RunService end-to-end compatibility
  const hReal = await createHarness('real-replay-compat', {
    configureRegistry: async (registry, signal) => {
      await registry.register('web', 'builtin', {
        listTools: async () => createWebToolDefinitions(),
        callTool: async () => {
          const data = fixture();
          data.signals.forEach(s => { s.sourceSlug = 'web'; });
          return data;
        },
        close: async () => {},
      }, signal);
    },
  }, false);
  try {
    await hReal.ui.open('web');
    await hReal.ui.start();
    await hReal.ui.completed();
    await hReal.ui.report();
    const card = hReal.page.locator('#evidence-rail .evidence-card').first();
    await card.waitFor({ state: 'visible' });
    assert.equal((await card.innerText()).includes('undefined'), false);
    assert.equal(await hReal.ui.langfuseLink().isVisible(), false, 'Replay run must not show external Langfuse link');
    assert.deepEqual(hReal.pageErrors, []);
    assert.deepEqual(hReal.consoleErrors, []);
  } finally {
    await hReal.close();
  }
});

const isMain = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  let passed = 0;
  let failed = 0;
  for (const item of localCases) {
    try {
      await item.run();
      passed++;
      console.log('PASS ' + item.name);
    } catch (error) {
      failed++;
      console.error('FAIL ' + item.name + '\n' + (error instanceof Error ? error.stack : String(error)));
    }
  }
  console.log(JSON.stringify({ total: localCases.length, passed, failed, releaseGate: failed === 0 }));
  if (failed > 0) process.exitCode = 1;
}
