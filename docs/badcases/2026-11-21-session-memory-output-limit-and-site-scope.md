# Badcase 记录：Session Memory 冗余载荷触发推理输出耗尽（`output limit exhausted after 2 attempts`）与竞品官方域名 `site:` 查询误拦截

- **Badcase ID**：`bad-session-memory-output-limit-and-site-scope`
- **日期**：2026-11-21
- **来源运行**：
  1. `.runtime/web/c5f82be8-80d5-437d-abac-96c4d8204a65`（Trace `dcdb7c23-9b71-4977-9f7f-111ffe551778`，`modelTurns: 6`，`toolCalls: 8`，`totalTokens: 92780`）
  2. `.runtime/web/68f4ac32-52d5-4540-8e7f-b3a4acdd6dda`（Trace `116b39ab-5a7b-4c16-9e66-dcba84ed7e05`，重试后跨越前两处错误，但在第 4 轮触发 `Error: budget_tokens: 102436/100000` 并伴随 `http://docs.bigmodel.cn/cn/update` 触发 `web_url_outside_scope`）
- **致命错误现象**：
  - 阶段一：`Error: Error: session_memory_update_failed: output limit exhausted after 2 attempts; memory checkpoint unchanged`
  - 阶段二：`Error: budget_tokens: 102436/100000`
- **伴随误拦截与重试现象**：
  - 查询 `site:bigmodel.cn 更新日志 changelog` 触发 `Error: policy_block: web_query_outside_entity_scope`
  - 远端 `web_fetch` 抓取 `https://docs.bigmodel.cn/cn/update/new-releases` 30s 超时后，模型重复尝试同一 URL 并降级尝试 `http://docs.bigmodel.cn/cn/update`（被 HTTPS 策略拦截 `web_url_outside_scope`）

## 根因分析

### 1. 主致命缺陷：`PiSessionMemory` 将冗余原始检索串灌入推理模型，且输出耗尽重试未压缩输入
- 在 Revision 1（`workflow__save_plan` 轮次）中，记忆维护输入仅 `3,955` 字符（`1,063` tokens），`step-5-preview` 第 1 次尝试即在 `959` 输出 token 内（`2,168` thinking 字符 + `1,421` JSON 字符）正常完成 `stop`。
- 进入第 2 轮（并行 5 次 `web_search`，其中 4 条成功返回约 `22KB` 原始 `RetrievalResult` JSON，经 `ToolResultGovernor` 截断为 `~8.4KB` 的 `HEAD` 片段，内容几乎全是三重转义的重复 `"raw"` 字段），`PiSessionMemory.prepare()` 实际发给模型的记忆维护请求高达 **`47,995` 字符（`19,103` input tokens）**。
- **第 1 次尝试（`maxTokens: 1024`）**：`step-5-preview` 逐条分析这 `48KB` 搜索片段，耗尽全部 `1,024` output tokens 于 `<thinking>`（`thinkingChars: 3337`, `textChars: 0`），返回 `stopReason: 'length'`。
- **第 2 次重试（`maxTokens: 4096`）**：`session-memory.ts` 仅做 `rounds.slice(0, 1)`，而单轮并行工具本身就占满预算，导致第 2 次请求输入仍为 **`47,998` 字符（`19,053` input tokens）** 丝毫未缩减；模型再次把全部 `4,096` output tokens 耗尽在 `<thinking>`（`thinkingChars: 13853`, `textChars: 0`），最终抛出 `session_memory_update_failed: output limit exhausted after 2 attempts` 并直接中止整次运行（浪费近 3 分钟与 92k tokens）。

### 2. 伴随范围校验缺陷：`PreferredWebSource.validateScope` 未计入竞品配置域名
- 竞品任务配置为 `name: "智谱"`、`product: "GLM"`、`domains: ["bigmodel.cn"]`。
- 模型发出高度合规的官方域查询 `site:bigmodel.cn 更新日志 changelog`，但 `web.ts` 第 84 行仅检查 `[competitor.name, product, ...aliases]`，未检查配置的具体 `competitor.domains`，导致合法的官方站内搜索被 `web_query_outside_entity_scope` 误拦截。

