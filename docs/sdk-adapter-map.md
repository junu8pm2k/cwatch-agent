# Pi AgentSession 适配实锚

基线 @earendil-works/pi-coding-agent@0.84.2。迁移前核对已安装 dist/core/sdk.d.ts、sdk.js、agent-session.d.ts/js、resource-loader.d.ts、settings-manager.d.ts，以及包内 pi-agent-core 的 agent.d.ts、types.d.ts、agent-loop.js。版本不变。

用户任务：默认接受通用任务与所选 Skill，自主使用已授权工具并保存回答；选择调查模板时，再要求实体、时间窗、证据与本地报告。两种入口共用 SDK、IPC、ToolExecutor、预算和审计。

## 职责与映射

| 本工程职责 | SDK 落点 |
|---|---|
| 实际调查循环 | PiModel.runSession → 主进程 runPiSubprocess/fork → worker → createAgentSession → session.prompt；SDK 负责模型请求、工具调度、结果回填和继续执行 |
| 业务约束 | 共享 TaskRuntime 回调处理执行与预算；普通 agent.ts 接受最终回答，investigation.ts 扩展才强制计划→采集→分析→审查→草稿顺序 |
| 工具注册 | buildProxyTools → wrapToolsWithHooks/wrapSingleTool → customTools；显式 tools allowlist，noTools=builtin 禁止未包装工具自动注册；PiBuiltinSource 显式接入七个 SDK 内建工具 |
| 工具执行 | 子进程包装工具的 originalExecute → IPC pre_tool_use_request → 主进程 ToolExecutor → requestPreToolUseApproval → runPreToolUseChecks → IPC pre_tool_use_response → 子进程 tool_execute_request → 执行前复查 → 主进程实际分发；三模式、绑定/范围、审批、取消和快照均保留 |
| SDK 自身拒绝的工具 | tool_execution_end 的错误结果归一为 tool_failed Observation，包括未知工具和参数校验失败 |
| 决策 | message_end 的 assistant 消息解码；单调用保持原契约；多调用按 call_tools 整批登记，逐项串行授权与执行；重复 ID、非法批次和截断响应在执行前拒绝 |
| 会话上下文 | AgentSession 追加保留完整历史；PiContextManager 在续轮前按字符预算、模型窗口与真实 usage 判断压力，生成摘要并追加 compaction 边界；仅将初始任务、最新摘要、最近完整工具轮次与边界后消息用于后续请求 |
| 工具结果治理 | ToolResultGovernor 在摘要前按完整消息预算 snip，再按 entryId + toolCallId/toolName 将旧成功只读结果 microcompact；以 custom entries 记录可重建投影，原始消息不改写，assistant 文本和结果配对不删；session__read_tool_result 经宿主执行器分页读取本次会话的完整归档内容 |
| 正式压缩 | groupApiRounds/流前检查保护完整 assistant 调用与全部结果；结构化续办记录 + 保留轮次 + afterCompact 宿主附件/hook 结果经预算校验后追加 compaction/custom_message/compact_commit。getCommittedContextEntries 只启用完整提交的边界，未提交部分回退到上一上下文；保留范围不跨越旧边界重引入已摘要消息 |
| 模型与认证 | worker 内 createPiRuntime，MODEL_PROVIDER/MODEL_ID/API_KEY/BASE_URL 经 init IPC 配置；自定义端点 registerProvider；凭据只在内存 |
| 持久化 | SessionManager.inMemory 的原生 header/entries 经 onTranscript IPC 由主进程脱敏追加到 sessions/<runId>.jsonl；转录与 Trace 独立；压缩不删除旧消息。replayState 仍只重建业务状态，不自动继续工具执行 |
| 事件 | 订阅 message_end/tool_execution_end 并归一化；SDK toolCallId 经代理/执行器关联请求裁决和执行记录；原始 SDK 事件不直接落盘 |
| 取消 | 主进程发 IPC abort 并取消挂起工具/审批；worker 调用 session.agent.abort/session.abort，超过宽限强制终止；主进程等待执行收尾与子进程回收后落终态 |
| 预算 | 首次请求前和 SDK prepareNextTurnWithContext 续轮前检查；shouldStopAfterTurn 在失败后停止；每个工具仍有单独超时 |
| 用量 | 业务消息与摘要响应的 usage 均经 onUsage 计入总预算；beforeRequest 在两类请求前检查剩余 Token 并启动单请求超时；自定义端点不声称 SDK 默认价格是实际成本 |
| 隔离 | SettingsManager.inMemory，关闭 SDK 自带自动压缩、自动重试、遥测；压缩由宿主适配层显式管理；资源加载显式禁用扩展/目录 skill/提示模板/主题/上下文文件发现 |

