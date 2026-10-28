# 官方来源发现 P1 验收：2026-10-24

结论：已补齐“官方站点定向查询＋明确起始 URL”的发现策略，并实测覆盖三个目标的九个原有参考入口；没有放宽白名单或替换服务。**上游搜索召回仍弱，不能宣称搜索问题完全消失。** 本轮搜索去重候选为 2/1/0，精确起始 URL 搜索命中为 0/9；显式抓取起始 URL 则取得 9/9 份可核对正文。该分母仅是已列九个入口，不是全站、整页完整度、事件黄金集或线上召回率。

## 本轮实现

- Web 工具说明披露来源配置中原有的 allowedDomains 和 urls，起点先经许可域名校验。模型此前主要从 API 指南或本地文件发现这些 URL；现在直接在工具目录可见。披露内容不含搜索服务地址或凭据，也不改变原授权域名和抓取路由。
- 内置 competitor-investigation Skill 要求把起始 URL 写入计划的 evidenceRequirements，queries 保留官方站点、文档/更新及精确官方仓库的有界查询。搜索为空也显式抓取已确认起点；搜索失败不授权其他服务或扩大范围。
- discovery-queries.json 固定每产品三组 query、每次 limit=10。probe-competitor-discovery.ts 经 SourceServerBuilder → ToolRegistry → ToolExecutor → 既有 Web MCP，分别归档搜索与起点抓取。父工具仍 45 秒，来源请求上限沿用此前显式的 60 秒。
- source-coverage.ts 区分上游候选出现次数、越域过滤、去重候选、精确参考入口搜索命中、参考入口文本可用性及实际 signals；缺失上游计数是 null。查询间去重，不把相同域名或其他 GitHub 仓库等同于一个参考页；不同路径、tag 和查询参数保持区别。
- 结构化 GitHub Releases 独立串行采集，每仓库一次、per_page=10，遇限流停止，无自动重试。该采集不把 Web 搜索结果或 Markdown 转换成 release signals。

## 查询与候选数量

每个目标的三组查询是主官网、文档/资源路径、精确 GitHub 仓库。已核对 Trace 中实际传入的 query 与固定矩阵一致，实际输入 n=10；沿用原服务参数 use_common_search=true，没有新增或猜测供应商参数。

| 目标 | 查询数 / 每次上限 | 上游返回出现次数 | 越域过滤次数 | 白名单内去重候选 | 精确参考入口搜索命中 |
|---|---:|---:|---:|---:|---:|
| ZCode | 3 / 10 | 30 | 24 | 2 | 0/3 |
| Kimi Code | 3 / 10 | 30 | 27 | 1 | 0/3 |
| MiniMax Code | 3 / 10 | 30 | 30 | 0 | 0/3 |

90 次上游候选出现中，81 次越域被过滤；剩余 9 次出现去重后只有 3 个候选。每目标三组不同 query 返回了高度重复的白名单候选，不能据定向查询的文字推断服务一定严格执行了 site: 范围；本地白名单过滤始终保留。与此前宽泛 limit=5 的首轮不是同一测试条件，不将这些样本差异表述为稳定的召回提升百分比。

新增搜索候选：ZCode 的 /cn/docs/welcome 与 /cn/docs/configuration；Kimi 的 /code/console；MiniMax 无。它们均未作为冻结参考入口的替代或自动认证事实，未取代参考分母，也没有为提高数量去抓取非白名单域名。Kimi 的 console 候选不等于完整官网或更新记录覆盖。

## 起始 URL 文本覆盖

参考入口完全来自此前三份 sources.json 与 targets.json，未在看到搜索结果后修改分母。已核对源配置哈希与上一轮 P1 抓取验收一致，MCP serverId 不变，所有 Web 后端阶段均为 mcp.remote.*。九份正文检查了产品主体，未见 404、验证码或拒绝页；完整快照哈希验证通过。

