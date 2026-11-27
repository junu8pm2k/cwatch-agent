# Cwatch 本地 Agent 工作台

在仓库根目录运行：

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run web
~~~

打开终端打印的本地地址。默认从 http://127.0.0.1:4310 开始，端口被占用时尝试后续 9 个端口；可用 WEB_PORT 指定固定端口。服务只绑定 127.0.0.1。已有 web:live 是 CLI 联网调查快捷命令，网页入口是 npm run web。

## 可以操作什么

- 在首页输入任务后，工作台用所选模型做一次无工具的意图判断。读取工作区文件、解释和快速查询直接交给只读通用 Agent。需要公开网页信息的快速查询可用配置好的 Web 工具。需要系统采集、核验证据并出报告的任务进入「确认调查」，预填请求中明确写出的公司和产品，由用户确认时间范围、来源和交付要求后启动完整流程。域名留空时搜索公开 HTTPS 网页，填写根域名时包含其子域名。
- 对具名产品或套餐的开放式调查可直接进入「确认调查」，由用户补充范围。首页的单点联网查询最多调用工具 5 次，同一工具最多 3 次，每次默认限时 120 秒。此前符合首页配置的总超时联网查询在重试时会重新判断意图。
- 留空发送或点击调查示例可直接打开调查表单。离线演示沿用固定脚本。意图判断失败会保留输入并显示错误，便于重试或更换模型。
- 真实调研的确认页可添加公开 HTTPS 网址，标明官网、官方文档、发布日志或官方论坛等类型。默认优先逐个读取指定入口，其他公开来源仍服从域名限制。选择「只查指定网址」后，Web 工具只接受指定网址及其下级路径，搜索也按这些路径限定。
- 计划为每个必查问题设定候选目标。达到该目标、不同策略的连续两次有效搜索无新增、工具预算耗尽或来源不可用时结束对应搜索。抓取过的候选按正文和日期核验。报告的「阶段结束依据」列出指定网址处理结果、候选覆盖、逐问题结论和审查项。
- 分析必须给每个计划问题一个结果，事实结论须有证据引用。审查涉及范围、来源身份、引用、证据支撑、冲突与缺口、表达一致性，问题项会显示需要修改的内容和相关引用。审查可提出一次带具体网址或查询的定向补查。草稿使用审查后的结论，未解决的问题会以缺口或冲突呈现。
- 调研结果先保存在原会话的草稿里。可以选择报告文字、添加标注、提交一段校订或继续追问。校订需要原文在 Markdown 正文中唯一匹配。追问使用当前草稿和近期对话，建议由用户确认后写入正文。证据快照和原有核验记录仍可从引用与轨迹查看。
- 点击「保存到我的调研」归档当前草稿和标注。归档后可以在原会话继续编辑，再用「更新我的调研」确认新版。资料库打开和并排对比均读取已保存的版本，最多对比四份。
- 左栏直接显示会话。可以在项目标题旁点击「+」开始新会话，也可把已有会话拖入项目。会话右侧的「⋯」可以重命名会话或删除已结束的会话。确认窗口会说明随会话删除的内容。
- 模型列表默认包含 `.env` 的 `MODEL_ID` 与 `WEB_MODEL_IDS`，也支持直接在「来源与连接」添加其他 OpenAI 兼容模型供应商（无需重启服务）。离线演示使用预设调查任务与合成快照。
- 在第二步的「运行设置」里调整联网搜索、限定域名、关注类型、调研深度、工具权限、扩展来源 (MCP)、Skill、单次工具超时和 Token 上限。每次工具调用重新计时。超时的调用会记录失败，任务可在剩余额度内继续。「我的调研」支持搜索、按运行方式筛选、打开报告与删除历史。
- 三态专注工作台：
  1. **任务首页**支持提交普通任务或调研需求，也可点击示例卡片打开调查表单。
  2. **运行聚焦态**：真实调查在「计划」阶段内审批，批准后才开始采集，拒绝则结束调查。提交修改意见后，Agent 在已确认的调查范围内重拟计划，每个新版本都重新审批。点击阶段后，详情和执行轨迹仅显示该阶段的步骤。审批模式还会在修改、发送或发布前逐次请求确认。
  3. **调查报告与轨迹**：正文区保留「调查报告」与「执行轨迹」两页签，右侧配备「引用证据 & 信息缺口」伴随栏，点击主张可与右侧证据卡片双向联动高亮。
- Langfuse Trace 直达：配置 `.env` 中的 Langfuse 凭据后，真实任务运行中与完成后均在顶栏和阶段操作区提供「Langfuse Trace」直达链接，点击在新标签页中打开完整嵌套调用树、Prompt/输出、用量与评分（原前端自研 Trace 抽屉已下线，详细说明见 [Langfuse 接入](langfuse.md)）。
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
| POST | /api/task-intent | 根据 `instruction` 和可选的 `model` 返回通用任务或完整调研的分类，限时 30 秒，分类本身不启动运行 |
| POST | /api/projects | 创建项目，传入 `name` |
| POST | /api/runs | 启动任务，可为真实运行传入本机已配置的 `model.id` 和可选的 `model.reasoningEffort` |
| GET | /api/runs | 获取运行列表 |
| GET | /api/runs/:id | 获取一次运行快照 |
| GET | /api/runs/:id/events | SSE 推送快照，重连后从当前状态恢复显示 |
| POST | /api/runs/:id/cancel | 取消运行 |
| POST | /api/runs/:id/delete | 删除已结束的历史任务及其本地输出目录（拒绝删除活跃运行） |
| POST | /api/runs/:id/messages | 等待追问时提交 `{messageId: UUID, text: string}`，相同 ID/正文重传不重复执行 |
| POST | /api/runs/:id/end | 等待追问时正常结束会话并释放 worker |
| POST | /api/runs/:id/approvals/:requestId | 提交 `allowed` 与当前 `argsHash`。计划审批也可提交 `feedback` 与当前 `argsHash`，要求重拟 |
| GET | /api/runs/:id/report | 下载当前 Markdown 草稿，使用 `?version=saved` 下载已保存报告 |
| POST | /api/runs/:id/project | 设置 `projectId`，传入 `null` 时移回未归档会话 |
| POST | /api/runs/:id/title | 设置会话标题 `title` |
| GET | /api/runs/:id/report-review | 读取草稿、标注和追问，使用 `?version=saved` 读取已保存版本 |
| POST | /api/runs/:id/report-annotations | 对指定 `revision` 添加 `quote`、`note` 和可选 `replacement` |
| POST | /api/runs/:id/report-messages | 在调研会话里对草稿追问，使用 `messageId` 和 `text` |
| POST | /api/runs/:id/report-save | 确认归档指定 `revision`，也可用同一入口更新已保存报告 |
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

首页启动的通用任务在保存回答后结束。程序调用真实通用 Agent 时可传 `conversation:true`，每轮回答后进入 `awaiting_user` 并支持追问。快照包含递增 revision，浏览器不会用较旧的 HTTP 回执覆盖较新的 SSE 状态。Token、模型轮次与工具预算按整段会话累计，等待输入期间暂停执行和模型超时，等待中的会话仍占用一个并发名额。 [用户追问](conversations.md)

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
