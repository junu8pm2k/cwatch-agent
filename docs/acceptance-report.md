# 2026-10-27 结构化 Trace 验收

2026-10-29 清理说明：内置 eval case、题单、材料及对应评测归档已删除。下文中的旧案例数量、路径与成绩仅描述历史；当前状态见 [评测状态](evaluation.md)。

下文的数字记录历史验收。当前评测和报告入口见 [Agent Benchmark](../evals/README.md)，历史验收证据见 [审计摘要](../artifacts/history-summary/README.md)。

- 任务终态自动导出 `cwatch.structured-trace.v1` JSON；模型轮次、工具与后端阶段关联，保存权限、用量、耗时和归一化错误。原 JSONL 保留为审计来源，支持历史转换和 Web 查询。
- 评分器按原始事件和 SHA-256 重建视图，拒绝被篡改或不一致的结构化文件。导出写入失败不丢失原始终态，未知请求次数、价格与辅助请求耗时保留 null。
- `npm run verify` 551/551（contract 383、semantic 63、integration 105），结构与 TypeScript 检查通过；`npm run test:trace` 10/10。日志为 `artifacts/structured-trace-verify.log`、`artifacts/structured-trace-tests.log`。历史 CLI 转换合成双调用样例通过；没有新增外部模型请求。
- 清理测试工作目录、一次性调试产物及无引用旧日志，保留评测原始证据、文档引用日志和本机配置。实际数量见 `artifacts/cleanup-summary.json`；结构与使用方法见 [结构化 Trace](structured-trace.md)。

# 2026-10-24 官方来源发现 P1 验收

- 将原来源 urls/allowedDomains 披露至 Web 工具目录；内置调查 Skill 明确使用官方 site: 查询、已确认起始 URL、冻结参考分母和独立计数。未改三站原来源配置、白名单、MCP 地址/凭据或抓取路由。
- 每产品三次定向查询、每次 limit=10：上游合计返回 90 次候选出现，81 次越域过滤，白名单内去重后分别 2/1/0，精确参考入口搜索命中 0/9；上游搜索仍弱，不能认定搜索召回完全通过。
- 显式抓取九个原起始 URL，正文可用 9/9，人工核对主体及错误页；完整快照验证通过。Kimi 文章与 MiniMax 更新日志有明确本地截断，其他页上游完整性未确认，不冒充全站/整页覆盖。Web 候选和正文仍为发现材料，自动结构化信号为零。
- 独立原 GitHub 来源实跑 HTTP 200，原始 signals 1/10/10，实体匹配且窗口内、非未来的 signals 1/4/10；不把一页 releases 或网页正文数当全部事件数量。六份 Trace 校验无问题，没有生成完整调查报告或虚报整体通过。
- npm run verify 466/466（contract 334、semantic 34、integration 98），结构、类型、git diff --check 通过；专项 62/62。日志 artifacts/p1-discovery-verify.log、artifacts/p1-discovery-targeted.log。具体证据与未覆盖项见 [官方来源发现验收](p1-discovery-acceptance-2026-10-24.md)。

# 2026-10-24 GitHub 限流 P1 修复验收

- GitHub REST 的主/次级限流 403/429 与真正 401/普通权限 403 分开处理；GitHub 特有语义仅用于其配置的官方 origin。严格 http.rateLimit 元数据白名单记录实际额度、UTC reset、Retry-After 与最早再尝试提示，不保存任意响应头或凭据。
- 有效 Retry-After 与 primary reset 同时出现时取更晚提示；次级无有效提示仅记录带来源标签的一分钟建议。缺失/非法/过期主 reset 不补造未来时间；适配器无等待或自动重试。限流保留失败与来源缺口，不声明无更新、不产生事实。
- 原公共凭据配置下串行复验三仓均 HTTP 200，remaining 分别 33、32、31 / 60，Trace 无问题；这是复验时的响应头观测，不保证当前额度。三份原真实 403 正文离线重分类均为 rate_limited，缺失历史响应头的重试时间保持未知；未刻意耗尽额度。
- npm run verify 457/457（contract 329、semantic 30、integration 98），结构与类型检查通过；专项 40/40，git diff --check 和新实跑产物凭据扫描通过。日志 artifacts/p1-github-verify.log、artifacts/p1-github-targeted.log。
- 实现边界、官方依据、runId 与证据见 [GitHub P1 验收](p1-github-acceptance-2026-10-24.md)。本轮没有生成或评定完整调查报告、没有修改前端或额外运行视觉验收。

# 2026-10-24 抓取超时 P1 修复验收

- 确认原 MCP 服务正常返回但耗时约 30 秒：旧客户端 30 秒请求上限冲突；延长上限后另暴露 structuredContent.page.markdown 未识别。新增有界 requestTimeoutMs 及嵌套正文归一化，错误 code、空正文、多页和返回 URL 不符仍拒收。
- 三份竞品来源显式设 searchMcp.requestTimeoutMs=60000；未改 MCP 地址/token、起始 URL 或白名单。父工具恢复原 45000 后三站正文 3/3 成功，约 30.6–30.8 秒；前后 serverId 相同，所有后端阶段均为 mcp.remote.*，Trace 校验无问题。
- 新增独立 scripts/probe-competitor-fetch.ts。正文字符 ZCode 12245、Kimi Code 1783、MiniMax Code 2550；人工核对产品内容，无验证码/拒绝页。上游整页完整性未确认，发布时间保持未知，不升级为结构化事实或宣称整项调查通过。
- npm run verify 447/447（contract 321、semantic 30、integration 96），结构与类型通过；相关抓取回归 79/79，git diff --check 通过。日志 artifacts/p1-fetch-verify.log、artifacts/p1-fetch-targeted.log。
- 实跑、配置差异审计、原始快照与完整性边界见 [抓取修复验收](p1-fetch-acceptance-2026-10-24.md)；本轮没有改前端或额外运行视觉验收，没有发布或发送外部消息。

# 2026-10-24 Memory 输出预算 P0 修复验收

- 核对实际模型为 StepFun step-5-preview，旧 Memory 输出固定 1024 且本地 thinking/off 未转换为供应商推理参数。维护请求仅对已核对的官方端点使用 low 推理及 JSON 格式，新增实际 wire 参数归档，不向其他兼容端点猜测参数。
- length 截断最多一次受控恢复，重新获取预算并缩小到首个完整 API round；所有已返回用量累计计量、请求可取消，第二次截断及非法/无用量/超预算响应停止且不提交非法 memory。待处理增量保留，不关闭 Memory 或重放业务工具。
- 最终 npm run verify 442/442（contract 318、semantic 30、integration 94），结构与类型检查通过；Memory 专项 16/16，git diff --check 通过。日志 artifacts/p0-memory-verify.log、artifacts/p0-memory-targeted.log。本轮未改前端，未额外重跑独立浏览器视觉检查。
- MiniMax 保持原配置、原预算真实复跑：两次恢复成功，提交三个合法检查点；共六次维护请求均计量，维护用量 48363、总用量 91035，超过原 80000 门禁后明确停止。最后一次截断回复未提交，无报告，整项调查仍 failed。Trace 校验无问题，不把局部恢复成功当作原功能通过。
- 实现边界、原始请求/响应和新 runId 见 [Memory 修复验收](p0-memory-acceptance-2026-10-24.md)。后续仍需降低维护开销并改善调查收敛。

# 2026-10-24 多工具调用 P0 修复验收

