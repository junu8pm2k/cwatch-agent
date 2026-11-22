# Badcase 记录：Web 联网调研反复在采集阶段触发 `Error: budget_same_tool: 9/8 tool=web_search` 中止

现行额度和超限行为见[运行限制](../run-limits.md)。下文保留故障现场及当时的修复方案。

- **Badcase ID**：`bad-budget-same-tool-web-search`
- **日期**：2026-11-22
- **来源运行**：
  1. `.runtime/web/dce87021-ea0c-4150-b4b6-7b58b1dbe15f`（Trace `259b9772-a73f-48eb-ae11-4e722b4f772e`，智谱 GLM 18 个月发布调研，`callsByTool: { workflow__save_plan: 1, web_search: 9, web_fetch: 5 }`，`totalTokens: 226107`，耗时 `275.9s`，停留在阶段 1 采集）
  2. `.runtime/web/baba6bd8-f8f9-4d8c-a288-be4387eb4a5b`（Trace `ea1d4a6b-6a41-4531-9ff8-f49b5a45dc6b`，同任务重试，`callsByTool: { workflow__save_plan: 1, web_search: 9, web_fetch: 4 }`，`totalTokens: 185228`，停留在阶段 1 采集）
  3. `.runtime/web/f92c12f1-b3cd-475a-a08d-a6ca3f9c877b`（Trace `1cfcec82-c0a2-4690-bb74-aa6dcc204df4`，未重启旧 `npm run web` 父进程下的重试，`web_fetch` 已成功，但触发 `Error: Path not found: ...\retrievals\0e2caa7352a1c11bb954328445a615828fc5aac127ee56c0d8143cb3dd5409b0.txt` 并继续逐条补搜触发 `9/8`）
  4. `.runtime/web/d3bb9ab2-b7a6-4644-8298-494896777b39`（Trace `6a7c4218-aa2e-418c-a7cd-ee3ab86a78f4`，未重启旧 `npm run web` 父进程下的重试，子进程已生效剔除冗余 `raw`，但因产品调查默认暴露了本地工作区 `ls/find/read` 工具，模型在保存计划前后空转调用了 13 次 `ls/find/read` 浏览本地仓库，撞上旧父进程 `Error: budget_tools: 21/20`）
  5. `.runtime/web/69314c13-4847-4226-a0ed-c2c2e3c08095`（Trace `7eda4fcf-61cc-4f39-a451-d552ae195f56`，`ToolResultGovernor.capResults()` 因把 21KB `entry.message.details` 计入尺寸，将仅 `7565` 字符的 `web_fetch` 误包装为 `Archived tool result (snip)... [...snipped...]`，迫使模型连续调用 `session__read_tool_result` 翻页并在第 4 次 Session Memory 增量更新时耗尽 `4096` 输出 Token）
- **致命错误现象**：
  - `Error: budget_same_tool: 9/8 tool=web_search`（从未进入 `workflow__analyze` / `workflow__review` / `workflow__draft`）
  - `Error: Path not found: C:\Users\Swing\Desktop\Cwatch-agent\retrievals\0e2caa7352a1c11bb954328445a615828fc5aac127ee56c0d8143cb3dd5409b0.txt`
  - `Error: budget_tools: 21/20`（13/21 次工具调用消耗在本地工作区 `ls / find / read`）
  - `Error: Error: session_memory_update_failed: output limit exhausted after 2 attempts; memory checkpoint unchanged`

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
   - 在 `RunService` 启动竞品/产品调查（`isInvestigationTask(task)`）时显式设置 `builtinTools: false`（仅通用 Agent 保留 `read/ls/find/grep/write/edit/bash`），杜绝模型在产品联网调研中空转调用 10+ 次 `ls/find/read` 浏览本地代码仓库并耗尽总工具预算。