| 目标 | 冻结参考入口 | 返回正文字符 | 文本可用覆盖 |
|---|---|---|---:|
| ZCode | 官网 /en、安装 /cn/docs/install、zai-org/ZCode 仓库页 | 12245 / 1820 / 7201 | 3/3 |
| Kimi Code | 官网 /code、介绍 /resources/kimi-code-introduction、MoonshotAI/kimi-code 仓库页 | 1783 / 24000 / 6282 | 3/3 |
| MiniMax Code | 官网 /about、/docs/changelog、MiniMax-AI/minimax-code 仓库页 | 2550 / 24000 / 19675 | 3/3 |

人工核对包含 ZCode 产品/安装及官方 README，Kimi 产品介绍、Kimi Code 专题文章和 CLI README，MiniMax 产品功能、日期分节的更新日志及终端 Agent README。Web pages 的 published_at 仍为 null，不将页面内的“更新于”、相对时间或采集时间直接作为已核验发布时间。

Kimi 专题文章和 MiniMax 更新日志在模型可见结果中明确 locallyTruncated=true，完整原始响应保留快照；Kimi 首页末句不完整，部分其他页面的上游抽取完整性也未建立。即使本地未截断，也不宣称服务返回了整页所有内容。网页出现的外域文档、CDN 或安装命令未因此获得抓取/执行授权。

## 与结构化信号分开计量

本轮 Web 搜索与抓取合计产生 **0 个自动结构化信号**。另行调用原 GitHub Releases 结构化适配器，三仓均 HTTP 200：

| 目标 | 原始映射 release signals | 实体匹配、窗口内且不晚于实跑时点的 signals | 公共 remaining（响应时） |
|---|---:|---:|---:|
| ZCode | 1 | 1 | 39/60 |
| Kimi Code | 10 | 4 | 38/60 |
| MiniMax Code | 10 | 10 | 37/60 |

时间窗仍为 [2026-09-24T00:00:00+08:00, 2026-10-25T00:00:00+08:00)，basis=published_at。Kimi 的其余六条在窗口外，没有用原始十条直接充当窗口内数量。只取各仓库一页最多十条，不声称全部 releases 已遍历；仓库/CLI release 不等于桌面产品同步发布。ZCode README 含其他版本更新描述，也说明单一 Releases 接口不能代表全部产品更新。

这些是采集与归因计数，没有生成完整模型报告、最终业务 claims 或人工质量分数，也没有改变此前整项调查未通过的结论。尚缺全站/事件参考集、更多搜索候选的实体核验、官方文章/更新日志的专门结构化解析以及 price/content/campaign 的覆盖验证。

## 证据与复现

- examples/competitor-acceptance/discovery-queries.json：冻结查询矩阵；三个旧来源和白名单不变。
- scripts/probe-competitor-discovery.ts、probe-competitor-github.ts：分离的有界实跑入口。
- artifacts/competitor-live/20261024/p1-discovery/web/summary.json：每次 query、候选、参考匹配、正文和 Trace；各目标 results、retrievals、executions 保存原始证据。
- 同目录上一级 github/summary.json：独立结构化采集；acceptance.json 汇总相同配置/服务、实际 query、正文人工核对、哈希和时间归因。
- Web runId：ZCode dda10325-ff41-4bba-9043-89009b1434bc；Kimi 8d9525e2-564c-4b8b-9994-8b6d5e92aadf；MiniMax 928bcb76-b39f-42af-afaa-3361979b62e0。
- GitHub runId：ZCode bdb0075b-a21c-446b-9b33-2e9f0d8672d7；Kimi 28143287-bbc5-4bfa-9fea-fec88e52940b；MiniMax 25ffe496-c2d1-4750-9c46-5b4a10097733。

```powershell
node --use-env-proxy --experimental-transform-types scripts/probe-competitor-discovery.ts --out artifacts/competitor-live/20261024/p1-discovery/web
node --use-env-proxy --experimental-transform-types scripts/probe-competitor-github.ts --out artifacts/competitor-live/20261024/p1-discovery/github
```

复跑需改用新 --out 目录保留旧证据。六份正式 Trace 均无校验问题。专项 62/62；npm run verify 466/466（contract 334、semantic 34、integration 98），结构与类型、git diff --check 通过。日志 artifacts/p1-discovery-targeted.log、artifacts/p1-discovery-verify.log。