- 模型单轮多调用归一化为带 SDK ID 的 call_tools 决策，宿主登记队列并按顺序逐项授权执行；保持原单调用、审批、取消和执行握手。未知工具失败结果按 ID 保留，不丢弃后续调用或伪造成功。
- 新增批内身份、重排、重复 ID、提前结束、未完成决策覆盖、伪造 Observation、未执行却报成功，以及独立审批、预算、撤权、取消和无进展等回归；Trace 校验补齐批次顺序与结果完整性。
- 最终 npm run verify 435/435（contract 314、semantic 30、integration 91）；npm run eval:web 9/9；Replay 批次与工作台活动补充检查通过。日志 artifacts/p0-multicall-verify.log、p0-multicall-web.log。
- 原配置真实复跑 ZCode/Kimi：分别完成一批 3 调用和两批共 5 调用，Trace 校验通过，已越过原先的多调用拒绝；两次随后均因独立的 Session Memory 响应截断而 failed，未生成报告，不宣称端到端调查通过。
- 具体实现、命令边界和新 runId 见 [多调用修复验收](p0-multicall-acceptance-2026-10-24.md)；原始首轮失败及来源诊断保留。未改写模型/搜索凭据，Memory 保持启用，未发布或发送外部消息。

以下保留此前历史验收记录。

# 2026-10-22 项目 Skill 结构规范化验收

- 内置普通 Markdown SOP 迁移为 skills/general-agent/SKILL.md 和 skills/competitor-investigation/SKILL.md，目录与 name 一致；research-brief 与 competitor-review 示例补齐适用请求和排除条件。四份正文明确任务目标、流程、输出和必要约束，较长的审查清单仍按需读取。
- 宿主按任务类型选择内置包，用户扩展仍显式选择；不把 description 当成已经实现的自动路由。默认加载器解析 frontmatter 后仅注入正文，已更新状态附件的 Skill 名称与路径。显式 skillPath 指向的旧普通 Markdown 仍兼容读取，标准 SKILL.md 缺失 frontmatter 时明确拒绝。
- Skill Creator quick_validate.py 四份均通过；所需 PyYAML 仅安装于忽略的 artifacts/skill-validation/python，没有修改项目依赖或系统 Python。新增契约用例验证两份内置包可安装、默认加载不注入 YAML、旧覆盖路径兼容和非法入口拒绝。
- npm run verify 418/418（contract 298、semantic 30、integration 90），含 Skill 安装/资源读取、通用任务、真实 SDK 多轮与压缩协作；类型、结构和 git diff --check 通过。日志 artifacts/skill-normalization-verify.log。模型协议测试仍使用本地脚本提供方，不表示真实模型的 Skill 选择或生成质量已获验证。

以下保留此前历史验收记录。

# 2026-10-22 用户多轮会话验收

- 通用 Agent 新增 nextUserMessage 宿主端口与带身份/序号校验的 next_user_message IPC。最终答复完成后等待下一条用户消息，同一 SDK Session 反复 prompt；Transcript、Memory 游标、压缩边界和宿主工具状态持续保留，正常结束才 dispose。调查模板与原单次任务入口保留原契约。
- 追问首个请求刷新权限、已披露绑定与宿主规则，通过 SDK transformContext 接入治理/Memory/Compact，并同步循环消息及 agent state，防止后续工具续轮复活已压缩长文。等待输入暂停执行与模型计时，预算按会话累计，不重放既有工具；no-progress 检查按用户轮次划界。
- 工作台真实通用 Agent 默认开启交互：对话记录、发送追问、正常结束、刷新续聊；HTTP 消息 ID 去重、忙碌/冲突拒绝及快照 revision 防倒序。CLI --chat 已在实际 PTY 中完成两轮本地模型对话和 /exit 正常退出。服务重启只恢复历史显示并标记中断，未实现自动恢复执行。
- 完整 npm run verify 416/416（contract 297、semantic 30、integration 89）；最终复核修正外层准备超时计时器后，会话专项 9/9，包括新增等待超过准备时限再追问的回归。npm run verify:web 9/9；五个 workspace 独立类型检查、结构检查及 git diff --check 通过。日志为 artifacts/conversation-verify.log、conversation-web.log、conversation-workspaces.log；移动端截图为 artifacts/web-eval/conversation.png。
- 模型测试使用真实 Pi SDK、worker、HTTP/SSE 与本地脚本提供方；浏览器和 CLI 使用真实用户输入链路，没有调用付费模型，不把这些用例视为真实模型记忆准确率验证。协议、使用方法及剩余边界见 docs/conversations.md。

以下保留此前历史验收记录。

# 2026-10-20 稳定提示前缀与缓存观测验收

- System Prompt 按硬规则、Skill 快照、实体/来源/时间窗、当前权限与来源状态组织，工具代理名与实际 JSON Schema 键确定排序；动态权限、来源撤销和原始披露检查保持有效。新增 prefixHash/toolsetHash 观测，指纹不被当作缓存命中。真实请求对比发现并修正 ResourceLoader 首轮附加 cwd 后缀、续轮刷新却丢失的差异，正常续轮和反应式恢复均保留相同静态后缀。
- 业务请求通过 SDK cacheRetention=short/none 和本次 sessionId 控制；维护摘要、Session Memory 与模型探针显式为 none。标记由 SDK API/compat 决定，不向未知兼容端点手写缓存字段，不开放长 TTL、cache editing 或 cached microcompact。程序接口可设 promptCache=none；该值不承诺供应商停止隐式自动复用。
- 新增按 turn/summary/memory/rejected 的缓存读、创建和归一化输入用量观测与汇总；正读用量与 SDK 归一化零值、缺失字段分开，读 Token 占比不冒充请求命中率或费用节省。Cache 命中仍完整计入窗口和 Token 预算，不替代 Memory、Compact 或原始转录，不保留过期权限换缓存命中。
- npm run verify：380/380，contract 274、semantic 30、integration 76；结构检查 68 个源文件、336 个导入，五个 workspace 独立类型检查及 git diff --check 通过。新增六项用例，覆盖稳定/动态上下文位置、Schema 与工具排序、撤销绑定、缓存零值与缺失、完整 Token 计量、真实 SDK Anthropic 标记序列化、实际 Pi 请求前缀一致及 none 控制下的记录；既有摘要/Memory 测试增强为检查维护请求使用 none。
- Anthropic 标记测试在 onPayload 中截断，确认未调用 fetch；其余协议使用真实 Pi 子进程与本地 HTTP/SSE 脚本提供方。测试没有证明真实供应商命中、费用下降或延迟收益，也未调用付费真实模型。详细职责与观测口径见 session-context.md、run-limits.md。

以下保留此前历史验收记录。

# 2026-10-20 供应商长度拒绝的反应式恢复与熔断验收

- 新增长度拒绝识别，仅对原生 SDK assistant error、无部分输出且错误文本明确指向输入/上下文超长时恢复；排除鉴权/限流/服务故障/网络/普通参数错误及部分正文或工具调用。失败响应保留在原生转录，通过经身份和类型校验的 cwatch.provider_rejection 标记退出活动投影，离线重建和 Session Memory 增量遵守相同过滤。
- 反应式路径复查业务请求预算与当前权限/绑定，强制治理并压缩，保留最近一整轮，候选必须实际缩小，再用 SDK Agent.continue() 继续未满足请求，不重提任务或自动重放已完成工具。SDK 自带自动压缩和通用重试仍关闭；摘要、附件、回查入口和持久化提交沿用既有协议。provider_rejected Trace 关联失败 entryId 与待决模型请求，维护严格的请求/决策顺序。
- 一个连续拒绝事件仅允许一次恢复重试；第二次连续拒绝熔断。成功业务决策清连续计数，但单运行总恢复尝试上限为二。无法缩小、摘要被拒绝/无用量/非法、预算、取消或提交失败直接停止，不递归压缩失败摘要。可用拒绝 usage 标为 rejected 并正常计量，不把缺失用量冒充已知零费用。
- npm run verify：374/374，contract 269、semantic 30、integration 75；结构检查 67 个源文件、335 个导入；五个 workspace 独立类型检查与 git diff --check 通过。新增十二项用例，覆盖保守识别与误报排除、连续/累计熔断、投影身份、低于预估阈值的真实 HTTP 400 恢复、重建、无可压缩初始提示、摘要拒绝、取消、请求预算、来源撤销、限流及增量 Session Memory 协作。已完成来源工具调用数量在恢复后保持预期，完整错误原文保留。
- 使用真实 SDK、Pi 子进程和本地 HTTP/SSE 脚本提供方，不是所有供应商错误格式或真实模型生产效果的验收，也不宣称启用 Claude 内部 feature gate。恢复次数、错误范围、成本和持久化边界见 session-context.md 与 run-limits.md。