3. **`packages/core/src/types/domain.ts`、`packages/shared/src/agent/core/prompt-builder.ts`、`packages/server-core/src/runtime/task-runtime.ts`、`packages/server-core/src/runtime/working-state.ts`、`packages/shared/src/agent/backend/pi/tool-hooks.ts`、`packages/shared/src/agent/backend/pi/session.ts`**：
   - 在不变的 `stable` 系统提示尾部声明本次 `RUN BUDGETS`（保持 `prefixHash` 与跨轮 Prompt Cache 稳定）。
   - 在压缩后的 `WorkingStateTracker` 附件中保留当前 `budgets` 计数。
   - 在 Pi 会话中追踪实时工具剩余预算：临近或耗尽上限时仅在模型可见的 `toolResult.content` JSON 尾部附带 `_hostBudgetNotice`（既不被 `ToolResultGovernor` 的 `HEAD...TAIL` 裁掉，也不污染宿主 `state.observations`、`RetrievalSchema` 或 `Trace`）；当工具达到 `maxSameToolCalls` 后，在后续轮次将其从活跃工具列表中停用（保留回查与 `workflow__analyze/review/draft`），引导模型自然进入分析、审阅与草稿阶段。
   - 保留 `task-runtime.ts` 原有硬性 `budget_same_tool` 门禁：若提供方仍强行发出超额调用或超额批次，仍在副作用前立即阻断并记录 `budget_exceeded`。
4. **`packages/shared/src/tools/pi-builtins.ts`、`packages/shared/src/agent/backend/pi/tool-hooks.ts`、`packages/server-core/src/runtime/investigation-workflow.ts`**：
   - `BuiltinFileScope.path()` 支持只读工具（`read / grep / find / ls`）在工作区不存在同名路径时，安全解析 `store.root`（`protectedRoots`）下的 `retrievals/ | plans/ | reports/ | claims/ | reviews/ | comparisons/` 快照文件，同时继续严格拦截对该目录的 `write / edit`（`builtin_protected_path`），彻底消除 `Error: Path not found: ...\retrievals\0e2caa...txt`。
   - `buildProxyTools()` 在向模型返回已归一化出 `pages` 或 `searchResults` 的 `RetrievalResult` 时，从模型可见 `toolResult.content` 中剔除重复的 16KB 原始转义 `"raw"` 包裹（`details` / `state.observations` 仍完整保留 `raw`），避免 `web_fetch` 的 `pages[0].text` 因整包超过 16KB 被 `ToolResultGovernor` 攔腰截断而引发多轮无效翻页与本地检索。
   - `workflow__extract_signal` 在校验已抓取页面原文之外，支持当 `web_fetch` Markdown 转换丢失日期标题（如 `2026-08-26 GLM-5.3-Flash 原生多模态模型上线`）时，联合同一 `url` 已落盘校验的 `web_search` 快照与已抓取正文做交叉核验。
5. **`packages/shared/src/agent/backend/pi/tool-result-context.ts` & `packages/shared/src/agent/backend/pi/session-memory.ts`**：
   - `projectSessionEntries()` 在构建活跃上下文消息时剥离不发给模型的 `entry.message.details`；`ToolResultGovernor.capResults()` 在剥离 `details` 后若 `text` 本身已 `<= maxResultChars`（如 `5.3KB` 的 `web_search` 与 `7.5KB` 的 `web_fetch`），直接保留完整 `text` 而不插入伪造的 `Archived tool result (snip)... [...snipped...]`，消除因假截断引发的 `session__read_tool_result` 连环翻页与 `windowTokens` 虚高。
   - `PiSessionMemory` 对 `session__read_tool_result` 等分页回查结果同样提取紧凑 `memoryDigest`，在请求前由代码预裁剪 `currentMemory` 各数组长度并移除冲突的思考计数约束，同时将 `step-5-preview` 增量更新（`loaded !== null`）的首轮输出预算从 `2048` 提升至 `3072`，避免首轮触顶退回单轮提交造成 `pendingMessages: true` 死循环。
6. **`packages/shared/src/sources/web-tools.ts` & `skills/competitor-investigation/SKILL.md`**：
   - 明确要求抓取到发布记录页后立即批量调用 `workflow__extract_signal` 并推进 `workflow__analyze`，不要按每个条目循环追加 `web_search`。

## 回归用例

- 独立 Badcase 验证与回归用例：[tests/badcase-budget-same-tool-web-search.test.ts](../../tests/badcase-budget-same-tool-web-search.test.ts)
- 回归入口：[scripts/eval.ts](../../scripts/eval.ts)
