# 真实竞品调查首轮验收：2026-10-24

2026-10-29 清理说明：内置 eval case、题单、材料及对应评测归档已删除。下文中的旧案例数量、路径与成绩仅描述历史；当前状态见 [评测状态](evaluation.md)。

后续进展：多调用 P0 已完成受控串行执行修复，ZCode/Kimi 已真实复跑越过该阻塞；后续仍因 Memory 截断失败。实现、测试与新 runId 见 [多调用修复验收](p0-multicall-acceptance-2026-10-24.md)。下文保留首轮结果。

Memory P0 后续进展：已实现并真实验证两次截断恢复、三个合法记忆检查点，维护未关闭；MiniMax 此次最终因总预算 91035/80000 停止，整项调查仍未通过、无报告。见 [Memory 修复验收](p0-memory-acceptance-2026-10-24.md)。

抓取 P1 后续进展：修复客户端 30 秒上限冲突与 page.markdown 嵌套正文解析，在原 MCP、原白名单与原 45 秒父工具上限下取得三站起始页正文，3/3 成功。整页完整性及全站覆盖未据此认定通过。见 [抓取修复验收](p1-fetch-acceptance-2026-10-24.md)。

GitHub P1 后续进展：已区分认证/权限与主/次限流，记录安全额度及最早重试提示；按实际公共额度串行复验三仓库均 HTTP 200，原三份真实 403 正文离线重分类为 rate_limited。没有强行耗尽额度或自动重试，限流时更新状态保持未知。见 [GitHub 修复验收](p1-github-acceptance-2026-10-24.md)。

官方来源发现 P1 后续进展：已直接向 Web 工具披露旧配置的起始 URL，补齐定向查询＋显式起点抓取策略并分别统计。实跑白名单内去重搜索候选 2/1/0、精确参考入口搜索命中 0/9；起始 URL 正文可用 9/9，但不是全站或整页完整覆盖。窗口内匹配的独立 GitHub signals 为 1/4/10，不与网页计数混合。上游搜索仍有缺口，见 [官方来源发现验收](p1-discovery-acceptance-2026-10-24.md)。

## 结论

当前模型与来源配置下，三个真实调查任务全部失败，没有生成可供业务评分的报告。不能据既有工程回归通过或功能目录完整，认定竞品调查已达到稳定交付。此次是三个任务的首轮探索性验收，不估算线上成功率或模型准确率。

没有改动 Agent 执行、权限或记忆逻辑来绕过本轮失败。已新增三个目标的任务配置、官方来源配置、对应 GitHub 使用指南，以及独立来源诊断。现有 Node.js 演示配置未替换。

## 范围和来源

用户指定目标为 Zcode、kimicode、minimaxcode，分别确认为以下产品入口与官方源码仓库：

