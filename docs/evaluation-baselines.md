# 用例基线工作流

基线是一次经人工认可的真实执行快照。按项目所有者最新要求，新 Case 先只写 Prompt，真实执行并保存 Trace 和最终回答，交由人工确认作为基线；此阶段不编写评分预期、不调用 Judge。确认后再准备后续评分与正式测试。重复五次用于验证稳定性，不能代替基线的人审。

2026-10-31 项目所有者明确要求：先跑一次不带评分预期的基线试跑，主动提供 Prompt、原始 Trace 和 Outcome，等待其明确确认，再登记基线。既有 Case/量表保留历史，但不得加载到这次纯执行输入或据此评分。若人工指出需要修改，保留原记录，修改后重新独立执行。不能只报告自动满分后等用户追问，也不能代填人工通过。

纯执行试跑保存于 artifacts/baseline-trials/<caseId>/<trialId>/，包括 prompt.md、input.json、trial.json、outcome.md 和原始/结构化 Trace，reviewStatus 为 awaiting_user_review。它不生成分数或自动确认。下文 eval:baseline 是已有评分批次的冻结入口，其当前实现要求综合评审达标，不能用它强迫纯执行试跑先完成评分或伪造通过记录；纯执行试跑得到人工认可后，登记应绑定原始证据与真实用户确认。

## 保存位置

登记文件：evals/baselines/<caseId>.r<revision>.json。快照：evals/baselines/<caseId>/r<revision>/<baselineId>/baseline.json 及旁边的证据文件。这些文件随仓库版本管理，不属于 artifacts 中可清理的普通日志。基线登记按 Case ID、修订和完整内容哈希关联；Case 内容变化时旧快照不会自动成为新 Case 的基线。

snapshot schema 为 cwatch.eval-baseline-snapshot.v1，包含文件清单与 SHA256、来源批次/runId/Trial、代码和模型版本、实际耗时/Token/费用/步骤、最终回答与完整可观察执行证据。未知费用保持 null。确认记录与快照分开，不改写原始证据。

## 固定入口

先从已有的、评分完整且达标的运行准备候选，程序不会调用模型：

```powershell
npm run eval:baseline -- --report <batch/report.json> --case activation-001 --attempt 1
```

程序校验原始证据、冻结可共享快照、扫描已配置的凭据，生成 candidate 登记与 approval-input.json 模板。执行输入中始终不包含基线答案。

人工检查快照的过程与最终结果，再在模板副本中填写真实审核者、process/outcome 的 pass/fail/unknown、理由、证据引用。最终结果须引用 final-answer。两项均 pass 后才能确认：

```powershell
npm run eval:baseline -- --binding evals/baselines/activation-001.r2.json --approve --input <filled-approval.json>
```

空模板、错误的快照哈希、未通过的任意项或无效证据引用均不能确认。确认记录保留用户审核来源；对话中明确认可也可转录，不能将代码通过或 LLM 通过冒充人工意见。

## 报告与归档

使用原固定入口更新已有批次：

```powershell
npm run eval:run -- --report <batch/report.json> --gate automatic
```

报告实际读取登记及校验清单，展示 not_established、candidate、confirmed、incompatible 或 invalid。confirmed 只表示该基线已被人工认可；不会代填其他 Trial 的人工评分、批准 Case 标准或改变稳定性结果。报告展示真实基线指标与 runId，不再固定输出“尚未建立”。

程序将本报告引用的基线和确认记录复制到批次的 baseline-references 下，随 ZIP 一起归档。该副本带独立校验清单，原基线目录迁移后归档仍包含参考证据。已生成的旧报告与 ZIP 不覆盖。代码检查与 Rubric 继续执行自己的判据，基线不要求回答逐字相同，也不会在此步骤自动触发模型重新评分。

运行归档不要求 Git 提交；基线快照、登记和确认记录应与 Case/量表一起作为评测资产纳入版本管理。本工具只准备本地文件，提交由正常项目流程处理。

## 自动回归准入

基线确认后，可通过 eval:regression -- --qualify --dataset <dataset.json> --case <ID> 新跑五次。全部满足严格自动门禁时程序才写入 evals/regression/suite.json 及独立准入记录。每次 CI 核验 Case 内容、基线文件、准入证据和主模型/Judge 身份，然后运行整个回归集；旧入集记录不能为修改后的 Case 或模型直接背书。此自动门禁不会代填后续运行的人工评分。
