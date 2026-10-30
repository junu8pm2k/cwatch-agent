# 本地 Search / Fetch 与统一工具执行

2026-10-29：项目已移除 GitHub API 接入、来源配置和联网探测入口，并拦截内建网络通道的 GitHub API 地址。旧离线 fixture 与历史验收记录仅用于审计，不代表当前可用能力。详见 [停用说明](github-api-disabled.md)。

Search 和 Fetch 是宿主定义的本地 Agent 工具，底层调用用户配置的第三方 API。它们不创建 MCP Client / Server，也不执行 initialize、tools/list 或 tools/call。远程 MCP 仍通过独立 Adapter 接入，所有来源共用 ToolRegistry、PreToolUse 和 ToolExecutor。

```text
Pi AgentSession / ReplayModel
  → 固定工具定义、ToolBinding
  → PreToolUse：Schema、来源、实体/域名、权限、必要的审批
  → ToolExecutor：超时、取消、执行记录、阶段权限复查
      → web_search / web_fetch
          → PreferredWebSource
              → webApi：本地 WebApiAdapter → 第三方 REST API
              → 原生工具 / 远程 MCP：原有可选路径
      → 其他来源：平台 API MCP、外部 MCP、浏览器、Workflow
  → Observation、原始响应快照、统一 Trace
  → Agent 下一轮
```

## 配置与路由

推荐使用 `examples/sources-web-api.json`。Search 和 Fetch 可以分别使用不同的服务地址、密钥与映射；也可以只配置其中一个。`webApi` 和 `searchMcp` 在同一来源上互斥，防止选择歧义。

```json
{
  "slug": "web",
  "kind": "web",
  "allowedDomains": ["nodejs.org"],
  "webApi": {
    "search": {
      "urlEnv": "API_SEARCH_URL",
      "queryParam": "query",
      "limitParam": "max_results",
      "auth": { "tokenEnv": "API_SEARCH_KEY" }
    },
    "fetch": {
      "urlEnv": "API_FETCH_URL",
      "urlParam": "urls",
      "urlAsArray": true,
      "auth": { "tokenEnv": "API_FETCH_KEY" }
    }
  },
  "fixture": "fixtures/web-discovery.json"
}
```

端点是固定 HTTPS 地址或环境变量引用。配置使用 GET 查询参数或 POST JSON（默认 POST），鉴权支持 header、query、body。默认 header 使用 Bearer；可以指定原始 X-Api-Key 等头。密钥只从指定环境变量读取，不借用模型 API_KEY。`fixedParams` / `paramsFromEnv` 支持服务必需的固定参数。

显式配置 `webApi` 后直接使用 API，模型配置不会改变后端；API 报错或缺少操作时保留错误，不自动换服务。未配置 `webApi` 时保持原有受控原生工具 → 配置的远程 MCP 路径。旧 `searchMcp: { "type": "api", ... }` 仍可读取，但执行同一条本地 API 路径，Trace 身份改为 `web.api`。旧模块 `web-api-mcp` 仅保留弃用兼容导出，不再实现 MCP 包装。

## Search 怎么实现

1. `web-tools.ts` 定义 `web_search({query, limit})`：query 为 1–500 字符，limit 为 1–10 的整数。模型只能提供业务参数，不能提供 API 端点和凭据。
2. 宿主检查查询包含任务实体名称、别名或产品名，并检查来源授权。API Adapter 再按相同输入 Schema 校验。
3. `WebApiAdapter` 将 query / limit 映射为服务参数，例如 q / num 或 query / max_results，构造 GET 或 POST 请求并注入凭据。
4. 真正 HTTP 请求前再执行 `web.api.http.search` 权限检查；请求禁止自动重定向，响应体最多 2 MB，内部超时 25 秒，同时服从父工具和任务预算。
5. `web-results.ts` 将 results / hits / items 等常见返回归一化，也支持显式 `response.resultsPath` 与字段映射。过滤非许可域名、按 URL 去重、限制条数、摘要最多 2000 字符。
6. 返回 `searchResults`：URL、标题、摘要、抓取时间。发布时间保持未知，不把摘要自动转为已核验事实。

