# 用户自定义 MCP 与 Skill

扩展由 CLI 管理，保存在当前项目的 .cwatch/。它不修改 Codex、其他应用或用户全局 Skill/MCP 配置。.cwatch/ 与 .env 均忽略 Git。命令可用 --workspace DIR 指定另一份项目扩展目录；该参数不改变 CLI 的工作目录或 .env 读取位置。

## 从可运行示例开始

在本项目根目录执行：

~~~powershell
npm start -- mcp add custom --config examples/mcp-custom.json
npm start -- mcp test custom
npm start -- skills install examples/skills/competitor-review
npm start -- run --mode live --task examples/task-custom.json --mcp custom --skills competitor-review --timeout 180000 --tool-timeout 45000
~~~

先在本地 .env 中配好现有模型配置。示例 MCP 是真实 stdio 服务，返回明确标记的 fixture 发布信息；这个示例不代表现实竞品情报。mcp test 只初始化和发现工具，不执行 tools/call。

## 配置 MCP

支持 stdio、Streamable HTTP 和旧版 SSE；auto 在 Streamable HTTP 返回 404/405 时协商 SSE，不在鉴权或限流失败时切换服务。

~~~powershell
# 远程 MCP：先在本地 .env 添加自己的 RESEARCH_MCP_TOKEN
npm start -- mcp add research --url "https://your-server.example/mcp" --token-env RESEARCH_MCP_TOKEN

# 使用宿主定义的逐工具规则；模板里的工具原名需要改成服务实际返回的名称
npm start -- mcp add research --config examples/mcp-remote.json

npm start -- mcp list
npm start -- mcp test research
npm start -- mcp disable research
npm start -- mcp enable research
npm start -- mcp remove research
~~~

上面两条 add 是同一服务器的两种配置方法，选择一种即可；已有名称不会被覆盖。需要更换配置时先 remove 再 add，或在停止运行后编辑 .cwatch/mcp.json。可用 mcp test 查看服务的工具原名和输入 Schema。

**未分类工具默认是 modify。** explore 会拒绝其调用，ask 逐次审批，allow-all 放行但仍检查绑定、Schema 与任务来源。服务返回的 readOnlyHint 不能提升权限。确认整个服务都是只读时可添加 --action collect；混合服务使用 toolSemantics 逐个声明。

配置示例：

~~~json
{
  "slug": "research",
  "transport": "auto",
  "url": "https://your-server.example/mcp",
  "tokenEnv": "RESEARCH_MCP_TOKEN",
  "authHeader": "Authorization",
  "authScheme": "bearer",
  "defaultAction": "modify",
  "toolSemantics": {
    "search": "collect",
    "publish": "publish"
  },
  "resultFormat": "raw",
  "toolResultFormats": {
    "structured_release": "retrieval"
  }
}
~~~

密钥只填在本地环境或 .env，JSON 的 tokenEnv 填变量名；不会借用模型 API_KEY。自定义 API-key 请求头可配置 authHeader 和 authScheme=raw。远程 URL 使用 HTTPS，本机 localhost/127.0.0.1/::1 可以使用 HTTP；URL 不接受内嵌凭据，重定向和 SSE 跨源消息端点不会接收凭据。本轮不实现浏览器 OAuth 授权流程。

stdio 配置：

~~~json
{
  "slug": "local-data",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "your-mcp-package"],
  "env": {
    "SERVICE_API_KEY": "MY_SERVICE_KEY"
  },
  "defaultAction": "modify",
  "toolSemantics": {
    "query": "collect",
    "update": "modify"
  }
}
~~~

env 是“服务变量名 → 主进程环境变量名”的显式映射，不是密钥值，映射值均按敏感数据脱敏。非敏感设置（如 LANG）可在 JSON 的 publicEnv 中使用相同的变量名映射；publicEnv 不参与秘密值匹配，不能与 env 重复目标变量。CLI 也支持 --command、--args-json、--env-map、--transport、--auth-header、--auth-scheme、--tool-actions FILE、--result-format。stdio 不使用 Shell 拼接；相对参数以所选 workspace 为工作目录。配置的本地服务按用户提供的程序启动，工具权限门禁不构成对服务进程自身的 OS 沙箱。

实际调用披露为 mcp__slug__工具原名；净化碰撞或超长名称仍拒绝。MCP 工具必须在任务 allowedSources 中，或者由本次 --mcp slug1,slug2 明确加入任务。启用配置只表示可选，不会把所有服务器自动加入每次调查；只注册本次任务需要的来源。

### 工具结果与情报事实

默认 raw 保留一般 MCP 文本/结构化结果，脱敏后保存完整 raw 快照，向模型返回有界结果。它不要求第三方服务实现竞品领域类型，也不会把任意文字自动当成已验证事实。

retrieval 仅用于返回本项目 RetrievalResult 的工具：包括明确 status、signals、raw、provenance，Signal 的 sourceSlug 必须等于配置 slug。toolResultFormats 可按工具覆盖格式，适合一个服务同时提供采集和普通诊断工具。成功的非采集诊断结果不参与竞品事实归一；未结构化的 collect 结果保留 source_unstructured_result 缺口，报告为 partial。

