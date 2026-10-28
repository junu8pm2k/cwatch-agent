# 工具权限模式

CLI 的 --mode live/replay 选择模型运行方式；--permission 选择宿主工具权限，两者独立。默认 explore。

| 模式 | 采集、分析、本地计划/草稿 | 修改、发送、发布 |
|---|---|---|
| explore | 允许 | 拒绝，不弹审批 |
| ask | 允许 | 每次调用需人工审批；拒绝、超时或无审批入口时不执行 |
| allow-all | 允许 | 直接执行，不请求审批 |

模式覆盖所有通过 ToolExecutor 注册的来源、MCP、API 包装 MCP、原生联网适配和 workflow 工具。通用 API 按实际 method/path/params 推导 action：GET 默认 collect，其余默认 modify，只读 POST 需宿主规则明确声明；指南和模型参数不能改写分类。模式不会自动注册额外工具，也不改变调查任务的 draft 输出目标。

Pi SDK 的 read/grep/find/ls 默认作为本地检查工具注册；write/edit/bash 为 modify，ask 逐次审批，explore 隐藏并拒绝。工具实现通过同一宿主执行器调用，不是未经包装的 SDK 默认执行。工作目录与 shell 边界见 [pi-builtins.md](pi-builtins.md)。

## CLI

以下命令使用离线样例，三种模式都能生成相同的本地调查草稿，因为示例仅包含采集、分析与本地草稿工具：

~~~powershell
npm start -- run --mode replay --permission explore --out artifacts/explore-demo
npm start -- run --mode replay --permission ask --out artifacts/ask-demo
npm start -- run --mode replay --permission allow-all --out artifacts/allow-all-demo
~~~

真实调查可改用 --mode live。ask 遇到修改、发送、发布时，需要交互终端输入完整 requestId；非交互环境没有审批人则失败。审批绑定任务、工具、参数哈希、请求 ID 与有效期，只批准当前调用。

## 兼容与边界

- 原 safe 输入保留为 explore 别名。CLI、ActionPolicy 构造与 setMode 均归一化；新运行与 Trace 只写 explore。历史 safe Trace 仍可验证与回放。
- 相较旧实现，ask 现在允许修改操作进入审批；不再无条件禁止所有 modify。
- allow-all 省略人工审批，但仍检查已注册工具、Schema、任务允许来源、参数范围、来源激活状态及绑定版本；不接受未知语义。
- 执行前与每个后端阶段仍重新读取宿主当前模式。模式降为 explore，或者降为 ask 却没有本次参数的审批时，后续后端调用被阻止。
- 模型参数 incoming_mode、网页内容或 MCP 返回内容不能更改宿主模式；只有 CLI 参数或宿主代码调用 ActionPolicy.setMode 才能设置。
- 三种模式保留预算、取消、脱敏、完整快照及 Trace。写操作中途取消且结果无法确认时记 unknown，不声称回滚。

## 审计与验证

CLI 输出及 runs/*.json 包含 permissionMode。run_started 保存起始模式；policy_decision 与 backend_policy 保存每次检查的 effectiveMode；终态记录最终模式。更换模式不复用未经本次请求/参数授权的审批。

模式入口 packages/shared/src/agent/core/permission-manager.ts、apps/cli/src/index.ts；统一检查 packages/shared/src/agent/core/pre-tool-use.ts；异步裁决 packages/shared/src/agent/pre-tool-use.ts。实际 Pi 工具经 wrapToolsWithHooks/wrapSingleTool 包装，最终进入 ToolExecutor；执行前和每阶段复查相同检查链。tests/permissions.test.ts 验证独立六类 action 矩阵、边界、模式降级、取消、历史兼容和 CLI；tests/pi-session.test.ts 用真实 SDK + 本地模型协议桩验证 ask/allow-all 的修改、发送和发布调度。全部测试由 npm run verify 执行，不访问真实外发服务。

## 模式工具面与每轮提示



ActionPolicy.visibleTools 按任务来源、active 状态与声明 action 生成模型可见列表。explore 不披露只有修改/发送/发布能力的工具；通用 API 工具保留读取入口，对实际写请求硬拒绝；ask 与 allow-all 披露相应工具，但执行器仍分别审批或放行。模型乱报隐藏名称不能获得新绑定；SDK 拒绝保留失败 Observation，宿主执行仍有独立门禁。

ContextPipeline 首次披露后固定绑定 ID 上限。模式降级和来源停用会在下一轮移除工具并更新 system prompt；提升模式、新增来源或替换绑定不在已有会话内静默增权，需要新运行获得新增工具面。Skill 在安装/选择时解析，每轮使用冻结正文并注入权限分支。

注册 inactive 来源只登记状态，不连接 MCP、不启动 MCP 进程/浏览器、不要求其密钥存在。实际调用的 HTTP、MCP 和浏览器阶段继续由 ToolExecutionContext.stage 复查。

## API 指南前置条件

session__read_source_guide 本身经门禁、source.guide.read 阶段和 Trace，返回固定来源指南及哈希。API 调用前检查已读版本，缺失/未读/变更均拒绝，allow-all 同样适用。运行开始重置阅读状态。实际请求 action 写入 ExecutionRecord/policy_decision，context_prepared 记录通用工具的动态分类标记。详见 [平台 API MCP](platform-api-mcp.md)。
