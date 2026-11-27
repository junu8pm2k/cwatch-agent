# 会话转录与活动上下文

本次目标：长调查积累大量材料时，保留可追溯的对话原文，同时通过摘要继续调查；压缩不得删除历史、重复执行工具或改变宿主权限。

通用 Agent 现支持同一 Session 接收多条用户消息：每轮最终答复后进入等待，下一条消息沿用当前 SDK Session、Transcript、Memory 与压缩边界；显式结束才释放进程。用户追问与工具续轮分别接入既有上下文治理，等待期间暂停活跃执行计时。工作台刷新可继续，服务重启后仍不自动续跑。端口和预算边界见 [多轮会话](conversations.md)。

## SDK 实锚与映射

依赖版本保持 @earendil-works/pi-coding-agent@0.84.2。实现前核对安装包 docs/compaction.md、dist/core/session-manager.d.ts/js、agent-session.js、model-runtime.d.ts，以及内嵌 pi-agent-core 的 agent-loop.js。

| 本工程职责 | 已核对的 SDK 接口与行为 |
|---|---|
| 原始转录 | SessionManager.getHeader/getEntries 返回原生会话 header、带 id/parentId 的消息和元数据；AgentSession 在 message_end 的监听通知之后同步 appendMessage，适配层用事件队列在下一微任务取增量 |
| 压缩边界 | appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) 只追加条目，不删除历史 |
| 活动上下文 | SDK buildContextEntries/buildSessionContext 提供摘要、firstKeptEntryId 起的保留消息与边界后消息；适配层 getCommittedContextEntries 仅启用完整提交的边界，初始任务放在保留消息中 |
| 下一轮请求 | 包装原 prepareNextTurnWithContext，保留 SDK 的工具刷新，再返回压缩后的 context；agent-loop 以返回的 context 继续下一轮 |
| 摘要请求 | 已配置 ModelRuntime.completeSimple；无工具、无副作用，使用独立提示和同一取消信号；响应经 onUsage 纳入累计预算 |
| 请求归档 | onPayload 在 HTTP 发送前归档最终业务请求 payload；摘要请求/响应作为 custom entry 保存；custom entries 不参与模型上下文 |

## 两份独立记录

- `traces/<runId>.jsonl`：业务决策、审批、执行与状态重建。
- `sessions/<runId>.jsonl`：sessionId 等于 runId；原生 Pi header、完整 user/assistant/toolResult 消息（包括辅助文本、思考及工具参数）、请求快照、摘要响应和压缩边界。

worker 只发送条目，主进程 SessionTranscript 校验身份、唯一条目和父链、脱敏后追加写盘，并确认成功；失败会停止会话。请求前、消息完成后及收尾均刷新新增条目。转录不承诺保存尚未完成的流式 token 或系统断电零丢失。

## 压力与压缩

在字符上限或可用输入 Token 的 80% 触发。输入 Token 上限为模型 contextWindow 减去预留输出；使用 UTF-8 字节估算，并与最近业务响应的 input + output + cacheRead + cacheWrite，加新增消息及固定上下文增长的估算取较大值。最近 assistant 输出已包含在 usage 中，不再次计入新增消息。累计计费 Token 与当前窗口压力是不同维度。压缩后清除旧窗口 usage 锚点，不能拿压缩前的窗口用量估计新窗口。

正式摘要按完整 API round 保留消息，优先保留最近两轮，在保留预算不足或将跨越上一条压缩边界时退为最近一轮。每轮包含对应用户消息、一个 assistant 响应及其全部工具结果；多调用响应的结果可以乱序返回，但同一轮中重复 ID、重复/孤立/错名/缺失结果会阻止压缩与下一次模型请求。不同轮次复用 toolCallId 可以区分。当前业务调度支持每轮多个工具调用，按返回顺序逐项授权并串行执行；整批结果回填后才请求下一轮，批内不进行压缩或 Memory 维护。

初始任务额外固定保留；保留轮次中的工具结果继续使用上一层治理后的投影。旧活动消息（包含上一份摘要）用于生成结构化续办记录：userGoal、completedWork、keyFiles、errorsAndFixes、unfinishedTasks、nextSteps、references、sourceGaps。全部字段必需，nextSteps 至少一项；无依据的信息使用空数组或明确未知，不接受泛泛聊天概述代替结构化记录。格式校验不等同于语义真实性验证。