ModelPort.runSession 是框架无关的可选会话执行端口；业务域不导入 SDK 类型。没有 runSession 的 ReplayModel / 测试模型仍用确定性单步驱动，以便回归业务语义。PiModel.decide 仅用于联通探针；上下文摘要在适配层单独使用 runtime.completeSimple，不参与业务工具调度。

交互通用任务通过 `AgentSessionHooks.nextUserMessage` 保持同一个 SDK Session：最终答复与转录落盘后向宿主请求下一条用户消息，返回 null 才 dispose。`next_user_message` 通过原带身份、序号校验的 IPC hook 端口传递；宿主仅在已确认最终答复且没有未决工具时允许等待。追问用原生 `session.prompt` 追加，首个请求经 `transformContext` 做治理/Memory/Compact 并同步循环消息数组。每次 prompt 会重设 SDK base prompt，因此实际 streamFunction 使用当轮宿主 stable 及固定 SDK 后缀。工具续轮继续使用原 prepareNextTurnWithContext。代码实锚、预算与恢复边界见 [用户追问](conversations.md)。

进程契约位于 packages/shared/src/agent/backend/pi/protocol.ts；主进程校验消息版本、会话/任务、递增序号和一次性调用身份，并记录 agent_process 生命周期。取消、断线和退出均等待挂起执行收束，超出停止宽限则强制回收；未恢复 SDK 会话或重放工具。

SDK 的公开 agent.prepareNextTurnWithContext 已由 AgentSession 安装刷新逻辑；适配器包装并调用原回调，保留其上下文/工具刷新。事件队列等待主进程确认，错误经 IPC 返回并触发取消，shouldStopAfterTurn 返回停止，不在 SDK 同步事件监听中向外抛错。工具参数 schema 来自注册时已校验的 JSON Schema，仅在适配边界转换 SDK 类型。

工具包装及类型化裁决结构详见 tool-call-pipeline.md。SDK ToolDefinition.execute 的 toolCallId、params、signal、onUpdate、ExtensionContext 依照已安装 dist/core/extensions/types.d.ts 透传；包装原 execute，未臆造新 SDK 钩子。

## 联网关系

通用 Web 工具在显式配置 webApi 时由本地 WebApiAdapter 直接调用 REST API；未配置时保留受控厂商内置适配器与所选远程 MCP。Search/Fetch 的直接 API 不再建立进程内 MCP；通用平台 API 的 MCP 适配保持原实现。厂商内置联网适配器由项目调用，不因启用 AgentSession 而自动支持所有模型的内置联网。SDK 普通工具事件不等于厂商服务端每个内部搜索动作的可拦截事件。

## 用户扩展映射

用户 MCP 由主进程 UserMcpSource 使用现有 MCP SDK 发现/调用；服务工具经 ToolRegistry/ToolExecutor 暴露为 SDK 代理，保留主子进程 PreToolUse 握手。未知动作默认 modify，逐工具格式在适配器内处理，不把第三方 MCP 结果对象升级为领域事实。

