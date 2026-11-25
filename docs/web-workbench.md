# Cwatch 本地 Agent 工作台

在仓库根目录运行：

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run web
~~~

打开终端打印的本地地址。默认从 http://127.0.0.1:4310 开始，端口被占用时尝试后续 9 个端口；可用 WEB_PORT 指定固定端口。服务只绑定 127.0.0.1。已有 web:live 是 CLI 联网调查快捷命令，网页入口是 npm run web。

## 可以操作什么

- Web 工作台已统一收拢为单一**调查模式**（底层 `runAgent` 与 CLI 多轮对话保持兼容）。在首页横幅下的输入框写下调查需求（或直接点示例卡片），选择运行方式、模型与思考强度后点击发送进入「确认调查」页面，补充公司、产品、时间范围、关注类型与交付要求即可启动调查。域名留空时搜索公开 HTTPS 网页，填写根域名时包含其子域名。
- 模型列表默认包含 `.env` 的 `MODEL_ID` 与 `WEB_MODEL_IDS`，也支持直接在「来源与连接」添加其他 OpenAI 兼容模型供应商（无需重启服务）。离线演示使用预设调查任务与合成快照。
- 在第二步的「运行设置」里调整联网搜索、限定域名、关注类型、调研深度、工具权限、扩展来源 (MCP)、Skill 和时限或 Token 上限。「我的调研」统一汇总全部调查与报告，支持搜索、按运行方式筛选、打开报告与删除历史。
- 三态专注工作台：
  1. **调查首页**：输入调研需求或点击示例卡片预填表单。
  2. **运行聚焦态**：启动后隐藏重复表单，顶部保留状态、标题、单行指标及「导出草稿」入口；Ask 模式的修改/发送/发布审批请求以醒目「待处理审批」卡片直接置顶呈现，无需切页签即可批准或拒绝。
  3. **调查报告与轨迹**：正文区保留「调查报告」与「执行轨迹」两页签，右侧配备「引用证据 & 信息缺口」伴随栏，点击主张可与右侧证据卡片双向联动高亮。
