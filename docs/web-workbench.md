# Cwatch 本地 Agent 工作台

在仓库根目录运行：

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run web
~~~

打开终端打印的本地地址。默认从 http://127.0.0.1:4310 开始，端口被占用时尝试后续 9 个端口；可用 WEB_PORT 指定固定端口。服务只绑定 127.0.0.1。已有 web:live 是 CLI 联网调查快捷命令，网页入口是 npm run web。

## 可以操作什么

- 通用任务：默认模板为「通用 Agent」，真实模式编辑任务描述、选择工具来源和 Skill；最终回答可查看、复制、下载并在刷新后恢复。无需填写实体或时间窗，也不经过固定调查阶段。
- 离线演示：通用模板用固定脚本读取 README；官网与发布、联网调研、浏览器/API 调查模板保留原合成快照演示。均无需模型密钥。
- 真实调查：沿用本机 .env 的 MODEL_PROVIDER、MODEL_ID、API_KEY、BASE_URL；编辑实体、产品、域名、时间和来源。配置映射仍须匹配任务，不能只修改名称就跨实体调用。
- 过程：展示计划、工具调用、处理阶段、错误、用量和运行用时。运行中的状态通过 SSE 更新；历史与报告保存在本机，刷新页面可重新查看。
- 审批：Ask 模式的修改/发送/发布请求显示工具、脱敏参数、请求 ID、参数哈希与期限；只能批准或拒绝当前请求。重复、过期、参数哈希错误和取消后的批准均无效。
- 取消：停止模型/待审批调用/工具执行并回收资源。页面关闭不自动批准，也不自动取消调查；重新打开可以继续查看当前运行。工具超时仍按宿主预算收束。
- 报告：展示结构化主张、来源链接、发布时间、fixture 标记和缺口；可查看、复制或下载完整 Markdown 草稿。
- 来源与技能：展示现有来源配置，真实模式可选择已启用的用户 MCP 和已安装 Skill。配置/安装管理仍通过本地文件与现有 CLI 完成；“已配置”不表示已验证服务连通。
- 同时最多运行两个调查，各自拥有独立 Registry、MCP 池、取消信号和输出目录；容量满时明确拒绝。

默认产品来源不再包含示例新闻 MCP。调查模板中普通搜索/网页内容继续保持 discovery 身份；通用任务可引用工具材料，但调用成功不等于事实核验通过。

## 后端边界

~~~mermaid
flowchart TD
  UI["浏览器 · 中文工作台"] --> HTTP["本地 Node HTTP API"]
  HTTP --> Service["RunService · 运行 / 审批 / 历史 / 取消"]
  Service --> Runtime["runAgent / runInvestigation → 共享 TaskRuntime"]
  Runtime --> Pi["独立 Pi Agent 子进程"]
  Pi -->|"工具意图 / 执行握手"| Gate["主进程 PreToolUse / ToolExecutor"]
  Gate --> Tools["内建工具 / MCP / API 包装 MCP"]
  Runtime --> Trace["先落盘的 Trace v2"]
  Trace -->|"脱敏后的受限事件摘要"| Service
  Service -->|"SSE snapshot"| UI
~~~

apps/web 提供 UI 和 HTTP/SSE 传输，packages/server-core/src/runtime/run-service.ts 提供进程内服务；core/types/runs.ts 定义共享 DTO。前端使用 TypeScript、HTML/CSS，启动时将客户端 TypeScript 转换为浏览器模块，不引入额外前端框架或构建服务器。

CLI 通过 runAgent 或兼容的 runInvestigation 进入同一共享 Runtime；CLI 的装配仍独立于 RunService。权限、Pi worker、来源客户端和业务规则使用已有实现，浏览器不能通过启动接口注入工具客户端、服务脚本或模型凭据。真实任务里的文件与命令请求仍须经过宿主执行器授权。