候选摘要必须非空、完整、无工具调用，连同保留轮次、附件和 hook 结果实际缩小上下文并满足硬预算，才能提交。摘要失败、预算不足或无法缩小明确失败，原有消息与审计均保留。固定 system、任务、工具或最近完整轮次本身超限时，无法靠压缩解决。

ContextPipeline 在 live 会话不重复注入全量 observations；业务 AgentState 与 Trace 仍保留全部 observations。ReplayModel 的固定单步驱动不变。工具 raw 的 16000 字符裁剪及原文快照仍是独立机制。

SDK 内置自动压缩继续关闭，避免其隐藏的请求、重试和用量绕过宿主预算。摘要请求单独计费并受模型/调查超时和取消约束，Trace 的 model_usage.purpose 区分 turn/summary；当前自定义端点沿用适配器的保守 128000 Token 配置，不宣称自动探测真实模型容量。

## 摘要之前的工具结果治理

顺序为：原始 toolResult 落盘确认 → 单条活动结果预算（snip）→ 窗口压力检查 → 旧只读结果 microcompact → 再检查压力 → 必要时请求正式摘要。治理只修改模型可见的投影，原生消息与宿主 observations 保持完整。

每条投影编辑绑定原生消息 entryId 和 SDK toolCallId/toolName，作为 custom entry 追加；离线重载也应用同样的编辑。普通 assistant 消息、工具调用及其结果配对不删除。单条结果预算为上下文字符上限的 20%，最高 16000、最低 1024 字符；覆盖整条活动结果，包括非 raw 字段和 SDK details。过大的内容使用首尾预览与明确的重读说明。旧成功只读结果可替换为短占位，保留最近两条结果（仍受单条预算约束）。错误、写入/外发/发布回执以及无法确认只读的动态 API 不参与 microcompact。

`session__read_tool_result` 仅在有会话转录的运行中提供，通过本次运行的 entryId + toolCallId 分页读取已脱敏的原始工具内容；默认每页 1024、最多 4096 字符，通过 nextOffset 翻页，返回内容哈希并检查快照完整性。拒绝其他会话、错误身份和任意文件路径。它走原有 ToolExecutor/IPC/预算链，读取归档不重放原工具，也不改变来源指南的前置阅读状态。每轮复查重读工具是否仍可用；已治理结果的重读入口被撤销时明确停止。

SDK 实锚：已核对安装包 pi-ai 的 ToolResultMessage（toolCallId、toolName、content、details、isError）及 SessionManager 的 message/custom entries、sessionEntryToContextMessages；用原生 entry 身份应用投影，完整转录仍使用 SDK 原始消息。工具结果被编辑后清除压缩前的 usage 锚点，避免旧用量继续触发不必要的摘要。

正式摘要的输入同样使用治理后的结果，不会从完整转录重新塞回已经 microcompact 的长文。现有来源大小、raw 快照及 IPC 帧上限仍独立生效；这里的预算限制的是模型活动上下文。

## 正式压缩的重建与提交

存储顺序为 `Compact Boundary → Summary Messages → Messages To Keep → Post-Compact Attachments → Hook Results`：Pi 的原生 compaction 条目同时承载边界与摘要，模型可见顺序为摘要、固定初始任务和保留完整轮次、压缩后附件、hook 结果，随后才追加新消息。

宿主 `afterCompact` 通过 IPC 提供当前 workflow 状态附件，包括阶段、计划路径、精确 claim/evidence ID、报告路径、来源状态、权限模式与归档工具结果引用。程序调用者可显式设置 `RuntimeOptions.onPostCompact(request, signal)` 返回附加 hook 结果；不自动发现或执行目录脚本。该回调在最终提交前收集结果，受调查取消/超时约束，结果经脱敏和 Schema 验证。附件与 hook 文本都是数据，不改变宿主权限、绑定或指南前置条件。

所有部分预先检查顺序、完整轮次和字符/Token 预算，再追加原生 compaction、custom_message 附件/hook 和 `cwatch.compact_commit`。提交元数据不进入模型正文。只有完整提交且所有保留身份、附件身份和顺序校验成功，边界才成为活动上下文；写盘中断留下未提交边界时，离线重建回退到上一个完整上下文，原始消息仍保留。非法提交明确报错。这是会话投影的逻辑提交协议，不宣称跨文件数据库事务或断电零丢失。

