# 平台 API：guide.md + 通用 MCP 工具

2026-10-29：项目已移除 GitHub API 接入、来源配置和联网探测入口，并拦截内建网络通道的 GitHub API 地址。旧离线 fixture 与历史验收记录仅用于审计，不代表当前可用能力。详见 [停用说明](github-api-disabled.md)。

按 Craft 的 sources/api-tools.ts 与 agent/core/prerequisite-manager.ts 组织：每个 API 来源提供一份 guide.md 和一个 api_<slug> 工具。工具描述仅指向指南，模型按需读取端点说明，再提交 path、method、params。指南是使用文档，权限仍由主进程独立裁决。

GitHub 原始 MCP 工具为 api_github；本项目保留来源命名空间，Agent 代理名为 mcp__github__api_github。旧 mcp__github__releases_list 与 api.tools 逐端点配置已移除，调用脚本及示例同步迁移。save_plan、analyze、review、draft 等 workflow 工具仍显式注册。

## 来源目录与加载

~~~text
sources/
  github/
    config.json
    guide.md
  platform/
    config.json
    guide.md
~~~

config.json 由操作者配置，guide.md 记录端点、参数、结果限制和使用示例。sources/platform 是停用的占位模板；不得直接用于真实采集。指南路径固定为工作区根目录 sources/<slug>/guide.md；目录名必须匹配 config.slug。

CLI --sources 支持原 JSON 数组、单个配置对象，以及包含各来源目录的 sources 目录。省略该参数时仍使用 examples/sources.json。使用单来源或目录配置时，task.allowedSources 和计划须匹配实际启用的来源。

~~~powershell
npm start -- run --mode replay --task examples/task.json
~~~

默认演示只选择官网来源。sources/platform 保留为停用的通用平台占位模板。

## 工具调用与门禁

~~~mermaid
sequenceDiagram
  participant M as Agent 子进程 / Pi SDK
  participant H as 主进程 PreToolUse / ToolExecutor
  participant G as PrerequisiteManager
  participant C as 池化 MCP Client / Server
  participant API as 平台 REST API
  M->>H: session__read_source_guide {source}
  H->>G: 范围、来源状态、受控路径与有界读取
  G-->>H: text / path / hash，记住已读版本
  H-->>M: 指南与快照，完整 Trace
  M->>H: mcp__<slug>__api_<slug> {path, method, params}
  H->>H: 绑定 / Schema / 动态 action / 模式 / 指南 / 业务前置条件
  opt ask 的写请求
    H->>H: 一次性人工审批，绑定完整参数哈希
  end
  H->>C: 执行握手后 tools/call
  C->>H: HTTP stage 再走相同检查链
  H->>G: 校验指南版本
  C->>API: 注入凭据、固定 origin、请求
  API-->>C: 有界响应
  C-->>H: RetrievalResult
  H-->>M: 执行记录、快照与工具结果
~~~

平台 API 和 GitHub 均归 mcp 通道，使用真实 MCP SDK Server / Client / InMemoryTransport。连接池按配置和 live/replay 隔离，最后租约释放后关闭；没有新增外部 HTTP MCP 端点。子进程不持有来源凭据或 HTTP 执行器。

session__read_source_guide 自身经过同一 ToolExecutor、PreToolUse 和 Trace，backend 为 source.guide.read。仅能读取任务选中且启用的 API 来源，不能传任意文件路径。限制为 64 KB 文件、32000 字符，拒绝空文件和符号链接；返回路径、内容哈希和原始快照。

未读、缺失或已变化的指南会硬阻断 API 调用，重复重试和 allow-all 均不能跳过；变化后须重读。每次运行重置已读状态；当前 Pi 自动上下文压缩关闭，未实现压缩后的自动重读。与参考 Craft 的普通来源指南软重试不同，这里保持严格门禁。

## 通用平台配置

完整模板见 examples/sources-platform-api.json。按目标平台文档修改 baseUrl、路径范围和规则；示例域名不提供服务。

