# 工具调用结构与 Craft 对照

工具代理与统一执行链参考 Craft，名称按本项目的实际类型区分：`web_search`、`workflow__save_plan`、`session__read_tool_result`；只有真正经过 MCP 的工具使用 `mcp__`，例如 `mcp__github__api_github`。名称生成、内存映射、SDK 代理及迁移说明见 [tool-registration.md](tool-registration.md)。

Pi SDK 的 read、write、edit、bash、grep、find、ls 也默认显式注册，使用原名并经同一宿主 IPC / PreToolUse / ToolExecutor 调用真实 SDK 实现。权限和文件边界见 [pi-builtins.md](pi-builtins.md)。

本项目借鉴 Craft 的 Agent 子进程、工具代理、共享 PreToolUse 检查和宿主裁决结构。参考仓库仅用于阅读；其 SDK 为 0.80.6，本项目仍锁定 0.84.2，按实际安装接口独立实现。CLI 不引入 Electron 或常驻 WebSocket Server。

## 实际进程边界

主进程运行 CLI / Runtime，持有任务、业务状态、权限模式、ApprovalManager、ToolRegistry、来源客户端、实际工具、文件存储和 Trace。Agent 子进程运行 Pi AgentSession、模型请求、连续对话历史和代理工具。

~~~mermaid
sequenceDiagram
  participant M as 模型
  participant A as Agent 子进程 / Pi SDK
  participant H as 主进程 / ToolExecutor
  participant P as runPreToolUseChecks
  participant T as 实际工具 / MCP
  M->>A: 工具调用
  A->>H: pre_tool_use_request
  H->>P: Schema / 绑定 / 来源 / 模式 / 前置条件
  opt ask 模式的写操作
    H->>H: 等待一次性人工审批
  end
  H-->>A: pre_tool_use_response：allow / block
  alt allow
    A->>H: tool_execute_request：相同调用身份
    H->>P: 执行前复查
    H->>T: 使用主进程保存的参数执行
    T-->>H: 结果
    H->>H: 保存快照 / ExecutionRecord / Trace
    H-->>A: tool_execute_response
    A->>M: 回填工具结果，模型继续
  else block
    A->>H: 归一化失败 Observation
  end
~~~

PiModel.runSession 使用 Node fork 启动真实子进程，通信采用 Node IPC 的 JSON 序列化。子进程不能通过协议传入 SourceClient、权限 setter 或实际执行函数。主进程从自己保存的初始披露绑定解析工具；审批只在主进程发生一次。

ReplayModel 和独立来源探针仍直接进入同一个 ToolExecutor，不为离线决策启动 SDK 子进程，不绕过检查链。probe:model 的 completeSimple 仅用于独立连通探测。

## 文件职责

| 文件 | 职责 |
|---|---|
| packages/shared/src/agent/backend/pi/subprocess.ts | 主进程 fork、IPC 校验、请求防重、放行后执行握手、取消与退出收尾 |
| packages/shared/src/agent/backend/pi/worker.ts | 子进程创建模型运行时和 AgentSession，将模型/工具事件转为主进程请求 |
| packages/shared/src/agent/backend/pi/protocol.ts | 协议版本、会话/任务身份、双向序号、消息 Schema 与调用身份 |
| packages/shared/src/agent/backend/pi/model-runtime.ts | 显式内存认证和自定义模型注册，供子进程与独立模型探针使用 |
| packages/shared/src/agent/backend/pi/session.ts | SDK 生命周期、连续历史、工具 allowlist、预算及事件队列 |
| packages/shared/src/agent/backend/pi/tool-hooks.ts | buildProxyTools、wrapToolsWithHooks/wrapSingleTool；保存 originalExecute，透传 SDK 参数、取消、进度与 ExtensionContext |
| packages/shared/src/agent/core/pre-tool-use.ts | 共享同步检查，输出 allow/block/prompt，不执行工具 |
| packages/shared/src/agent/pre-tool-use.ts | 主进程一次性审批、审批后复查和 pre_tool_use_response |
| packages/shared/src/tools/executor.ts | 执行账本、握手后复查、实际分发、后端阶段复查、快照与终态 |
| packages/server-core/src/runtime/investigation.ts | 业务阶段、预算、流程前置条件、归一化事件与最终运行状态 |

