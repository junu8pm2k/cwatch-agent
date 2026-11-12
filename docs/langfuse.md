# Langfuse 接入

从 Dataset 页面启动完整 Agent 评测：见 [Webhook 实验入口](langfuse-experiments.md)。该入口是可选平台适配器，原本地与 GitHub Actions 流程仍独立运行。

在项目根目录 `.env` 填入同一个 Langfuse 项目的 API Keys（Project Settings → API Keys）：

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_TIMEOUT_MS=5000
```

`LANGFUSE_BASE_URL` 填实例根地址，不加 `/api/public`：EU 为 `https://cloud.langfuse.com`，US 为 `https://us.cloud.langfuse.com`，自部署填自己的 HTTPS 地址，本机可以使用 `http://localhost:3000`。密钥与实例必须对应。环境名用小写字母、数字、`_` 或 `-`，最长 40 字符，不以 `langfuse` 开头。

两项密钥留空时关闭上报；只填一项会返回配置错误。可以设置 `LANGFUSE_ENABLED=false` 临时关闭，设为 `true` 则要求密钥齐全。CLI、Web 和真实模型评测均由宿主 Runtime 在真实任务结束时等待上报，正常完成、失败、取消都会尝试；replay 测试不自动上传。修改 `.env` 后重启 Web 或重新运行 CLI。

## 验证连接

```powershell
npm run probe:langfuse
```

该命令发送标记为 synthetic 的本地样例，包含根 Agent、两个模型轮次、工具及后端阶段，不调用真实模型或搜索服务；样例 token 用量也是合成值。输出 `langfuse.status: exported` 表示接口接收成功，并提供可在 Langfuse 中搜索的 `traceId`。在 Langfuse 里确认观察项、父子关系和用量展示后再运行真实任务。

## 数据与失败处理

沿用[结构化 Trace](structured-trace.md)作为公开追踪数据源，将 run → model → tool → backend/process 映射成 Langfuse Agent、Generation、Tool 和 Span。上报任务输入、最终输出、工具参数与结果、权限、错误、耗时、模型名及已知 token 用量。任务 ID 作为 session ID；runId 和 taskId 会传播到每个观察项的 metadata。维护调用只有用量、缺少起始时间时，导出零时长并保留 `timingAvailable: false`；未知 token 不填零，也不虚构实际费用。模型输入沿用现有审计数据（上下文大小及公开配置），不包含完整 prompt 或私有思考。

密钥只在宿主用于鉴权，上报前再次执行环境密钥及现有 Redactor 脱敏。不读取 SDK 私有转录。配置启用后，脱敏后的任务与工具内容会发送到所配置的 Langfuse 实例。

