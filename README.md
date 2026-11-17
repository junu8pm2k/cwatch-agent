# Cwatch

Issue 流程测试：本仓库已可通过 GitHub Issue 跟进任务。

2026-10-29：GitHub API 接入已移除并停用，默认来源只使用官网与网页工具。eval case 及其归档已随后清空；详见 [停用说明](docs/github-api-disabled.md)。

当前自带工具的完整清单、用途和清理记录见 [工具清单](docs/tools.md)。

工具注册按实际类型命名：原生工具保留原名，本地工作流使用 `workflow__<tool>`，会话与宿主工具使用 `session__<tool>`，直接调用的来源使用 `<slug>__<tool>`；只有 MCP 工具及经过 MCP 包装的 API 工具使用 `mcp__<slug>__<tool>`。宿主按完整名称查内存绑定再分发，原始工具名不变；命名与迁移见 [工具注册说明](docs/tool-registration.md)。

Cwatch 默认提供「通用 Agent + Skill」：输入任务 → 加载所选 Skill → 模型选择工具 → 宿主权限检查与执行 → 结果回填 → 保存回答。原竞品调查保留为可选业务模板，继续验证计划、实体归因、证据、审阅和引用草稿。架构参考 Craft Agents，参考仓库和历史材料均未改动。运行方法、实现分层与调用图见 [通用 Agent](docs/generic-agent.md)。

真实通用 Agent 支持同一会话连续追问：工作台答复后可继续发送消息或结束会话，刷新浏览器仍沿用原会话；CLI 使用 `npm start -- run --mode live --chat --instruction "初始问题"`，输入 `/exit` 结束。Transcript、Session Memory 和压缩状态随会话持续保留；服务重启后明确标记中断，尚不自动恢复执行。详见 [多轮会话](docs/conversations.md)。

后端的进程边界、模块职责、当前能力与缺口见 [后端现状说明](docs/backend-overview.md)。

## 项目结构

按 Craft 的职责拆分为 npm workspaces：apps/cli 是入口，packages/core 保存契约，packages/shared 保存 Agent/来源/MCP/Skill/会话能力，packages/server-core 承载共享任务 Runtime 与可选调查模板。目录树、依赖图和文件迁移索引见 [项目结构](docs/project-structure.md)。现有 npm start、demo、verify、scripts/eval.ts 入口保留。

## 安装与首次演示