以下保留此前历史验收记录。

# 2026-10-20 独立增量 Session Memory 验收

- Live Pi 默认新增 session-memory/<runId>.json，维护当前工作状态及宿主身份、版本/哈希、初始化和更新阈值、正向窗口增长、累计/本次覆盖工具调用数、最后已处理原生 message ID、消息数与待处理批次。默认窗口压力 12000 Token 初始化，增长 4000 Token 或新增六次工具调用时更新，可由程序接口调整或关闭。
- PiSessionMemory 只把最新 memory 与新增完整 API 轮次交给无工具的隔离 ModelRuntime.completeSimple 请求，按有界批次推进，不重扫整份 transcript 或截断配对；窗口缩小仍能按工具调用数更新。没有宣称 SDK forked Agent API 或并发后台子 Agent。宿主通过 session_memory IPC 校验 CAS 版本、会话、转录内容与游标后原子写入，提交前失败不推进检查点；维护请求的 Token、超时和取消纳入原预算，purpose=memory 单独记录。
- 新增 workflow__read_session_memory，并在正式压缩后附上最新已提交 memory 及游标/滞后说明；宿主新状态和更新消息优先，完整 transcript 保持追加。当前状态检查点不等同跨运行长期记忆、最终答复后的强制同步或自动恢复执行。
- npm run verify：362/362，contract 260、semantic 30、integration 72；结构检查 66 个源文件、330 个导入，五个 workspace 独立类型检查和 git diff --check 通过。新增八项用例，覆盖阈值/增长/调用数、窗口缩小、批次无重无漏、完整配对、非法回复、用量/取消、磁盘/版本/身份/篡改，以及真实 Pi 子进程的增量请求、读取、计费和默认阈值下的正式压缩协作。此前 Pi 回归默认显式关闭维护以隔离原测试职责，新增专项显式验证启用路径和默认策略。
- 使用真实 SDK、子进程及本地 HTTP/SSE 脚本提供方，未调用付费真实模型；校验和固定样本不证明 memory 语义必然正确。参数、成本与滞后边界见 session-context.md 和 run-limits.md。

以下保留此前历史验收记录。

# 2026-10-20 摘要回查完整原始转录验收

- 每份正式摘要由宿主加入完整 JSONL 绝对路径、会话身份、原生条目锚点、快照哈希及读取说明；模型生成的续办内容不能伪造这组元数据。多次压缩刷新引用，活动上下文离线重建保留回查入口。
- 新增 workflow__read_transcript：仅本次会话固定前缀，分页默认 1024、最多 4096 字符，支持按 entryId 或最长 200 字符的 JSONL 字面 query 查询，拒绝任意路径/会话参数、外部身份和越界页。可核对旧用户要求、assistant 代码/错误/说明、工具结果及请求归档；逐条验证已落盘 JSON 形状、顺序和哈希，数据保持脱敏与不可信属性。读取经过既有 ToolExecutor/IPC/预算，不重放历史操作；读取回执不改变已固定分页范围，成功回查进入最近资源状态。
- npm run verify：354/354，contract 254、semantic 30、integration 70；五个 workspace 独立类型检查通过。最终绝对路径与资源状态接入后，七项转录/多次压缩/真实 Pi 专项回归再次通过，根类型与结构检查通过（63 个源文件、309 个导入），git diff --check 通过。
- 新增四个转录读取契约用例和一个多次压缩集成用例；既有真实 Pi 子进程压缩场景增加从摘要取得入口、调用工具找回旧 assistant 原文并继续调查的验证。测试发现并修正 SDK 对象 undefined 字段与实际 JSON 持久化形状不同导致的哈希误报。全部模型协议测试使用本地 HTTP/SSE 脚本提供方，不是付费真实模型质量或生产恢复验收；当前磁盘读取并非大文件流式索引。详见 session-context.md。

以下保留此前历史验收记录。

# 2026-10-20 压缩后工作状态重新注入验收

- 新增宿主 WorkingStateTracker，压缩附件补齐核验后的计划内容/分页入口、阶段、来源采集进度与下一步、最近成功资源读取、已加载 Skill 和资源使用、当前已披露工具绑定目录、指南前置检查与 Pi 进程/本次运行未决执行。没有将权限模式当作 Plan Mode，也未虚构延迟工具或异步子 Agent 支持。
- 最近六个资源各保留最多 1200 字符片段，计划预览最多 4000 字符；先脱敏再裁剪，避免秘密跨片段边界泄露。资源变更抑制旧片段，不自动更新指南阅读状态或安装 Skill；计划必须与本次已提交版本一致。工具目录分块并纳入附件/上下文限额，未决副作用不重放，其他 runId/taskId 执行不混入。
- npm run verify：349/349，contract 250、semantic 30、integration 69；结构门禁 63 个源文件、306 个导入，五个 workspace 独立类型检查通过。最后的脱敏与内置 Skill 路径校正后，五个状态专项用例及两个真实 Pi 压缩用例再次通过，根类型/结构检查和 git diff --check 通过。
- 新增五个契约测试，既有真实 Pi 子进程压缩用例补充实际读取来源指南、Skill 资源和计划后继续完整调查的断言，验证附件进入下一次 HTTP 请求、重读入口、状态保留及秘密跨预览边界脱敏。使用本地 HTTP/SSE 脚本提供方，不能据此宣称真实模型一定不会重复决策或具备生产恢复能力。详细契约见 session-context.md。

以下保留此前历史验收记录。

# 2026-10-20 正式压缩完整 API 轮次与重建提交验收

- 新增 API round 分组及每次模型流前校验，按一个 assistant 响应和全部匹配工具结果组织保留消息；支持组内结果乱序和跨轮次复用 ID，拒绝缺失、重复、孤立、错名或跨响应配对。保留目标为最近两轮，预算不足或跨旧压缩边界时保留一整轮；不会开放业务多工具并行执行。
- 正式摘要改为必需字段的结构化续办记录，覆盖用户目标、已完成工作、关键文件、错误与修复、未完成任务、具体下一步、精确引用和来源缺口。泛泛概述、缺少字段或空 nextSteps 不可提交；格式约束不替代真实摘要内容质量验收。
- 重建顺序为原生 Compact Boundary/摘要 → 保留完整轮次（含初始任务）→ workflow 状态附件 → 显式 RuntimeOptions.onPostCompact hook 结果。宿主经 IPC 提供当前阶段、计划路径、claim/evidence ID、报告、来源/权限状态和可重读结果引用，脱敏后作为数据注入；不授予执行权限或自动发现脚本。
- 新增 cwatch.compact_commit 逻辑提交。摘要、轮次、附件与 hook 结果整体通过预算后才追加；元数据不进入模型正文。缺少提交的半成品边界在离线重建时回退到上一完整上下文，保留身份和附件顺序不符的提交明确拒绝；旧版无提交标记的原生 compaction 兼容读取。完整转录不删除，不宣称数据库原子事务或自动续跑。
- npm run verify：344/344，contract 245、semantic 30、integration 69；结构检查 62 个源文件、297 个导入。五个 workspace 独立类型检查通过；最终附件投影的预算预检/实际大小一致性断言、上下文/API round 专项和真实 Pi 压缩/hook 集成专项通过，git diff --check 通过。
- 本轮新增 10 项回归，覆盖完整多调用轮次、未完成轮次不压缩、两轮保留/排队用户消息、结构化摘要、附件/hook 顺序与重载、hook 失败/超大/取消、提交写盘中断、历史格式兼容，以及分组异常；既有真实 Pi 调查用例增强验证宿主附件与 hook 经 IPC 进入下一次模型请求。
- 验证使用真实 SDK、子进程与本地 HTTP/SSE 脚本提供方；未新增付费模型摘要质量验收。依赖版本和 .env 未改写，CLI 恢复仍为业务审计。SDK 实锚及契约见 session-context.md、sdk-adapter-map.md。

