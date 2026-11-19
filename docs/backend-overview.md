# 后端现状与职责

本文记录 2026-10-22 的后端核对结果。当前评测入口见 [Agent Benchmark](../evals/README.md)。

项目文件现按 apps/cli、packages/core、packages/shared、packages/server-core 分层，详见 [项目结构](project-structure.md)。

## 当前形态

这是可由 CLI 或本地 Web 工作台启动的 TypeScript Agent 后端。模型在独立 Agent 子进程中通过 Pi AgentSession 决策；主进程负责业务状态、权限、实际工具执行、预算、持久化及故障收尾。已增加仅绑定 127.0.0.1 的本地 HTTP/SSE 工作台；尚无公网服务、Electron 主进程或 Langfuse 集成。

默认入口现为通用 Agent + Skill，接受自然语言任务并使用已授权工具保存最终回答。原竞品调查仍可作为业务模板运行，继续要求实体、时间窗、证据整理和规则审查。没有多 Agent 编排；通用入口也不保证任意任务均能成功。共享循环与业务扩展的实现见 [通用 Agent](generic-agent.md)，下文调查阶段描述适用于原业务模板。

## 一次真实调查

~~~mermaid
sequenceDiagram
    participant CLI as CLI
    participant Host as 主进程 Runtime
    participant Worker as Agent 子进程 / Pi SDK
    participant Tool as 主进程工具 / MCP
    CLI->>Host: 任务、配置、来源、所选 Skill、预算
    Host->>Worker: 私有 IPC 初始化 / 可见工具
    Worker->>Worker: 请求模型，模型提出工具调用
    Worker->>Host: 决策与 pre_tool_use_request
    Host->>Host: 预算 / 绑定 / Schema / 范围 / 前置条件 / 审批
    Host-->>Worker: pre_tool_use_response
    Worker->>Host: allow 后 tool_execute_request
    Host->>Host: 核对同一次请求并复查
    Host->>Tool: 实际执行
    Tool-->>Host: 工具结果
    Host->>Host: 保存执行记录、快照、Trace
    Host-->>Worker: tool_execute_response
    Worker->>Worker: Pi 回填结果，继续请求模型
    Host-->>CLI: 最终状态、草稿路径、缺口
~~~

模型决定调用什么工具、参数是什么、什么时候请求结束。Pi SDK 管理对话历史、模型请求和工具调度。主进程允许、拒绝或终止调用，并决定业务是否满足完成条件。Pi 不是权限裁决者。

ReplayModel 使用固定决策脚本，不启动真实模型会话，用于演示与可重复回归；它与真实路径共享业务工具和门禁。

## 模块边界

