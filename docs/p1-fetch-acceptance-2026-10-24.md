# 抓取服务超时 P1 修复验收：2026-10-24

结论：原 MCP 路由下，三个已配置官网起始页均已取得可读正文；在原调查的父工具 45 秒上限内再次复验，3/3 成功。未更换 MCP 地址、凭据、授权 URL 或许可域名，未增加直接抓取或失败兜底路由。本轮是正文可用性验收，不是整项竞品调查或全站覆盖验收。

## 根因与修复

同一服务连接与 tools/list 正常，实际工具 Schema 的 web_fetch 仅接收 url。默认 30 秒配置下，三站均在约 30.3–30.5 秒报 search_mcp_request_timeout。

显式延长客户端上限后，服务约 30.6–31.0 秒已返回结果，但旧解析器仍报 web_result_missing_page_text。读取原始 MCP 响应确认：正文实际位于 structuredContent.page.markdown，外层 code=0；ZCode 响应的 time_cost=30027。因而存在两个独立问题：客户端上限与服务返回时间冲突，以及嵌套正文格式未被识别。

- Remote MCP 增加 requestTimeoutMs，Schema 限定整数 1000–120000 毫秒，默认仍 30000；HTTP 和 tools/call 使用该上限，连接/发现最多 min(30000, requestTimeoutMs)。所有阶段继续受父工具与运行取消控制，没有重试或超时后换服务。
- 三份 examples/competitor-acceptance/*.sources.json 仅显式增加 searchMcp.requestTimeoutMs=60000；既有 URL/token 环境变量、白名单、起始 URL、其他来源均保留。更大的来源上限不延长父工具上限。
- 正文归一化识别 page 包裹，继续校验单页、非空文本与输入/返回 URL 一致；非零 code 的失败包裹即使附带旧正文也不作为成功。原始响应继续保存快照，publication time 不从抓取时间推断。
- 增加 scripts/probe-competitor-fetch.ts，默认只读取三个原配置的第一个官网 URL，经 SourceServerBuilder → ToolRegistry → ToolExecutor → 原 MCP → 统一正文归一化。探针不使用规划模型、不产生调查报告；--all-urls 可显式验证其余配置入口，本轮未执行全量入口覆盖。

实现：packages/shared/src/sources/web-mcp.ts、web-results.ts。回归：tests/web-mcp.test.ts、web.test.ts。

## 原父预算复验

来源请求上限 60000，父工具上限仍 45000 毫秒。实际 backend 均为 mcp.remote，全部 Trace 校验无问题。机器核对配置变更仅为 requestTimeoutMs；前后 serverId 相同，URL 和 allowedDomains 完全相同，所有 backend_started 均为 mcp.remote.*。

| 目标 | 许可起始 URL | 正文字符 | 用时 | runId |
|---|---|---:|---:|---|
| ZCode | https://zcode.z.ai/en | 12245 | 30769 ms | 46b331f4-75ea-4997-8e03-d04cd038b916 |
| Kimi Code | https://www.kimi.com/code | 1783 | 30606 ms | 374bedbc-e603-4d4e-91ea-a81bea50f5f8 |
| MiniMax Code | https://agent.minimax.cn/about | 2550 | 30673 ms | 1a2d9d95-edf0-45f8-9333-396cbbddee2a |

正文人工核对：ZCode 含产品定位、功能与下载部分；Kimi Code 含桌面/CLI/IDE 介绍及订阅部分；MiniMax Code 含产品介绍、插件/远程/浏览器/CLI 与对比部分。返回内容包含各自产品标识，未见验证码或访问拒绝页。没有执行网页中的安装命令或把相对时间视作发布日期。

可用正文不等于整页完整：Kimi 返回文本末句不完整，MiniMax 的 FAQ 后续正文未确认。适配器没有本地截断这三段正文，不能据 truncated=false 推断远端提取完整。三站 published_at 均为 null，signals 均为空；正文仍是发现材料，不自动生成时间窗内的结构化事实。

## 证据与复现

- artifacts/competitor-live/20261024/p1-fetch/baseline：旧 30 秒上限，三站超时。
- 同目录 timeout90：客户端余量增大后暴露旧嵌套格式解析失败，不把该阶段当成功。
- tools.json 与 mcp-fetch-envelope.json：同服务的工具 Schema 和 ZCode 原始响应诊断；诊断不计入正式成功结果。
- fixed：新解析器与 60 秒来源上限下首次 3/3 正文成功，父工具 70 秒。
- final45：父工具恢复原 45 秒后再次 3/3 成功，含 results、retrievals、executions、traces 与独立 runId。
- acceptance.json：配置差异、相同 serverId/白名单/URL、正文哈希、人工核对与完整性边界。

```powershell
node --use-env-proxy --experimental-transform-types scripts/probe-competitor-fetch.ts --out artifacts/competitor-live/20261024/p1-fetch/final45 --tool-timeout 45000
```

复跑应改用新 --out 目录以保留本次证据。抓取相关回归 79/79，覆盖超时配置、嵌套正文、非法/失败包裹、URL 伪造、取消与路由不变；日志 artifacts/p1-fetch-targeted.log。最终 npm run verify 447/447（contract 321、semantic 30、integration 96），结构、类型与 git diff --check 通过，日志 artifacts/p1-fetch-verify.log。

本轮没有复跑完整模型调查、GitHub 限流或搜索召回质量；既有整项调查未通过的结论继续保留。