以下保留此前历史验收记录。

# 2026-10-20 摘要之前的工具结果治理验收

- 新增 ToolResultGovernor：原始结果落盘确认后，先按整条消息预算 snip（非 raw 字段及 details 同样覆盖），再按窗口压力将旧成功只读结果 microcompact 为可重读占位，最后才决定是否发起正式摘要。单条默认最高 16000、随上下文上限收紧，保留首尾预览和归档身份。
- 编辑按 entryId + toolCallId/toolName 绑定，以 custom entry 追加到完整转录；原始消息、宿主 observations、工具调用配对和普通 assistant 文本不被这层治理删除。最近两条结果仍保留（受单条预算约束）；错误、写入回执与未确认只读的动态 API 不参与 microcompact。正式摘要使用治理后的历史，不复活已移出的工具长文。
- 新增 workflow__read_tool_result，通过现有 IPC、ToolExecutor 与预算链分页读取本次会话的完整脱敏内容。校验双重身份、内容哈希、分页范围，拒绝其他会话和任意路径；读取归档不重放原工具或改变指南前置状态。每轮复查重读入口，入口撤销后不继续使用失去恢复能力的投影。
- npm run verify：334/334，contract 238、semantic 30、integration 66；结构门禁检查 59 个源文件、283 个导入。五个 workspace 独立类型检查及 git diff --check 通过。
- 本轮新增 9 项回归，覆盖整条非 raw 大结果限制、分页重建、microcompact 避免摘要、assistant 文本和最近工具配对不变、重复 provider tool-call ID、错误/写回执排除、正式摘要回退不复活旧长文、投影写盘失败、脱敏/完整性/入口撤销，以及真实 Pi 子进程归档重读无重复来源调用。既有正式摘要集成用例增强为 assistant 长文本造成压力的回退场景。
- 使用真实 SDK、子进程与本地 HTTP/SSE 脚本提供方，未调用付费真实模型或声称启用了 Claude 内部 feature gate。现有来源/IPC 大小上限及 CLI 恢复边界保持原约定；实现契约见 session-context.md。

以下保留此前历史验收记录。

# 2026-10-20 完整会话转录与活动上下文验收

- 新增主进程 SessionTranscript 与 PiContextManager。sessions/<runId>.jsonl 追加保存原生会话消息、请求快照、摘要响应与 compaction 边界；worker 通过 IPC 等待落盘确认，写盘失败会在业务工具执行前停止。Trace 继续独立承担业务审计。
- 压缩压力结合字符预算、SDK 模型窗口、实际 input/output/cacheRead/cacheWrite usage 和新增消息估算，预留输出空间；不重复计算已纳入 usage 的 assistant 输出。80% 触发后保留初始任务和最新完整工具轮次，旧历史摘要后退出活动上下文，完整原文不删除。
- 摘要为无工具的独立模型请求，纳入累计 Token、响应字符、单请求超时、调查超时及取消；model_usage.purpose 区分 turn/summary。摘要无用量、截断、为空、失败或不能缩小时明确停止；不自动重试或重放工具。SDK 自带压缩继续关闭。
- npm run verify：325/325，contract 233、semantic 30、integration 62；结构门禁检查 58 个源文件、279 个导入。五个 workspace 独立类型检查通过，git diff --check 通过。
- 本轮新增 8 项测试，验证真实 Pi 子进程压缩后完成调查、摘要用量计入总预算、写盘失败零工具执行、多次压缩及原生 JSONL 重载、保留初始任务/工具配对、usage/缓存/输出预留、摘要异常及取消；既有并行会话、脱敏和权限测试同步增强。
- 使用真实 SDK、子进程与本地 HTTP/SSE 脚本提供方；未进行付费真实模型摘要质量验收，依赖版本和 .env 未改写。完整转录支持离线重建边界，CLI recover/replay 仍不自动恢复会话执行。实现与 SDK 实锚见 session-context.md。

以下保留此前历史验收记录。

# 2026-10-18 本地 Web 工作台与 RunService 验收

- 新增 apps/web，提供中文任务表单、三组来源方案、离线/真实模式、权限与预算、运行阶段与事件、工具审批、取消、历史记录、引用与报告下载。真实模式沿用本机 .env，来源与 Skill 仍通过现有本地配置/CLI 管理。
- 新增 core/types/runs.ts 与 server-core/runtime/run-service.ts，提供 start/get/list/cancel/subscribe/respondToApproval/report/wait/close；各运行独立 Registry、MCP 池、AbortSignal、账本与输出目录，最多并行两项。CLI 原入口保留，Web 经服务进入同一调查 Runtime。
- Trace 增加可选观察者，在脱敏、Schema 校验和 append 后收到副本。Web 只订阅有界摘要；观察者失败不破坏既有审计。审批继续绑定 requestId 和 argsHash，重复/过期/取消后的批准被拒绝，拒绝与取消零写入。
- HTTP/SSE 仅绑定 127.0.0.1，检查 Host、跨站来源、同源 Origin 和 CSRF token；JSON 请求上限 64 KB，SSE 最多 16 个连接且限制慢客户端缓冲；静态资源使用明确允许清单，前端不执行来源 HTML。接口不接受任意命令、脚本、工作区路径或明文模型凭据。
- npm run verify：317/317（contract 227、semantic 30、integration 60）；新增 12 项运行服务/HTTP 契约与集成测试。
- npm run verify:web：7/7。真实 Edge 验证离线调查、三份引用与报告下载、刷新恢复、批准/拒绝与取消、手机无横向溢出、键盘标签切换和不可信任务文本。另通过本地模型 HTTP/SSE 协议桩实际启动 Pi worker，并调用真实 stdio MCP 完成 live 模式：6 轮模型消息、720 个合成 usage Token、1 条明确 fixture 主张。
- npm run verify:browser：6/6，既有来源浏览器能力保持通过；5 个 workspace 独立类型检查通过，结构门禁检查 56 个源文件和 270 个导入。
- fresh copy 离线 npm ci 安装 245 个包后，结构门禁与 Web 启动检查通过（HTTP 200、三组方案）。锁文件只增加 Web workspace 链接及已有 TypeScript 的运行时依赖分类，第三方版本未升级，Pi 仍为 0.84.2。
- 本地工作台最终预览为 http://127.0.0.1:4311；默认端口冲突时自动顺延。记录位于忽略 Git 的 .runtime/web。服务重启可查看历史，在途记录标 unknown，不重放工具；不是 Pi 会话续接。强制退出遗留的 .host.lock 需确认进程停止后手工移除单个文件。
- 本轮无付费模型调用或真实市场质量验收；模型协议、页面与业务验收数据均标明 fixture。CI 已接入 verify:web，远端 CI 未触发。截图/诊断 ZIP 仅留本地，提交紧凑验收 JSON/Markdown；.env 未改写且不提交。
- 使用与接口边界见 docs/web-workbench.md；Web 页面已手工查看桌面与手机截图，并在本轮启动的预览进程加载最终版本。

以下保留此前历史验收记录。

# 2026-10-18 Craft 来源指南与通用 API 工具验收