使用 Node.js **24.5+**（本次实测 24.21.0）和 npm。使用 Node 自带 TypeScript 转换，无需构建或 tsx；出现 ExperimentalWarning 是运行时提示。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run demo:agent
npm run demo
```

`demo:agent` 使用固定脚本读取 README 并保存回答；`demo` 保留原调查演示，模型决策来自 `fixtures/model-script.json`，两个来源来自固定合成快照。正常输出两条事件、三份证据、两条主张及草稿路径。二者均为 **replay 测试模式**，验证工程与固定用例，不证明真实模型生成质量或现实市场事实。

输出目录 `artifacts/demo/`：`plans/`、`facts/events.json`、`facts/versions.json`、`evidence/index.json`、`evidence/snapshots/`、`claims/`、`reviews/`、`reports/`、`executions/`、`traces/`、`states/` 和 `runs/`。Pi 真实会话另存 `sessions/<runId>.jsonl` 完整脱敏转录。重复运行同目录会比较之前保存的事实。换一个 `--out` 可得到全新历史。

运行结束自动输出结构化 Trace：`traces/<runId>.json`，包含任务输入、最终输出、模型/工具/后端步骤、调用关联、耗时、用量、权限和错误；原始审计事件保存在同名 `.jsonl`。CLI 的 `trace` 字段指向结构化文件，`traceEvents` 指向审计日志。字段、历史转换及接口见 [结构化 Trace](docs/structured-trace.md)。

## Web 操作界面

运行 npm run web，打开终端打印的本地地址（默认从 http://127.0.0.1:4310 开始，端口占用时自动顺延）。默认进入通用任务，也可切换调查模板；支持离线演示、真实执行、实时事件、审批、取消、历史记录和结果下载。真实模式沿用本机 .env。网页由 RunService 管理任务，实际工具仍经主进程门禁与 Trace。使用方法、接口和验证范围见 [Web 工作台](docs/web-workbench.md)。

~~~powershell
npm run web
npm run verify:web
~~~

## 用户 MCP 与 Skill

支持在项目中添加远程 Streamable HTTP（兼容旧版 SSE）或本地 stdio MCP，以及从本地目录/GitHub 安装 Skill。配置和安装副本位于忽略 Git 的 `.cwatch/`；实际调用仍经主进程权限门禁和 Trace。

项目 Skill 使用标准目录入口：通用任务为 `skills/general-agent/SKILL.md`，调查流程为 `skills/competitor-investigation/SKILL.md`；示例为 `examples/skills/research-brief/` 与 `examples/skills/competitor-review/`。每份入口都包含 name、带适用与排除条件的 description，以及正文流程和输出要求。加载与安装边界见 [用户扩展](docs/user-extensions.md)。

```powershell
npm start -- mcp add custom --config examples/mcp-custom.json
npm start -- mcp test custom
npm start -- skills install examples/skills/competitor-review
npm start -- run --mode live --task examples/task-custom.json --mcp custom --skills competitor-review --timeout 180000 --tool-timeout 45000
```

该示例 MCP 返回明确的 fixture 数据。自定义服务默认工具语义为 modify，按实际只读/写入能力配置 toolSemantics；Skill 安装不执行脚本，按 `--skills` 选择使用。配置、GitHub 安装、密钥引用、启停和资源读取详见 [用户扩展指南](docs/user-extensions.md)。

## 真实模式

复制 `.env.example` 为 `.env`，填写 `MODEL_PROVIDER`、`MODEL_ID`、`API_KEY` 和 `BASE_URL`。`BASE_URL` 是 OpenAI 兼容 Chat Completions 接口的 API 根地址（例如实际服务的 `/v1`），不包含 `/chat/completions`；支持自定义提供方和未收录在 SDK 目录中的模型名。密钥只注入 SDK 的内存认证，不填入任务、来源 JSON、模型上下文或 Trace。

CLI 与 `probe:model` 共用 `packages/shared/src/config/models.ts`，不再使用单独的 `ANTHROPIC_API_KEY` 配置。若使用 SDK 已收录模型的原生接口，可将 `BASE_URL` 留空并仍通过 `API_KEY` 配置认证。已有 Shell 环境变量优先于 .env。自定义接口的 SDK 上下文配置为本地保守默认值，不代表官方模型容量；定价未知时只保留提供方返回的 token 用量，不报告零费用。

```powershell
npm run probe:model
npm run probe:sources
npm start -- run --mode live --task examples/task.json --sources examples/sources.json --out artifacts/live
```

真实调查使用 Pi SDK 的 `AgentSession`：SDK 管理连续对话、模型请求、工具调度和工具结果回填；注册的每个业务工具都经现有 `ToolExecutor` 校验权限、审批并记录 Trace。项目 Runtime 管理业务阶段、预算和落盘，ReplayModel 保留确定性测试驱动。Pi SDK 的 read/write/edit/bash/grep/find/ls 已通过宿主执行器显式接入，按当前权限模式披露；仅关闭未经包装的 SDK 自动注册、全局扩展和目录资源发现。实现与权限见 [Pi 内建工具](docs/pi-builtins.md)。工具调用按 Craft 风格组织为 wrapToolsWithHooks、runPreToolUseChecks 和 pre_tool_use_response；Pi AgentSession 在独立 Agent 子进程运行，主进程通过 Node IPC 接收工具意图并裁决，放行后收到对应执行请求才调用工具，每次只审批一次。子进程崩溃或断线时，主进程取消待审批/执行中的调用、保存状态并回收子进程；不自动重放工具。详见 [工具调用结构](docs/tool-call-pipeline.md) 与 [SDK 接口映射](docs/sdk-adapter-map.md)。模型每轮可返回一个或多个工具调用，宿主按返回顺序逐项授权并串行执行，所有结果回填后再进入下一轮。普通任务直接保存最终回答；调查模板要求实际生成计划与草稿说明，并在 `workflow__draft` 保存成功后才允许完成。上限默认 24 轮、20 个工具、120 秒、单工具 15 秒、上下文 150000 **字符**。超限明确报错；已支持单次输出和累计 Token 预算，累计值依赖提供方 usage，不是硬计费上限。完整限额见 [运行限制](docs/run-limits.md)，不宣称缓存收益。

`npm start`、来源/模型探测启用 Node 环境代理支持，遵循系统 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`。本机 Codex 沙箱默认禁止网络；真实公开来源和本地 HTTP 模型协议测试需要运行环境允许网络/回环访问，不能将沙箱拒绝误报成实现通过。

