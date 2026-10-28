# 实现缺口审计（2026-10-17）

真实任务：给定明确的竞品实体、产品、时间窗和允许来源，用户需要可复核的竞品变化草稿；Agent 的价值在于自主规划和选工具，保存事实证据，并明确冲突与采集缺口。

## 材料与决定

- 当前目录初始为空。独立工程现位于 `Cwatch-agent`，不修改 `竞品情报agent-resume` 或参考仓库。
- 主线采用 `resume-package/scenario-competitor-intel-2026-10-12/resume-draft.md`。已核对同目录 alignment-audit、scenario-design、agent-project-model、claim-ledger、evidence-navigation、source-verification，以及 resume-paste-ready、reviewed/resume-draft-reviewed、tool-unification-flow。旧绝对路径按真实材料根重新定位。
- 历史 `Implemented` 指底座或证据摘录，场景 Artifact 仍为设计；历史测试结果均不计入本次通过数。
- 参考仓库 `C:/Users/Swing/Desktop/craft-agents-oss-main`：package version 0.11.4，Bun workspace，Apache-2.0。完整源码可读，但不作为本工程已接入的运行时。只参考架构，业务源码独立编写；保留来源归属说明。原参考仓库不执行安装或修改。
- 参考版本 Pi 0.80.6 与本次技能基线 0.84.2 有差异。本工程单独锁定技能基线，已读技能 SDK 映射；实际安装后再核对声明。只支持经过实现和验证的后端。
- 2026-10-18：只读 browser_tool 与宿主 MCP 池保留；平台 API 现统一包装为真实进程内 MCP，CLI 采集和 api 执行通道已移除。通用 API 仍需明确参数配置和领域映射；多后端和外部 HTTP 池未实现。见 source-adapters.md、platform-api-mcp.md、resume-backend-alignment.md。

## 五条主线

| 简历原文 | 目标行为 | 当前源码证据（静态核对） | 初始缺口 | 实现位置 | 验收 |
|---|---|---|---|---|---|
| **竞品来源 MCP Hub** 设计由 SourceServerBuilder 装配 MCP 与 API 的来源契约，池内发现工具并按原名派发，来源 Adapter 映射为 CompetitorSignal；将协议适配与实体、证据、时间字段归一分层。 | 三类通道保持差异；唯一绑定、原名派发、可撤销来源；官网、公开 API、本地 MCP | Craft `packages/shared/src/sources/server-builder.ts:SourceServerBuilder`；`mcp/mcp-pool.ts`、`proxy-tool-name.ts` | 无独立来源 Adapter 和领域运行时 | `packages/shared/src/sources/server-builder.ts`, `packages/shared/src/tools/registry.ts`, `tests/fixtures/news-mcp-server.ts` | 路由、碰撞、更新、撤销、请求映射和协议集成 |
| **竞品采集 Tool Calling 门禁** 选择执行前裁决承载 ActionPolicy，分析 runPreToolUseChecks 的模式、来源与审批分支，按 pre_tool_use_response 控制调用；为采集、修改和外发定义参数规则及拒绝后无执行的验收。 | 所有执行共用宿主策略，审批与参数哈希绑定且仅用一次 | Craft `agent/core/pre-tool-use.ts:runPreToolUseChecks`；`pi-agent.ts` 中 pre_tool_use_response；Claude 路径也使用检查 | 无独立执行门禁或审批记录 | `packages/shared/src/agent/core/permission-manager.ts`, `packages/shared/src/tools/executor.ts` | 通过真实执行器计数验证拒绝/过期/取消/未激活/越界为零 |
| **竞品任务 Context Engineering** 设计 CompetitorTask 的实体、时间窗与来源范围，复用 BaseAgent.chat 的技能前置处理；以 buildStableContextParts 装配稳定块，buildVolatileContextParts 承载当轮任务和来源状态。 | 任务校验、实际加载 Skill、预算、验证计划落盘后回调 | Craft `agent/base-agent.ts:BaseAgent`；`agent/core/prompt-builder.ts` stable/volatile 两入口；`session-tools-core/src/handlers/submit-plan.ts` | 无调查 Skill、任务和计划存储 | `packages/core/src/types/domain.ts`, `packages/shared/src/agent/core/prompt-builder.ts`, `skills/competitor-investigation/SKILL.md`, `packages/server-core/src/runtime/investigation.ts` | 缺实体/时区、上下文溢出、文件/回调失败 |
| **竞品采集 Agent Runtime 取消** 针对取消调研时的挂起审批，分析 requestId 关联与 handleAbort 的 block 清理，设计 ExecutionRecord 区分权限等待、执行中和取消状态；采集缺口保留未知，避免误报成功或副作用已回滚。 | 模型/审批/工具取消、持久记录、重启未决 unknown、不重放副作用、证据版本 | Craft Pi requestId 与 abort 机制，非业务恢复能力 | 无独立执行账本和事实历史 | `packages/shared/src/sessions/storage.ts`, `packages/shared/src/tools/executor.ts`, `packages/server-core/src/runtime/investigation.ts`, `packages/shared/src/intelligence/evidence.ts` | 等待取消、迟到响应、重启未决、版本比较 |
| **竞品事实 Agent Eval** 以 CompetitorSignal 的官网与转载快照规划 EvalCase，按实体、事实数、证据和双时点设置断言；将归因、去重、时间窗评测与 routing.test.ts 的底座契约回归分开。 | 固定标签、真实路径断言、有序 Trace、只读 Reviewer 和非零 CI 门禁 | Craft routing、parity、pre-tool-use 测试仅证明底座契约 | 无业务样本/runner/本次报告 | `tests/`, `fixtures/`, `scripts/eval.ts`, `packages/shared/src/sessions/trace.ts` | 分别输出契约与语义通过分母；关键契约全部通过 |

状态约定：本表“静态核对”只说明参考源码存在；本工程“有源码”和“本次实测通过”由 `docs/acceptance-report.md` 及实际生成的测试报告分别记录，不能互相替代。

后续实际审计产物：`artifacts/audit/materials.json` 完整读取并记录 10 份核心材料的哈希/结构、56 份源码证据文件，历史清单的 25 个源码记录与当前参考仓库逐项哈希匹配（25/25）。该匹配证明文件对应关系，不是原底座测试已运行。本次新工程验证结果另列。