- API 来源采用 sources/<slug>/config.json + guide.md，每来源仅注册一个 api_<slug>；Agent 仍保留来源命名空间，例如 github__api_github。旧逐端点 api.tools 配置和 github__releases_list 调用已迁移；workflow 业务工具保持显式注册。
- workflow__read_source_guide 经相同的主进程 IPC、PreToolUse、ToolExecutor 与 source.guide.read 阶段，保存路径、哈希及快照。缺失、未读、变化的指南硬阻断 API，allow-all 不能跳过；每运行重置状态。与参考 Craft 的普通指南软重试不同，本项目保留严格策略。
- 通用工具按真实 method/path/params 推导权限：GET 默认 collect，其余默认 modify；只读 POST 必须有宿主规则。路径范围、参数 Schema、固定参数、来源/实体、计划前置条件和分析后禁采继续硬校验。写请求取消保持 unknown，执行前模式降级会阻止上游请求；raw body 不得省略配置的 fixedParams。
- MCP 包装仍为真实 SDK Server/Client/InMemoryTransport，平台凭据按次读取且只在主进程使用。context_prepared 记录动态动作标记，执行账本与 HTTP 事件记录实际动作，指南不能授予权限。
- npm run verify：305/305；contract 219、semantic 30、integration 56。新增/改写通用 API 专项 30 项全部通过，固定参数补充检查后再次独立全跑此模块。
- npm run verify:browser：6/6，实际 Edge 155.0.4283.45；真实 Pi 子进程读取指南后调用 API MCP，与浏览器在同一调查生成两条合成主张。四个 workspace 独立类型检查通过，结构门禁检查 51 个源文件、237 个导入。
- demo runId b5ab46a5-72db-4d0c-9671-e8113514e609；demo:adapters runId 7dcaa1cb-663d-426d-9ba7-62585ea64d01。两者 complete、gaps=[]，各一次指南读取与 API tools/call，Trace 校验通过。
- fresh copy 离线 npm ci 安装 244 个包后，结构门禁及 demo:adapters 通过：runId 31c9aae2-a369-48df-a6d4-66cf8cf15036，complete、gaps=[]。复制脚本包含 sources 目录，不复制 .env。
- CLI --sources 同时接受 JSON 数组、单对象和每来源目录，默认路径保持 examples/sources.json；示例 sources/platform 默认停用。首次完整回归发现已关闭的 stdio MCP 租约被回放权限委托误用，已修复，最终回归通过。
- 未新增付费模型或真实外部平台验收；以上业务内容与模型协议响应为显式 fixture，工程通过率不是模型质量准确率。Pi 自动压缩仍关闭，不宣称压缩后的自动指南重读。参考仓库和 .env 未改写，.env 不纳入 Git。

以下保留此前历史验收记录。

# 2026-10-18 Craft 风格目录迁移验收

- 现有 39 个源码文件迁入 apps/cli、packages/core、packages/shared、packages/server-core；使用真实 npm workspace 包链接和显式 exports，根目录 scripts/eval.ts、npm start、demo、verify 的运行入口保留。
- core 独立承载任务、工具、权限模式和 PreToolUse IPC 契约；shared 组合 Agent/来源/MCP/Skill/存储；server-core 负责主进程调查 Runtime；CLI 负责交互与配置装配。业务阶段和工具门禁行为保持原样。
- npm run check:structure：4 个 workspace，49 个源文件，227 个导入检查通过；新增门禁检查导出路径、跨包引用方向和默认资源相对路径。
- npm run verify：290/290，contract 206、semantic 30、integration 54；npm run verify:browser：6/6。
- npm run typecheck:workspaces：4 个包独立类型检查通过。测试文件保持 *.test.ts，harness/fixture 文件名不变。
- fresh copy 中 npm ci --offline --ignore-scripts --no-audit --no-fund 成功，新增 244 个包；check:structure 和 demo:adapters 通过，调查 runId 5dbf854c-fbf7-4534-9933-f38de477c561，complete、gaps=[]。workspace 与 Pi SDK 模块均解析在副本内部。
- 根目录 demo:adapters 的 runId efad731c-adcc-4be4-8033-a3f39f24e91f，complete、gaps=[]。浏览器和模型协议验收仍使用明确的合成页面/模型响应，不代表真实模型质量。
- lockfile 仅增加 4 个本地 workspace 链接，第三方依赖元数据变化为零。68 个原文件的非路径字符串经比对无意外改动，抽出的权限与握手类型已计入对应比较。
- 初次回归抓到迁移脚本对 constructor 等原型键的误匹配；已改为 own-property 映射，并从 Git 基线重新生成迁移结果，专项和最终全量回归均通过。
- 目录树、依赖图、Craft 对照和迁移索引见 docs/project-structure.md；.env 位置、内容和忽略规则未改，未纳入 Git。

以下保留此前验收记录。

# 2026-10-18 平台 API 统一 MCP 验收

最新完整门禁 290/290 通过：contract 206、semantic 30、integration 54；真实浏览器门禁 6/6 通过。

- 参考 Craft buildApiServer/createApiTool/createApiServer 的装配顺序，实现平台 API Tool → MCP Server/Client；GitHub 预设与通用 kind=api 均以 mcp 通道进入主进程 MCP 池。包含实际 MCP initialize、tools/list 和 tools/call。
- 删除 CLI 采集源码、测试程序、夹具与示例；保留应用自身 CLI、browser_tool 与 stdio MCP 服务。kind=cli 配置明确拒绝。
- 通用 API 验证固定 HTTPS 地址/路径/method、输入 Schema、环境变量凭据刷新、来源/产品绑定、门禁拒绝零 HTTP、取消、并发调用上下文、HTTP 状态、2 MB 流上限和写 Trace 前脱敏。
- npm run demo:adapters：runId e7f9eda0-8d1a-41a4-8217-33dad3b3a56b，complete，gaps=[]；Trace 校验无问题，GitHub 披露为 mcp，执行一次 mcp.api.tools_call。
- npm run verify:browser：真实浏览器、真实 Pi 子进程和真实 MCP 协议调用；页面、模型响应和平台 HTTP 响应仍为显式合成 fixture，不证明真实模型推理质量。
- 配置指南：docs/platform-api-mcp.md；通用模板 examples/sources-platform-api.json；只更新 .env.example，未改写或提交 .env 的内容。

以下保留此前历史验收记录。

# 本次验收报告

最新核对：2026-10-18，Asia/Shanghai；2026-10-17 的历史验收记录保留。环境：Windows、Node.js 24.21.0、npm；实际源码和全部产物位于当前独立项目。参考材料未改写。**可安装 CLI、离线闭环、固定回归已验证；真实模型已通过 AgentSession 跑通，用户 MCP/Skill 组合完成 fixture 调查。纯真实来源的完整情报验收和生产发布仍未完成。**

## 简历四条描述对应的后端完善（当前，2026-10-18）