官网读取现统一使用 web_search / web_fetch，真实运行需配置 Web API 或受支持的后端。通用平台 API 经过实际 MCP 包装；每个来源只提供一个通用 API 工具，模型先经 session__read_source_guide 读取指南，宿主再校验 path/method/params 和权限。只读浏览器、API MCP 与真实 Pi 子进程的本机集成已使用合成页面验证。新闻 MCP 固定数据已移到独立测试夹具，不再作为产品来源。历史真实调查曾生成保留来源缺口的 partial 草稿，详见 [历史验收记录](docs/acceptance-report.md)；不据此声称全部真实来源已完成验收。

## 任务与来源

联网配置可运行 `npm run probe:web`（独立工具连通）或 `npm run web:live`（真实模型调查）。模型使用 `web_search` / `web_fetch`，显式配置 `webApi` 时由本地工具直接调用 REST API；未配置时保留 **受控模型内置工具 → 配置的搜索 MCP** 路径。各阶段均经权限复查并关联同一 Trace。`examples/sources-web.json` 的 `searchMcp: {}` 从本机 .env 读取通用 URL/token，无厂商枚举或固定服务地址；更换模型和搜索服务互不影响：

```dotenv
SEARCH_MCP_URL=https://your-search-service.example/mcp
SEARCH_MCP_TOKEN=your-token
```

自动发现工具并识别常见 search/fetch 名称、参数别名、JSON/Markdown/文本结果；支持 Streamable HTTP，并在连接明确返回 404/405 时尝试旧版 SSE。多工具歧义可显式指定工具名，非标准 Schema 或不明结果明确报错；MCP 标准不保证所有服务业务参数一致。无需 token 的服务可留空。既有本机服务已迁移到这两个变量，运行时不再自动借用模型 API_KEY。MCP 不可用、缺少能力或请求超时均明确返回错误，不再直连网页或调用其他搜索 API；其他服务格式使用协议桩验证，未宣称全部厂商实测。

自建 RSS/Brave 搜索和 HTTP fetch 保底已移除；Anthropic 内置协议尚无真实凭据验证，StepFun 模型原生内置联网尚未接入。`web:live` 单工具预算为 45 秒，普通 CLI 默认 15 秒，可用 `--tool-timeout` 调整。配置与限制见 [web-tools.md](docs/web-tools.md)。

普通 REST 搜索/抓取 API 使用独立的 `webApi: { search, fetch }` 配置：宿主自建工具直接调用配置端点，不再创建进程内 MCP Client/Server。它们与外部 MCP 共用 ToolRegistry、PreToolUse、ToolExecutor、Observation 与 Trace。支持 GET/POST、header/query/body 鉴权和结果字段映射；搜索与抓取可分别用不同厂商，密钥只放本机 .env。旧 `searchMcp.type=api` 仍兼容，但也执行本地 API 路径，backend 为 `web.api`。模板见 `examples/sources-web-api.json`，实现与调用链见 [本地 Search / Fetch](docs/web-api.md)。`npm run test:web-tools` 为专用回归入口。

修改 `examples/task.json`：任务 ID、稳定竞品 ID、名称/域名、产品、信号类型、带时区的 `[start,end)` 窗口、时间依据、IANA 时区、允许来源及 `outputScope: draft`。缺实体、时间、时区时返回 `needs_clarification`，不猜测。未知/未激活来源写入报告缺口。

来源配置由操作者管理：

| kind | 通道 | 支持能力 |
|---|---|---|
| browser | 内建只读浏览器 | 配置 URL 的 JavaScript 渲染、匿名文本/HTML 采集；HTTP 请求由宿主中介并拒绝重定向 |
| api | 平台 API 包装 MCP | guide.md + 每来源一个通用 API 工具；固定 origin、动态请求权限、环境变量鉴权与 MCP 门禁 |
| mcp | MCP stdio 连接池 | 真实 tools/list、tools/call；操作者声明每个原名的业务语义，未声明拒绝 |
| web | 本地统一 Web 工具 | web_search / web_fetch；配置的直接 API、受控原生后端或远程 MCP |