- 侧滑 Trace 抽屉：点击顶栏「运行详情」按钮从右侧滑出结构化 Trace 抽屉，查看 `run → model → tool → backend` 调用树、相对耗时瀑布条与节点输入输出，按 `Esc` 即可关闭。
- 取消、一键重试与记录管理：停止模型、待审批调用或工具执行时会回收资源。失败、已取消、中断或部分完成的调查可重试，也可以复用配置后再修改。「我的调研」可随时回看或删除已结束的调查。
- 报告阅读与多格式导出：完整支持 XSS 安全的 Markdown 渲染（代码块与一键复制、表格、列表、引用块与安全链接）；点击「导出草稿」弹出多格式导出窗口，支持导出 **完整 Markdown（`.md`）**、**独立排版网页（`.html`）**、**Word 文档（`.doc`）**、**证据与主张明细表（`.csv`，UTF-8 BOM + 公式注入防护）** 与 **结构化数据包（`.json`）**，并支持一键复制完整 Markdown 与打印/导出 PDF。所有导出均经服务端脱敏。
- 来源与技能：独立的「来源与连接」视图支持通过模型卡片右下角「＋」添加与移除 OpenAI 兼容模型供应商、配置与恢复搜索工具（自动兼容搜索 API 与远程搜索 MCP）、在网页中直接添加/启停/删除自定义 MCP 与 Skill，并以居中弹窗查看 Skill Markdown 说明，同时支持只读 `listTools` 在线连通性测试（不执行 `tools/call`，网页录入的密钥统一隔离在忽略 Git 的 `.cwatch/connections.json` 中并全程脱敏，不写入 `.cwatch/mcp.json` 或 Trace）。
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
| GET | /api/bootstrap | 可选模型 ID、思考强度配置、来源方案、技能、运行历史与当前页面 CSRF token |
| POST | /api/runs | 启动任务，可为真实运行传入本机已配置的 `model.id` 和可选的 `model.reasoningEffort` |
| GET | /api/runs | 获取运行列表 |
| GET | /api/runs/:id | 获取一次运行快照 |
| GET | /api/runs/:id/events | SSE 推送快照，重连后从当前状态恢复显示 |
| POST | /api/runs/:id/cancel | 取消运行 |
| POST | /api/runs/:id/delete | 删除已结束的历史任务及其本地输出目录（拒绝删除活跃运行） |
| POST | /api/runs/:id/messages | 等待追问时提交 `{messageId: UUID, text: string}`，相同 ID/正文重传不重复执行 |
| POST | /api/runs/:id/end | 等待追问时正常结束会话并释放 worker |
| POST | /api/runs/:id/approvals/:requestId | 提交 allowed 与原 argsHash |
| GET | /api/runs/:id/report | 下载当前运行的原始 Markdown 报告 |
| GET | /api/runs/:id/export?format=md\|html\|doc\|csv\|json | 按指定格式导出脱敏后的调查草稿（完整 Markdown、独立排版 HTML、Word 文档、证据明细 CSV 或结构化 JSON） |
| GET | /api/runs/:id/trace | 获取当前运行的结构化 Trace（`cwatch.structured-trace.v1`） |
| GET | /api/extensions | 获取脱敏后的搜索配置、内建来源、自定义 MCP 元数据与内置/用户 Skill 清单 |
| POST | /api/extensions/providers | 添加网页模型供应商（OpenAI 兼容接口） |
| POST | /api/extensions/providers/:provider/delete | 移除网页添加的模型供应商 |
| POST | /api/extensions/search | 配置工作台搜索工具（HTTPS 搜索 API 或搜索 MCP） |
| POST | /api/extensions/search/delete | 清除工作台搜索覆盖，恢复环境变量默认配置 |
| POST | /api/extensions/mcp | 在网页中添加远程自定义 MCP 服务（Token 隔离存放在 `.cwatch/connections.json`） |
| POST | /api/extensions/mcp/:slug/toggle | 启用或停用自定义 MCP 服务 |
| POST | /api/extensions/mcp/:slug/test | 执行只读 `listTools` 发现以测试自定义 MCP 连通性（不执行调用、脱敏输出） |
| POST | /api/extensions/mcp/:slug/delete | 删除自定义 MCP 服务及其隔离存储的 Token |
| POST | /api/extensions/skills | 在网页中添加 Skill（上传或粘贴 `SKILL.md`） |
| GET | /api/extensions/skills/:name | 读取指定 Skill 的说明正文与参考文件列表 |
| POST | /api/extensions/skills/:name/toggle | 启用或停用已安装的用户 Skill |
| POST | /api/extensions/skills/:name/delete | 删除已安装的用户 Skill |

POST 必须携带同源 Origin、bootstrap 返回的 X-Cwatch-Token 和 application/json。Host 必须匹配实际监听地址；跨站请求被拒绝，不启用跨域访问。请求体上限 64 KB，SSE 连接最多 16 个，慢客户端达到缓冲上限时断开。静态资源只有明确允许的 HTML/CSS/JS，不开放工作区文件读取；CSP 禁止内联脚本和页面嵌入，来源正文以文本渲染。

真实通用 Agent 页面默认传入 `conversation:true`。每轮答复后状态为 `awaiting_user`，结果页显示对话记录与追问输入；模型执行中、审批中及会话结束后不能追加消息。快照包含递增 revision，浏览器不会用较旧的 HTTP 回执覆盖较新的 SSE 状态。Token、模型轮次与工具预算按整段会话累计，等待输入暂停执行与模型超时；等待中的会话仍占用两个并发名额之一，可结束或取消释放。完整机制见 [用户追问](conversations.md)。

这是单用户、本机工作台，没有公网登录、多租户、HTTPS 终端或远程部署能力。不要把 loopback 监听改成公网部署使用。

## 持久化与停止

运行数据位于忽略 Git 的 .runtime/web/<id>/，包括 summary.json、activity.jsonl 和原有 reports、traces、executions、evidence 等。summary 是 UI 状态，Trace 是调用审计，两者职责不同。Ctrl+C 会取消未完成调查并关闭服务。

服务对 .runtime/web/.host.lock 加独占锁并记录进程 PID 与监听地址。若上次进程被强制结束导致锁文件残留，下次启动会自动检测旧 PID 已退出并清理失效锁；若旧服务仍在运行，则会提示正在运行的 PID 与地址。启动后将持久化的在途记录标为 unknown，不重放工具；当前 Pi 对话仍使用内存会话。历史显示恢复不等于模型会话续接。

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
