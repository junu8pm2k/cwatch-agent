# Langfuse 接入

在项目根目录 `.env` 填入同一个 Langfuse 项目的 API Keys（Project Settings → API Keys）：

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PROJECT_ID=           # 可选；填写后工作台直达链接跳转到 /project/<id>/traces/<traceId>
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_TIMEOUT_MS=5000
```

`LANGFUSE_BASE_URL` 填实例根地址，不加 `/api/public`：EU 为 `https://cloud.langfuse.com`，US 为 `https://us.cloud.langfuse.com`，自部署填自己的 HTTPS 地址，本机可以使用 `http://localhost:3000`。密钥与实例必须对应。环境名用小写字母、数字、`_` 或 `-`，最长 40 字符，不以 `langfuse` 开头。

两项密钥留空时关闭上报；只填一项会返回配置错误。可以设置 `LANGFUSE_ENABLED=false` 临时关闭，设为 `true` 则要求密钥齐全。CLI 和 Web 由宿主 Runtime 通过官方 Langfuse v4 OpenTelemetry SDK（`@langfuse/tracing`、`@langfuse/otel`、`@opentelemetry/sdk-trace-node`）在真实运行中实时批量发送并在终态 flush，正常完成、失败、取消都会收口；replay 模式默认不联网上报。修改 `.env` 后重启 Web 或重新运行 CLI。

## 观测树与统一埋点

全链路只维护一套 OTel/Langfuse 埋点（实现见 `packages/shared/src/sessions/langfuse-otel.ts`），以嵌套观测树呈现在 Langfuse Tree 视图中：

- `agent.run`（`agent`）：任务输入、最终输出、模式、权限、自动 Tags 与运行级 Scores。
  - `turn.<N>`（`chain`）：单个模型决策轮次。
    - `context.prepare`（`span`）：窗口 token 压力、snip/microcompact 统计。
      - `memory.update`（`span`）→ `memory.attempt.<k>`（`generation`）：会话记忆增量维护与重试/降级/熔断记录。
      - `compact.run`（`span`）→ `summary.attempt.<k>`（`generation`）：正式上下文压缩与续写摘要生成。
    - `model.turn`（`generation`）：主模型请求、完整脱敏输入/输出与决定类型（如记忆已降级则标 `WARNING` 并附 `memoryDegraded`）。
    - `guardrail.<tool>`（`guardrail`）：工具策略判定、人工审批等待时长与放行/阻断结果。
    - `<toolName>`（`retriever` 用于 `web_search`，其余为 `tool`）→ `backend.<stage>`（`span`）：工具与底层网络/MCP 阶段耗时。
- `intent.classify`（独立 `generation`）：Web 首页无工具任务意图路由调用。

### 统一 Generation 诊断字段

所有 `generation`（`turn` / `memory` / `summary` / `intent`）统一记录：

- `model`、`modelParameters`（计划 `maxTokens`、实际发包 `wireMaxTokens`、`reasoningEffort`、`responseFormat`、`cacheRetention`）与 `usageDetails`（`input`、`output`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`total`）。
- 诊断 metadata：`purpose`、`stopReason`、`thinkingChars`、`textChars`、`thinkingToTextRatio`、`wireMaxTokens`、`outputUtilization`、`validationErrors`、`outcome`（`succeeded`/`retried`/`degraded`/`blocked`/`failed`）。
- 内容捕获：默认在经过宿主 `Redactor` 与环境密钥脱敏后上报完整 prompt 与输出正文（包括记忆与摘要的 prompt/响应）。

### 自动 Tags 与运行级 Scores

- **自动 Tags**：`status:*`、`mode:*`、`model:*`、`err:memory_degraded`、`err:memory_circuit_open`、`err:compact_failed`、`err:output_truncated`、`err:schema_invalid`、`err:budget_exceeded`、`err:provider_rejected`、`used:compact`、`used:reactive_compact`、`used:rework`。
- **运行级 Scores**：`run_success`、`memory_first_try_rate`、`memory_degraded`、`compact_success_rate`、`truncation_count`、`aux_token_ratio`、`cache_read_share`、`tool_error_rate`、`evidence_gap_count`。

## 验证连接

```powershell
npm run probe:langfuse
```

该命令发送标记为 synthetic 的本地样例，包含根 Agent、模型轮次、工具及后端阶段，不调用真实模型或搜索服务；样例 token 用量也是合成值。输出 `langfuse.status: exported` 表示接口接收成功，并提供可在 Langfuse 中搜索的 `traceId` 与跳转链接。

## 工作台直达与失败处理

配置 Langfuse 后，Web 工作台顶栏与阶段详情区直接展示「Langfuse Trace」跳转链接（运行中显示「实时」，新标签页打开）；不再维护本地自研 Trace 抽屉。本地 `traces/<runId>.jsonl` 继续保留，供工作台实时执行轨迹、状态重放与安全审计校验使用。

密钥只在宿主用于鉴权，不传给 Pi 子进程或评测容器。上报最多等待 `LANGFUSE_TIMEOUT_MS`（默认 5 秒，最大 30 秒），失败不会阻断或改变主任务状态；结果中的 `langfuse` 字段记录 `disabled`/`exported`/`failed` 及 `traceUrl`，并落盘 `traces/<runId>.langfuse.json`。断网或进程崩溃后，仍可从本地完整有效日志手动补传：

```powershell
npm start -- trace --out artifacts/live-web --run <runId> --langfuse
```

## Agent Benchmark（无密钥 CI 同构导出）

DeepEval 自动化 CI 容器不注入任何 Langfuse 密钥：`evals/benchmark-agent.ts` 通过本地文件 Exporter 将同一套 OTel Span 与运行级 Scores 落盘为 `trace.otel.json`（同时继续保留 `trace.json` 供 `evals/metrics.py` 本地工具规则校验）。评测结束后，宿主机 `evals/benchmark-publish.ts` 补齐 `sessionId` 与 `benchmark` metadata，将 OTLP Spans 原样上传至 Langfuse 并挂载 `benchmark.*` 与运行级 Scores，使 CI 与线上 Trace 在 Langfuse 中保持 100% 同构。仅执行本地回归时可设置 `BENCHMARK_PUBLISH=0`。`npm run eval:publish -- <run-id>` 用于重试上传，本地审阅题加 `--review-tests`。 [Benchmark 操作指南](../evals/README.md)
