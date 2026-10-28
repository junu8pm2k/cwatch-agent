# 工具清单

项目自带 21 项工具能力。实际加载取决于来源配置、会话资源、选中的 Skill 和权限模式；外部 MCP 及额外 API 来源按配置动态增加工具。

默认「通用 Agent + Skill」不加载五个 `workflow__*` 调查工具；选择调查模板才加载。其余工具继续按原有配置与权限提供。普通任务和模板的区别见 [通用 Agent](generic-agent.md)。

| 类别 | 工具名 | 作用 |
|---|---|---|
| Pi 内建 | `read` | 读取工作区文件 |
| Pi 内建 | `write` | 写入工作区文件 |
| Pi 内建 | `edit` | 修改工作区文件 |
| Pi 内建 | `bash` | 执行命令，按修改操作授权 |
| Pi 内建 | `grep` | 搜索文件内容 |
| Pi 内建 | `find` | 查找文件 |
| Pi 内建 | `ls` | 列出目录 |
| 本地 Web | `web_search` | 搜索网页 |
| 本地 Web | `web_fetch` | 获取网页正文 |
| 工作流 | `workflow__save_plan` | 保存和提交调查计划 |
| 工作流 | `workflow__read_plan` | 分页读取已核验的当前调查计划 |
| 工作流 | `workflow__analyze` | 整理证据、事实和历史变化 |
| 工作流 | `workflow__review` | 审查主张、证据和时间一致性 |
| 工作流 | `workflow__draft` | 保存带引用的报告草稿 |
| 会话与宿主 | `session__read_transcript` | 分页读取本次会话转录 |
| 会话与宿主 | `session__read_tool_result` | 分页读取归档工具结果 |
| 会话与宿主 | `session__read_session_memory` | 读取最新工作记忆 |
| 会话与宿主 | `session__read_source_guide` | 读取来源指南并完成前置阅读检查 |
| 会话与宿主 | `session__read_skill_resource` | 读取选中 Skill 的受控资源 |
| 会话与宿主 | `session__browser_tool` | 读取需要 JavaScript 渲染的配置页面 |
| MCP 包装的 API | `mcp__github__api_github` | 调用范围受限的 GitHub API |

通用 API 来源注册成 `mcp__<slug>__api_<slug>`，外部 MCP 注册成 `mcp__<slug>__<原名清洗后>`。这类配置相关的动态工具无法用固定清单穷举。所有工具均保存内存绑定，进入同一权限、执行和审计流程；只有实际经过 MCP 的工具使用 `mcp__` 前缀。命名细节见 [tool-registration.md](tool-registration.md)。

## 已清理的入口

- 删除 `official__web_fetch` 及 `official_web` 来源适配器。官网读取统一使用 `web_fetch`，默认官网来源仍保留 `official` 标识，但 kind 改成 `web`。旧配置需要迁移为 `kind=web` 并配置 allowedDomains 与 Web API / 可选后端。
- `mcp__news__search_news` 不再进入产品默认来源、任务或运行脚本。固定新闻数据和 MCP Server 移至独立测试夹具，保留协议、去重和反证测试，不作为真实新闻搜索能力。
- 删除启动假新闻服务的 `mcp:sample` 产品脚本。

结构化页面解析函数仍供浏览器采集使用。通用 Web 的真实返回是发现材料，不因改名或调用成功而自动成为事实；离线演示保留明确标记的预构造结构化快照。

## 保留相似工具的原因

- `bash` 与 `read/grep/find/ls` 的执行和权限不同；明确的文件工具允许只读模式完成检索。
- `web_fetch` 获取正文，`browser_tool` 支持页面渲染。
- `read_plan` 读取已提交且校验完整性的计划，`read_tool_result` / `read_transcript` 以会话身份分页回查归档，不等同于任意文件读取。
- `read_source_guide` 会更新来源的前置阅读状态，普通 `read` 不会。
- analyze、review、draft 分别承担证据整理、规则审查和草稿保存，不合并业务阶段。

## 验证

2026-10-22 通用 Agent 改造：`npm run verify` 408/408，`npm run test:agent` 9/9，`npm run eval:web` 8/8，`npm run eval:browser` 6/6。日志与通用/调查入口说明见 [generic-agent.md](generic-agent.md)。

2026-10-21：`npm run verify` 399/399，`npm run eval:web` 7/7，`npm run eval:browser` 6/6。日志位于 artifacts/tool-cleanup-verify.log、artifacts/tool-cleanup-web.log、artifacts/tool-cleanup-browser.log。它们覆盖固定回归、本机 UI、浏览器及 Pi 子进程，不代表真实模型准确率。
