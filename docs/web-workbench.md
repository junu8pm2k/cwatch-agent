# Cwatch 本地 Agent 工作台

在仓库根目录运行：

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run web
~~~

打开终端打印的本地地址。默认从 http://127.0.0.1:4310 开始，端口被占用时尝试后续 9 个端口；可用 WEB_PORT 指定固定端口。服务只绑定 127.0.0.1。已有 web:live 是 CLI 联网调查快捷命令，网页入口是 npm run web。

## 可以操作什么

- 通用任务与竞品调查（两模式）：顶部以胶囊切换「通用 Agent」与「竞品调查」，无需填写复杂模板即可上手；真实模式下默认开启「联网搜索」，不填限定域名即允许搜索与读取全网公开 HTTPS 网页（仍严格拦截 `localhost`、内网/单标签域名、IP 字面量、非 HTTPS、嵌入凭据与 GitHub API 路径），填写根域名（如 `bigmodel.cn`）时自动放行其子域名（如 `open.bigmodel.cn`）。后端 `POST /api/runs` 仍向后兼容 `standard`、`adapters` 等历史 profile。
- 离线演示与设置弹层：次要项（离线演示/真实运行切换、工具权限、自定义 MCP 开关、Skill 与时限/Token 上限）收口到输入卡左下角「设置」弹层，保持首页清爽；未配置 `.env` 时自动使用本地合成快照演示。
- 三态专注工作台：
  1. **输入首页**：居中浮雕卡片 + 3 个一键示例场景，零冗余面板。
  2. **运行聚焦态**：启动后隐藏重复表单，顶部仅保留状态、标题与单行指标；Ask 模式的修改/发送/发布审批请求以醒目「待处理审批」卡片直接置顶呈现，无需切页签即可批准或拒绝。
  3. **结果阅读与轨迹**：正文区仅保留「任务结果/调查报告」与「执行轨迹」两页签。通用 Agent 保持单栏柔和阅读与多轮追问流，工具过程合并为语义化单行步骤卡（计划/搜索/读取/本地/分析/审阅/草稿/MCP）；竞品调查配备右侧「引用证据 & 信息缺口」伴随栏，点击主张可与右侧证据卡片双向联动高亮。
- 侧滑 Trace 抽屉：点击顶栏「Trace」按钮（或工具胶囊快捷链接）从右侧滑出结构化 Trace 抽屉，查看 `run → model → tool → backend` 调用树、相对耗时瀑布条与节点输入输出，按 `Esc` 即可关闭。
- 取消与记录管理：停止模型/待审批调用/工具执行并回收资源。页面关闭不自动批准，也不自动取消任务；重新打开可恢复查看。侧边栏仅在并发槽位占满（2/2）时提示并发上限，有历史记录时自动出现筛选框并支持安全删除已结束任务。
- 报告与阅读：完整支持 XSS 安全的 Markdown 渲染（代码块与一键复制、表格、列表、引用块与安全链接），覆盖多轮对话与任务结果/调查报告；支持复制单条回复、完整报告或下载 Markdown 草稿。
- 来源与技能：独立的「来源与连接」视图展示模型状态、内建来源、自定义 MCP 与内置/用户 Skill，支持查看 Skill Markdown 详情、启停已安装 Skill / 自定义 MCP，以及只读 `listTools` 在线连通性测试（不执行 `tools/call`，密钥始终留在环境变量中）。
- 视觉与主题：采用柔和莫兰迪纸感浅色主题（默认）与深林灰深色主题，自动记忆偏好，移动端（390px）保持零横向溢出。

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

apps/web 提供 UI 和 HTTP/SSE 传输，packages/server-core/src/runtime/run-service.ts 提供进程内服务；core/types/runs.ts 定义共享 DTO。前端采用模块化原生 TypeScript（`apps/web/src/client.ts` 与 `apps/web/src/client/*.ts`）和语义化 CSS Token，启动时由服务端通过 TypeScript AST 转换并按静态白名单输出浏览器 ESM 模块，不引入额外前端框架或构建服务器。

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
| POST | /api/runs/:id/delete | 删除已结束的历史任务及其本地输出目录（拒绝删除活跃运行） |
| POST | /api/runs/:id/messages | 等待追问时提交 `{messageId: UUID, text: string}`，相同 ID/正文重传不重复执行 |
| POST | /api/runs/:id/end | 等待追问时正常结束会话并释放 worker |
| POST | /api/runs/:id/approvals/:requestId | 提交 allowed 与原 argsHash |
| GET | /api/runs/:id/report | 下载当前运行的 Markdown 报告 |
| GET | /api/runs/:id/trace | 获取当前运行的结构化 Trace（`cwatch.structured-trace.v1`） |
| GET | /api/extensions | 获取脱敏后的内建来源、自定义 MCP 元数据与内置/用户 Skill 清单 |
| GET | /api/extensions/skills/:name | 读取指定 Skill 的说明正文与参考文件列表 |
| POST | /api/extensions/skills/:name/toggle | 启用或停用已安装的用户 Skill |
| POST | /api/extensions/mcp/:slug/toggle | 启用或停用自定义 MCP 服务 |
| POST | /api/extensions/mcp/:slug/test | 执行只读 `listTools` 发现以测试自定义 MCP 连通性（不执行调用、脱敏输出） |

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