## Fetch 怎么实现

1. `web_fetch({url})` 只接收一个 URL。宿主验证 HTTPS、许可域名、端口与 URL 中的凭据；禁止 IP 字面量和 localhost。
2. Adapter 把目标 URL 传给配置的抓取服务，例如 `{ "url": "..." }` 或 `{ "urls": ["..."] }`。本地宿主请求的是抓取 API 端点，不是直接下载目标网页。
3. HTTP 仍走 `web.api.http.fetch` 权限复查。远端服务负责实际抓取和正文提取，本项目不在此路径维护 HTML/PDF 抽取器。
4. 支持 JSON 中的 markdown / raw_content / text / content 等常见字段，以及 `response.pagePath` / `textField` 显式映射；`response.format=text` 可接收纯文本。
5. 上游返回 URL 时必须与许可输入一致；批量提取返回必须恰好一页。只配置 search 时，fetch 明确报 operation_not_configured，不自动请求其他服务。
6. 返回 `pages`，包含 URL、标题、正文、抓取时间。正文最多 24000 字符并标记 truncated；完整已脱敏上游响应进入快照。

域名检查约束宿主输入与返回材料，不能逐动作拦截远端服务内部的 DNS、重定向或抓取行为。正文仍按不可信外部数据处理。

## 其他部分

- `ToolRegistry` 负责工具 Schema、名称与来源绑定；模型仍调用 `web_search` / `web_fetch`，更换后端无需修改 Agent 工作流。
- `ToolExecutor` 统一 PreToolUse、ActionPolicy、执行阶段、超时、取消和 Trace；本地 API 与 MCP 的协议不同，共享调用治理。
- `web-mcp.ts` 继续负责外部 MCP 连接、发现、Schema 校验与调用。`web-mcp-results.ts` 只解码 MCP 信封，再复用协议无关的 `web-results.ts`。
- `api-tools.ts` 的通用平台 API / GitHub MCP 包装保持现有架构，本次仅调整专用 search / fetch API 路径。
- 成功响应先脱敏；完整 raw 保存在 `retrievals/<hash>.txt`，模型仅接收最多 16000 字符 raw 摘录与快照引用。API 错误、空结果、限流和取消分别保留，不用空结果掩盖失败。
- Trace 标记 `backend=web.api`、`protocol=http`、`transport=direct`。每次调用只有一条逻辑 ExecutionRecord，内部阶段关联同一 requestId。

## 运行与验证

```powershell
npm run test:web-tools
npm run verify
npm start -- run --mode live --task examples/task-web.json --sources examples/sources-web-api.json --out artifacts/live-web-api --timeout 180000 --tool-timeout 45000
```

公开 GitHub 搜索示例及 probe:web-api / probe:api-mcp 命令现已移除。Google / Tavily 仅保留参数映射模板。

固定回归覆盖直接 GET/POST、鉴权与脱敏、结果映射、错误、撤权复查、取消与迟到响应、API/MCP 共用执行器，以及 search → fetch → analyze → review → draft 的合成闭环。

本次验证（2026-10-21）：

- `npm run test:web-tools`：74/74；包含本地 API 与远程 MCP 的同执行器回归。
- `npm run verify`：384/384（contract 277、semantic 30、integration 77），结构检查与 TypeScript 检查通过。沙箱最初阻止本地 HTTP fixture 连接，改在沙箱外运行完整验证后全部通过。
- `npm run probe:web-api`：runId `d341baa2-119e-4acb-995f-acafe72da02d`，公开 GitHub issue 搜索返回 3 条，backend=`web.api`，Trace 无校验问题，汇总为 `artifacts/web-api-probe/latest.json`。
- 真实 Fetch 服务尚未提供凭据；Fetch 的映射、URL 一致性、截断和调查闭环使用固定响应验证。未宣称真实模型已完成这条新增 API 路径的端到端调查。
- Google 示例仅保留既有 Custom Search 参数映射，不承诺新账号可开通该服务。