用户 Skill 由 SkillStore 解析、安装和选择；正文显式加入 stable，上下文和资源结果脱敏。参考文本经 session__read_skill_resource 进入主进程执行器；SDK 默认 Skill/扩展发现继续关闭，不使用 SDK 隐式加载或脚本执行。YAML 解析是主进程的独立依赖，不为此实例化 Pi SDK。详见 user-extensions.md。

## 验证边界

协议集成测试使用真实 Pi SDK、真实本地 HTTP/SSE 与脚本提供方，验证循环、历史、工具权限、取消及 Trace；不把脚本模型当作真实模型推理效果。真实模型探针与完整业务验收分别报告。

## 本轮后端补齐



ContextPipeline.prepareTurn 是宿主每轮前置模板，装配模式、实体、来源、时间窗、来源状态及工具面。prepareNextTurnWithContext 保留 SDK 原有刷新后，用本轮 stable 更新 context.systemPrompt；不跳过 SDK 会话管理。初始未披露、后来新增或替换的绑定不自动授权。

browser_tool 经 Playwright 的新匿名上下文实际渲染，HTTP 响应由主进程受控读取。平台 API 经宿主 MCP Server/Client 与通用 HTTP handler 调用，origin、范围和动态权限由宿主配置固定。二者只作为业务代理注册到 SDK；SDK 的 read/write/edit/bash/grep/find/ls 经宿主 PiBuiltinSource 与同一执行器启用，子进程不持有源客户端或 MCP 凭据。

来源/用户 MCP 在宿主 McpConnectionPool 中按配置复用，Agent 入口仍为 Node IPC。AgentEventSchema 与 Trace v2 在宿主落盘前校验。实际浏览器 + Pi + CLI 联合验收使用本地固定提供方与页面 fixture，不是实际模型质量验收。

## 平台 API MCP 边界

SourceServerBuilder 装配 API Tool → MCP Server，平台和 GitHub 工具都以 mcp 通道注册，使用 MCP SDK Server / Client / InMemoryTransport，不改变 Pi AgentSession 的代理工具和主进程 IPC。MCP tools/call 的每个 HTTP 阶段复用原 ToolExecutionContext，API 凭据仅由主进程 handler 按次读取。CLI 采集适配器已移除。详见 platform-api-mcp.md。

## 按需来源指南

Prompt Cache 仅复用已核对的 StreamOptions.cacheRetention/sessionId：业务 streamFunction 显式传 short/none 和本次 runId，摘要、Memory completeSimple 及探针传 none。Anthropic cache_control 与 OpenAI-compatible prompt_cache 字段由安装 SDK 的 API/compat 映射，不向未知 BASE_URL 增补私有字段。SDK parseChunkUsage 把 prompt_tokens 拆为未缓存 input、cacheRead、cacheWrite，项目 cache 观测使用该归一化结果，预算仍求完整 input/output/cacheRead/cacheWrite。cache edit、cached microcompact 未实现。ResourceLoader 添加的静态 cwd 后缀由适配层捕获并保留到每次正常刷新和反应式继续，避免首轮与续轮的 System Prompt 指纹漂移。测试在 onPayload 回调中截断 SDK 原生 Anthropic 请求验证标记，无外部 HTTP 或付费模型调用。

反应式恢复核对了安装包 pi-agent-core 的 agent-loop.js（error 响应结束循环，未执行工具）与 Agent.continue()（从非 assistant 末尾继续），以及 AgentSession 的失败消息追加和自动压缩开关。项目保留 SDK 内置 compaction/retry 关闭：message_end 落盘后识别明确长度拒绝，以原生 entryId 标记活动投影，强制 PiContextManager.prepare(..., reactive=true) 压缩，再由 session.agent.continue() 继续未满足请求。原始 SDK 错误响应保留，未使用私有自动压缩 API、重提用户任务或重放业务工具。provider_rejected Trace 结束失败请求的待决状态，原来的 beforeModel/beforeRequest/onUsage/IPC 继续提供预算、权限刷新与审计。错误模式采用明确白名单及限流等排除项，不照搬 SDK 对未知 400/413 的宽泛推断；详见 session-context.md。

