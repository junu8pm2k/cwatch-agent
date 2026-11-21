# Badcase 记录：Session Memory 冗余载荷触发推理输出耗尽（`output limit exhausted after 2 attempts`）与竞品官方域名 `site:` 查询误拦截

- **Badcase ID**：`bad-session-memory-output-limit-and-site-scope`
- **日期**：2026-11-21
- **来源运行**：`.runtime/web/c5f82be8-80d5-437d-abac-96c4d8204a65`（Trace `dcdb7c23-9b71-4977-9f7f-111ffe551778`，Web 真实竞品调查模式，`智谱 / GLM`，`domains: ["bigmodel.cn"]`，模型 `stepfun/step-5-preview`，`modelTurns: 6`，`toolCalls: 8`，`totalTokens: 92780`）
- **致命错误现象**：`Error: Error: session_memory_update_failed: output limit exhausted after 2 attempts; memory checkpoint unchanged`
- **伴随误拦截现象**：查询 `site:bigmodel.cn 更新日志 changelog` 触发 `Error: policy_block: web_query_outside_entity_scope`

## 根因分析

### 1. 主致命缺陷：`PiSessionMemory` 将冗余原始检索串灌入推理模型，且输出耗尽重试未压缩输入
- 在 Revision 1（`workflow__save_plan` 轮次）中，记忆维护输入仅 `3,955` 字符（`1,063` tokens），`step-5-preview` 第 1 次尝试即在 `959` 输出 token 内（`2,168` thinking 字符 + `1,421` JSON 字符）正常完成 `stop`。
- 进入第 2 轮（并行 5 次 `web_search`，其中 4 条成功返回约 `22KB` 原始 `RetrievalResult` JSON，经 `ToolResultGovernor` 截断为 `~8.4KB` 的 `HEAD` 片段，内容几乎全是三重转义的重复 `"raw"` 字段），`PiSessionMemory.prepare()` 实际发给模型的记忆维护请求高达 **`47,995` 字符（`19,103` input tokens）**。
- **第 1 次尝试（`maxTokens: 1024`）**：`step-5-preview` 逐条分析这 `48KB` 搜索片段，耗尽全部 `1,024` output tokens 于 `<thinking>`（`thinkingChars: 3337`, `textChars: 0`），返回 `stopReason: 'length'`。
- **第 2 次重试（`maxTokens: 4096`）**：`session-memory.ts` 仅做 `rounds.slice(0, 1)`，而单轮并行工具本身就占满预算，导致第 2 次请求输入仍为 **`47,998` 字符（`19,053` input tokens）** 丝毫未缩减；模型再次把全部 `4,096` output tokens 耗尽在 `<thinking>`（`thinkingChars: 13853`, `textChars: 0`），最终抛出 `session_memory_update_failed: output limit exhausted after 2 attempts` 并直接中止整次运行（浪费近 3 分钟与 92k tokens）。

### 2. 伴随范围校验缺陷：`PreferredWebSource.validateScope` 未计入竞品配置域名
- 竞品任务配置为 `name: "智谱"`、`product: "GLM"`、`domains: ["bigmodel.cn"]`。
- 模型发出高度合规的官方域查询 `site:bigmodel.cn 更新日志 changelog`，但 `web.ts` 第 84 行仅检查 `[competitor.name, product, ...aliases]`，未检查配置的具体 `competitor.domains`，导致合法的官方站内搜索被 `web_query_outside_entity_scope` 误拦截。

### 3. 伴随外部环境观测（非致命，保持原安全契约）
- 远端搜索 MCP 的 `web_fetch` 在抓取 3 个 `docs.bigmodel.cn` 页面时均在 30s 超时（`McpError -32001`），按安全契约返回 `unavailable:search_mcp_request_timeout` 且不做本地静默 HTTP 回退；该超时本身不会导致任务失败（应作为信息缺口记入草稿），真正导致任务崩溃的是随后触发的 `session_memory_update_failed`。

## 修复方案

1. `packages/shared/src/agent/backend/pi/session-memory.ts`：
   - **结构化检索结果紧凑投影（Attempt 1 即生效）**：在构建隔离记忆维护输入时（不修改原始转录，且不反膨胀已被 microcompact 缩小的 stub），对 `RetrievalResult` 形状的 `toolResult` 提取紧凑摘要（保留 `status`、`backend`、`error`、`snapshot.path`、`signalsCount`、以及精简后的 `searchResults` 标题/URL/时间与 `pages` 预览，剔除冗余的 `"raw"` 转义原文），将典型 5 路并行搜索轮次从 `~48KB` 压缩至 `~4KB` 级别。
   - **输出耗尽重试强制收敛输入（Attempt 2 Recovery）**：当 Attempt 1 因 `stopReason === 'length'` 触发重试时，除了保持单轮边界 `rounds.slice(0, 1)` 外，额外将恢复输入预算收敛到 `min(maxInputBudget, 12_000)` 并将单条 `toolResult` 裁剪至紧凑上限（`<= 480` 字符），同时在系统提示词明确禁止逐条展开原始搜索片段，确保推理模型迅速输出合规 JSON 工作态。
2. `packages/shared/src/sources/web.ts`：
   - `PreferredWebSource.validateScope()` 对竞品调查的 `web_search` 查询同时按域名边界匹配具体配置的 `task.competitor.domains`（排除通配符 `'*'`），放行 `site:bigmodel.cn ...` 与 `site:docs.bigmodel.cn ...`，同时严格拦截仿冒域名（如 `site:evilbigmodel.cn`）与无关公司查询。

## 回归用例

- 独立 Badcase 验证与回归用例：[tests/badcase-session-memory-output-limit.test.ts](../../tests/badcase-session-memory-output-limit.test.ts)
- 回归入口：[scripts/eval.ts](../../scripts/eval.ts)