### 3. 阶段二暴露的级联 Token 消耗与 `web_fetch` 超时后降级 `http://` 重试（`68f4ac32`）
- **Session Memory 首轮 `1024` 输出上限对推理模型偏小，引发每轮双请求级联**：在 `68f4ac32` 中，虽然输入已从 `19,103` tokens 降至 `2,630–3,434` tokens，但 `step-5-preview` 输出 `<thinking>` + JSON 需要 `1,000–1,864` tokens，导致 Attempt 1（`1024`）每次都恰好触顶触发 Attempt 2（`4096`）；而 Attempt 2 仅提交单轮（`rounds.slice(0, 1)`），留下 `pendingMessages: true`，迫使下一轮无条件再次触发 Session Memory（整局多跑了 5 次记忆请求、额外消耗约 `18,000` tokens 与 `35s`）。
- **默认 `100,000` 累计 Token 预算对 5 阶段联网调查过紧**：主循环每轮带 6 条检索结果的活跃上下文约 `28k–44k` tokens（含 `cacheRead`），3 轮业务调用叠加记忆维护即达 `102,436` tokens，在进入 `workflow__analyze` 前触顶中止。
- **远端搜索 MCP 的 `web_fetch` 30s 超时后模型盲目重试并降级 `http://`**：远端 MCP 抓取 `https://docs.bigmodel.cn/cn/update/new-releases` 在 30s 超时返回 `unavailable:search_mcp_request_timeout`，模型未将其记为缺口推进分析，而是再次请求同一 URL 并尝试降级为 `http://docs.bigmodel.cn/cn/update`（被 `allowedUrl` 的强制 HTTPS 规则拦截为 `web_url_outside_scope`）。

## 修复方案

1. `packages/shared/src/agent/backend/pi/session-memory.ts`：
   - **结构化检索结果紧凑投影（Attempt 1 即生效）**：在构建隔离记忆维护输入时（不修改原始转录，且不反膨胀已被 microcompact 缩小的 stub），对 `RetrievalResult` 形状的 `toolResult` 提取紧凑摘要（保留 `status`、`backend`、`error`、`snapshot.path`、`signalsCount`、以及精简后的 `searchResults` 标题/URL/时间与 `pages` 预览，剔除冗余的 `"raw"` 转义原文），将典型 5 路并行搜索轮次从 `~48KB` 压缩至 `~4KB` 级别。
   - **推理模型首轮输出上限提升至 `2048`**：当 `memoryRequestContract` 识别为推理模型（如 `step-5-preview`）时，Attempt 1 输出上限从 `1024` 提升到 `2048`，让记忆更新一次通过并一次性提交所有已完成轮次（`pendingMessages: false`），消除每轮双请求级联。
   - **输出耗尽重试强制收敛输入（Attempt 2 Recovery）**：当 Attempt 1 因 `stopReason === 'length'` 触发重试时，除了保持单轮边界 `rounds.slice(0, 1)` 外，额外将恢复输入预算收敛到 `min(maxInputBudget, 12_000)` 并将单条 `toolResult` 裁剪至紧凑上限（`<= 480` 字符），同时在系统提示词明确禁止逐条展开原始搜索片段。
2. `packages/shared/src/sources/web.ts` & `packages/shared/src/sources/web-tools.ts`：
   - `PreferredWebSource.validateScope()` 对竞品调查的 `web_search` 查询同时按域名边界匹配具体配置的 `task.competitor.domains`（排除通配符 `'*'`），放行 `site:bigmodel.cn ...` 与 `site:docs.bigmodel.cn ...`，同时严格拦截仿冒域名（如 `site:evilbigmodel.cn`）与无关公司查询。
   - `createWebToolDefinitions()` 在 `web_fetch` 描述中明确声明仅允许 `https://`（严禁降级 `http://`），且遇到 `unavailable` 或超时错误时不得重复请求同一 URL，应直接作为来源缺口记录并推进 `workflow__analyze`。
3. `packages/server-core/src/runtime/run-service.ts`、`apps/web/public/index.html`、`apps/web/src/client.ts`：
   - 将 Web 工作台与 `RunService` 的默认累计 Token 预算从 `100,000` 提升至 `400,000`，默认总时限从 `180s` 提升至 `300s`，并在运行轨迹中透传工具软错误详情（如 `unavailable:search_mcp_request_timeout`）。

## 回归用例

- 独立 Badcase 验证与回归用例：[tests/badcase-session-memory-output-limit.test.ts](../../tests/badcase-session-memory-output-limit.test.ts)
- 回归入口：[scripts/eval.ts](../../scripts/eval.ts)