SDK 的事件订阅不能直接等待 IPC。适配器用事件队列串行等待主进程确认；工具执行前和续轮前等待该队列。预算或决策被主进程拒绝后，子进程停止会话。SDK 自身拒绝的未知工具或参数仍形成失败 Observation。

## 关联与执行防重

### 一轮多个工具调用

模型可返回一批调用，Pi SDK 使用 sequential 执行模式；批内不并行。单调用继续使用 `call_tool`，多调用归一化为 `call_tools`，每项保存 `sdkToolCallId`、工具名和参数。最多 64 项，批内 ID 必须非空且唯一；非法参数对象或截断响应在第一项执行前拒绝。

主进程先保存整批意图队列。每次 `pre_tool_use_request` 只能匹配队首的工具、参数和 SDK ID，经独立 Schema、来源、权限、审批和执行握手后运行；上一项的 Observation 确认后才消费队首并处理下一项。同名同参数的调用仍具有各自 ID、requestId 和审批，不共享批准结果。

未知工具和 SDK 参数错误保留各自失败结果，后续调用仍需通过自己的门禁。来源或权限在批内发生变化时，后续项按最新状态复查；取消或运行预算失败会停止后续项，不重放已完成工具。调用依赖前一项返回值时，模型应在下一轮构造参数。

一批调用只记一次模型决策，所有项分别占用工具次数和同工具次数预算；宿主在首项执行前预留整批预算，超限整批不执行。因此工具计数包含已预留但因中断未执行的项，实际执行数以 ExecutionRecord 为准。批内禁止发起下一次模型决策、压缩、Memory 维护或宣称完成。Trace 校验额外检查每项结果的调用 ID、队列顺序和成功结束前的完整回填。

这是对供应商多调用响应的适配，不依赖供应商是否支持 `parallel_tool_calls` 参数，也不修改供应商请求格式来声称已强制限制返回数量。

每个 IPC 帧携带协议版本、独立 sessionId、taskId 和严格递增的单向序号；消息有大小限制。主进程拒绝未知、重复、乱序、跨会话与不匹配请求。

工具请求和裁决关联 requestId、taskId、toolName、bindingId、argsHash、sdkToolCallId。工具 requestId 使用 UUID；历史执行 ID 不允许重用。主进程核对当前模型意图与初始披露绑定，复制参数并创建 awaiting_permission 记录。

收到 allow 之后，子进程必须发送对应的 tool_execute_request。主进程只消费一次 allowed 状态，使用自己保存的参数，复查当前策略后执行；子进程不能借执行消息改写参数。仅获批准但未请求执行的调用不会产生工具副作用，超时或断线后收束。每个后端阶段仍复查权限。

pre_tool_use_response 的 action 为 allow/block；prompt 在主进程等待用户后解析。业务 modify action 表示修改操作，不代表实现了 Craft 的参数改写分支。未加入隐式来源激活或展示元数据注入。

## 崩溃、取消和 Trace

主进程监听 error、disconnect、exit、close。子进程失败时中止该会话的主进程 AbortSignal，取消挂起审批和执行；等主进程请求收束、子进程回收后再写运行终态。默认启动等待最多 15 秒，停止宽限 1 秒，挂起进程超过宽限则强制终止。调查总预算仍覆盖启动时间。

- 未执行的调用以 execute_count=0 收尾；待审批取消后，迟到批准不会再执行。
- 执行中的只读调用标记 cancelled；无法确认结果的修改/外发/发布标记 unknown，不宣称已经回滚。
- 已完成调用与证据保留；迟到结果不能追加 Observation 或修改终态。
- 当前运行失败，不自动重启会话或重放工具；主进程可以处理新的调查。

Trace 记录 pre_tool_use_request → policy_decision → 可选 approval_resolved → pre_tool_use_response → execution_started → 后端阶段 → execution_finished，以及 agent_process 的 started/ready/stopping/exited、PID、会话 ID 和退出码。校验器检查关联、裁决唯一性、审批与执行顺序、进程退出及未决请求收束。历史没有进程事件的日志仍可读取。

模型凭据只经私有 IPC 发送，不出现在命令行或 Trace。子进程环境仅继承操作系统与代理/证书所需变量，不继承搜索 token、其他模型 key 或 NODE_OPTIONS；标准输出/错误不进入协议或 Trace。

## 用户扩展

