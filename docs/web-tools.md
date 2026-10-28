# 本地 Web 工具、原生后端与远程 MCP

## 模型入口与执行路径

当前本地 API 路径及配置迁移见 [web-api.md](web-api.md)。

使用 `examples/sources-web.json` / `examples/task-web.json` 时，模型获得 `web_search({query,limit})`、`web_fetch({url})`、`mcp__github__api_github` 及 workflow 工具（含指南读取；API 使用前须先读 sources/github/guide.md）。新闻 MCP 仅保留为独立协议测试夹具，不进入默认产品来源。

```text
模型发出 web tool call
  → ToolBinding / Schema / 任务来源与参数范围检查
  → ActionPolicy / 必要时审批 / 执行前复查
  → PreferredWebSource
      → 显式 webApi / 旧 searchMcp.type=api：本地 API Adapter 直接执行
      → 未配置 API 时，已配置受控内置 Adapter：先尝试内置
      → 未接入该提供方、被宿主关闭或明确 unsupported：尝试配置的搜索 MCP
      → MCP 未配置、明确 unsupported 或暂不可用：返回明确错误
      → 每个后端请求再次检查有效权限、来源和绑定
  → 统一返回状态、发现结果/页面、后端身份、快照引用
  → Observation → 模型下一轮
```

鉴权失败、限流、策略拒绝、来源撤销、取消、数据不可核验都不会被“回退”掩盖。内置只返回最终文字而没有工具事件时返回 parse_failed，不能伪装为采集成功。没有自动重试副作用。

## 同一权限和 Trace

本地 API、内置和 MCP 都通过 `ToolExecutor`，持有同一个 requestId/taskId/runId/ToolBinding/参数哈希。每个后端阶段经 `ToolExecutionContext.stage`：`backend_policy → backend_started → backend_finished`；路由记录为 `web_route`，厂商可见事件和 MCP 调用元数据为 `provider_tool_event`。所有事件关联父 requestId，执行记录仍表示一次模型发起的逻辑工具调用，后端尝试数由 stageId 单独计数。MCP 连接和工具发现是控制阶段，也记录权限和状态；不是计费搜索次数。

Trace 保存：所选后端、优先/回退原因、实际查询或 URL（厂商返回时）、结果、错误、用量和原始快照引用。密钥留在请求 header 和宿主环境；不进入模型上下文。完整已脱敏响应先保存到 `retrievals/<hash>.txt`，模型只收到最多 16000 字符 raw 摘录、分页正文上限和明确截断标记，避免网页原始 HTML 直接挤爆上下文。证据可引用并验证完整快照哈希。

## 内置能力与限制

已实现 **Anthropic 原生 Messages API** 的受控 web_search/web_fetch Adapter：每次独立子请求只提供一个工具，`max_uses=1`，传入允许域名，fetch 仅给一个已批准 URL，禁用其他工具与完整 Agent 历史。读取原始 `server_tool_use` 与对应结果，检查数量、ID、实际参数与许可输入，保存事件和 usage。无事件、额外调用、输入不一致、结果越域或 pause_turn 均拒收，不把解释文本当证据。

宿主可以在这个**独立请求之前**授权搜索/抓取范围，但无法在厂商服务器内部动作开始前再插入本地 Hook。厂商内部查询只能按其公开事件事后核对；不承诺操作系统级或远端服务内部的逐动作拦截。内置和 MCP 的远端内部子动作都无法由宿主逐个插入前置 Hook，只能控制公开的请求级范围。发现违约只能拒绝结果、留审计，不能声称远端请求已回滚。

`WEB_NATIVE_PROVIDER=auto` 仅自动识别原生 Anthropic 配置（MODEL_PROVIDER=anthropic 且 BASE_URL 为空）。当前 StepFun Chat Completions 接口尚无已接入并验证的受控内置 Adapter，因此进入通用搜索 MCP 配置；MCP 与模型厂商独立。官方 Realtime 文档的 web_search 也不能直接证明当前 Chat Completions 接口支持相同协议。

可选内置配置可在本机 .env 添加：

```dotenv
WEB_NATIVE_PROVIDER=anthropic
WEB_NATIVE_API_KEY=
WEB_NATIVE_MODEL=
WEB_NATIVE_BASE_URL=https://api.anthropic.com/v1
```

原生内置 Adapter 已通过固定协议响应验证，**没有真实 Anthropic 凭据，尚未运行真实厂商请求**。是否支持具体模型、账户和服务端工具取决于真实接口；明确 unsupported 才允许回退。内置搜索可能单独计费，不能理解为免费附送。

## 通用搜索 MCP：URL + token

本节描述远程 MCP。普通搜索/抓取 API 推荐使用 `webApi: { search, fetch }`，通过本地工具直接执行 HTTP，共用权限和 Trace；见 [web-api.md](web-api.md)。旧 `searchMcp.type=api` 保持配置兼容，但不再创建 MCP Client/Server。两种入口由用户选择，不串成失败保底链。