通用 MCP 依据用户声明的 action、服务器输入 Schema 和任务来源授权；不自动推断任意业务参数的实体/URL边界。web_search/web_fetch 继续使用域名限制；显式 webApi 配置走本地 API，未配置时保留原生优先与搜索 MCP 路径，见 web-api.md。

## 安装 Skill

本地目录必须有标准 SKILL.md：

~~~yaml
---
name: competitor-review
description: >-
  Review supplied competitor claims for source support, entity identity, chronology, and contradictions.
  Use for evidence review or an investigation's review phase. Do not use to start unrelated collection,
  perform code review, or replace a general research brief.
---
~~~

目录名与 `name` 一致，入口使用 `SKILL.md`。YAML 支持常见引号和折叠描述；name 使用小写字母、数字、连字符，最长 64 字符。`description` 简要说明能力、适用请求和容易误触发的排除条件；触发信息放在这里，正文只在加载后可见。

正文说明任务目标、所需材料、执行流程、结果格式与必要约束；较长且条件性的检查表或示例放在 `references/`，由正文指出何时读取。不要把示例、可选检查或其他 Skill 的流程写成所有任务必须执行的步骤，也不要在 Skill 中声明工具已执行或授予权限。

项目内置 Skill 为 `skills/general-agent/SKILL.md` 和 `skills/competitor-investigation/SKILL.md`，按任务类型由宿主选择。用户 Skill 仍通过 `--skills` 或工作台选择显式加载；描述中的适用条件不表示当前实现了新的自动路由机制。内置包会解析 YAML，只将正文注入提示；显式 `skillPath` 指向的旧普通 Markdown 仍可读取。

本地安装会复制到 `.cwatch/skills/<name>/`，保留引用文件、模板和脚本文件，并记录文件哈希；不会执行包内脚本或安装 npm/Python 依赖。已经安装的副本不会随示例目录编辑而自动更新。

~~~powershell
npm start -- skills install "C:/path/to/my-skill"

# GitHub 仓库内的 Skill 目录
npm start -- skills install --repo owner/repo --path skills/my-skill --ref main

# GitHub tree URL
npm start -- skills install "https://github.com/owner/repo/tree/main/skills/my-skill"

# 单 Skill 仓库，SKILL.md 位于根目录
npm start -- skills install --repo owner/single-skill

npm start -- skills list
npm start -- skills show my-skill
npm start -- skills disable my-skill
npm start -- skills enable my-skill
npm start -- skills remove my-skill
~~~

GitHub 安装需要 Git，支持分支/标签，记录实际 commit；分支含斜杠时使用 --repo/--path/--ref。实现采用无 checkout 的浅克隆和 Git blob 读取，不执行仓库脚本。已有 Skill 不覆盖；移除只删除本项目的安装副本，保留原目录/仓库。

包最多 512 文件、10 MB，SKILL.md 最多 64 KiB；过滤 .git、node_modules、.env* 和私钥文件。拒绝软链接/目录联接、路径越界与大小写冲突；失败清理本次暂存目录，完整校验后原子安装。

## 在调查中使用 Skill

~~~powershell
npm start -- run --mode live --mcp research --skills competitor-review
npm start -- run --mode replay --skills competitor-review
~~~

--skills 可逗号分隔多个名称。只有本次选中的已启用 Skill 正文进入稳定上下文，仍受原有字符预算约束。安装不代表自动启用所有 Skill；没有 --skills 时原有调查行为不变。

模型通过 session__read_skill_resource 读取选定包的参考文本，参数为 skill、path，可选 offset、limit，单次最多 24000 字符。读取校验安装清单、路径和哈希，经过同一个 ToolExecutor、PreToolUse、取消和 Trace；不会读取任意本地文件或执行脚本，二进制资源不直接解码。需要其他能力的 Skill 可配合相应 MCP 工具使用。

Skill 元数据中的 alwaysAllow、requiredSources 等字段不会自动改变权限或加入来源。安装/启停/配置修改在下一次任务选择时生效，不热重载 SDK 会话；安装文件被修改时拒绝继续读取，需要重新安装。

## 实现与审计

- managed-workspace.ts：项目目录约束、原子写、管理命令锁与受限删除。
- user-mcp.ts / user-mcp-source.ts：持久配置、鉴权、SDK discovery/call、逐工具语义和结果格式。
- skills.ts：YAML、复制/GitHub 安装、清单、启停、选择与引用读取。
- extension-cli.ts / cli.ts：用户管理及任务选择；不将管理能力暴露给模型。
- runtime.ts：显式 Skill 注入、workflow 资源读取、结构化采集与原始材料分层。
- Trace 的 skills_loaded 保存所选名称、哈希、资源路径；每次 MCP/Skill 工具调用仍关联主子进程请求、裁决和执行记录。

SDK 的目录自动发现、默认编码工具和全局扩展仍关闭。测试在 tests/extensions.test.ts；合成模型协议测试、公开 GitHub 安装和真实规划模型验收分别记录，不将 fixture 数据描述成真实竞品事实。