所有任务均受可信来源配置的域名、URL 或仓库范围限制；调查模板额外要求实体、产品映射与待调查对象对应。JSON-LD 只支持明确的字段，其他站点需添加解析器，不声称通用网页理解。MCP 服务命令来自可信配置，使用受限继承环境、argv 和超时，无 Shell；这是启动 MCP 协议服务，不是把任意 CLI 配置为 MCP。

`ToolBinding` 保存来源、原名、代理名、Schema、后端映射和修订。净化冲突直接拒绝；更新使旧绑定失效；撤销移除工具并关闭连接。官网/浏览器走 builtin，平台 API 统一经过 MCP。没有外部 HTTP 池端点、Shell 工具或其他模型后端旁路。

## 权限、审批、取消和恢复

使用 --permission 选择三种宿主模式，默认 explore；与 --mode live/replay 相互独立：

| 模式 | 采集、分析、本地计划/草稿 | 修改、发送、发布 |
|---|---|---|
| explore | 允许 | 拒绝 |
| ask | 允许 | 逐次人工审批 |
| allow-all | 允许 | 直接执行 |

例如 npm start -- run --mode replay --permission allow-all。旧 safe 参数兼容为 explore，新 Trace 使用规范模式名。模式同时决定模型可见工具：explore 隐藏仅有外部写入能力的工具，通用 API 入口仍可读取，写请求逐次硬拦截；每轮刷新当前模式、来源状态和 system prompt。执行层仍独立检查工具绑定、Schema、任务范围及来源状态，保留取消、预算、快照和 Trace。当前示例只包含采集与本地草稿，正常运行不会弹审批。详见 [permissions.md](docs/permissions.md)。

审批显示 requestId、任务、工具、脱敏参数、哈希和期限。交互终端输入完整 requestId 才批准那次调用；非交互环境无审批人即拒绝。代码在批准后重新核对当前宿主策略和绑定。只有 CLI 的 --permission 或宿主 setMode 能切换权限；模型参数中传入 allow-all、网页注入和旧权限都不能覆盖宿主模式。来源服务声明的工具语义必须经过操作者审查；这不是操作系统或网络沙箱。

Ctrl+C 传递取消到模型、审批、工具和网络。审批等待被清理，后续批准无效；正在执行的外发结果无法确认时保留 `unknown`，不会声称回滚。迟到结果不能把取消任务改成成功。

```powershell
npm start -- inspect --out artifacts/demo
npm start -- replay --out artifacts/demo --run <runId>
npm start -- trace --out artifacts/demo --run <runId>
npm start -- recover --out artifacts/demo
```

inspect 查询持久化 ExecutionRecord；replay 从 append-only Trace 重建 AgentState，不重放工具。recover 将中断的执行/运行标记 unknown，不自动恢复对话或重试副作用。CLI 每输出目录单写者 `.lock`；进程异常退出留下锁时，先确认该目录没有活动进程，再手工删除这个**单个锁文件**后 recover。库调用者必须每运行使用独立 registry，避免并行覆盖 workflow 来源。

文件存储使用原子替换，事实、版本、证据、执行记录分开保存；不宣称跨文件事务、机器断电零丢失、多进程数据库能力或完整工作流引擎。

## 证据与审阅

主张链：Claim → Event → FactVersion → Evidence → URL / 发布时间 / 采集时间 / 原始快照。稳定事件键合并官网/转载，证据各自保留；变化追加版本。仅名称相同无法归因；未知时点不替代为采集时间；失败和空结果不能推断“竞品没有动态”。

Reviewer 是只接收数据快照的纯函数，检查实体、时间、事件版本、证据、反向证据；Runtime 另查原始快照存在和哈希。接受、补证、否决分别保存。它不拥有执行器、外发或写入接口。模型生成的自由说明始终标为“待人工核对”；Reviewer 接受只覆盖结构化主张，不构成对自由文本的语义真实性保证。

## 后端能力对齐与来源适配

浏览器、API MCP、MCP 池、模式工具面、每轮 ContextPipeline 和 Trace v2 的实现/验收边界见 [简历与后端对齐](docs/resume-backend-alignment.md)。这不代表已有实时监控或真实模型质量黄金集。

~~~powershell
npm run demo:adapters
npm run verify:browser
~~~

## 运行限制