~~~json
{
  "slug": "platform",
  "kind": "api",
  "active": true,
  "entityId": "nodejs",
  "product": "Node.js",
  "api": {
    "baseUrl": "https://api.example.com/v1",
    "auth": {"tokenEnv": "PLATFORM_API_TOKEN", "scheme": "bearer"},
    "allowedPaths": ["/releases/**", "/search"],
    "blockedPaths": ["/releases/private/**"],
    "requestRules": [{
      "method": "POST",
      "path": "/search",
      "action": "collect",
      "paramsSchema": {
        "type": "object",
        "properties": {"query": {"type": "string", "minLength": 1}},
        "required": ["query"],
        "additionalProperties": false
      }
    }],
    "resultFormat": "json"
  }
}
~~~

先读指南，再调用通用工具：

~~~json
{"name":"session__read_source_guide","args":{"source":"platform"}}
{"name":"platform__api_platform","args":{"path":"/releases","method":"GET","params":{"limit":5},"_intent":"Read recent releases"}}
~~~

- 模型可选择 path、method、params，不能修改 baseUrl、认证、来源实体或宿主规则。path 相对 baseUrl 路径前缀追加；禁止跨域、点路径、反斜杠、query/fragment 与编码路径。
- allowedPaths 默认为 /**；blockedPaths 优先。支持精确路径和尾部 /** 子树匹配。requestRules 选最深规则，同深度精确路径优先。
- GET 默认 collect；POST/PUT/PATCH/DELETE 默认 modify。只读 POST 必须由可信 requestRules 显式声明 collect；PUT/PATCH/DELETE 不能声明 collect。特殊 GET 也可声明 modify/send/publish。
- paramsSchema 可对匹配端点的参数做同步 JSON Schema 检查。fixedParams 是固定参数，模型不能覆盖；不再支持旧 parameterMap。指南写“只读”或模型参数写 action=collect 都不能改变宿主分类。
- explore 保留该通用工具的读取入口，并逐请求阻断写入；ask 对实际写请求逐次审批；allow-all 仍做来源、参数、指南与阶段复查。执行记录保存实际解析的 action；context_prepared 另标 dynamicAction 与 availableActions。
- GET 的 params 写 query，其他方法默认写 JSON body；非 GET 支持 params._rawBody 字符串和可选 _contentType；配置 fixedParams 时拒绝 raw body，避免跳过固定参数。_intent 仅说明调用目的，不发送给平台，也不影响回放匹配。
- auth 支持 header/query、bearer/raw、自定义 name；密钥从 tokenEnv 每次实际请求读取，required 默认 true。headers 仅放公开静态头，认证与 Cookie 不可硬编码。固定参数也不要写密钥。
- 固定 HTTPS origin，不跟随重定向，响应流上限 2 MB；取消贯穿 MCP/HTTP。401/403、429、解析失败与空数据分别处理。凭据及常见编码形式在嵌套 HTTP 错误写 Trace 前脱敏，不记录含鉴权 query 的最终 URL 或认证头。

### 已停用的 GitHub API

GitHub 专用适配器、来源目录和探测脚本已移除。HTTP 分类器中的旧响应语义只供注入固定响应的离线回归使用；内建网络传输拒绝连接 GitHub API，不提供开关或凭据启用方式。

## 结果与验证

resultFormat=json 将普通 JSON 保留为 discovery 页面和快照，published_at=null，不自动成为事实。resultFormat=retrieval 验证完整 RetrievalResult，并拒绝其他 sourceSlug 的信号，随后仍经归因、时间窗、去重、版本与 Review。

replay 也经过实际 MCP tools/call，fixture 不改成 live；通用 API fixture 需配置匹配的 fixtureRequest。

npm run verify 覆盖实际 MCP 发现/调用、指南门禁、动态权限、规则优先级、凭据轮换、取消、并发、业务前置条件与目录配置。npm run verify:browser 另验真实 Pi 子进程、浏览器和进程内 MCP 的合成数据闭环。普通 REST 搜索/fetch 使用独立的本地 webApi 工具路径，见 web-api.md；不属于本节的平台 API MCP 包装。

这些验证证明工程契约，不证明任意平台字段映射或真实模型质量。CLI 采集已移除；应用 CLI 和 stdio MCP 仍保留。