| 模块 | 当前职责 | 主要源码 |
|---|---|---|
| CLI 入口 | 解析配置、准备来源、审批输入、取消和输出目录锁 | apps/cli/src/index.ts、apps/cli/src/commands/extensions.ts |
| 领域与上下文 | 任务/工具/结果契约，实体、时间窗、来源与 Skill 上下文 | packages/core/src/types/domain.ts、packages/shared/src/agent/core/prompt-builder.ts |
| 业务 Runtime | 计划→采集→分析→审查→草稿；预算与终态 | packages/server-core/src/runtime/investigation.ts、packages/shared/src/agent/core/budgets.ts |
| 模型适配 | Pi 会话、子进程生命周期、IPC 身份与代理工具 | packages/shared/src/agent/models.ts、packages/shared/src/agent/backend/pi/session.ts、packages/shared/src/agent/backend/pi/ |
| 工具执行 | 绑定、Schema、来源范围、三模式、一次性审批及阶段复查 | packages/shared/src/tools/registry.ts、packages/shared/src/tools/executor.ts、packages/shared/src/agent/core/permission-manager.ts、packages/shared/src/agent/core/pre-tool-use.ts、packages/shared/src/agent/pre-tool-use.ts |
| 来源与 MCP | 结构化官网/GitHub 来源、本地 Web API 工具、通用联网、远程/stdio MCP 和平台 REST→MCP | packages/shared/src/sources/server-builder.ts、packages/shared/src/sources/browser.ts、packages/shared/src/sources/api-tools.ts、packages/shared/src/mcp/client-pool.ts、packages/shared/src/sources/web.ts、packages/shared/src/sources/web-mcp.ts、packages/shared/src/sources/web-api.ts、packages/shared/src/mcp/source.ts |
| Skill | 本地/GitHub 安装、选择、正文注入、受控参考资源读取 | packages/shared/src/skills/storage.ts、packages/shared/src/workspaces/managed-workspace.ts |
| 证据与存储 | 事件/版本/证据/主张、规则 Reviewer、草稿、审计和中断处理 | packages/shared/src/intelligence/evidence.ts、packages/shared/src/sessions/storage.ts、packages/shared/src/sessions/trace.ts |
| 验证 | 契约、业务语义与真实协议集成的固定回归 | scripts/eval.ts、tests/*.test.ts、fixtures/ |

## 固定业务顺序与模型自主性的边界

模型需要先实际生成并调用 workflow__save_plan。主进程保存、读回校验并完成提交回调后，才允许采集。模型可以在预算内选择来源工具和参数，但不能绕过业务阶段。

workflow__analyze 整理结构化采集结果，保留归因、时间和来源缺口，生成事件版本与有证据的主张。任意 MCP 原始文本、搜索片段和抓取页面不因调用成功就自动升级为竞品事实；结构化信号仍需要相应适配与验证。

workflow__review 调用数据规则函数，检查主张/证据、实体、时间、版本和反向证据，并核对快照。它不是另一个 LLM Agent，也不是模型回答的全语义正确性评委。

模型再调用 workflow__draft，传入草稿说明与已有 claimIds。草稿保存成功后，才能结束；自由文本仍标为待人工核对。最终状态区分 complete、partial、failed、cancelled；complete 不等于来源全部真实或内容必然正确，fixture 身份必须另看数据来源。

## 扩展与权限

- 通用联网优先走已实现的受控内置适配器，再走配置的搜索 MCP；远程搜索 MCP 与 REST API 包装 MCP 是配置选项。原自建搜索/抓取保底已移除。
- 远程 MCP 优先 Streamable HTTP；auto 只在 404/405 时尝试旧版 SSE。也支持 stdio。MCP 统一协议不代表所有服务具有相同参数或业务语义。
- 来源与用户 MCP 使用每运行 McpConnectionPool；子进程仍只使用受控 Node IPC。只读浏览器走 builtin，GitHub 与平台 API 均包装为 MCP 并走 mcp，配置与边界见 source-adapters.md。
- 平台 API 采用 sources/<slug>/config.json + guide.md 和单个通用 API MCP 工具；先经受控工具读取指南，HTTP 请求按实际 method/path/params 推导权限，allow-all 也不能跳过指南和范围校验。
- 用户自定义 MCP 按任务显式选择；未知动作默认 modify。普通 REST API 搜索/抓取可以通过实际 MCP Server/Client 包装链路使用。
- 内置联网不因填写任意模型 API_KEY 就自动出现。当前受控 Anthropic 内置适配器没有真实凭据验收；StepFun 原生内置联网尚未接入。
- Skill 安装复制文件并保存来源与哈希，不自动执行脚本。正文仅注入显式选中的 Skill；参考资源通过 session__read_skill_resource 读取，不增加权限。
- explore 拒绝修改/发送/发布；ask 对这些动作逐次审批；allow-all 允许其通过模式检查。三种模式都检查绑定、Schema、来源、范围与业务条件。
- 工具门禁不是操作系统沙箱。用户配置的 MCP 服务程序本身具有宿主授予的系统权限，不能把 Agent 子进程隔离描述为任意本地程序的安全隔离。

## 状态、Trace 和预算

.cwatch/ 保存工作区 MCP 配置和安装的 Skill。任务输出目录保存 runs、states、executions、plans、facts、evidence、reviews、reports 和 traces；Pi 会话另存 sessions/<runId>.jsonl 完整脱敏转录。密钥从环境变量引用，.env 不进入 Git。

Trace v2 是主进程写入的有序审计事件，AgentEventSchema 在落盘前校验载荷；旧版格式仍可读取，context_prepared/model_usage 分别记录每轮上下文与模型用量。它用于身份/顺序校验和 replayState 状态重建。ExecutionRecord 保存单次工具的审批等待、执行与终态。recover 将中断未决状态标为 unknown，不恢复 Pi 内存对话，不自动再次执行工具。

FileStore 使用 JSON/JSONL 与单文件原子替换；CLI 对输出目录加单写者锁。目前不是跨文件事务数据库，也不承诺机器断电零丢失。

完整会话转录与活动上下文独立：主进程经 IPC 确认追加原生 Pi 消息、请求快照及 compaction 边界；模型续轮只使用初始任务、最新摘要、保留工具轮次与边界后消息。字符压力、模型窗口、缓存 usage 和输出预留共同决定压缩；摘要计入既有 Token/超时预算。Trace 和业务 observations 不随压缩删减。实现、SDK 实锚及恢复边界见 session-context.md。

上下文/响应字符、单次输出/累计 Token、同一工具/总次数、轮数、调查/模型/工具超时已经实现，详见 run-limits.md。累计 Token 是依据 usage 的请求间预算，不能当作硬计费上限。调查总超时从 Runtime 启动开始，来源发现有独立准备阶段超时。

## 验证到什么程度

最新门禁结果见 artifacts/eval/latest.json；新增 Web 浏览器验收见 artifacts/web-eval/latest.json，来源浏览器验收见 artifacts/browser-eval/latest.json。 结果见 artifacts/eval/latest.json 和 artifacts/browser-eval/latest.json。SDK/IPC/MCP 集成包含真实进程与本地协议服务，提供方决策与部分业务数据是固定 fixture。这个分母不是模型回答准确率。

已保留真实模型运行证据：包括带真实来源失败缺口的 partial 调查，以及真实模型调用自定义 MCP/Skill 完成的 fixture 调查。不能据此宣称纯真实来源完整验收已经完成。

目前还没有完整的真实模型 Golden Case 数据集、统一质量评分和模型版本对比实验。Langfuse 只是候选接入方案，尚未实现。

## 下一步后端优先事项

1. RunService 和本地 Web 已实现创建/查询/取消、事件订阅与回应审批；下一步可让 CLI 复用服务装配，并完善大结果治理。当前 CLI 仍直接调用同一 Runtime。
2. 明确任务与会话关系：当前每次运行创建独立 Pi 会话，完整转录已持久化并可离线重建压缩边界；若需要连续聊天或运行恢复，还需定义重新接入、宿主阶段重建及副作用处理契约。审计 replay 不能冒充恢复会话。
3. 建立真正的 Golden Cases：冻结来源快照，人工标注关键事实/证据和缺口，单独评测真实模型的任务完成与报告质量。
4. 增加可选观测导出：本地审计先落盘，脱敏后异步导出 Langfuse/OpenTelemetry；网络故障不影响执行，工程回归仍保留。
5. 按实际并发和恢复需求决定数据库演进，不先迁移文件存储或推翻已有门禁。

RunService 的实际接口和本地 Web 边界见 web-workbench.md；其余建议以实现证据为准。