## 压缩后重新注入工作状态

宿主每次正式压缩成功提交前，通过 `WorkingStateTracker` 重新读取当前状态，追加以下附件，而不是仅相信模型摘要中的进度：

| 附件 | 内容与约束 |
|---|---|
| Current workflow state | 已保存计划的路径、哈希和最多 4000 字符预览，阶段、来源采集状态、精确证据/claim ID、review、报告和下一步；计划文件须与宿主已提交版本一致 |
| Recent resource reads | 最近六个已成功读取的资源，保留路径/原生结果身份、哈希、分页位置、最多 1200 字符片段及明确重读入口；更早资源省略数量与裁剪标记可见 |
| Loaded skills and resource usage | 已注入内置和用户 Skill 的身份、版本哈希，以及实际读取过的 Skill 资源；注入正文不冒充执行脚本或已阅读所有参考文件 |
| Current tool and MCP catalog | 当前权限可见且初始已披露的工具名称、绑定 ID、修订、动作、描述和 Schema 哈希；完整定义仍随当次模型请求发送，不重新联网发现工具 |
| Source guide prerequisites | 来源指南的 current/unread/changed/unavailable/inactive 状态；检查不改变阅读状态，不代替模型主动读取指南 |
| Execution and agent status | 当前 Pi 子进程生命周期、仅本 runId + taskId 的待审批/执行中/unknown 调用；遇到未决执行优先核对，不自动重放 |

读取资源只记录宿主 `read_source_guide`、`read_skill_resource`、`read_tool_result` 和 `read_plan` 的成功结果；来源返回的任意 path、Skill 或 Agent 声明不成为宿主工作状态。指南或 Skill 资源变更后不再注入旧片段，保留失效状态与重读入口；不会自动认可新版指南或重装 Skill。资源片段仍为不可信资料，先脱敏再裁剪，所有结构字段也在 JSON 序列化前脱敏，再经统一附件 Schema 与总上下文预算检查。目录元数据分块，不能容纳时明确失败，不悄悄漏掉工具。

新增 `workflow__read_plan` 仅读取本次运行已提交、哈希一致的计划，不接受任意文件路径；默认 1024、最多 4096 字符，通过 nextOffset 翻页，走既有执行器、权限与预算。宿主状态从实际 observations 和当前运行执行账本计算来源进度，已采集的来源不会仅因摘要省略而被标成未开始。

当前项目只有来源指南、Skill 资源和运行归档等受控读取，没有通用代码文件读取工具；这里不宣称追踪任意代码文件。计划是调查计划，权限模式 explore/ask/allow-all 仍是权限模式。项目没有 Plan Mode、延迟加载工具或异步子 Agent 调度，附件明确标记这些能力不支持；普通未决执行与 Pi 进程状态按实际记录恢复。

## 摘要回到原始转录的入口

每次正式压缩的最终摘要除了结构化续办记录，还由宿主加入 `transcript` 与 `transcriptLookup`。`transcript` 包含完整 JSONL 绝对路径、sessionId、throughEntryId、snapshotHash、entryCount 和 `session__read_transcript` 工具名。模型只生成续办内容，不能自行填写或覆盖这些身份字段；宿主在落盘确认后的原生条目上确定回查位置。多次压缩刷新该入口，旧摘要和旧完整转录仍留在 JSONL；离线重建活动上下文也保留入口。

`session__read_transcript` 按 `throughEntryId` 固定本次会话的转录前缀，不接受任意路径或 sessionId。默认从 offset 0 读取 1024 字符，最多 4096 字符，以 nextOffset 翻页；可添加 entryId 读取其中一条原生记录，或添加 query 在 JSONL 序列化文本中做大小写敏感的字面搜索，两者不能并用。返回匹配记录的 JSONL 文本、分页位置、匹配数量和快照身份，片段可能跨行，需分页拼回后再解析。原始用户消息、assistant 文本/代码/错误、工具调用及结果、原生元数据与请求归档都可回查，不局限于工具结果。