独立 Session Memory 由 SDK SessionManager 的原生 message ID 及完整 API round 推进增量，PiSessionMemory 使用已核对的 ModelRuntime.completeSimple 创建无工具维护上下文，仅传上次 memory 和新增消息投影。没有使用或臆造 SDK forked Agent 接口，也未新增后台并发调度。宿主 SessionMemoryStore 通过类型化 session_memory IPC 端口加载/提交，校验本次身份、哈希、CAS 版本和转录游标，落盘路径 session-memory/<runId>.json；用途为当前状态检查点，非自动恢复执行。维护请求走 beforeRequest(memory)、onUsage(memory)、onTranscript 原有预算/审计端口，正式压缩后的宿主附件读取最新已提交 memory。详见 session-context.md。

摘要的完整转录回查入口通过现有 afterCompact 返回值的 transcript 字段从宿主传回；PiContextManager 在候选校验与原生 appendCompaction 之前把宿主身份加入最终摘要，使用既有 commit 协议持久化。`session__read_transcript` 是宿主对已落盘 SessionTranscript 的分页/按条目/字面查询工具，不调用 SDK 内置 read/bash，不把任意磁盘路径交给 worker。新增条目的哈希索引只保存在宿主，读取逐条复核截至原生 entryId 锚点的 JSONL，沿用现有 ToolExecutor/IPC。没有新增或假定 SDK 的转录搜索 API。

压缩后工作状态由宿主 `WorkingStateTracker` 跟踪成功资源读取与实际业务阶段，使用现有 `afterCompact` IPC 端口注入 custom_message 附件。SDK 的 Skill/扩展自动发现仍关闭；工具定义继续由原 prepareNextTurnWithContext 刷新，附件只映射当前可见且已披露绑定的身份与版本，不另开网络发现。宿主记录的 agent_process 生命周期映射为当前 Pi 进程状态；项目未实现异步子 Agent、Plan Mode 或延迟工具加载。`workflow__read_plan` 为本次已验证计划的宿主工具，不是 SDK 内置任意文件读取。完整字段、失效和预算策略见 session-context.md。

来源 guide.md 不由 SDK 隐式文件发现加载，也不整篇塞入工具描述。模型通过 session__read_source_guide 取得所选来源的有界文本与哈希，再调用 mcp__<slug>__api_<slug>。宿主 PrerequisiteManager 与动态 resolveAction 在同一 PreToolUse 链中检查；读指南与实际请求均保留 IPC、阶段复查及 Trace。SDK 内置自动压缩仍关闭，宿主适配层显式压缩不授予权限或变更宿主阅读状态；阅读状态按运行重置，不宣称压缩后自动重读指南。完整机制见 session-context.md。

2026-10-25 评测隔离核对：Pi 0.84.2 的 DefaultResourceLoader.reload 在 noSkills/noExtensions 等过滤前仍调用包管理器 resolve，扫描用户 `.agents/skills`。现用 ExplicitResourceLoader 实现本地已核对的 SDK ResourceLoader 接口（dist/core/resource-loader.d.ts）：getSystemPrompt 只返回宿主 Prompt，资源 getter 返回空集合，getExtensions 使用导出的 createExtensionRuntime，reload 不执行发现，extendResources 拒绝新增隐式资源。createAgentSession 继续接收同一 resourceLoader 端口；ContextPipeline/SessionTools 的显式宿主 Skill、工具和引用文件入口不变。没有修改 SDK 版本、HOME/USERPROFILE 或扩大文件许可。评测中的真实会话复用 runPiSession，运行在受 Node 文件/子进程权限限制的独立评测 Worker；生产默认 PiModel.runSession 仍使用原 IPC 子进程。验证与限制见 evaluation.md。