采用官方支持的 [OTLP HTTP/JSON 接口与属性映射](https://langfuse.com/integrations/native/opentelemetry)，携带 `x-langfuse-ingestion-version: 4`；按[完整 Span 导出规则](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4)在任务终态一次性发送。运行中不会实时展示；本地 JSONL/JSON 继续保留，评测与状态重放保持原有读取方式。

上报最多等待 `LANGFUSE_TIMEOUT_MS`（默认 5 秒，最大 30 秒），独立于任务取消信号。失败不会改变任务状态，结果的 `langfuse` 字段记录 `disabled/exported/failed`，尝试上报后还会保存 `traces/<runId>.langfuse.json`。成功记录会跳过向同一实例、同一项目重复上传；没有后台自动重试。断网或进程崩溃后，可从本地完整有效日志手动补传：

```powershell
npm start -- trace --out artifacts/live-web --run <runId> --langfuse
```

未配置、非法/未完成日志、HTTP 错误或部分拒收时命令返回非零退出码。网络超时可能发生在服务器已经接收数据之后，手动重试前先在 Langfuse 搜索 traceId；v4 不保证重复 Span 去重。成功标记只针对当前本地目录，复制原日志时应同时保留 `.langfuse.json`。

## 程序、LLM 与人工共用原扣分制

### Dataset 和 Prompt Management 同步

```powershell
npm run eval:langfuse -- --mode assets
```

注册 `cwatch/current/activation`、`core_logic`、`resilience`、`artifact_quality` 四个 Dataset，ACTIVE题数分别为2、8、2、2。唯一当前题单为[evals/cwatch](../evals/cwatch/README.md)，每题使用原CaseSchema：Input只含Agent任务，Expected Output是expected_final，Metadata的evaluation.rubric是逐题语义评分标准，evaluation.scoring.checks是程序规则，execution是宿主执行条件。14题已有完整可审阅规则和纯执行输入；两道异常题已有受控fixture。新修订均needs_review，没有确认基线或成绩。

评分模板由`cwatch/judges`中的结果、过程、证据三个Prompt管理（evaluation标签），不再注册14份任务输入副本。具体题目Rubric随评测packet传入；不在模板硬编码14题答案。去重、Markdown和JSON三题无需LLM。仅已分配的维度调用Judge；安全与成本不用LLM Judge。历史题目模板与旧Dataset修订不用于新题单。另有`cwatch/agent`管理被测Agent的真实行为指导，支持拉取固定版本运行原Case，见[Agent提示词同步与版本评测](agent-prompts.md)。

本次迁移用`--mode assets --archive-input-templates`把此前误建的14份input模板标为archived，保留原内容和版本，在Config中注明已弃用。其draft标签移除，不再部署或维护。这里的archived是明确的模板标签，不是Langfuse自动停用Evaluator的开关；执行器只引用三个cwatch/judges定义。

重复同步复用题目ID与模板版本；同一修订被编辑时停止，避免覆盖平台修改。题目使用稳定的cwatch-current-<caseId>标识；更高修订只有在旧内容与原始本地快照完全匹配时才能原位更新，旧版本由Langfuse保留，避免增加重复题目。旧v2条目均已ARCHIVED，仅作历史；原触发试验Dataset不动。当前清单在`.runtime/langfuse-assets/catalog.json`。`--mode assets --dry-run`离线检查计划；`--mode assets --update-prompts`显式以本地评分模板更新同一组Evaluator和注册模板。

在Langfuse中调整Case后，可导出完整题单供现有执行、评分程序读取：

```powershell
npm run eval:langfuse -- --mode pull
```

只读取四个Dataset的ACTIVE项，验证CaseSchema、数量和场景，生成内容哈希固定的`artifacts/langfuse-suite/<hash>/dataset.json`。返回的路径可传给原`eval:run --dataset`；不再维护另一套评分器。Input不会拼入预期或Rubric。新修订先按基线工作流用`evals/cwatch/inputs/*.json`纯执行供审核；`pull`本身不运行模型、不审批Case或基线。

在 Prompt Management 修改评委后，将所需版本的标签设为 `evaluation`，再执行下面的显式应用命令：

```powershell
npm run eval:langfuse -- --mode judges --apply-registered-prompts
```

只将这三个带 evaluation 标签的 Prompt 应用到原 Evaluator ID；不改变模型、映射或输出类型，未修改的定义不增加版本。普通评测准备不会自动覆盖 Evaluator。也可直接在 Evaluators 编辑提示词；使用本地文件为来源的 `--update-prompts` 与上述命令不能同时使用。四类场景说明和逐题 rubric 仍由评测 packet 传入。

评测连接器为 `scripts/eval-langfuse.ts`。它复用冻结 Case、原始 Trace、`quality.ts` 的评审验证与 `automatic.ts` / `penalty.ts` 的扣分实现，不用 Langfuse 中的分类值替代总分。平台上的 1、0、-1 等分类编码不是扣分权重。

已有真实评分批次可准备程序检查、必要人工队列和评审指南：

```powershell
npm run eval:langfuse -- --report <batch/report.json> --case <ID> --attempt 1
```

这个命令不运行 Agent 或 Judge。它上传代码检查，并为 Case 分配的过程/安全项建立人工队列。已上传的 live Trace 不补发 v4 Span；新连接默认建立绑定相同真实执行的评测视图，metadata 标明原 runId 与 Trace ID，不代表又运行了一次 Agent。旧试验可通过 `--adopt-pilot <pilot-session.json>` 接管，必须匹配原报告、Case 和平台完整评测包。

加 `--native` 会按当前 Case 已分配的评分角度，复用[结果、过程、证据三个固定 Judge](../evals/judges/README.md)。三者共用同一模型，各自只判定自己维度的条目；四类 case 场景只是上下文，具体规则从冻结 rubric 传入。没有分配某个维度就不调用该 Judge，也不按 case、条目或运行新建 Judge。需要现有 `JUDGE_*` 配置与同名 Langfuse 模型连接。

根观察项上运行适用的结果、过程、证据 Judge；证据复核在独立的 `eval.evidence_audit_input` 上仅复用证据 Judge，包含逐处日期核验，不增加第四个评委。命令不创建全项目自动触发规则。binding.json 固定每个维度的评委、版本和目标。已有本地 Judge 也可以保留并上传其判定。

`eval:langfuse -- --mode judges` 准备三个定义，重复执行复用原 ID。可以直接在 Langfuse 改对应角度的 Prompt，普通运行不会覆盖；以本地文件为来源时显式执行 `--mode judges --update-prompts`。历史运行保留版本。`--retire-scenario-judges` 仅用于将此前误按场景创建的四个配置改名标记弃用，保留记录。当前快照为 `.runtime/langfuse-judges/catalog.json`。

加 `--adjudication` 可另建可选的结果/证据否决队列：`not_reviewed` 表示未审核，`no_rejection` 仅表示本次不提出否决，`reject` 才导入原有人工否决入口。明确否决要填写理由与必要证据；原模型结果保留，一票否决合并扣一次 100。后来的“不否决”标签不会静默撤销已经登记的否决记录。

### 人工在界面中填写

打开命令返回的 `queueUrl`，进入唯一对应的任务，先阅读实际输入、输出及 Tree/Timeline。对每个分配条目选择 pass、fail 或 unknown。选择后在 Comment 写审核者自己的理由和引用，例如：

```text
这里填写你实际观察到的依据。[task] [rules] [final-answer] [trace:7]
```

引用必须来自 `review-guide.json` 的 allowedEvidenceRefs；示例中的 7 不能套用到其他执行。过程项要覆盖其原 Rubric 指定的证据种类，安全项需要任务与实际 Trace 依据。填完点击 **Mark Completed / Complete + next**。空模板、未完成任务、API 写入的假人工标签、多位审核者未裁定的意见、无理由或无效引用均不能生成完整综合分。

### 拉回、汇总、归档

```powershell
npm run eval:langfuse -- --mode sync --binding <binding.json>
npm run eval:langfuse -- --mode sync --binding <binding.json> --watch --watch-minutes 60
```

同步只读取平台判定，不重跑 Agent/Judge。平台 Judge 必须匹配项目、根观察项、冻结条目与评委版本，并通过原量表及独立证据审核验证。人工必须来自该队列的真实 `ANNOTATION`、具有审核者身份，并完成对应任务；多位审核者不自动多数表决。每份平台原始评分随本地评审证据保留。

程序分别写回 `automatic.total`、`automatic.deduction.*`、`final.status`、`final.score_available`，综合评审完整时再写 `final.total` 与 `final.deduction.*`。重开任务、未知、分歧或无效评审不会沿用旧人工通过：最新同步状态与可用标记变为待审核，当前综合分为 null。旧数值保留为历史，读取时必须核对相同 `aggregationVersion` 的状态与分数，不能只取旧的最后一个数字。

`latest-sync.json` 保存当前完整状态。判定变化后生成原格式报告；完成综合评审后生成新报告与 ZIP。重复同步相同评审不重复创建本地评审或报告。Token/费用/请求数缺失时保持 null。日常自动回归仍用原 `eval:run --gate automatic`，不强制人工逐次审核。

### 用户明确授权的 AI 代审

`scripts/evaluation/delegated-review.ts`为明确授权的代审保存独立记录，身份固定为ai_delegate。记录绑定本次subjectSha256、逐题理由和实际证据引用；指定过程/安全维度仍通过原评审结构校验，扣分仍调用原scorePenalty。它不生成kind=human的Assessment，不伪造Langfuse ANNOTATION，也不确认人工基线或正式回归准入。

平台使用`ai_review.total`、`ai_review.status`与`ai_review.human_confirmed=false`展示这类结果；原automatic和真实人工确认结果分别保留。报告明确区分“已完成AI代审”和“真人已确认”。已知结果失败可保留0分，同时保留无法逐项确定的unknown，不为让表格全绿而改写判定。

本批次实验通过OTLP在每个Span携带同一实验、Dataset、Item及根观察项标识。临时Judge规则同时按精确报告哈希和指定维度过滤，执行完成即关闭。缺失或格式不合格的过程Judge可在同一Trace下补建`eval.trajectory_review_input`，只复核同一冻结执行包，不重跑Agent；导入时验证父观察项、包哈希、原始内容、评委版本与评分目标，未声明的目标改绑仍被拒绝。

## 新版 Case 的纯执行基线

新 Case 先按项目约定仅运行 Prompt，不加载评分预期、不调用 Judge：

```powershell
npm run eval:baseline:trial -- --input evals/cwatch/inputs/activation-001.r6.json --case activation-001 --revision 6 --publish
```

每次生成独立目录、原始回答、完整 Trace 和证据清单。失败记录保留。平台准备“基线流程认可”和“基线产物认可”两项：accept / reject / unknown。Comment 写自己的审核理由；流程引用该次真实 `[trace:序号]` 或 `[step:步骤ID]`，产物引用 `[final-answer]`。

```powershell
npm run eval:baseline:trial -- --trial <trial.json> --publish
npm run eval:baseline:trial -- --trial <trial.json> --sync --watch --watch-minutes 60
```

`--trial ... --publish` 复用原执行，不再次调用模型。同步将实际人工意见保存为绑定执行哈希的 `human-feedback-*.json`；认可反馈与基线正式登记分开。该命令不会把设计稿、旧分数、标注队列或 LLM 结果冒充已登记基线，更不会冒充五次稳定性测试。见[基线工作流](evaluation-baselines.md)。

`--watch` 是当前进程中的限时轮询，每 10 秒读取一次；到期退出，没有安装常驻服务。首次接线和后续改动通过 `npm run test:eval-pipeline` 的离线工程测试验证，不把工程 fixture 当作真实 Agent 成绩或真实人工审核。
