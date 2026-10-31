# 自动化评测的固定入口

评测工作由仓库程序执行，操作它的聊天 Agent 只负责调用入口、解释结果。不得手工拼接评分记录、代填人工身份或临时编写另一种格式的测试报告。

新 Case 按项目所有者 2026-10-31 最新要求，先只写 Prompt 并进行一次纯执行试跑，不写评分预期、不调用 Judge；主动提供 Trace 与 Outcome，等待人工明确确认基线，再进入正式评分测试。下述 eval:run 自动评分入口用于后续测试，不能替代首次纯执行基线审核。完整顺序见 [基线工作流](evaluation-baselines.md)。已有基线的日常自动测试继续使用默认 automatic 模式。

## 新运行

在项目根目录执行：

```powershell
npm run eval:run -- --dataset evals/activation/dataset.json --case activation-001 --repeat 1 --gate automatic
```

运行前读取主模型和显式 JUDGE_* 配置；缺必需配置时先退出，不先消耗主任务请求。每个 Case/Trial 使用独立会话与输出目录，执行 Agent 不收到量表或标准答案。没有量表的 Case 跳过 Judge。失败结果保留，不自动重试或覆盖。

| 顺序 | 程序步骤 | 固定输出 |
| --- | --- | --- |
| 1 | 执行题单中的 Case | 原始批次报告、回答、Trace、日志与冻结输入 |
| 2 | 代码检查 | 每条规则的判定与依据 |
| 3 | 按冻结量表运行真实 LLM Judge | 每条 finding 的判定、理由、证据 |
| 4 | 根据模式处理人工审核 | 自动/回归模式不创建待办；显式人工模式遇到未审项时生成待审材料并暂停，在出报告前询问用户 |
| 5 | 汇总自动项与最终评分 | 自动/回归直接生成；人工模式收到实际结论后才生成正式 JSON 和六层 Markdown 报告 |
| 6 | 打包归档 | ZIP、SHA256、逐文件校验清单 |

阶段事件保存在 pipeline-events-<id>.jsonl，流水线结果保存在 pipeline-result-<id>.json；输出根目录的 latest-evaluation.json 指向最新报告、人工待办与归档。每个批次有互斥锁，避免两个进程同时重复评分。已有结果不会被新报告覆盖。

人工模式在必需意见缺失、仍 unknown 或存在过程分歧时，先保存 review-checkpoint-<id>.json（cwatch.eval-review-checkpoint.v1），状态 awaiting_human、退出码 2，report/archive 均为 null；不调用正式报告或 ZIP 生成器。检查点提供提示词、实际回答、Trace、评审材料和输入模板。聊天 Agent 必须此时向用户询问，收到真实回复并导入后再用 --report 与 --gate final 续行；可继续其他不依赖意见的工作，不能先结束评测、出正式报告后再要求补签。程序 API 以 HumanReviewRequired 携带检查点返回这一正常等待状态，CLI 将其作为待审而不是执行错误展示。重入等待会复用模板和 Judge，不重跑模型。已经确认的否决可直接生成失败报告，不要求为其他项补签通过。

主模型输出达到上限时记录 model_response_truncated，与 provider_unavailable 分开。截断运行仍交给 Judge 按现有证据评审，不将残缺输出当作完整回答；只有模型不可用且没有最终响应或工具执行迹象时才跳过 Judge，并保留实际错误。历史上带 provider_unavailable 前缀的 truncated_response 也按截断处理。

有 Evidence 判据的 Case 在综合 Judge 后增加独立证据审核请求：仅提供该维度的冻结判据、原始任务材料、完整回答与必要调用事实，不向审核请求披露第一次 Judge 的结论。审查覆盖建议改写、例子和附注；对回答中每处 ISO 日期提取位置与上下文，要求逐处记录回答和来源各自表达的日期角色及来源原文。角色记录表明“回答断言上线日期、来源仅为发布日期”时按现有 Evidence 判据失败处理；缺项、引文不对应或审核截断均不能通过。任一请求的已证实失败不被另一请求的 pass 抵消。两次请求共用原 Judge 总超时，逐次请求与响应独立归档，实际请求数和 Token 合并记录；不引入额外扣分项，也不向执行 Agent 提供评分预期或旧答案。

逐日期记录同时区分肯定断言和否定/警示语句（assertsEvent），避免将“不能由发布日期推断上线日期”误当成断言某日上线。两轮 Judge 都能看到从实际 run_started 任务中提取的 hostExecutionContext：业务事实对应材料，执行/权限范围声明对应 Trace 与真实宿主配置；合法的空来源白名单不能误判成编造业务来源。这些补充事实来自原有已校验执行记录，不改变既有 subject 的哈希或覆盖旧评分。

## 自动项与人工项分别展示

自动评分包含已分配的代码检查、LLM 结果/过程/证据判定，以及实测耗时扣分。自动过程扣分只表达 LLM 的判定，尚未取得人工共同确认；不能冒充最终过程结论。

报告标明 evaluationMode 和 scoreScope。自动模式显示本次自动得分、自动评分完整度及稳定性；适用人工维度标记 not_requested，不创建待办，也不因缺少人工意见而显示待完成。人工模式显示指定人工项及人工综合分。两种模式均保留已存在的人工记录。自动项证据缺失或 Judge 无效时保留 unknown，不能默认满分。

