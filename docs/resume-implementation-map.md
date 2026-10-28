# 五条主线与本次实现

原文来自 2026-10-12 场景简历，原材料不修改。本次代码只支持本次实际完成的能力，不证明历史所有权、上线或生产收益。

## A 来源 MCP Hub

> **竞品来源 MCP Hub** 设计由 SourceServerBuilder 装配 MCP 与 API 的来源契约，池内发现工具并按原名派发，来源 Adapter 映射为 CompetitorSignal；将协议适配与实体、证据、时间字段归一分层。

实现：`packages/shared/src/sources/server-builder.ts:SourceServerBuilder/GithubSource/McpSource`、`packages/shared/src/tools/registry.ts:ToolRegistry`、`packages/core/src/types/domain.ts:ToolBinding/SignalSchema/RetrievalSchema`。演示 `npm run demo`、`npm run probe:sources`。证据 `artifacts/source-probe/latest.json` 与 demo traces。测试 contracts 的跨来源、净化碰撞、配置更新、撤销、GitHub 请求映射；integration 的真实 stdio MCP。状态：离线与真实公开来源已验证；MCP 真实协议、样例数据为 fixture。新增用户级 mcp add/list/test/enable/disable/remove，stdio、Streamable HTTP/旧版 SSE、任意工具按原名派发，逐工具语义/结果格式和任务选择；Skill 支持本地/GitHub 安装、显式注入与受控资源读取。通用远程搜索 MCP 已实现 Streamable HTTP/旧版 SSE、独立 URL/token、工具发现与结果适配；REST search/fetch 现通过本地 WebApiAdapter 直接调用，不再包装 MCP。公开 API 包装链路实测成功 3 条结果；远程 MCP 搜索实测成功，最近一次 fetch 探测超时。本轮新增只读浏览器、平台 API MCP 和宿主 MCP 连接池，实际浏览器/Pi/API MCP 联合验收使用显式 fixture；详见 docs/source-adapters.md。任意视觉交互、Craft 其他后端和外部池 HTTP 未实现。

## B Tool Calling 门禁

> **竞品采集 Tool Calling 门禁** 选择执行前裁决承载 ActionPolicy，分析 runPreToolUseChecks 的模式、来源与审批分支，按 pre_tool_use_response 控制调用；为采集、修改和外发定义参数规则及拒绝后无执行的验收。

实现：`packages/shared/src/agent/backend/pi/tool-hooks.ts:buildProxyTools/wrapToolsWithHooks/wrapSingleTool`、`packages/shared/src/agent/core/pre-tool-use.ts:runPreToolUseChecks`、`packages/shared/src/agent/pre-tool-use.ts:requestPreToolUseApproval/PreToolUseResponse`、`packages/shared/src/agent/core/permission-manager.ts:ActionPolicy/ApprovalManager` 和 `packages/shared/src/tools/executor.ts:ToolExecutor.execute`。主子进程 IPC 的 pre_tool_use_request/response 与 tool_execute_request/response 关联任务、SDK toolCallId、绑定、参数哈希与执行记录；explore/ask/allow-all 在执行前与每阶段复查，业务前置条件也统一检查。参考的是 Craft 结构和命名，代码为本项目独立实现。演示 `npm run eval`，查看权限/审批用例和独立 executions。拒绝、未批准、超时、参数改变、未激活和越界经执行计数验证为零；生效模式在批准后重查。状态：当前产品入口已验证；无旁路 HTTP 端点。不能由这些结果声称 Craft 全后端或操作系统沙箱安全。

## C Context Engineering

> **竞品任务 Context Engineering** 设计 CompetitorTask 的实体、时间窗与来源范围，复用 BaseAgent.chat 的技能前置处理；以 buildStableContextParts 装配稳定块，buildVolatileContextParts 承载当轮任务和来源状态。