支持上下文/响应长度、单次及累计 Token、同一工具/总工具调用次数，以及调查/模型/工具三层超时；超限停止并记入 Trace。所有 CLI 参数、默认值及 Token 计量边界见 [运行限制](docs/run-limits.md)。

Pi 会话将完整转录与活动上下文分开：历史消息、请求与压缩边界追加保存到 `sessions/<runId>.jsonl`；接近字符或模型窗口预算时生成摘要，后续请求使用初始任务、最近摘要、保留的完整工具轮次与边界后的新消息。窗口压力结合提供方 usage（含缓存用量）及新增消息估算，并预留输出空间；摘要同样计入 Token 和超时预算。压缩不删除转录，无法缩小或摘要失败时明确停止。恢复仍是业务审计，不自动继续执行。详见 [会话上下文机制](docs/session-context.md)。

正式摘要前先治理工具结果：单条活动结果默认最多 16000 字符（随上下文预算收紧），长内容保留首尾与归档引用；窗口仍紧张时，将旧成功只读结果替换为短占位，保留最近两条结果及普通 assistant 消息。模型可用 `session__read_tool_result` 按本次运行的消息身份分页重读原文；不重放原工具，完整转录和业务证据不删除。轻量治理释放足够空间时跳过摘要请求。

正式压缩按完整 API 轮次保留消息，优先最近两轮、预算不足时保留一整轮，绝不从工具调用与结果之间切开。重建顺序为摘要 → 保留消息（含初始任务）→ 当前 workflow 状态附件 → 显式配置的 hook 结果。摘要必须包含目标、已完成工作、关键文件、错误与修复、未完成任务、下一步及引用/缺口；所有部分校验并完成逻辑提交后才供模型使用，未完整落盘的压缩边界不会生效。

压缩后还会重新注入已核验的调查计划和阶段、来源采集进度、最近成功读取的指南/Skill/归档资源片段与重读入口、已加载 Skill、当前工具绑定目录、Pi 进程及本次运行未决执行。`workflow__read_plan` 可分页重读已提交计划；资源变更不会自动解除指南前置检查，未决副作用不自动重放。当前没有通用代码读取、Plan Mode、延迟工具加载或异步子 Agent，这些能力在附件中按实际支持情况标明。

每份正式摘要由宿主加入完整转录路径、会话身份和固定条目锚点。模型可用 `session__read_transcript` 分页、按条目或字面搜索核对压缩前的用户消息、assistant 原文、错误和工具记录。读取仅限本次会话已脱敏且完整性校验通过的转录，不重放历史操作；固定锚点避免读取回执使分页不断增长。摘要用于续办，转录用于证明细节。

Live 会话还默认维护独立的 `session-memory/<runId>.json`：窗口达到 12000 Token 后初始化，此后累计窗口增长 4000 Token 或新增六次工具调用时，以“上次 memory + 新增完整消息轮次”更新当前状态，记录版本和最后处理的消息 ID。维护使用无工具的隔离模型请求，计入 Token/超时预算；`session__read_session_memory` 可读取最新检查点，压缩后也会重新注入。Memory 允许滞后，不替代完整转录或当前宿主状态。程序接口可调整阈值或关闭，未实现并发 fork Agent 调度；详见 [会话上下文机制](docs/session-context.md)。

供应商明确拒绝输入超长时，还会尝试反应式压缩后继续原模型请求：失败回执保留在转录，重试前刷新预算、权限和绑定，已完成工具不自动重放。每个连续拒绝事件最多重试一次，单运行最多两次恢复；再次拒绝、无法缩小或摘要失败时熔断停止。鉴权、限流、普通参数错误和部分输出不进入这条恢复路径。

稳定规则、Skill 和任务字典位于提示前缀，工具定义确定排序，首轮与续轮保留相同 SDK 静态后缀。业务请求的短期缓存控制由 SDK 按供应商能力映射，程序接口可设 promptCache:none；Trace 分别记录前缀/工具指纹和供应商归一化的缓存读/创建用量，不把指纹相同或缓存零值当作命中证明。缓存只处理重复输入复用，不能替代 Session Memory、完整转录或 Compact；命中 tokens 仍完整纳入窗口与预算，不宣称未知端点的缓存收益。

## 测试与五条主线演示

```powershell
npm run verify
npm run eval
```

测试用例统一命名为 `tests/*.test.ts`，`harness.ts` 等辅助文件和夹具保持原名；仍由 `scripts/eval.ts` 显式导入运行。

