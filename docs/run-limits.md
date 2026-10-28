# 运行限制

所有调查共用主进程预算；模型、MCP 和 Skill 无法通过参数提高限额。

| CLI 参数 | 默认值 | 含义 |
|---|---:|---|
| --context-chars | 150000 | 活动上下文与请求的字符上限，包含工具 Schema；Pi 在接近上限时先摘要压缩，完整归档历史不计入活动窗口 |
| --max-response-chars | 32000 | 每轮模型决策的序列化字符上限，含工具参数；Pi 流式内容也提前检查 |
| --max-output-tokens | 4096 | 单次模型请求输出 Token 上限，受模型声明的上限约束 |
| --max-tokens | 100000 | 整次调查累计 Token 预算，包含输入、输出、缓存，思考子项不重复累计 |
| --max-same-tool-calls | 8 | 一个工具在整次调查中的最大调用尝试次数，按完整代理名计数，参数变化仍累计 |
| --max-tool-calls | 20 | 整次调查工具调用尝试总数，包括工作流工具及失败/被拒绝的调用 |
| --max-steps | 24 | 最大模型决策轮数 |
| --timeout | 120000 | 调查总超时，毫秒 |
| --model-timeout | 60000 | 每轮模型等待超时，毫秒；第一轮包含 Agent 子进程启动 |
| --tool-timeout | 15000 | 单工具调用超时，毫秒，含权限审批等待 |

计数不区分相同/不同参数。workflow__save_plan 与 workflow__analyze 是不同工具，两个来源中的同名工具也按来源分别计数。触及总次数或同一工具次数上限后，超额那次调用不会进入执行器。原来的连续三次完全相同决策防死循环检查继续生效。

字符数按 JavaScript UTF-16 长度计数，不冒充 Token 数。Pi 在字符或可用输入 Token 的 80% 判断需要压缩；Token 使用 UTF-8 字节估算与最近实际 usage 加新增消息估算取较大值，模型窗口需预留输出额度。旧会话经摘要和显式 compaction 边界退出活动上下文，完整脱敏转录继续保留；固定提示、工具、任务或最近完整工具轮次仍超限时明确失败。ReplayModel 的单步上下文仍超限即失败。草稿正文还受已有 12000 字符 Schema 限制。工具结果保留已有来源大小上限、快照及有限观察值，再进入上下文检查。详见 session-context.md。

Token 累计使用提供方返回的 Pi usage。每次请求输出额度为“配置的单次额度、剩余总预算、模型上限”的最小值；收到 usage 后及下一次请求前再次检查。输入 Token 无法在请求前精确计算，因此累计预算是请求间的停止门禁，当前请求仍可能超出预算，不是硬计费额度。真实 Pi 模型有效响应若没有正数 usage，会停止并记录 budget_usage_unavailable。取消或流式中止时当前请求可能不返回 usage，记录的累计用量可能不完整。ReplayModel 不产生模型用量，不虚构 Token 或计费。

摘要请求使用同一提供方与模型，不暴露工具；输出最多 1024 Token 并受上述剩余额度限制。摘要 usage 同样计入累计预算，且单独受模型超时、调查超时与取消信号约束；不会增加业务决策轮数或工具执行次数。摘要为空、截断、包含工具调用、缺少有效 usage 或无法缩小上下文时明确停止，不提交新的压缩边界。

Pi 正式摘要前先对单条工具结果执行整条消息的字符预算（上下文上限 20%，最高 16000、最低 1024），再按压力将旧成功只读结果 microcompact 为可重读占位，保留最近两条结果。治理只改活动投影，原文和宿主 observations 不变；错误、写入回执与未确认只读的动态 API 不参与轻量替换，普通 assistant 文本也不受此层删除。分页重读属于正常工具调用，计入轮数、总工具数、同一工具次数、单工具超时等既有限额。

正式压缩的保留目标为最近两轮完整 API round；两轮投影超过上下文字符上限的 40% 或将跨越旧压缩边界时，保留最近一整轮。摘要、固定任务、保留轮次、附件与 hook 结果合并后再次检查字符和模型窗口；无法装下最近完整轮次时失败，不截断调用配对。post-compact 回调受调查总超时和取消约束，回调失败、Schema 不符、附件超限或逻辑提交失败均不发送下一次业务模型请求。

工作状态附件保留最近六个资源，每个片段最多 1200 字符，计划预览最多 4000 字符；目录元数据按约 18000 字符分块，统一附件 Schema 限制最多 16 份、单份最多 24000 字符，并纳入总上下文预算。`workflow__read_plan` 默认每页 1024、最多 4096 字符，重读属于正常工具调用；无法校验本次已提交计划时明确失败。附件只恢复宿主已知状态，不自动重读来源指南、发现新工具或重放执行。