读取前验证磁盘上的 header 及截至锚点的所有条目身份、顺序与宿主落盘时的哈希，防止静默读取被修改或缺失的原文。哈希按实际 JSON 持久化形状计算，忽略 SDK 对象里不会写入 JSON 的 undefined 字段。固定前缀不会随新的工具读取回执增长，避免分页追逐自身输出；这不是任意时刻整份增长文件的固定总长度。摘要中的 path 是定位信息，读取权限仍来自本次运行工具；入口工具被撤销后停止继续使用带有回查承诺的压缩上下文。

工具沿用 ToolExecutor、IPC、权限、取消与预算，不能重放归档操作。读取的是已脱敏原文，标记 untrusted，归档里的历史指令不改变当前宿主权限。最近成功的转录回查也记录到工作状态附件。摘要负责继续任务，原始转录用于核对细节；这里只承诺在当前宿主会话中受控回查及离线定位，不新增自动崩溃续跑或跨会话文件访问能力。

## 独立持续更新的 Session Memory

Live Pi 运行默认启用 Session Memory，独立保存为 `session-memory/<runId>.json`（`memory` 文档及 `contentHash`）。完整 transcript 继续只追加；正式 compact 仍负责控制活动窗口。Memory 维护当前目标、已完成工作、关键文件、错误与修复、未完成任务、下一步和引用/缺口，不通过删除历史或每次重扫第一条消息更新。

| 检查点字段 | 用途 |
|---|---|
| policy.initializeTokens | 初始化所需的当前窗口压力阈值，默认 12000 Token |
| policy.growthTokens / windowGrowthTokens | 两次更新间累计的正向窗口增长，默认增长 4000 Token 触发更新；窗口缩小不产生负增长 |
| policy.toolCalls / toolCallCount / toolCallsSinceUpdate | 默认新增六次工具调用触发更新；保存截至游标的累计调用数及本次覆盖的调用增量，窗口压缩不会清空调用历史 |
| lastMessageId / messageCount | 最后已处理的原生 message ID 和消息数量，截点只能落在完整 API 轮次之后 |
| revision / pendingMessages | 宿主版本检查及待处理增量标记，防止重复提交、回退游标或批次丢失 |
| windowTokens / transcript / updatedAt | 更新时的窗口压力、完整转录回查入口和时间；记录估算/usage 口径，不冒充提供方精确输入数 |

在工具结果治理之后、正式压缩判断之前检查更新条件。第一次达到初始化阈值后才建立 memory；此后窗口增长或工具调用数达到任一阈值且存在新增完整轮次时更新。每次最多处理一个有界批次，未处理完的增量以 pendingMessages 标记，下轮继续；不裁断工具调用/结果，也不悄悄跳过过大消息。窗口缩小时仍能按累计工具调用推进。没有新增完整轮次时不重复请求。

隔离维护上下文只读取宿主最新 memory 和 lastMessageId 之后的新原生消息，使用治理后的只读工具结果投影；不重新注入整个会话、历史 memory 请求或业务工具定义。已有 SDK `ModelRuntime.completeSimple` 承担无工具的独立维护请求，使用同一模型和取消信号。这实现了截图中隔离增量维护的职责，未调用或假定 SDK 存在 forked Agent API，也没有新增并发后台子 Agent。当前执行在下一轮业务请求前串行完成。

宿主经独立 session_memory IPC 端口读写文件，校验 sessionId/taskId、内容哈希、版本号、原生转录完整性、游标进度和工具轮次配对。模型仅生成工作状态正文，身份、版本、计数与路径由宿主补齐。文件原子替换并读回校验。输出截断和工作状态格式错误会触发受控重试。校验始终未通过、模型无有效 usage、返回工具调用、预算耗尽、取消、版本冲突或写入失败时停止运行并保留旧检查点。已完成的原子写入不会因后续的进程取消或审计故障自动回滚。

Memory 请求与响应分别作为 `cwatch.memory_request` / `cwatch.memory_response` 追加到完整转录，成功后记录 checkpoint 元数据与 `session_memory_updated` Trace；`model_usage.purpose=memory` 纳入累计 Token、模型超时和调查超时，不增加业务决策或业务工具次数。初始化阈值前不会凭空增加维护模型请求，Replay 固定脚本不运行该维护链。

`session__read_session_memory` 可读取本次运行最新文件（尚未初始化时返回 initialized:false），走既有执行器与权限。正式 compact 后会附上已保存 memory、文件路径、lastMessageId 和滞后说明；更新较新的宿主 workflow 状态与新消息优先。Memory 可以滞后，最终 respond 后不强制额外更新，也不自动作为跨运行长期记忆或崩溃恢复入口。