- 新增 browser_tool 与 JSON CLI 来源，分别归 builtin 和 api；McpConnectionPool 按运行、配置和租约管理来源/用户 MCP 连接与发现。停用来源不启动程序或解析密钥，Agent 子进程继续只使用受控 Node IPC 代理。
- ActionPolicy.visibleTools 按模式与任务筛选工具；ContextPipeline.prepareTurn 每轮校验冻结 Skill 正文、注入模式/实体/来源/时间分支，再检查体积。Pi 续轮实际更新 system prompt；新注册或替换绑定不静默扩权。执行器继续保留 PreToolUse、一次性审批与阶段复查。
- 新 AgentEventSchema 与 TraceSchema v2 在落盘前校验载荷，新增 context_prepared/model_usage。旧格式可读，混合降级版本、仍等待模型决策的成功终态会被拒绝。
- 最终 npm run verify：**284/284**（contract 201、semantic 30、integration 53），类型检查通过，较上一阶段新增 33 项。fixtures/eval-cases.json 提供 8 项独立固定标签；另覆盖漏采 partial、历史证据在范围缩小时过滤、三通道和模式工具面完整性。
- npm run verify:browser：**6/6**，实际 Edge 版本 **155.0.4283.45**。包含真实 Pi 子进程、真实浏览器和真实 JSON CLI 的同一调查闭环，所有工具经统一 PreToolUse/Trace，保存 2 条有引用的合成主张。页面与模型响应均是 fixture，不代表真实模型推理质量或线上竞品数据。
- 浏览器 HTTP 由宿主手动读取，在交给渲染器前拒绝 3xx、越域和非 GET/HEAD，另有资源/总字节及请求尝试次数上限。验收发现普通 Playwright 路由不重新拦截重定向，已修正实现和测试；取消覆盖运行中及晚启动浏览器。CLI 验证原样 JSON、显式环境、结构化身份及直接子进程回收。
- npm run demo:adapters：complete、gaps []。此演示两条来源均为 fixture，完整输出仅保留本地；实际浏览器紧凑证据 artifacts/browser-eval/latest.json/latest.md，诊断 ZIP 忽略 Git。
- 完整回归曾遇到 Windows 扫描器短暂占用 Skill 安装目录；仅对相同受控路径的本地重命名加有限重试，不重试外部工具副作用。旧注入测试改为断言未披露工具在进入执行器前被拒绝，零外发要求保留。
- browser-regression CI 已配置，远端未执行。实时调度、真实模型质量 Golden Cases、Langfuse、长会话恢复与纯真实来源完整质量验收仍未完成。原简历、参考仓库及 .env 未修改。源码与边界见 docs/resume-backend-alignment.md、docs/source-adapters.md。

## 运行预算验收（历史阶段，2026-10-18）

- 统一 RuntimeOptions 与 CLI 参数校验，支持上下文字符、单轮响应字符、单次输出 Token、累计 Token、同一工具/总调用次数及轮数。调查、每轮模型等待、单工具调用分别设超时；默认值与范围见 docs/run-limits.md。
- 主进程在决策/执行前阻止超额工具尝试，按完整代理名跨参数累计；Token 按提供方 usage 统计，含缓存且不重复计思考子项。下一次实际请求的输出额度取剩余预算与配置/模型上限的最小值。真实 Pi 有效响应缺 usage 则停止。
- run_started 保存限额，usage_reported 保存分工具次数和累计 Token，budget_exceeded 记录超限。调查/模型超时回收子进程、清理审批和在途调用；工具超时保留既有失败观察值与未确认写操作 unknown 语义。
- 最终 npm run verify：**251/251**，contract 179、semantic 20、integration 52，TypeScript 检查通过。新增 12 项预算边界用例，覆盖真实 SDK/子进程的请求输出上限、剩余额度、缺失 usage、流式长度与模型超时。
- 完整回归发现 SDK 流式工具参数的原始缓冲区与解析对象会重复计数，现按 text/thinking/toolcall delta 各计一次；原有完整会话长度检查与新增单轮长度检查均通过。
- 仅固定协议桩与离线回归，不新增付费模型或真实外部搜索验收。累计 Token 为请求间门禁，当前请求输入和中止请求的 usage 不可预先精确获知，不是硬计费保证；CLI 来源发现仍有单独超时。

## 用户 MCP 与 Skill 扩展验收（上一阶段）

- 新增 mcp add/list/test/enable/disable/remove，支持任意配置的 stdio、Streamable HTTP、旧版 SSE 与 404/405 协商。配置保存在项目 .cwatch/mcp.json，密钥通过环境变量名引用；默认未知工具 action=modify，不信任服务的 readOnlyHint 提权。按任务 --mcp 或 allowedSources 选择服务器，原名分发与主进程审批/Trace 保留。
- 新增 skills install/list/show/enable/disable/remove，支持本地目录、GitHub 仓库根目录与子目录/tree URL。YAML 解析使用直接依赖 yaml@2.9.0，Pi SDK 保持 0.84.2。安装复制文件、保存哈希与来源 commit，不执行包内脚本，不安装包依赖。
- --skills 显式注入选定正文；workflow__read_skill_resource 校验清单、路径与哈希并经过 ToolExecutor。SDK 自动目录发现仍关闭；Skill 不改变权限、自动启用来源或绕过主子进程边界。
- npm run verify：**239/239**，contract 167、semantic 20、integration 52。新增 28 项用户扩展配置、协议、权限、秘密、取消、YAML、安装、资源边界和完整 CLI/Pi 子进程回归；其通过率不是模型准确率。
- 实际从 openai/skills 的 skills/.system/skill-installer 安装 8 个文件，源 commit 49f948faa9258a0c61caceaf225e179651397431；只安装在 artifacts/extensions-demo/.cint，不修改 Codex 全局 Skill，不执行下载的脚本。
- 真实模型经 CLI 配置的 stdio MCP 和安装的 competitor-review Skill 完成调查：runId **eddda3b5-0e3e-4323-8087-db42e4f439f5**，status complete、gaps []。11 轮决策、10 次工具调用，包含实际参考文件读取、诊断与采集；主进程 PID 62316、Agent PID 61248，子进程退出 0，Trace 校验 []。采集内容全部明确为 fixture，不是纯真实来源的情报验收。
- 首次实测发现同一 MCP 的诊断/采集工具不能共用 retrieval 格式，已增加 toolResultFormats 并排除成功诊断结果的错误归因；修复后重跑真实模型和完整回归通过。一般 raw 采集结果保留未结构化缺口，不自动成为事实。
- 精简证明 artifacts/extensions-demo/latest.json；完整数据和安装副本仅保留本地并忽略 Git。.env、参考仓库和原简历材料均未修改。用法见 docs/user-extensions.md，示例见 examples/mcp-custom.json、mcp-remote.json、task-custom.json 与 examples/skills/competitor-review。

## 主进程与 Agent 子进程验收（上一阶段）

- 实际调查由 PiModel.runSession → Node fork → Agent 子进程 Pi AgentSession 驱动。CLI 主进程持有权限、工具/MCP、业务状态、执行账本和 Trace；ReplayModel 与独立来源探针仍走同一 ToolExecutor。
- 真实 IPC 链路为 pre_tool_use_request → 主进程 runPreToolUseChecks/一次性审批 → pre_tool_use_response → 子进程 tool_execute_request → 主进程复查/执行 → tool_execute_response。校验协议版本、会话/任务、消息序号、SDK 调用 ID、绑定和参数哈希，拒绝重复或错配执行。
- 子进程崩溃/断线即取消挂起审批和工具；只读执行标 cancelled，无法确认的写操作标 unknown，execute_count 保留。等待请求收尾并回收子进程后写运行终态；无自动重试副作用。启动默认最多等待 15 秒、停止宽限 1 秒，超过宽限强制回收。
- npm run verify：**211/211**，contract 150、semantic 19、integration 42。新增 16 项真实故障子进程用例和 2 项真实 Pi SDK 崩溃用例；验证主进程继续完成新会话。故障测试曾发现取消后的未处理 Promise 拒绝，已修复并重跑全量通过。
- 使用现有 .env 的真实模型重新运行 CLI：runId **6191dc8e-5adb-46a5-aa4b-427ea457e052**；主进程 PID 62640、Agent 子进程 PID 23112。8 轮模型决策、7 次工具调用，每次均有请求/裁决和执行记录；子进程正常退出码 0，Trace 校验 []。
- 真实结果 **partial**：官网 live 成功 1 条但发布时间未知；GitHub HTTP 403/rate_limited；news 为真实 stdio MCP 返回的明确 fixture，成功 1 条。保存了计划、审阅、证据和草稿，不将来源缺口写成全成功。
- 命令：npm start -- run --mode live --task examples/task.json --sources examples/sources.json --out artifacts/subprocess-live --timeout 180000 --tool-timeout 45000。精简证明 artifacts/subprocess-live/latest.json；完整 Trace/报告/计划仅留本地。
- 未修改 SDK/依赖、.env 或来源配置。子进程环境不继承搜索 token、其他模型 key、NODE_OPTIONS；模型认证经私有 init IPC 传递，不进入命令行或 Trace。子进程提供故障隔离，不宣称操作系统安全沙箱、自动恢复模型会话或远端副作用回滚。