`examples/sources-web.json` 的 web 来源使用：

```json
"searchMcp": {}
```

它从本机 .env 读取两个变量，更换服务无需修改 TypeScript 或填写 provider：

```dotenv
SEARCH_MCP_URL=https://your-search-service.example/mcp
SEARCH_MCP_TOKEN=your-token
```

默认鉴权是 Authorization: Bearer token；公开服务可留空 token。模型 API_KEY 不再被隐式借用；切换模型不会切换搜索凭证。现有本机服务已一次性迁移到这两个变量，保留原模型配置且不提交 .env。空 URL 或移除 searchMcp 时仅使用已接入的内置能力；没有可用内置时返回 web_backend_unavailable。

默认先连接 Streamable HTTP；仅初始连接明确返回 404/405 时尝试旧版 SSE，不把鉴权/限流失败当作协议切换依据。SSE 公布的消息 POST 地址必须同 origin，自动跳转禁止，token 不跟随跨域地址。也可设置 transport 为 streamable-http 或 sse。

`packages/shared/src/sources/web-mcp.ts:RemoteSearchMcp` 负责连接 → 分页 tools/list → 匹配能力与参数 → 按远端 Schema 校验 → tools/call。自动识别常见 search/web_search/带前缀 search，以及 fetch/scrape/extract/read_url；query/q/search_query、limit/n/count/numResults/max_results、url/uri/urls 等字段自动转译，只给一个许可查询或 URL。声明修改/破坏性的工具不自动选取。发现最多 5 页、256 工具，重复名字和循环游标拒绝。

`packages/shared/src/sources/web-mcp-results.ts` 将 structuredContent、文本 JSON、常见 Markdown 链接/URL 列表和 MCP resource 块归一化；支持 results/hits/items/web.results、data 包裹、markdown/raw_content/text/content 等常见格式。Fetch 额外支持 page 包裹（如 StepSearch 的 code=0、page.markdown），失败 code、空正文、多个页面或返回 URL 不匹配仍拒收。搜索结果按允许域名过滤、去重、限量，时间保持未知，正常空结果不额外降级。fetch 返回 URL 时必须匹配许可 URL；纯文本结果按调用 URL 关联，属于可信度待核验的发现材料。JSON Schema 2020-12 与显式 draft-7 已支持，format 为注解，URL 范围另行强制检查。

MCP 只统一工具协议，并不统一业务 Schema。**常见搜索 MCP 只填 URL/token 即可；多工具歧义、未知必填参数或不明结果会明确报错，不猜值或伪装成功。** 多候选可在配置中指定名字：

```json
"searchMcp": {
  "tools": { "search": "vendor_web_search", "fetch": "vendor_fetch" }
}
```

服务使用特殊鉴权头时可配置 authHeader/authScheme；凭据仍只来自环境变量。例如：

```json
"searchMcp": {
  "urlEnv": "SEARCH_MCP_URL",
  "tokenEnv": "SEARCH_MCP_TOKEN",
  "authHeader": "X-Api-Key",
  "authScheme": "raw"
}
```

URL 可直接写入配置，默认 Bearer；端点必须 HTTPS，不嵌入账号密码或 token/key 查询参数。使用收费服务的额度按该服务规则消耗，本适配层不提供免费搜索承诺。

MCP 缺少操作、方法不支持、5xx、连接失败、超时、401/403、429、解析、Schema、策略拒绝与取消都明确保留错误，不再调用任何自建联网后端。远程 searchMcp.requestTimeoutMs 可显式配置 HTTP 请求及 tools/call 超时，范围 1000–120000 毫秒，未配置仍为 30000；连接与工具发现最多 min(30000, requestTimeoutMs)。provider_tool_event 记录本次工具请求上限，不包含凭据。这不是整个工具的额外时长：父工具/运行预算与取消始终优先；例如 requestTimeoutMs=60000 配合父工具 45000 时，整个操作仍在父级 45 秒限额内。普通 CLI 可用 --tool-timeout 调整父限额。总体预算先耗尽时结束，不重试或切换服务保底。允许域名校验搜索候选与 fetch 输入/返回 URL，宿主无法插入远端内部抓取、DNS 或跳转的 Hook。

竞品验收的三个来源已显式配置 `"searchMcp": { "requestTimeoutMs": 60000 }`，继续从相同环境变量读取原服务地址与凭据，未改变许可域名。实际服务约 30 秒返回 page.markdown；旧 30 秒限额会提前中止。独立复验命令 `node --use-env-proxy --experimental-transform-types scripts/probe-competitor-fetch.ts --out artifacts/competitor-fetch-probe --tool-timeout 45000`，默认只抓三个配置的首个起始 URL，经原 ToolExecutor、权限与 Trace；--all-urls 显式逐一验证其余配置起点。探针只检查正文可用性，不调用规划模型或产出竞品事实报告。

