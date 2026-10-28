# 工具注册与命名

当前完整工具清单与已删除入口见 [tools.md](tools.md)。`official__web_fetch` 已删除，官网读取统一使用 `web_fetch`。

工具统一注册、授权、分发和审计，但名称按实际类型区分。`mcp__` 仅用于 MCP 工具，以及实际通过 MCP Server / Client 调用的 API 工具；本地函数、HTTP API 或 IPC 本身不构成 MCP。

| 工具类别 | 注册名 | 示例 | 执行路径 |
|---|---|---|---|
| Pi SDK 内建工具 | 原名 | `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` | 宿主 PiBuiltinSource → SDK 实现 |
| 本地 Web 工具 | 原名 | `web_search`、`web_fetch` | 宿主 Web Source → 配置的 Web API / 可选后端 |
| 业务工作流 | `workflow__<原名>` | `workflow__save_plan`、`workflow__analyze`、`workflow__review`、`workflow__draft`、`workflow__read_plan` | 宿主 Workflow |
| 会话与宿主能力 | `session__<原名>` | 下表 | 宿主会话资源 / BrowserSource |
| 其他本地来源扩展 | `<slug>__<原名>` | `catalog__read_item`（命名示例） | 按已注册客户端执行；当前默认未配置 |
| 外部 MCP / MCP 包装的 API | `mcp__<slug>__<原名>` | `mcp__github__api_github`、用户配置的 MCP 工具 | MCP Client → Server → 实际服务 |

会话与宿主工具包含：

| 工具 | 用途 |
|---|---|
| `session__read_transcript` | 分页回查本次会话的原始转录 |
| `session__read_tool_result` | 分页读取本次会话归档工具结果 |
| `session__read_session_memory` | 读取最新会话工作记忆 |
| `session__read_source_guide` | 读取选中来源指南，并更新前置阅读状态 |
| `session__read_skill_resource` | 读取选中 Skill 的资源 |
| `session__browser_tool` | 使用本地只读浏览器能力 |

这些是宿主按本次运行条件提供的能力，不代表都用于管理聊天，也不代表都在每次运行注册。保存计划、分析、审查、起草和读取调查计划属于业务工作流。

Web 工具本身是本地注册入口，即使其内部选择远程 MCP 后端，名称仍为 `web_search` / `web_fetch`；实际后端由 Trace 记录。假新闻 MCP 已从默认来源、任务、脚本和产品工具清单移除，协议夹具仅位于 tests/fixtures。

## 名称生成与约束

`packages/shared/src/tools/tool-names.ts` 提供：

- `proxyToolName(slug, originalName)`：仅生成 MCP 名称 `mcp__${slug}__${originalName}`。
- `registeredToolName(slug, channel, tool)`：先检查 `channel=mcp`；否则根据宿主 `namespace=native/session`、workflow 通道或来源 slug 生成本地名称。工作流中的会话辅助工具显式声明 `namespace=session`。

外部 MCP 通道不能通过工具元数据冒充 native / session。本地名称清洗后若以 `mcp__` 开头，拒绝注册，包括本地 native 名称伪装或使用 mcp 来源 slug 的情况。

来源 slug 只允许 `[a-zA-Z0-9_-]+`，区分大小写，不强制小写。最终名称中的其他字符统一替换成下划线；名称不能为空、最长 64 字符，超长拒绝，不截断。清洗后发生碰撞时整批拒绝，已有绑定保持不变。

例如 MCP 原始名称 `search.records` 注册成 `mcp__crm__search_records`，但实际仍以 `search.records` 调用服务。

模型披露名、Pi 注册名、Replay 名、IPC 调用名和执行账本使用同一 `binding.proxy_name`，没有隐式别名。前缀不改变 `source_slug`：会话辅助工具仍可绑定于宿主 workflow 来源，浏览器仍绑定配置的浏览器来源。授权与撤权使用真实绑定。

## 内存映射与分发

```text
entries: Map<完整注册名, { binding, client, validate }>
sources: Map<真实来源 slug, { active, revision, client }>

模型调用 mcp__crm__search_records
  → entries.get(完整名称)
  → binding: source_slug=crm，original_name=search.records
  → Schema / 来源 / 范围 / 权限 / 前置条件检查
  → 使用保存的 client.callTool("search.records", args)
```

本地工具和 MCP 工具共用这条调用链。注册名是查表键，不用拆分双下划线恢复来源或原名；含点号、双下划线的原始名称仍能正确路由。

来源重新注册会生成新的 revision 和 binding ID，并替换该来源条目；初始披露绑定不会自动扩权。退出后客户端对象不做持久化，下一次启动根据配置重建。Trace 和 ExecutionRecord 保存绑定快照。

## Pi 代理与迁移

`buildProxyTools` 保留完整注册名作为 name；label 从绑定中保存的 original_name 生成，不解析前缀；description 完整保留，promptSnippet 最多 200 字符；SDK parameters 移除顶层 $schema，宿主仍用原始 Schema 校验。execute 闭包持有绑定快照，委派统一宿主执行器。

代理、IPC 和执行门禁结构参考 Craft，本项目按实际协议划分前缀，不照搬其跨后端 `mcp__session__` 命名。

此前命名迁移将旧本地 `mcp__session__*` 分类改为 `workflow__*` / `session__*`，将 `mcp__official__web_fetch` 改为 `official__web_fetch`。真正的 MCP 工具名保持不变。提示词、当前运行脚本、fixture、来源指南、上下文回查入口和探针同步更新；不注册旧名称别名，不重写已保存历史 Trace。用户自己的 Replay 脚本需要同步更新本地工具名。

验证命令：`npm run verify`（结构、类型、命名分发契约、权限、会话归档与真实 Pi 子进程回归）；浏览器集成另用 `npm run eval:browser`。

2026-10-21 验证通过：`npm run verify` 为 398/398（contract 288、semantic 30、integration 80），`npm run eval:browser` 为 6/6。日志分别见 `artifacts/tool-prefix-verify.log` 和 `artifacts/tool-prefix-browser.log`；这些固定回归与本机集成不代表真实模型准确率。
