# GitHub 公共 API 限流 P1 修复验收：2026-10-24

结论：已区分 GitHub 主/次级限流与认证/权限失败，增加严格的 HTTP 额度与最早重试提示元数据。按实际公共额度串行复验三个原仓库，均 HTTP 200；没有配置或输出 GitHub 凭据，没有为了验证故意耗尽额度。限流分支经固定协议响应及此前真实 403 正文离线复核，不冒充本轮重新触发了线上限流。

## 分类与时间契约

旧 PlatformApiAdapter 将任何 403 归为 auth_failed。新分类规则仅在配置的 https://api.github.com REST origin 使用 GitHub 特有语义：

| 实际响应 | 分类 |
|---|---|
| HTTP 401，包括同时带有额度信息 | auth_failed，不能被限流信息覆盖 |
| GitHub 403/429 且 remaining=0 | rate_limited，主限流 |
| GitHub 403 带限流 message，或有效 Retry-After | rate_limited，次级/未细分限流 |
| 普通 403，无限流证据 | auth_failed，认证或权限失败 |
| 通用 429 | rate_limited |
| 503 等其他错误，即使附带剩余零 | unknown，不误判为认证或限流 |

http.rateLimit 只含 kind、limit、remaining、resetAt、retryAt、retryAfterSeconds 和 retrySource 等严格字段。数字要求非负安全整数，日期要求可表示的 UTC 时间；不保存任意头、Authorization、Cookie 或头原文。成功响应也记录实际额度；HTTP 响应 Trace、MCP Observation、快照与宿主返回字段贯通。域映射或上游 RetrievalResult 不能覆盖宿主实际 HTTP 元数据。

Retry-After 支持整秒及标准 HTTP-date；主限流的 x-ratelimit-reset 是 UTC epoch 秒。两个提示都有效时取更晚时间，标 combined。明确次级限流缺少有效未来提示时，标 secondary-minimum，建议至少等待一分钟，不冒充服务端 reset。缺失、非法、溢出或已过期的主限流 reset 不补造未来时间；历史响应缺少头信息时保持未知。

这些时间是最早再尝试提示，不保证届时有额度或成功。适配器不等待、不自动重试；普通调用继续受宿主调用次数、取消、权限及超时控制。依据为 [GitHub REST 官方限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

## 原来源实际额度复验

2026-10-24 13:53 UTC（北京时间 21:53），使用原 github_releases 来源、原仓库路径及 per_page=10，经指南门禁 → ToolExecutor → 进程内 API MCP → GitHub REST。GITHUB_TOKEN 未配置，因此使用当前出站公共额度；未改源范围、权限或路由。

| 仓库 | HTTP / 采集结果 | 结构化 release signals | 响应头 remaining | runId |
|---|---|---:|---:|---|
| zai-org/ZCode | 200 / success_with_data | 1 | 33 / 60 | cb958fee-a226-419a-8825-ab24386c4688 |
| MoonshotAI/kimi-code | 200 / success_with_data | 10 | 32 / 60 | 561c8f6e-c392-434e-b11b-7a46e2999d0b |
| MiniMax-AI/minimax-code | 200 / success_with_data | 10 | 31 / 60 | 1e806070-9a01-4b19-8a32-e9e2b81a1a2c |

这三份响应的 resetAt 均为 2026-10-24T14:00:44.000Z（北京时间 22:00:44）。该值是复验时响应头的历史观测，不是当前实时额度或未来可用性承诺。三份 Trace 均校验通过。这里是源连通性与映射复验，release 数量不代表窗口内事件数，也不是完整报告或质量评分。

探针 scripts/probe-competitor-github.ts 串行执行，每仓库最多一次 HTTP，最多三个；遇到 rate_limited、其他失败或已消耗至 remaining=0 即停止后续共享额度请求并记录未尝试，不自动等待/重试、不将跳过写成空结果。首次诊断额外取得一份 HTTP 200，但探针收尾事件字段冲突导致记录失败；该诊断目录 live 保留，不计入正式 final 三仓验收，修正后使用独立目录完成上述复验。

```powershell
node --use-env-proxy --experimental-transform-types scripts/probe-competitor-github.ts --out artifacts/competitor-live/20261024/p1-github/final
```

重复验证应改用新 --out 目录，并遵守实际响应中的等待信息。不会为了测试刻意消耗完配额。

## 历史失败与语义边界

此前 source-probes/{target}/results/3.json 的三份真实 HTTP 403 原始正文包含 API rate limit exceeded；原状态均 auth_failed。用新规则离线复核均为 rate_limited。旧记录没有持久化完整响应头，复核明确 inputHeadersAvailable=false，不补造 remaining、resetAt 或 retryAt；原证据没有覆盖。

限流结果保持失败采集、signals=[]，EvidenceStore 保留 rate_limited 来源缺口，不产生事实事件或声明；不是 success_empty，也不表示产品没有更新。四份 GitHub 来源指南补充了该语义与 retryAt 的边界。没有重跑完整模型调查，既有整项调查尚未通过的结论不变。

## 实现与证据

- packages/shared/src/sources/api-http.ts：纯分类与安全头字段解析。
- packages/shared/src/sources/api-tools.ts：实际 HTTP 元数据接入和 Trace，不增加自动重试。
- packages/core/src/types/domain.ts：严格 http 结果契约。
- tests/api-http.test.ts、tests/api-mcp.test.ts：主/次限流、真正认证失败、普通 403、其他域名、HTTP-date、组合/无效提示、无凭据泄漏及无虚假事实。
- artifacts/competitor-live/20261024/p1-github/final/：正式 summary.json、各仓结果、Trace 与原始快照。
- 同目录上一级 historical-reclassified.json：三份真实旧错误的离线重分类结果。
- artifacts/p1-github-targeted.log：专项 40/40；最终 npm run verify 457/457（contract 329、semantic 30、integration 98），结构与类型、git diff --check 及新产物凭据扫描通过。全量日志 artifacts/p1-github-verify.log。