| 目标 | 官方产品入口 | 官方仓库 | 归因边界 |
|---|---|---|---|
| ZCode | [ZCode 官网](https://zcode.z.ai/en) | [zai-org/ZCode](https://github.com/zai-org/ZCode) | 官网界面示例的相对时间不能视作产品发布日期 |
| Kimi Code | [Kimi Code 官网](https://www.kimi.com/code) | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | 旧 kimi-cli 的历史信息不得直接等同于当前产品；[旧项目迁移说明](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/guides/getting-started.md) |
| MiniMax Code | [MiniMax Code 官网](https://agent.minimax.cn/about) | [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) | 仓库发布与桌面应用发布需分别标识 |

窗口：`[2026-09-24T00:00:00+08:00, 2026-10-25T00:00:00+08:00)`，按发布时间判断。执行时点之后的事件不得纳入。官方入口的外部预查仅确定身份与来源，不计入 Cwatch 自行采集成功。

运行使用项目现有 `.env` 模型和搜索 MCP 配置、真实 Pi SDK、独立 Worker、宿主权限与工具执行器。权限为 explore；每目标独立目录，超时 240 秒、模型超时 60 秒、工具超时 45 秒、单次输出上限 2048、累计 Token 门禁 80000。累计门禁不是硬计费额度。

## 三次实际运行

| 目标 | runId | Runtime 结果 | 已完成工具调用 | 提供方记录 Token | 用时 | 直接原因 |
|---|---|---|---:|---:|---:|---|
| ZCode | `2e88d6ac-8e33-4756-bb98-b2455cbadd21` | failed | 0 | 4507 | 7.1 秒 | 首轮返回多个工具调用，被单调用契约拒绝 |
| Kimi Code | `e2f0e95e-a216-463b-985c-b4f3827e6bb9` | failed | 1 | 9563 | 10.8 秒 | 读取指南后的下一轮返回多个工具调用，被拒绝 |
| MiniMax Code | `b679b573-d2b5-46d4-9358-bc455510d431` | failed | 3 | 27556 | 38.9 秒 | Session Memory 辅助响应耗尽输出预算，工作记忆更新失败 |

合计记录 41626 Token，包含模型决策与记忆维护用量。当前自定义接口价格未独立核验，不换算货币费用。三次完整 Trace 校验结果均为空问题列表；这证明记录与状态契约成立，不证明任务成功。

- ZCode 首轮请求同时调用 `session__read_session_memory` 和 `session__read_source_guide`。
- Kimi Code 首轮成功读取指南；下一轮同时请求 `session__read_session_memory` 和 `workflow__read_plan`。
- MiniMax Code 依次读取指南、保存调查计划、获取 10 条官方 GitHub release signals。随后记忆辅助请求以 1024 Token 上限结束，`stopReason=length`，响应内容只有 thinking，没有可解析的工作记忆正文。当前实现按契约停止，尚未进入 analyze、review、draft。

已有 system prompt 明确要求每轮一个工具调用；仅有文字要求仍未保证当前提供方遵守。SDK 工具顺序执行设置也没有阻止模型返回多调用。没有丢弃后续调用、绕过授权或把失败改写为成功。

## 独立来源诊断

来源探测不使用模型决策，经过现有 ToolExecutor。它与三次任务执行分开保存和计量，不计入报告完成数。

| 检查 | ZCode | Kimi Code | MiniMax Code |
|---|---|---|---|
| 宽泛搜索后许可域名内结果 | 0 | 0 | 0 |
| 限定官网 `site:` 搜索后结果 | 1 | 1 | 0 |
| 官方页面抓取 | MCP 请求约 30 秒超时 | MCP 请求约 30 秒超时 | MCP 请求约 30 秒超时 |
| 独立 GitHub releases 探测 | HTTP 403 | HTTP 403 | HTTP 403 |
| 来源 Trace 校验 | 无问题 | 无问题 | 无问题 |

宽泛查询实际返回每目标 5 条候选，均不在该目标的许可域名内，因而被过滤；不是上游没有任何搜索结果。限定官网后仅 ZCode 和 Kimi Code 召回可用链接。不能将过滤后的空列表推断成产品没有动态。

GitHub 403 的原文明确为公共 API rate limit exceeded，诊断头 `x-ratelimit-remaining=0`，本机没有配置 GITHUB_TOKEN。该问题发生在 MiniMax 主任务已成功获取 releases 之后。当前 API 适配器将所有 403 归为 auth_failed，因此本轮同时暴露错误分类不准确；不能据此认定官方仓库拒绝访问或凭据失效。

## 修复优先级与复验条件

| 优先级 | 问题 | 修复目标 | 必须保留的边界 |
|---|---|---|---|
| P0 | 提供方多调用与单调用 Runtime 契约不一致 | 核对实际请求和供应商支持，明确请求级限制或设计受控处理协议，再复跑 ZCode/Kimi | 每个工具独立校验、审批、执行身份；不得只执行第一个却伪造其余结果 |
| P0 | Memory 辅助响应输出预算被 thinking 耗尽 | 核对辅助请求的推理、正文和预算契约，设计有界恢复及明确的停止策略，再复跑 MiniMax | 维护请求仍计量、可取消；非法记忆不得提交；不能静默关掉记忆后称原功能通过 |
| P1 | 抓取服务连续超时 | 单独修复或配置可用抓取来源，再验证三站正文 | 不偷偷绕过已配置路由或放宽来源范围 |
| P1 | GitHub 公共 API 限流被记为认证失败 | 区分认证失败与 rate limit，记录可安全披露的重试时间；再按实际额度复验 | 不输出凭据，不无界重试，不承诺限流时没有更新 |
| P1 | 官方来源召回不足 | 使用官方站点定向查询及已确认起始 URL，评估来源覆盖与候选数量 | 不放宽白名单来凑结果；明确搜索、抓取和结构化信号的区别 |

三次失败样本应保留，修复后使用独立输出目录重复执行。当前没有报告，因此覆盖率、引用准确性、去重质量和报告可用性均未评分，没有真实质量通过结论。下一轮需先解决 P0，再验证至少一份完整可核对报告，之后才扩充黄金事件清单和重复运行样本。

## 本地证据位置

- 机器汇总：`artifacts/competitor-live/20261024/summary.json`。
- 完整任务证据：同目录下 `zcode/`、`kimi-code/`、`minimax-code/` 的 `traces/`、`sessions/`、`executions/`，MiniMax 另含已提交 `plans/`。
- 来源诊断：`source-probes.json` 与 `source-probes/<target>/latest.json`；完整响应按快照路径保存在各目录 `retrievals/`。
- 定向搜索：`focused-source-probes.json` 与 `focused-source-probes/<target>/latest.json`。
- 任务和来源配置：`examples/competitor-acceptance/`；新增官方 API 指南在 `sources/zcode_github/`、`sources/kimi_code_github/`、`sources/minimax_code_github/`。
- 评分约定与命令：[验收方案](competitor-live-acceptance.md)。