Trace 的观察回调在脱敏、Schema 校验和 append 成功后收到副本；观察者失败不破坏审计。Web 只推送有界事件摘要，不把完整网页原文和认证信息发送给事件面板；原始 Trace/快照仍由既有后端落盘。

## HTTP 接口

| 方法 | 路径 | 含义 |
|---|---|---|
| GET | /api/bootstrap | 模型配置状态、来源方案、技能、运行历史与当前页面 CSRF token |
| POST | /api/runs | 启动任务；profile/mode/permission/task/skills/limits/conversation 经 Schema 校验 |
| GET | /api/runs | 获取运行列表 |
| GET | /api/runs/:id | 获取一次运行快照 |
| GET | /api/runs/:id/events | SSE 推送快照，重连后从当前状态恢复显示 |
| POST | /api/runs/:id/cancel | 取消运行 |
| POST | /api/runs/:id/messages | 等待追问时提交 `{messageId: UUID, text: string}`，相同 ID/正文重传不重复执行 |
| POST | /api/runs/:id/end | 等待追问时正常结束会话并释放 worker |
| POST | /api/runs/:id/approvals/:requestId | 提交 allowed 与原 argsHash |
| GET | /api/runs/:id/report | 下载当前运行的 Markdown 报告 |

POST 必须携带同源 Origin、bootstrap 返回的 X-Cwatch-Token 和 application/json。Host 必须匹配实际监听地址；跨站请求被拒绝，不启用跨域访问。请求体上限 64 KB，SSE 连接最多 16 个，慢客户端达到缓冲上限时断开。静态资源只有明确允许的 HTML/CSS/JS，不开放工作区文件读取；CSP 禁止内联脚本和页面嵌入，来源正文以文本渲染。

真实通用 Agent 页面默认传入 `conversation:true`。每轮答复后状态为 `awaiting_user`，结果页显示对话记录与追问输入；模型执行中、审批中及会话结束后不能追加消息。快照包含递增 revision，浏览器不会用较旧的 HTTP 回执覆盖较新的 SSE 状态。Token、模型轮次与工具预算按整段会话累计，等待输入暂停执行与模型超时；等待中的会话仍占用两个并发名额之一，可结束或取消释放。完整机制见 [用户追问](conversations.md)。

这是单用户、本机工作台，没有公网登录、多租户、HTTPS 终端或远程部署能力。不要把 loopback 监听改成公网部署使用。

## 持久化与停止

运行数据位于忽略 Git 的 .runtime/web/<id>/，包括 summary.json、activity.jsonl 和原有 reports、traces、executions、evidence 等。summary 是 UI 状态，Trace 是调用审计，两者职责不同。Ctrl+C 会取消未完成调查并关闭服务。

服务对 .runtime/web/.host.lock 加独占锁。若进程被强制结束，确认旧服务已退出后，手工删除这一个锁文件再启动。启动后将持久化的在途记录标为 unknown，不重放工具；当前 Pi 对话仍使用内存会话。历史显示恢复不等于模型会话续接。

## 验证

~~~powershell
npm run verify
npm run verify:web
npm run verify:browser
npm run typecheck:workspaces
~~~

Web 浏览器验收使用已安装 Edge/Chromium；找不到时运行 npm run browser:install，或用 EVAL_BROWSER_EXECUTABLE 指定浏览器路径。

GitHub Actions 为两套 Playwright 测试安装同版本的 Chromium 和系统依赖，再并行运行 `npm run test:web` 与 `npm run test:browser`。在工作流的 Artifacts 中可以下载 `playwright-web` 和 `playwright-browser`，查看各自的报告和 Trace。 [项目检查工作流](../.github/workflows/ci.yaml)

`verify` 覆盖 RunService 和 HTTP 契约。`verify:web` 覆盖真实浏览器的任务启动、引用与报告下载、刷新恢复、审批与取消、手机布局、键盘操作及不可信文本渲染。真实模式用例在本机启动 Pi worker，并通过 HTTP/SSE 协议桩提供模型响应。本地报告位于 `artifacts/web-eval/`。