程序调用者可通过 `RuntimeOptions.sessionMemory` 调整 initializeTokens、growthTokens、toolCalls、maxInputChars，或设为 false 关闭。默认维护输入最多 48,000 字符，同时受总上下文与模型窗口约束。一般模型首次输出最多 1,024 Token，支持 Step 5 专用推理契约的模型首次输出最多 2,048 Token，已有检查点时为 3,072。重试重新获取预算，输出最多 4,096 Token，输入缩到首个完整增量轮次，其余增量通过 pendingMessages 留待后续更新。输出截断最多补一次。JSON 或字段校验失败会把缺失字段、字段类型和多余字段等具体错误放进下一次请求的 `validationErrors`。每次更新最多发出三次请求。完整通过格式及 12,000 字符的正文校验后才保存。首个完整轮次无法装下则停止。

维护请求的推理契约按实际端点核对。仅对 HTTPS 官方 api.stepfun.com / api.stepfun.ai 的 step-5-preview 使用官方 reasoning_effort=low 与 response_format=json_object，经 SDK samplingParams 传递；low 不承诺关闭 thinking，推理与正文仍共享输出预算。其他模型不猜测供应商参数，也不把 SDK 的 thinking/off 配置当作供应商已关闭推理的证据。依据为 [Step 5 官方推理参数说明](https://platform.stepfun.com/cookbook/step-5-reasoning)。SDK 通用 HTTP 重试显式设为 0。cwatch.memory_wire_request 保存不含凭据的实际输出上限、推理档位、格式和工具数量；cwatch.memory_recovery 记录 retry/stop 及正文、thinking 字符数。每次已返回的 usage 都在判断恢复前计量；取消但没有返回 usage 的请求只保留请求证据，不虚构零用量。恢复仍受模型/运行超时及同一取消信号控制，恢复失败不新增自动续跑承诺。

## 供应商长度拒绝后的反应式恢复

预估低于阈值仍可能被供应商按实际 tokenizer、工具 Schema 或多模态计量拒绝。适配器只对 SDK 返回的 assistant `stopReason=error`、无可见部分输出、且 errorMessage 明确匹配输入/上下文长度拒绝的情况尝试恢复；支持 context_length_exceeded、prompt too long、maximum context length 等明确模式。401/403/429/5xx、鉴权、配额、限流、网络/超时、普通参数错误、裸 413、length 输出截断、aborted 或带部分正文/工具调用的响应不触发这条路径；不因普通来源文本提到长度错误就重试。

先将失败响应完整落盘，再追加 `cwatch.provider_rejection` 身份标记。仅原生 ID、类型和明确失败性质均校验通过的条目退出活动投影，原始消息与错误仍能通过 transcript 回查；离线重建应用同一规则。该过滤同时用于完整轮次分组、压缩提交校验及 Session Memory 增量，不允许把正常 assistant/user 消息冒充失败条目隐藏。

随后复查业务请求轮数、当前宿主模式、初始已披露且尚有效的工具绑定；显式执行结果治理和强制 compact，采用最近一整轮保留策略，跳过本次可选 memory 维护请求。摘要、附件、hook、原文入口及提交仍走原有校验、落盘与预算链。候选必须比排除失败回执后的原上下文明显缩小才重试；没有可缩小历史时停止，不重复发送相同提示，也不丢弃原始任务或截断工具配对。

恢复使用已核对的 SDK `session.agent.continue()`，从重建后的 user/toolResult/custom 末尾继续尚未满足的模型请求，不重新提交 user task，也不重新派发已完成工具。SDK 内置 compaction/retry 仍关闭。重新计算剩余输出额度，压缩和重试共用调查/模型超时、取消及累计 Token 预算；失败供应商回执可用的 usage 以 purpose=rejected 记录，没有有效 usage 时不虚构精确计费，后续摘要/成功响应仍正常计量。重试也消耗新的业务请求轮数。

熔断器按运行独立维护 attempts、consecutiveRejections、open：一个连续拒绝事件只允许一次压缩后重试，第二次连续长度拒绝立即打开；有效业务决策会清除连续拒绝计数，但单次运行累计最多两次恢复尝试，不能靠间歇成功无限重试。摘要/提交失败、无法缩小、预算或权限检查失败时直接打开并停止，不递归压缩失败摘要或自动重复摘要请求。取消仍向上传播；没有后台重试、冷却后自动半开或跨运行恢复循环。

`cwatch.reactive_compact` 保存 started/retry/recovered/stopped、前后体积及熔断状态，Trace `provider_rejected` 把失败原生 entryId 关联到当前待决业务请求，防止恢复前后出现伪造决策或重叠请求。原始拒绝消息始终保留。本实现采用反应式恢复原则，未宣称启用 Claude 内部 feature gate 或完全覆盖所有供应商的错误格式。

## 稳定前缀与 Prompt Cache

三条链路分开：Prompt Cache 面向重复输入前缀的供应商复用；Session Memory 按游标维护下一轮需要的工作状态；Compact 在活动窗口不足时重建上下文。缓存没有存放本项目可恢复的业务状态，命中也不允许跳过指南、审批、最新权限、原始转录、memory 更新或压缩。

ContextPipeline 现在按“硬规则 → 已选 Skill 快照 → 实体/来源白名单/时间窗 → 当前权限模式 → 当前来源状态”组织 System Prompt，观察值与执行进度不插入稳定开头。权限和来源状态仍每轮刷新；不为了保留缓存而沿用过期规则或工具。工具按代理名排序，Schema 先取实际 JSON 形状再规范化键顺序，说明/Schema 不变时可稳定复用，替换或撤销绑定仍遵守初始披露约束。

SDK ResourceLoader 首轮会附加工作目录后缀；续轮及反应式恢复现在保留同一静态后缀，修复了首轮与普通续轮 System Prompt 不一致的问题。若安装 SDK 改变这一已核对的组装契约，适配器明确报错，不静默丢弃 SDK 提示。context_prepared 记录 prefixHash（宿主静态部分）与 toolsetHash（名称/说明/规范化 Schema），完整请求仍归档；这些指纹只证明输入是否变化，不证明供应商命中。权限/工具变化可以使实际缓存失效，供应商也可能以整个 System 块为断点，不保证保留局部缓存。

业务请求显式采用 SDK `cacheRetention=short` 和本次 sessionId。程序接口 `RuntimeOptions.promptCache='none'` 可关闭 SDK 显式缓存控制；当前只提供 none/short，没有专用 CLI 参数或任意 TTL/厂商字段。摘要、Session Memory 维护及单次连通性探针使用 cacheRetention=none，与稳定业务前缀分别处理。none 是 SDK 控制偏好，不是强制供应商停止隐式自动缓存的承诺。

已核对本地 SDK StreamOptions.cacheRetention/sessionId、Anthropic 的 cache_control 生成和 OpenAI-compatible usage 归一化。标记和字段由 SDK 的实际 API/compat 映射，项目不向未知兼容端点手写 prompt_cache_key、cache_control 或长缓存字段，也不启用 cache editing / cached microcompact。现有 microcompact 只是本地活动结果投影，与供应商缓存编辑不是同一能力。

每条 model_usage 增加 cache 观测，usage_reported.cacheUsage 按 turn/summary/memory/rejected 汇总读/创建 tokens、归一化输入 tokens 和有正读用量的响应数量。正 cacheRead 标为 reuse_reported；零值标为 no_positive_reuse_reported，不称为已确认 miss；缺失/非法字段为 unavailable/null。SDK 可能将供应商未提供的缓存字段归一为零，因此不能据零值推断支持情况。reportedCacheReadInputShare 是 cacheRead/(input+cacheRead+cacheWrite)，不是请求命中率、缓存容量或费用节省率；未计算费用节省，也不把未知价格当零费用。

缓存命中的输入仍完整计入上下文压力与累计 Token；不会因命中而放宽窗口、回答预留、Memory 阈值或总预算。缓存控制关闭时若供应商仍报告自动复用，继续记录实际读用量并正常计量。Memory 和 compact 的正确性不依赖缓存是否可用，转录和独立 memory 文件都不会因为缓存设置而删减。

## 恢复边界

JSONL 保留原生会话条目，可离线重建历史及边界。当前 CLI recover/replay 的契约仍为业务状态审计，不自动从转录恢复并继续执行。继续运行涉及宿主业务阶段、已发生副作用、权限和绑定重新校验，不能仅装载模型消息就宣称安全恢复。