实现：`packages/shared/src/agent/core/prompt-builder.ts:ContextPipeline/prepareTurn/loadInvestigationSkill/buildStableContextParts/buildVolatileContextParts/assembleContext`、`skills/competitor-investigation/SKILL.md`、`packages/server-core/src/runtime/investigation.ts:Workflow.callTool(save_plan)`。演示 demo 中 plans、plan-submissions.jsonl，测试缺实体、时区、上下文超限和文件/回调失败。状态：独立实现对应入口已验证；每轮模式分支、来源状态、工具面和实际 SDK system prompt 刷新已有回归，context_prepared 保存哈希与绑定列表。未宣称继承 BaseAgent、缓存收益或完整工作流引擎。

## D Runtime 取消

> **竞品采集 Agent Runtime 取消** 针对取消调研时的挂起审批，分析 requestId 关联与 handleAbort 的 block 清理，设计 ExecutionRecord 区分权限等待、执行中和取消状态；采集缺口保留未知，避免误报成功或副作用已回滚。

实现：`packages/shared/src/agent/backend/pi/subprocess.ts:runPiSubprocess` 启动独立 Agent 子进程，`packages/shared/src/agent/backend/pi/session.ts:runPiSession` 使用 Pi AgentSession 驱动真实模型循环，`packages/shared/src/agent/backend/pi/tool-hooks.ts` 包装工具并透传取消；`packages/shared/src/tools/executor.ts`、`packages/shared/src/agent/core/permission-manager.ts`、`packages/shared/src/sessions/storage.ts:FileStore.recover`、`packages/server-core/src/runtime/investigation.ts:runInvestigation/replayState`；领域历史在 `packages/shared/src/intelligence/evidence.ts:EvidenceStore`。演示 inspect/replay/recover，评测中审批取消、重复/迟到批准、不合作工具取消、超时、重启未决、版本追加。状态：真实子进程崩溃、断线、挂起、审批清理、写操作 unknown、主进程继续新会话、文件账本和状态重建已实测；未实现自动继续模型会话、跨文件事务或副作用回滚。

## E Agent Eval

> **竞品事实 Agent Eval** 以 CompetitorSignal 的官网与转载快照规划 EvalCase，按实体、事实数、证据和双时点设置断言；将归因、去重、时间窗评测与 routing.test.ts 的底座契约回归分开。

实现：`scripts/eval.ts`、`tests/contracts.test.ts`、`tests/semantics.test.ts`、`tests/pi-protocol.test.ts`、`tests/config.test.ts`、`fixtures/labels.json`、`packages/shared/src/agent/events.ts:AgentEventSchema`、`packages/shared/src/sessions/trace.ts:TraceSchema/validateTrace`、`packages/shared/src/intelligence/evidence.ts:reviewClaims`。演示 `npm run verify`，产物 `artifacts/eval/latest.json/latest.md`。contract/semantic/integration 分组，逐例分母与错误原因，任一失败非零；CI 配置已写但远端未运行。当前回归 284/284（contract 201、semantic 30、integration 53），另有真实浏览器门禁 6/6；覆盖三模式、共享 PreToolUse、包装器、真实 IPC、崩溃/断线/挂起、审批清理、迟到结果和真实 SDK 子进程退出后主进程继续运行。新增运行预算覆盖上下文/响应长度、单次/累计 Token、同一工具次数和调查/模型/工具超时，主进程门禁与 Trace 证据见 docs/run-limits.md。真实 Pi AgentSession 通过本地 HTTP/SSE 跑完整循环，与 ReplayModel 决策一致，7 次工具调用的 SDK ID 与请求/响应均对应。此前真实 stepfun/step-5-preview 模型通过独立 Agent 子进程完成 8 轮并生成 partial 草稿（artifacts/subprocess-live/latest.json）：官网时间缺失、GitHub HTTP 403、新闻为明确标记 fixture，Trace 校验通过。用户扩展组合另已通过真实模型完成 11 轮、10 次工具调用的 fixture 调查，含实际 Skill 资源读取，证明见 artifacts/extensions-demo/latest.json；纯真实来源完整调查、生成质量和 5–10 个真实模型黄金运行仍待验证，不能把固定回归通过率包装为通用准确率。