`session__read_transcript` 默认每页 1024、最多 4096 字符；字面 query 最长 200 字符，可选 entryId 与 query 不能并用。throughEntryId 固定快照前缀，分页不会吸收后续新增回执。回查计入普通工具/轮数/超时预算，结果仍受单条结果治理；摘要回查元数据计入压缩后总上下文预算。当前宿主读取并校验 JSONL 后再截取响应，限制的是模型可见页长，不宣称针对超大转录的流式磁盘索引或恒定内存读取。

Session Memory 默认在当前窗口压力达到 12000 Token 后初始化，此后累计正增长 4000 Token 或新增六次工具调用触发；有待处理批次时下一轮继续。每轮最多一个维护批次；首次请求输出最多 1024 Token，仅 length 截断允许一次缩小到首个完整轮次的恢复请求，输出最多 4096 Token，始终受调用者单次额度、模型上限及重新获取的剩余总预算限制。输入默认最多 48000 字符，工作状态正文最多 12000 字符。每次已返回的 usage 均计量，累计 Token、模型/调查超时与取消同业务模型共享，purpose=memory 单独记录；维护调用不计为业务工具，主动 read_session_memory 属于普通工具调用。恢复仍截断、非法 JSON、工具调用、缺失用量、预算、取消或持久化错误均停止且不提交非法 memory，不进行第三次请求、不静默关闭功能或跳过增量。Step 5 官方端点使用已核对的 low 推理档位及 JSON 格式，其余模型不猜测供应商参数，详见 session-context.md。程序接口 RuntimeOptions.sessionMemory 支持修改阈值或 false 关闭，当前无专用 CLI 设置。

明确的供应商长度拒绝可触发一次反应式压缩后重试；第二次连续拒绝熔断，单运行累计最多两次恢复。恢复请求消耗新的业务请求轮数，摘要与重试继续受剩余 Token、输出额度、模型/调查超时与取消控制，不能重置总预算。强制压缩保留最近一整轮完整 API round，跳过该次 memory 维护；摘要失败、无法缩小或没有历史时直接停止，不递归重试。失败回执 usage 若可用记为 rejected；未返回有效 usage 不代表已知零费用。SDK 通用重试保持关闭，该例外不适用于 401/403/429/5xx 或普通参数错误。

Prompt Cache 不提供额外上下文额度，也不抵扣本项目累计 Token 预算：压力与预算仍包含 input/output/cacheRead/cacheWrite。业务默认请求 SDK short 缓存控制，RuntimeOptions.promptCache 可设 none，摘要/Memory/探针为 none；均不保证端点支持或命中，当前无长 TTL 或专用 CLI 参数。cache 观测中的正读占比只是归一化输入 Token 的组成，不是请求命中率或节省金额；SDK 归一化零值不能证明供应商明确报告 miss，缺失字段按未知保留。

调查或模型超时会取消审批和工具，收回 Agent 子进程；单工具超时会取消该次调用并向模型返回失败观察值，可在剩余预算内继续。已开始但未确认完成的写操作仍记为 unknown，不自动重试。调查总超时从 runInvestigation 开始，CLI 的来源发现是之前的准备阶段，保留独立的每源 25000 毫秒超时；进程清理可能额外占用有限收尾时间。

~~~powershell
npm start -- run --mode live --task examples/task.json --sources examples/sources.json --max-tokens 50000 --max-output-tokens 2048 --max-same-tool-calls 4 --context-chars 100000 --max-response-chars 16000 --timeout 180000 --model-timeout 45000 --tool-timeout 20000
~~~

程序调用可在 RuntimeOptions 中传同名 camelCase 字段。所有值必须是安全整数；三种次数允许 0（立即阻止），其余必须大于 0。毫秒参数不得超过 Node 定时器范围，避免溢出后变成近乎立即超时。CLI 在创建输出目录前校验。

run_started 记录生效 limits；usage_reported 记录总调用尝试、按工具计数、累计 Token、原始模型用量及耗时。任务级预算超限追加 budget_exceeded，并保留明确的 run_failed 原因。单工具超时也记 budget_exceeded，但允许按前述规则在剩余预算内继续。

实现：packages/shared/src/agent/core/budgets.ts、packages/server-core/src/runtime/investigation.ts、packages/shared/src/agent/backend/pi/session.ts、apps/cli/src/index.ts。测试：tests/budgets.test.ts、tests/pi-session.test.ts；原有超时与预算回归继续执行。

浏览器内部 HTTP 请求另受请求次数、单资源/总字节预算约束，见 source-adapters.md。一次 browser_tool 调用仍计作一次 Agent 工具尝试，内部资源请求不会计作额外模型工具轮数。

远程 Web MCP 来源可显式设置 searchMcp.requestTimeoutMs（1000–120000 毫秒，默认 30000），同时用于 HTTP 与 tools/call；连接与发现最多 min(30000, requestTimeoutMs)。父工具超时、运行超时与取消仍优先，不因为来源设置更大而延长父预算，不自动重试或更换抓取后端。三个竞品验收来源现设为 60000，为约 30 秒返回正文的原服务留出余量；父工具 45000 的独立复验见 p1-fetch-acceptance-2026-10-24.md。