最终综合分沿用原规则：需要的人工过程/安全判定缺失或冲突时待确认。自动项 100 只说明自动已评范围没有扣分，不意味着人工审核完成、基线确认或用例已获批。五个维度不是各占 20 分；仍按统一负分制计算。

--gate automatic 为默认模式，仅以自动项门禁决定退出状态，不创建人工待办。--gate final 为显式人工审核模式，才生成 Case 分配的人工模板和综合评分报告，并要求完整发布门禁。不能把 automatic 的成功解释为 final 成功。建立基线、修改 Case/量表、异常诊断或抽样复核时可显式选择人工模式。

--gate regression 是正式自动回归门禁：每例五个独立 Trial、每次自动项 100 分、必需代码检查及全部 Rubric 条目 pass、兼容的 confirmed 基线。任意一次失败整例为 0，未知或缺失不能通过。它不创建人工待办，也不冒充完整 final 门禁。正式入集和 CI 使用 eval:regression，见 [回归集说明](../evals/regression/README.md)。

项目所有者明确要求回归集全自动：每次执行、Judge、扣分、门禁、报告和归档连续完成，不逐次请求人工复核或签字。失败/无效评分直接作为自动结果报告；修复后按相同自动流程重测。首次基线的人工确认与日常回归区分处理，回归阶段不切换到 --gate final。

| 退出码 | 含义 |
| --- | --- |
| 0 | 所选门禁通过 |
| 1 | 已确认失败 |
| 2 | 待评审或证据不完整，所选门禁尚未通过 |
| 3 | 配置、执行收集或流水线错误 |

## 复用已有运行

```powershell
npm run eval:run -- --report <batch/report.json> --gate automatic
```

--report 不重跑 Agent；只复用 subject 哈希、量表、Judge 版本/配置匹配的最后一条已完成评审。匹配记录已存在时不再调用评分模型。缺少适用评审时才调用 Judge。自动模式跳过人工派单；只有 --gate final 才生成/复用人工模板。修改题目后应使用新题单运行，不改变旧批次的冻结判据。

需要人工审核时，使用 eval:run -- --report <batch/report.json> --gate final 派单；通过 eval:human 导入已填写模板后，再执行相同 --gate final 命令更新人工综合报告与归档。eval:report 文件报告默认使用 automatic，查看人工模式可用 --mode human_review。所有评审和报告保留历史。

人工明确否决某个已分配的 Outcome/Evidence 条目时，使用 `eval:score -- --kind adjudication --report <batch/report.json> --case <ID> --input <human-rejection.json>`。输入采用 cwatch.human-rejection-input.v1，必须含 subjectSha256、真实 reviewer、用户原话 userStatement，以及 findings 中的 criterionId、fail、理由和实际证据引用；只接受冻结 Rubric 中已有的结果/证据条目，不支持用它代填通过或新增判据。人工裁决独立保存于批次 human-adjudications，绑定实际 subject/runId 并校验完整性。再用 --report 与 --gate final 汇总，程序合并一次否决扣 100、单次为 0，保留原 Judge 和自动分数；其他未审项仍未知，不伪造完整人审。已知人工否决会阻止正式自动回归通过，也不会继续派发不影响失败结论的人工批准待办。

## 报告与归档契约

基线不再固定显示“尚未建立”。报告读取 evals/baselines 中的 Case 修订绑定、快照和独立人工确认记录，核验内容哈希，展示实际基线指标，并将引用快照复制到批次供 ZIP 自包含归档。建立与确认使用 eval:baseline，见 [用例基线工作流](evaluation-baselines.md)。一次经人工认可的运行即可建立基线，五次稳定性测试独立进行；基线不会传给被测 Agent。

详细报告：cwatch.detailed-eval-report.v3；自动评分：cwatch.automatic-assessment.v1；流水线结果：cwatch.eval-pipeline-result.v2。报告由 scripts/evaluation/report.ts 生成，固定包含全局概览、用例列表、单例详情、用例汇总、稳定性和执行记录六层，保留模型、Token、费用、基线、Prompt、每次 Trial 和扣分明细。score、complete、稳定性及概览按本次模式汇总；finalScore 仅供人工模式使用，自动模式为 null 且不在 Markdown 中显示成待审项。自动模式不额外输出含人工待审的 quality-report，qualityReport 为 null；人工模式保留该报告。未知费用与未建立的基线不得写成 0。

回归运行另有 automaticRegression（cwatch.regression-gate.v1）字段与明确的 Markdown 严格自动门禁结果，逐次列出五次通过、失败或待判，不把人工待审误作自动评测失败。普通单次报告不显示此严格五次门禁。CI 与回归准入采用同一个程序判定，并将门禁记录一起归档。

归档由 scripts/evaluation/archive.ts 生成。打包前验证文件哈希并扫描已知凭据；ZIP 含每个文件的校验清单，旁边有 ZIP 的 .sha256。只归档本地运行证据，不执行 git commit、push 或远程上传。代码/Case/量表仍按普通版本管理维护；证据 ZIP 不包含完整依赖或源码 checkout。

## 离线工程验证

```powershell
npm run test:eval-pipeline
```

工程测试验证整条链、固定报告、自动/人工分栏、代码用例跳过 Judge、重复整理不重复评分、失败计分及归档密钥拦截。使用明确的离线脚本与模拟 Judge 传输，不请求真实模型，不计入 Agent 质量样本或回归集。此检查已加入 npm run verify，用来防止以后换操作 Agent 或改代码时无意改变流程契约。