## Craft 风格工具调用结构（上一阶段）

- 工具注册采用 buildProxyTools → wrapToolsWithHooks/wrapSingleTool；wrapTool 为同函数导出。包装器保存 originalExecute 并透传 SDK 参数、取消、进度与 ExtensionContext。
- 实际执行统一经过 requestPreToolUseApproval → runPreToolUseChecks → ActionPolicy/PrerequisiteManager → pre_tool_use_response。单进程返回类型化对象，不引入 IPC。计划前置条件与分析后的采集限制统一归入检查链。
- Trace 增加 pre_tool_use_request/response，关联 requestId、taskId、toolName、bindingId、argsHash、sdkToolCallId；新运行声明 toolPipeline=pre-tool-use-v1。校验缺失/重复/不匹配裁决、审批与执行顺序；保留旧日志兼容。业务拒绝现在也有 execute_count=0 的持久化记录。
- npm run verify：193/193，contract 135、semantic 19、integration 39。新增 16 项检查/包装/协议回归；原三模式、取消、来源、MCP、API 包装及完整 SDK 业务循环继续通过。真实 SDK 协议用例验证 7 个工具调用 ID 与宿主请求/响应的关联。
- 未修改 SDK/依赖版本、模型或搜索配置；没有新增外部消息发送、Shell、浏览器宿主、隐式来源激活或模型摘要服务。本轮只运行真实 SDK 与本地协议/业务回归，未重新运行真实付费模型；已有真实模型 partial 结果仍为上一阶段证据。
- 调用结构详见 docs/tool-call-pipeline.md，简历映射文档已同步当前实现与验证范围。参考仓库及原简历材料保持原样，.env 不提交。

## 三种权限模式验收（上一阶段）

- 权限模式为 explore、ask、allow-all；默认 explore，safe 作为兼容输入别名。采集/分析/本地计划与草稿在三种模式下均允许；修改/发送/发布在 explore 拒绝，ask 逐次审批，allow-all 直接放行。
- 三种模式都执行 Schema、任务来源、参数范围、来源状态和绑定版本校验，保留取消、预算、快照和 Trace。模式在执行前和每个后端阶段复查；模型参数不能改写宿主模式。
- CLI 使用 --permission，与 --mode live/replay 独立。CLI 输出、运行记录及起止 Trace 包含 permissionMode，具体检查记录 effectiveMode；历史 safe Trace 可读。
- npm run verify：177/177，通过 contract 119、semantic 19、integration 39。新增独立权限矩阵、修改审批、拒绝/无审批、来源边界、后端前降级、取消/超时、旧日志、五种 CLI 输入（默认/三种规范值/旧别名）及非法值测试；实际 Pi AgentSession + 本地协议桩验证 ask/allow-all 的修改、发送、发布。
- 本轮没有调用真实外发/发布服务，也没有重新运行付费模型；上一阶段真实模型 partial 草稿保持为历史验收证据。参考 Craft 源码仅用于对照；模型与搜索环境配置未修改，.env 未提交。用法见 docs/permissions.md。

## AgentSession 迁移验收（上一阶段）

真实调查改为 PiModel.runSession → Pi AgentSession → 注册工具 execute → 原 ToolExecutor。SDK 管理连续历史、工具调度、结果回填和续轮；项目保留任务/流程、预算、权限、审批、快照与 Trace。ReplayModel 仅保留确定性单步测试；probe:model 仍为独立最小模型探针。版本仍为 0.84.2。

- npm run verify：154/154，contract 103、semantic 19、integration 32。新增 23 个独立会话用例；完整协议用例使用真实 SDK、本地 HTTP/SSE 和实际工具执行，验证连续消息历史与 Replay 决策一致。覆盖预算前置、SDK 参数/未知工具错误记录、流程越序、权限与审批、绑定更新、取消/迟到、HTTP 401/429 无隐式重试、上下文预算及并行会话隔离。
- 真实模型 CLI：npm start -- run --mode live --task examples/task.json --sources examples/sources.json --out artifacts/session-live --timeout 180000 --tool-timeout 45000。runId 9b02c775-984e-486b-83c5-ef68b19a5cbf；8 轮模型决策，7 个工具调用，完成计划→三来源采集→分析→审查→草稿→响应。
- 结果为 partial，不能写成全部来源成功。官网 live 成功 1 条但发布时间未知；GitHub HTTP 403 / rate_limited；news 为真实 stdio MCP 返回的明确标记 fixture，成功 1 条。已生成本地草稿并保留缺口，Trace 校验为 []。
- 精简证明：artifacts/session-live/latest.json。完整 Trace、计划和报告在同目录 runId 对应子目录，仅保留本地、不提交。不是纯真实来源情报验收，也不是新增通用联网 MCP 或原生联网适配器的实测。
- 关闭默认编码工具、目录资源发现、自动重试/压缩和遥测。没有更改模型/搜索环境变量或依赖版本，.env 继续忽略提交。

## 后续环境变量调整与历史验证

上一阶段 API 包装 MCP：`npm run verify` **131/131**（82 contract、19 semantic、30 integration）。REST 搜索/抓取经 SDK McpServer + InMemoryTransport + Client 的 initialize/tools/list/tools/call 调用；HTTP 前独立复查权限，凭据不进入模型或 Trace。入口 searchMcp.type=api，既有远程 MCP 保持默认，自动保底没有恢复。

`npm run probe:api-mcp` 实测公开 GitHub REST 搜索返回 **3 条**，backend=mcp.api、Trace 无问题，runId 8dfce50b-8b5f-4a18-93bd-91780bff910a。Google/Tavily 模板通过协议响应与配置回归，没有真实账户测试；当时尚未运行真实规划模型全流程。当前 AgentSession 验证见上节；通用 API-MCP 真实模型全流程仍未实测。详见 docs/api-mcp.md。本轮 .env 未改动，模板新增可选 API 变量。

最新移除自建保底：`npm run verify` 已通过 **109/109**（67 contract、18 semantic、24 integration）。通用联网仅保留“受控内置 → 配置的 MCP”；RSS/Brave 搜索与 HTTP fetch 保底及配置已删除。MCP 缺少能力、连接失败、服务错误或请求超时明确返回错误，验证不会发起直连网页请求；旧配置字段严格拒绝。原自建后端用例移除或改写成两层失败断言，权限、取消、Trace、快照和完整 Agent 回归继续通过。

当前真实 probe runId bed89f9e-e310-4198-87c9-b6283e99bb58：search 返回 1 条结果，fetch 返回 unavailable:search_mcp_request_timeout、0 页；两者 backend=mcp.remote，Trace 校验无问题，日志没有 local 后端。probe:web 因真实 fetch 不可用而正确退出 1，不能写成全部工具连通成功。

上一阶段通用搜索 MCP 扩展通过 **111/111**（66 contract、19 semantic、26 integration）。原固定服务 Adapter 已替换为 URL/token 通用配置；常见工具名、参数别名、JSON/Markdown/资源结果、2020-12/draft-7 Schema、自动 SSE 协商、自定义/匿名鉴权和跨域凭证保护通过协议桩验证。模型 API_KEY 不再隐式借用；既有本机 .env 已迁移通用变量，未提交。

历史 probe runId 94d84228-7512-4bd2-a1eb-c2e7c6a3ce7a 曾在移除前通过 local.http 保底。该记录不代表当前仍有此能力。未实测其他厂商账户，MCP fetch 归一化仍只通过协议响应验证；Anthropic 原生尚未实测，StepFun 原生内置联网尚未接入。详见 `docs/web-tools.md`。