用户配置的 MCP 工具经 UserMcpSource 发现后进入同一绑定、代理与执行门禁，默认未知语义为 modify。所选 Skill 正文显式注入；session__read_skill_resource 在主进程检查安装清单、路径和哈希，再返回有界文本。安装/配置命令仅对用户 CLI 提供，不作为模型可调用工具；安装不执行脚本。详见 user-extensions.md。

## 实现边界与验证

子进程提供 SDK 故障隔离，不构成操作系统安全沙箱。实际工具仍在主进程，远端已经发生的副作用不能撤销。SDK 历史在内存中，持久化 Trace 用于重建审计状态，不宣称自动恢复完整模型会话。

tests/pi-protocol.test.ts 和 tests/pi-session.test.ts 使用真实 Pi 子进程、SDK、本地 HTTP/SSE 验证完整循环、三模式、历史、用量、取消、被杀后的收尾和新会话继续运行。tests/pi-subprocess.test.ts 使用真实故障子进程验证启动崩溃/挂起、断线、畸形/乱序/超大消息、重复调用、审批中崩溃和写操作状态 unknown。它们证明工程契约，不是模型生成质量指标；真实模型验收另记 acceptance-report.md。

## 模型披露与事件契约补齐



主进程 beforeModel 调用 ContextPipeline.prepareTurn，将 visibleTools 交给 SDK；每轮 context_prepared 保存模式、代理名/原名/来源/通道/绑定 ID 及上下文哈希。SDK prepareNextTurnWithContext 更新 system prompt 和活动工具；初始绑定上限不扩大。

来源/用户 MCP 租约来自 McpConnectionPool；浏览器归 builtin，GitHub 和平台 API 包装为 MCP 并归 mcp，CLI 采集已移除。它们使用同一个 IPC/PreToolUse/ToolExecutor 入口。浏览器 HTTP 响应由宿主检查，平台 API 则在 MCP handler 内按固定 origin 和宿主路径规则构造 HTTP 请求，并再次执行 stage 门禁；详见 source-adapters.md、platform-api-mcp.md。

packages/shared/src/agent/events.ts 提供 AgentEventSchema；Trace.emit 先脱敏并校验载荷，再按 schemaVersion=2 落盘；拒绝未知/畸形事件不推进序号。validateTrace 兼容旧格式和历史 safe，拒绝混合降级、身份/审批顺序错误及未完成模型决策的成功终态。model_usage 按轮记录提供方用量，不将未知价格当成零费用。

终态事件持久化后，自动将同一日志投影为 `cwatch.structured-trace.v1` JSON，按 run → model → tool → backend 组织步骤，并保留归一化事件、原始日志 SHA-256 和完整性检查结果。派生文件写入失败会通过 `traceArtifacts` 返回，已落盘的终态与观察者通知仍保留。历史导出不执行工具，也不追加审计事件。详见 [结构化 Trace](structured-trace.md)。

## 通用 API 与来源指南

每个 API 来源注册一个 api_<slug>，输入为 path/method/params/_intent。Registry 仅信任宿主适配器的 resolveAction，PreToolUse 按实际请求分类后检查模式、指南及原有计划/分析前置条件；POST 默认 modify，只有可信规则才能声明只读 POST。explore 保留读取入口，写调用仍硬阻断。执行器复制参数并按实际 action 保存账本，写操作取消保持 unknown 语义。

PrerequisiteManager 位于 agent/core/prerequisite-manager.ts，固定读取 sources/<slug>/guide.md。SourceGuideTools 提供 session__read_source_guide，同样经过主进程调用链和 source.guide.read 阶段；未读/变化不放行，指南不能授予权限。每轮 context_prepared 标记 dynamicAction/availableActions，API 的 HTTP 事件记录实际方法、路径与 action。详见 platform-api-mcp.md。

## 本地 Web 入口

apps/web 的 HTTP/SSE 层经 RunService 启动同一调查 Runtime，工具继续使用主进程 PreToolUse 与执行握手。网页审批只回应已存在的单次请求，核对原 argsHash；过期、重复和取消后的请求拒绝。Web 事件摘要来自先落盘的 Trace 副本，不改变审计与权限顺序。详见 web-workbench.md。


Search / Fetch 专用 API 使用本地 WebApiAdapter，不包装 MCP；它们与远程 MCP 共用上述 ToolRegistry、PreToolUse、ToolExecutor 及 Trace。显式 webApi 配置和旧 searchMcp.type=api 都走直接 HTTP，backend=web.api。具体步骤与配置见 [web-api.md](web-api.md)。
