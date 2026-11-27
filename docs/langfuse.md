# Langfuse 接入

在项目根目录 `.env` 填入同一个 Langfuse 项目的 API Keys（Project Settings → API Keys）：

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_TIMEOUT_MS=5000
```

`LANGFUSE_BASE_URL` 填实例根地址，不加 `/api/public`：EU 为 `https://cloud.langfuse.com`，US 为 `https://us.cloud.langfuse.com`，自部署填自己的 HTTPS 地址，本机可以使用 `http://localhost:3000`。密钥与实例必须对应。环境名用小写字母、数字、`_` 或 `-`，最长 40 字符，不以 `langfuse` 开头。

两项密钥留空时关闭上报；只填一项会返回配置错误。可以设置 `LANGFUSE_ENABLED=false` 临时关闭，设为 `true` 则要求密钥齐全。CLI 和 Web 由宿主 Runtime 在真实任务结束时等待上报，正常完成、失败、取消都会尝试；replay 测试不自动上传。修改 `.env` 后重启 Web 或重新运行 CLI。

## 验证连接

```powershell
npm run probe:langfuse
```

该命令发送标记为 synthetic 的本地样例，包含根 Agent、两个模型轮次、工具及后端阶段，不调用真实模型或搜索服务；样例 token 用量也是合成值。输出 `langfuse.status: exported` 表示接口接收成功，并提供可在 Langfuse 中搜索的 `traceId`。在 Langfuse 里确认观察项、父子关系和用量展示后再运行真实任务。

## 数据与失败处理

沿用[结构化 Trace](structured-trace.md)作为公开追踪数据源，将 run → model → tool → backend/process 映射成 Langfuse Agent、Generation、Tool 和 Span。上报任务输入、最终输出、工具参数与结果、权限、错误、耗时、模型名及已知 token 用量。任务 ID 作为 session ID，runId 和 taskId 会传播到每个观察项的 metadata。历史维护调用只有用量、缺少起始时间时，导出零时长并保留 `timingAvailable: false`。未知 token 和实际费用保留为缺失。模型输入沿用现有审计数据（上下文大小及公开配置）。

会话记忆更新的每次尝试对应一个 `model.memory`。Input 记录尝试序号、请求输出上限和更新前的检查点版本。有实际发包上限时也记录 `wireMaxOutputTokens`。Output 记录模型停止原因、正文和推理字符数、重试/停止/降级决策（`retry`/`stop`/`degrade`）、待处理轮次、熔断状态（`circuitOpen`）或保存的版本。JSON 校验失败时会附带字段错误。用量面板显示模型上报的输入和输出 token。模型生成类维护失败耗尽重试后默认降级放行主任务，不写入业务 `gaps`：对应 `model.turn` 正常执行，level 标为 `WARNING`，metadata 中的 `memoryDegraded` 指向失败的记忆尝试与降级原因；预算/取消/持久化等硬错误导致未发送的 `model.turn` 仍标为阻塞，metadata 中的 `blockedByMemoryStep` 指向失败的尝试。记忆诊断只上报这些字段，完整 prompt、记忆 JSON 和推理原文留在本地会话归档。

密钥只在宿主用于鉴权，上报前再次执行环境密钥及现有 Redactor 脱敏。不读取 SDK 私有转录。配置启用后，脱敏后的任务与工具内容会发送到所配置的 Langfuse 实例。

采用官方支持的 [OTLP HTTP/JSON 接口与属性映射](https://langfuse.com/integrations/native/opentelemetry)，携带 `x-langfuse-ingestion-version: 4`；按[完整 Span 导出规则](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4)在任务终态一次性发送。运行中不会实时展示；本地 JSONL/JSON 继续保留，评测与状态重放保持原有读取方式。

上报最多等待 `LANGFUSE_TIMEOUT_MS`（默认 5 秒，最大 30 秒），独立于任务取消信号。失败不会改变任务状态，结果的 `langfuse` 字段记录 `disabled/exported/failed`，尝试上报后还会保存 `traces/<runId>.langfuse.json`。成功记录会跳过向同一实例、同一项目重复上传；没有后台自动重试。断网或进程崩溃后，可从本地完整有效日志手动补传：

```powershell
npm start -- trace --out artifacts/live-web --run <runId> --langfuse
```

未配置、非法/未完成日志、HTTP 错误或部分拒收时命令返回非零退出码。网络超时可能发生在服务器已经接收数据之后，手动重试前先在 Langfuse 搜索 traceId；v4 不保证重复 Span 去重。成功标记只针对当前本地目录，复制原日志时应同时保留 `.langfuse.json`。

## Agent Benchmark

v3 的正式题集在仓库维护。编辑后执行 `npm run eval:sync`，审核并提交快照。使用 `npm run eval:sync -- --dataset <name>` 可以显式导入符合 v3 格式的 Langfuse Dataset。

本机和容器评测完成后，由宿主机向已配置的 Langfuse 上传 Trace 和 `benchmark.*` 分数。Code Judge 保留 `0–1`，LLM Judge 保留 `0–3`，各分项元数据记录满分、阈值和判定依据，Trace 记录 Case 状态。仅执行本地回归时可设置 `BENCHMARK_PUBLISH=0`。`npm run eval:publish -- <run-id>` 用于重试上传，本地审阅题加 `--review-tests`。 [Benchmark 操作指南](../evals/README.md)