- 统一使用 `MODEL_PROVIDER`、`MODEL_ID`、`API_KEY`、`BASE_URL`；`GITHUB_TOKEN` 仍为来源的可选凭据。.env.example 变量名与实际配置一致，密钥留空、服务地址使用占位值，未修改或提交 .env。
- `packages/shared/src/config/models.ts:readModelConfig` 校验必填项和 API 根地址；CLI 与 probe:model 共用入口。BASE_URL 注册 OpenAI 兼容自定义提供方/模型，API_KEY 仅注入 SDK 内存认证。自定义模型未知定价不输出零费用。
- 本次 `npm run verify`：类型检查通过，**61/61**（contract 40、semantic 14、integration 7）。新增环境变量、缺配置、URL 校验及模板用例；真实 Pi SDK 的本机 HTTP/SSE 全闭环直接走新配置入口，校验 Bearer 鉴权、请求路径和无凭据进入上下文。
- 本次 `npm run probe:model`：`stepfun / step-5-preview` 最小请求返回 **OK**，status connected，提供方报告 54 个 token。产物 `artifacts/model-probe/latest.json` 仅保存结果及用量，不含密钥或实际 BASE_URL。真实模型完整调查仍未运行。
- 下方 56 项及干净安装记录属于初始交付基线；`artifacts/verification-manifest.json` 也保留初始交付证明。本次不将基线副本测试描述为对新配置版本执行过的干净安装。

## 实际执行与结果

| 命令/动作 | 本次结果 | 证据 |
|---|---|---|
| `npm install --ignore-scripts` | 安装成功，后续精确修复 MCP/Ajv 并更新锁文件 | package.json、package-lock.json |
| `node --experimental-transform-types scripts/audit-materials.ts` | 读取 10 份核心材料、56 份证据文件；历史 25 个源码哈希与参考仓库 25/25 对应 | artifacts/audit/materials.json |
| `npm run verify`（根工程） | 初次固定用例 56/56；环境配置调整后本次 **61/61** | artifacts/eval/latest.json、latest.md 保存本次结果 |
| 全新隔离目录 `npm ci --ignore-scripts --offline --no-audit --no-fund` | **成功安装 238 个包**；此前目录无 node_modules | 历史临时目录 artifacts/test-work/clean-install-8GT48b/；副本已于 2026-10-25 清理，本行保留历史记录 |
| 隔离副本 `npm run verify` | 类型检查通过，同一套用例 **56/56** | 上述目录下 artifacts/eval/latest.json |
| 隔离副本 `npm run demo` | 完整 replay，status complete | 隔离 runId d61f9b74-43ae-4fc2-a5eb-70d07fb871ca |
| `npm start -- run --mode replay --task examples/task.json --sources examples/sources.json --out artifacts/delivery-demo` | 全新历史，2 个事件、2 个版本、3 份证据、2 条主张；计划/审阅/草稿/Trace 均落盘 | 交付 runId ea93b068-6e32-4cbf-82b0-6c0fe3e04822 |
| `node --use-env-proxy --experimental-transform-types scripts/probe.ts` | 官网 live 成功 1 条；GitHub live 成功 2 条；本地 MCP 成功 1 条 fixture | artifacts/source-probe/latest.json 与同目录 traces/executions |
| `npm run probe:model` | 初次因无凭据 blocked；配置调整后本次 **connected**，返回 OK | artifacts/model-probe/latest.json 保存本次结果 |
| `npm audit --json` | 修复后仍有 **3 项**（1 moderate、2 high），均来自 Pi 基线的间接依赖/聚合影响 | artifacts/dependency-audit.json、docs/dependency-review.md |

网络说明：初次沙箱内安装/来源探测受限；授权执行环境中成功安装并完成真实公开只读采集。HTTP 模型协议用例需要本机 127.0.0.1 回环权限：默认沙箱下曾连接失败，授权环境下最终全部通过。失败没有被改成跳过或通过。

## 回归分母与门禁

| 组别 | 通过 | 分母 | 覆盖 |
|---|---:|---:|---|
| contract | 35 | 35 | 任务、Schema、名称碰撞/原名路由、更新/撤销、参数范围、有效权限、审批拒绝/未批准/过期/变化/重复/取消、迟到响应、重启未决、预算、API 错误映射、Trace 脱敏 |
| semantic | 14 | 14 | 官网转载去重、多证据、同标题不同事件、同名歧义/错误归因、未知发布时间、跨时区和窗口边界、时间依据、版本追加、反向与正向冲突、缺证和来源部分失败 |
| integration | 7 | 7 | 全闭环与日志重建、计划文件/回调失败、网页注入后零外发和全产物脱敏、真实 stdio MCP、会话隔离、实际 Pi SDK 经本机 HTTP/SSE 与 replay 决策一致 |

指标为“独立断言通过的固定用例 / 本次执行的全部用例”，任何失败退出非零。全部固定用例均要求通过，没有根据待测输出生成期望值；fixtures/labels.json 与断言常量提供独立期望。该结果不是通用事实准确率、真实模型生成质量或生产覆盖率。CI Windows/Linux 配置已提供，远端 CI 本次未触发。

## 可直接复核的交付产物

- 草稿：`artifacts/delivery-demo/reports/ea93b068-6e32-4cbf-82b0-6c0fe3e04822.md`
- Trace：`artifacts/delivery-demo/traces/ea93b068-6e32-4cbf-82b0-6c0fe3e04822.jsonl`
- 计划：`artifacts/delivery-demo/plans/ea93b068-6e32-4cbf-82b0-6c0fe3e04822.json`，提交记录在 plan-submissions.jsonl
- 主张、审阅：同目录 claims/、reviews/，runId 一致
- 事实和历史：facts/events.json、facts/versions.json；原始内容与出处：evidence/index.json、evidence/snapshots/
- 执行记录：executions/，保存 taskId/runId/requestId/sourceSlug/ToolBinding/argsHash/起止时点/状态/execute_count
- 五条原文和实现符号、测试、演示定位：docs/resume-implementation-map.md

计划验证文件存在、可读、结构完整且内容一致后才回调；取消、拒绝等通过真实执行器计数验证，未运行工具为零。重启恢复只将已落盘未决状态标 unknown 并可查询；日志重建不重新调用工具。这不等于自动恢复调查会话、跨文件事务或副作用回滚。

## 仍待完成或不支持的项目

1. **纯真实来源完整调查与质量评测未完成。** 真实模型已经 AgentSession 完成一次带真实官网、GitHub 失败与 fixture 新闻的 8 轮闭环，并保留 partial 草稿。不能将它称为全部真实来源可用；真实生成质量、独立费用核验及 5–10 个真实模型黄金记录尚未形成，新增通用联网配置也未完成真实模型全流程验收。
2. **浏览器自动化缺运行宿主。** 只有 HTTP 网页读取，不将其写成 browser_tool；没有浏览器任务复验命令。普通 CLI 转 MCP、外部 HTTP MCP 池、远端 MCP 和其他模型 SDK 后端未纳入当前实现。
3. **Pi 基线依赖仍有已知漏洞。** 直接依赖 MCP/Ajv 已修复；SDK shrinkwrap 中 undici/brace-expansion 的补丁覆盖实际未生效，已删除无效配置。升级 SDK 并重新验证是后续依赖修复工作，当前不标生产安全放行。
4. 只读 Reviewer 验证结构化引用、实体、时点、版本、快照和冲突；不对自由模型叙述给出通用语义真实性保证。JSON-LD/Node.js 与 GitHub 解析为明确支持范围，其他站点需实现对应解析器。
5. 存储支持本地单写者文件持久化、保守恢复，不保证跨文件原子事务、机器断电无丢失或多进程数据库隔离。未部署服务、发布报告、发送外部消息或改写原简历。

本次工程验证完成范围与外部阻塞分开列出；未将离线测试通过、SDK 加载/协议通过、真实来源联通和真实模型联通合并为一个“已完成”。