依据：[MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

## API Key 不会自动启用联网

是否可用需要同时满足模型、API 端点、账户权限、请求工具声明和本项目 Adapter 已接入。OpenAI Responses 需声明 web_search；其部分模型的搜索工具有 open_page/find_in_page 动作，不能泛化成所有模型都有独立 fetch。Claude 的 web_search/web_fetch 分别声明；Gemini 的 Google Search 与 URL Context 也为不同工具。本项目内置路径只接入前述 Anthropic 原生协议，MCP 路径通用且独立于模型；不从厂商文档推导本项目已实现其他原生能力。

依据：[OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Claude Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)、[Claude Web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)、[Gemini Google Search](https://ai.google.dev/gemini-api/docs/google-search)、[Gemini URL Context](https://ai.google.dev/gemini-api/docs/url-context)。

## 移除自建联网保底

RSS/Atom、Brave 搜索和本地 HTTP 页面抓取已从通用 web 路由删除，feeds/searchBackend 与 BRAVE_SEARCH_API_KEY 不再是支持配置。旧来源配置携带已删除字段会被严格 Schema 拒绝，避免误以为仍生效。

SearchHit/Page 仍是发现材料，不自动生成事实；分析保留 discovery_only 缺口。旧 official_web 采集工具已删除；结构化解析函数仅供浏览器采集使用，GitHub Releases API 保留结构化映射。默认演示使用明确标记的预构造结构化快照，通用 Web 在真实运行中返回的 SearchHit/Page 不自动升级为事实。

## 官方入口发现与有界覆盖

SourceServerBuilder 现在把 web 来源原配置的 urls 与 allowedDomains 传入工具说明，模型可直接看到已知起始入口，无需搜索猜测或读取本地配置。披露前校验起始 URL 属于原许可域名；这些只是发现提示，既不扩大权限，也不把 URL 列表当作已发布事实或全站清单。网络仍由原 web_fetch 路由执行，URL 与凭据由既有宿主边界控制。

内置调查 Skill 要求将参考入口记入计划的 evidenceRequirements，queries 记录有界的官方站点/文档/精确仓库 site: 查询。即使搜索为空，仍可显式调用已配置入口；失败保留缺口，不偷偷换服务或扩大白名单。一个共享域名（例如 github.com）不能证明命中了特定官方仓库。

summarizeDiscovery 分开统计上游返回次数、越域过滤次数、去重候选、精确参考 URL 搜索命中、抓取正文可用入口和实际 structured signals。未知计数为 null，不写成零。候选跨查询去重；去掉片段与尾斜杠，只对 GitHub owner/repo 忽略大小写，保留其他路径、tag 和 query 的差别。失败、越域或返回 URL 不符不填补正文覆盖；候选与正文不自动升为信号。referenceTextAvailability 只是已列入口文本是否可用，仍需核对实体、错误页、截断及正文完整性，不能冒充全站或事件召回率。

examples/competitor-acceptance/discovery-queries.json 固定每产品三次查询、每次 limit=10；scripts/probe-competitor-discovery.ts 使用三个原有起始 URL 为分母，经原执行器与 MCP 独立保存搜索及抓取结果。结构化 GitHub 采集另用 probe-competitor-github.ts，不和页面数合并计为事实。2026-10-24 的具体结果及残余召回缺口见 [官方来源发现验收](p1-discovery-acceptance-2026-10-24.md)。

## 历史执行记录（迁移前）

- `npm run verify`：109/109 通过（contract 67，semantic 18，integration 24）。删除不再适用的自建后端用例，改为验证两层失败后零直连、明确错误、过时配置拒绝；保留完整权限、Trace、MCP 兼容性和 Agent 闭环。
- `npm run probe:web`：runId bed89f9e-e310-4198-87c9-b6283e99bb58；真实 search 返回 1 个允许域名候选，fetch 明确返回 unavailable:search_mcp_request_timeout、0 页，两者 backend=mcp.remote，Trace 无校验问题且无 local 后端。因实际抓取不可用，探测命令正确退出 1。汇总在 artifacts/web-probe/latest.json，完整 Trace/原始产物仅留本机且被忽略。
- 既有服务的真实连接/发现/搜索已验证。Exa/Tavily 类字段和旧版 SSE 使用协议桩验证，未调用其真实账户；MCP fetch 成功响应仍只有固定协议验证。通用解析不等于所有厂商都已经实测。
- 111/97/82 项属于历史阶段，曾出现的 local.http 成功记录不代表当前仍存在该保底。

```powershell
npm run probe:web
npm run web:live
```

web:live 使用真实规划模型；本次只独立验证了真实采集工具和固定完整 Agent 回归，未声称真实模型已完成该新增联网配置的端到端调查。

官方协议依据：[Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)、[web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)。本次仅参考公开工具协议，不复用网页中的指令。