2026-10-29：所有内置 eval case、题单、材料、候选、历史副本和对应评测归档已清理，当前内置 Case 为 0。普通工程测试与通用评测框架保留；Case 执行/审核需显式提供 `--dataset`，覆盖清单需显式提供 `--index`。说明见 [评测状态](docs/evaluation.md)。

评测维度统一为 Outcome（结果）、Trajectory（过程）、Evidence（证据）、Safety（安全）、Cost（成本）；结果、证据、安全为 P0，过程、成本为 P1。体验要求归入结果和交互过程。定义见 [五类评测维度](docs/evaluation-dimensions.md)。

评分器分工固定为：结果/证据=代码+Rubric，过程=Rubric+人工，安全=代码+人工，成本=代码。Rubric 指参考结构化量表的 LLM-as-a-Judge，人工不再对结果和证据打分，代码只记录过程事实。

三类评分已提供独立入口：`eval:score` 汇总规则、LLM 与人工结果，`eval:judge` 使用专用模型配置评分，`eval:human` 创建/提交逐次运行的人工评分。指定评委逐项判定后统一按 100 分负分制计算，P0 硬失败不能被其他分数抵消，缺失评分保留待复核，原证据与报告不改写。配置、量表与命令见 [三类评分器](docs/quality-grading.md)。

原四类场景题库及自动生成脚本已删除，`eval:scenarios` / `eval:scenarios:model` 不再提供。

统一负分制：100 分起、80 分达标，结果不符扣 100；过程由 Rubric 与人工确认，步骤遵循性、中间输出、工具/知识库调用各按不符步骤/项扣 10；分析耗时超过 5 分钟后每开始 1 分钟扣 10。所有计划 Trial 全部达标才取平均，否则用例分为 0。建议显式提供题单并运行 `--repeat 5`，逐次完成评委记录后用 `eval:score` 汇总；原始 Case 命令不再接受 `--score-gate`。报告保留 pass@k、pass^k 和类型容忍度。原必过项与人工审核状态单列，见 [负分制与稳定性](docs/penalty-scoring.md)。

`verify` 一条命令执行项目结构、TypeScript、工程及评测流水线离线检查。工程结果写入 `artifacts/eval/latest.json` 与 `latest.md`，任何失败退出非零。GitHub Actions 在每次 push 和 PR 时运行工程检查、浏览器检查和真实 Agent 自动回归三条独立任务，使用 Ubuntu runner 与 Node 24 / Debian 容器。自动回归集见 [正式清单](evals/regression/suite.json)，每例五次、全部 100 分及代码/Rubric 全通过才通过，本轮不创建人工待办。远程需要配置 `EVAL_API_KEY`、`JUDGE_API_KEY`；本次未触发远程 CI。

1. 来源 Hub：运行 demo，查看 Trace 中唯一 binding、original_name、builtin/mcp/workflow 三类 channel；实际本地 MCP 协议测试及 probe:sources 独立验证。
2. 执行门禁：eval 的权限/审批用例逐项断言真实执行次数；拒绝为零。
3. Context：查看落盘计划、plan-submissions.jsonl、调查 Skill；eval 覆盖缺口、预算、文件/回调失败。
4. Runtime：inspect、replay、recover 与取消/迟到/重启用例；查看独立执行账本与历史版本。
5. Eval：contract、semantic、integration 分组输出。Pi SDK 还通过本地 HTTP/SSE 固定提供方跑完整循环，与 ReplayModel 的决策逐步一致；它是协议测试，不能替代真实模型质量评测。

更多定位见 `docs/architecture.md`、`docs/resume-implementation-map.md`、`docs/implementation-gap.md`。原简历与历史审计不改写、不将本次开发冒充历史参与或生产效果。

依赖审计已修复 MCP/Ajv 直接依赖问题；锁定 Pi SDK 自带 shrinkwrap 中仍有 3 个已知受影响包，详见 `docs/dependency-review.md`。工程回归通过不等于依赖安全或生产发布放行。

常见故障：未配置 provider → 填写 .env；fetch failed → 核对代理与网络权限；rate_limited → 保留来源缺口，不自动重试；parse_failed → 保留原始内容并补站点解析器；context_budget_exceeded → 收窄任务；tool collision → 修正来源命名。不要把这些失败手工改成成功。
