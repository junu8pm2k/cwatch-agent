# Badcase 记录：多工具并行轮次触发 `session_memory_delta_too_large` 导致任务中止

- **Badcase ID**：`bad-session-memory-multicall-delta-too-large`
- **日期**：2026-11-21
- **来源运行**：`.runtime/web/72192b1b-4157-4cb3-b66c-84377ecaecb0`（Trace `5f21c7e6-dc8d-412b-865f-de92773dbe0a`，Web 真实联网调研模式，`modelTurns: 4`，`toolCalls: 9`，`totalTokens: 40190`）
- **错误现象**：`Error: Error: session_memory_delta_too_large: first complete round cannot fit maintenance input`

## 根因分析

1. **核心运行时缺陷（`PiSessionMemory`）**：
   - 主上下文 `ToolResultGovernor` 对单条工具结果的上限为 `16,000` 字符，而 `SessionMemoryPolicySchema` 默认 `maxInputChars` 为 `48,000` 字符。
   - 当模型在**单个 API 轮次**中并行发起 3–4 次 `web_search` / `web_fetch` / `read` 工具调用时（本错例第 2 轮并行 4 次 `web_search`，其中 3 条各达 16KB 截断上限），仅该单一轮次在 `JSON.stringify` 嵌套序列化后即可超过 `60,000` 字符（叠加 `assistant.thinking` 与 `toolResult.details` 更大）。
   - `PiSessionMemory.prepare()` 尝试推进该轮次时发现 `rounds[0]` 无法装入 `48,000` 字符维护输入，直接抛出致命异常 `session_memory_delta_too_large`，导致整个 Agent 运行失败退出。

2. **伴随 WebUI / RunService 可用性问题**：
   - 调查模板将 `允许域名` 折叠在 `实体标识与域名` 内，且修改 `竞品名称` 时未清理模板残留的 `aliases: ["Node"]` 与默认 `competitor.id: "nodejs"`；同时 `RunService` 启动 `web` 来源时仍固定使用 `examples/sources-web.json` 的 `allowedDomains: ["nodejs.org"]`。
   - 通用 Agent 模板未提供 `web`（联网搜索与读取）来源选项，导致自然语言联网检索无法直接启用。

## 修复方案

1. `packages/shared/src/agent/backend/pi/session-memory.ts`：
   - 维护输入投影剥离私有 `assistant.thinking` 块与冗余 `toolResult.details`（不修改真实转录与主上下文）。
   - 当首个完整 API 轮次仍超出维护输入预算且包含大型/多条 `toolResult` 时，仅针对本次记忆维护输入对 `toolResult` 文本做二分上限裁剪（保留首尾与原转录标记），保证完整 `toolCall / toolResult` 配对与 `<= maxInputChars`；若即使工具结果仅留占位仍装不下（例如超大 `assistant.text`），继续按契约抛出 `session_memory_delta_too_large`。
2. `packages/core/src/types/runs.ts`、`packages/server-core/src/runtime/run-service.ts`、`apps/web/`：
   - 调查表单将 `允许域名` 提到显性主字段，修改竞品名称时自动清理旧模板别名与默认标识，并标准化粘贴的 URL/域名。
   - `RunService` 真实模式将 `web` 来源的 `allowedDomains` 绑定到用户填写的公开 HTTPS 域名（经 `allowedUrl` 严格校验，继续拦截 GitHub / 本机 / IP / 非 HTTPS）。
   - 通用 Agent 模板开放可选的 `联网搜索与读取 (web)` 及对应的 `联网允许域名` 输入。

## 回归用例

- 独立 Badcase 验证与工程回归：[tests/badcase-session-memory-multicall.test.ts](../../tests/badcase-session-memory-multicall.test.ts)
- 回归入口：[scripts/eval.ts](../../scripts/eval.ts) 与 [tests/web-ui.test.ts](../../tests/web-ui.test.ts)
