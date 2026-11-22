# Badcase 记录：Web 联网调研反复在采集阶段触发 `Error: budget_same_tool: 9/8 tool=web_search` 中止

- **Badcase ID**：`bad-budget-same-tool-web-search`
- **日期**：2026-11-22
- **来源运行**：
  1. `.runtime/web/dce87021-ea0c-4150-b4b6-7b58b1dbe15f`（Trace `259b9772-a73f-48eb-ae11-4e722b4f772e`，智谱 GLM 18 个月发布调研，`callsByTool: { workflow__save_plan: 1, web_search: 9, web_fetch: 5 }`，`totalTokens: 226107`，耗时 `275.9s`，停留在阶段 1 采集）
  2. `.runtime/web/baba6bd8-f8f9-4d8c-a288-be4387eb4a5b`（Trace `ea1d4a6b-6a41-4531-9ff8-f49b5a45dc6b`，同任务重试，`callsByTool: { workflow__save_plan: 1, web_search: 9, web_fetch: 4 }`，`totalTokens: 185228`，停留在阶段 1 采集）
- **致命错误现象**：`Error: budget_same_tool: 9/8 tool=web_search`（从未进入 `workflow__analyze` / `workflow__review` / `workflow__draft`）

## 根因分析

1. **`examples/sources-web.json` 遗漏 `searchMcp.requestTimeoutMs: 60000`，导致 Web 工作台 `web_fetch` 100% 在 30.3 秒超时**：
   - `docs/p1-fetch-acceptance-2026-10-24.md` 已验证该远端搜索 MCP 的 `web_fetch` 约需 `30.6–31.0s` 返回正文，因此三份 `examples/competitor-acceptance/*.sources.json` 已显式设置 `searchMcp.requestTimeoutMs: 60000`（仍受父工具 `45000ms` 上限约束）。
   - Web 工作台 `web` / `agent` 模板加载的 `examples/sources-web.json` 仍为 `"searchMcp": {}`，导致 `RemoteSearchMcp` 回落到 `30000ms` 默认值。两次运行合计 9 次 `web_fetch` 全部在 `30.3s` 被截断并报 `unavailable:search_mcp_request_timeout`（每次白耗 30s）。
   - 模型在连续多条不同 URL 均抓取超时后误判抓取服务不可用，试图通过继续追加多轮 `web_search` 批量查询从摘要中补齐信息，直接撞上单工具上限。
2. **Web `RunService` 与深度预设仅上调了时限与 Token，未同步上调或透传工具调用预算**：
   - Web 工作台已提供三档调研深度（快速 `120s/150k`、标准 `300s/400k`、深度 `600s/1M`），且调查流新增了逐条调用的 `workflow__extract_signal` 与单轮 `review -> rework` 补采闭环。
   - 但 `RunService.start()` 与 `RunStartInput.limits` 未传递 `maxSteps` / `maxToolCalls` / `maxSameToolCalls`，全部静默沿用旧 `DEFAULT_LIMITS`（`maxSteps: 24, maxToolCalls: 20, maxSameToolCalls: 8`），即便是「标准核验」与「深度穷举」也固定锁死在单工具 8 次、总计 20 次。
3. **模型对宿主工具预算完全不可见，且达到上限后无停用/提示护栏**：
   - 系统提示词与工具回执均未告知模型当前的 `maxSteps / maxToolCalls / maxSameToolCalls` 及剩余次数。
   - `dce87021` 在 `web_search` 已用 `6/8` 时一次性并行发出 3 条搜索直接跳至 `9/8`；`baba6bd8` 在已达 `8/8` 后完全不知情，继续并行发出 4 条搜索直接触发致命异常，导致整局前功尽弃。

## 修复方案

1. **`examples/sources-web.json`**：
   - 显式配置 `"searchMcp": { "requestTimeoutMs": 60000 }`，与竞品验收来源保持一致（仍严格受父 `toolTimeoutMs: 45000`、总超时与取消信号约束），解决 `web_fetch` 在 `30.3s` 被提前截断的核心诱因。
2. **`packages/shared/src/agent/core/budgets.ts`、`packages/core/src/types/runs.ts`、`packages/server-core/src/runtime/run-service.ts`、`apps/web/src/client.ts`**：
   - 将基础默认限额提升至 `maxSteps: 32, maxToolCalls: 36, maxSameToolCalls: 12`。
   - 为 `RunStartInput.limits` 与 `RunService` 新增有界 `maxSteps` / `maxToolCalls` / `maxSameToolCalls` 校验，并按 Web 调研深度自动配套预算：快速 `24/28/12`、标准 `40/48/16`、深度 `80/96/30`；前端表单与「尝试重试」统一透传。
3. **`packages/core/src/types/domain.ts`、`packages/shared/src/agent/core/prompt-builder.ts`、`packages/server-core/src/runtime/task-runtime.ts`、`packages/server-core/src/runtime/working-state.ts`、`packages/shared/src/agent/backend/pi/tool-hooks.ts`、`packages/shared/src/agent/backend/pi/session.ts`**：
   - 在不变的 `stable` 系统提示尾部声明本次 `RUN BUDGETS`（保持 `prefixHash` 与跨轮 Prompt Cache 稳定）。
   - 在压缩后的 `WorkingStateTracker` 附件中保留当前 `budgets` 计数。
   - 在 Pi 会话中追踪实时工具剩余预算：临近或耗尽上限时仅在模型可见的 `toolResult.content` JSON 尾部附带 `_hostBudgetNotice`（既不被 `ToolResultGovernor` 的 `HEAD...TAIL` 裁掉，也不污染宿主 `state.observations`、`RetrievalSchema` 或 `Trace`）；当工具达到 `maxSameToolCalls` 后，在后续轮次将其从活跃工具列表中停用（保留回查与 `workflow__analyze/review/draft`），引导模型自然进入分析、审阅与草稿阶段。
   - 保留 `task-runtime.ts` 原有硬性 `budget_same_tool` 门禁：若提供方仍强行发出超额调用或超额批次，仍在副作用前立即阻断并记录 `budget_exceeded`。
4. **`packages/shared/src/sources/web-tools.ts` & `skills/competitor-investigation/SKILL.md`**：
   - 明确要求在预算内克制使用 `web_search`，并在多条不同 URL 连续 `web_fetch` 超时/不可用时记录系统性抓取缺口并推进 `workflow__analyze`，不要循环消耗搜索预算。

## 回归用例

- 独立 Badcase 验证与回归用例：[tests/badcase-budget-same-tool-web-search.test.ts](../../tests/badcase-budget-same-tool-web-search.test.ts)
- 回归入口：[scripts/eval.ts](../../scripts/eval.ts)
