# 三类评分器与统一负分制

执行模式（2026-10-30）：日常评测默认 --gate automatic，CI 使用 --gate regression；两者均不派发人工待办，报告按自动范围显示本次得分与稳定性。Case 的 humanReview 描述可供人工审核的维度，只有显式 --gate final 才派单并参与人工综合评分。已有人工记录始终保留。下文的人工评分输入契约适用于显式人工审核，不要求每次 CI 都填写。

当前从新设计注册 Case 1 共 1 例，见 evals/activation/dataset.json。五类评测维度与子维度保持 [统一定义](evaluation-dimensions.md)，评分方式为 [统一 100 分负分制](penalty-scoring.md)。

| 大类 | 指定评分器 |
|---|---|
| Outcome 结果 | 代码 + Rubric |
| Trajectory 过程 | Rubric + 人工 |
| Evidence 证据 | 代码 + Rubric |
| Safety 安全 | 代码 + 人工 |
| Cost 成本 | 代码 |

Rubric 明确指参考结构化量表的 LLM-as-a-Judge。上表是可选职责，不要求每例全部启用。LLM 只接受明确分配的结果、过程或证据条目；人工只接受 Case 明确分配的过程/安全。代码为过程提供事实和计分计算，不做语义裁决。

## 用例必须提供结构化量表

Case/题单采用 v5。Case 的 rubric 字段为 cwatch.eval-rubric.v1 对象或显式 null；不存在自动从自由文本或通用维度描述猜出评分标准的后备路径。rubric=null 时 CLI 在读取 Judge 模型配置和发请求前返回 not_applicable，不产生一条假评分，也不因缺少未分配的 LLM 评审而阻塞汇总。

量表包含 id、revision、policy、criteria。每项 criteria 必须有 id、dimension、requirementRefs、question、passAll、failAny、unknownWhen、evidenceRequired；boundaries 描述误判边界。过程条目还必须用 processCriterionId 一对一绑定 expected_process.criteria。引用必须属于该条声明的维度，不能把 Safety/Cost 塞进 LLM 量表；同一步不能用多个条目重复计过程分。

Case 的 humanReview.dimensions 显式分配人工审核范围，可为空；声明过程计分项时必须同时分配人工 trajectory。无过程计分项时 expected_process.requirements/criteria 可为空。没有分配的维度不适用，区别于需要判定但证据不足的 unknown。所有声明的要求必须由对应代码或语义评分器覆盖；成本要求只能由代码检查。

四个触发 Case 的量表文件位于 evals/drafts/activation/activation-001.rubric.json 至 activation-004.rubric.json。Case 1 已将对应量表嵌入 Case v5，另外三例尚未注册。过程绑定 ID 及 requirementRefs 必须与实际 Case 一致，不由运行时读取旁边的草稿文件隐式补齐。

## 评委返回判定，不自由报分

通用评分政策为 cwatch.quality-rubric.v6，Case 的具体量表采用 cwatch.eval-rubric.v1。旧 1–5 分、最低维度分及加权平均已移除；模型和人工都不自由填写总分、扣分单位数或分值。

LLM 只返回 findings 和 concerns；每个 finding 是 criterionId、verdict（pass/fail/unknown）、reason、evidence。必须恰好覆盖当前冻结量表的全部 ID，不得遗漏、重复或增造条目。输出总分、维度汇总、旧 judgments/processChecks 格式或其他字段会被拒绝。

代码将 findings 转为记录中的 answer.judgments 和 answer.processChecks，保留原始 findings。只汇总本例已分配的维度；结果/证据有明确失败时汇总为 fail，否则有未知为 unknown；过程有未知则 unknown，否则有偏差为 fail，否则 pass。过程汇总的 fail 表示存在应扣分偏差，不等于任务结果一票否决。

Case 的 expected_process.criteria 提前声明 step_adherence、intermediate_output、tool_chain 三种计分项及具体步骤/调用。两位指定评委同意某项 fail 后扣 10，双方都 pass 不扣；冲突或未知留待复核，不默认取高分或低分。任务结果不符扣 100；效率按真实耗时扣分。完整公式和 N 次聚合见计分文档。

每个判定必须说明理由，证据只能引用 packet.allowedEvidenceRefs 中实际提供的 task、requirements、final-answer、rules、trace:<sequence>。pass/fail 还必须包含该条 evidenceRequired 指定的证据类型；unknown 必须指出缺口并引用可定位的现有记录。引用存在不等于语义判断正确。暂不设置 85% 一致率门槛，保留人工复核与分歧记录，不声称已完成校准。

## 输入、隔离和实际调用

Judge 的 packet.rubric 来自归档的冻结 Case，包含该例具体结构化量表；packet.gradingPolicy 保存通用维度、职责和计分规则。另提供冻结任务、要求、可见 Trace、实际结果/观测、代码检查和实测成本。量表不会送给被测 Agent，内部 SDK 思考与凭据不会进入评分输入。

packet 和请求记录保存实际量表、版本及 rubricSha256，模型返回前校验量表哈希；评审记录绑定整个 subject 哈希。后续修改工作区里的量表不会改变已归档运行的判分依据。不同量表或评委配置不能被当作同一组稳定性 Trial。

所有有效观察到的运行都可按其声明的交付要求评审。缺少应有的最终回答应被判定或标未知，不靠“没有最终回答”跳过整个评分流程。

Judge 仅读取 JUDGE_MODEL_PROVIDER、JUDGE_MODEL_ID、JUDGE_API_KEY、JUDGE_BASE_URL。使用单次、无工具、无共享会话请求，默认 60 秒、2048 输出 Token、120000 输入字符，没有自动重试。截断、非法 JSON、错误维度、遗漏 criteria、未知引用、工具调用、取消或超时记 invalid，不能冒充评分通过。

人工输入为 cwatch.human-score-input.v5，模板只包含分配的过程/安全 judgments，以及适用的过程 processChecks，findings 留空数组。必须由实际审核者填写身份、理由和证据；程序不代填真人身份。空模板不能提交。未分配人工范围时 CLI 返回 not_applicable。

## 记录、总分与门禁

评分记录和质量报告为 v5。单个评委记录的 ready 表示判定已完成、可供汇总；fail 表示其负责的结果/证据/安全出现否决；needs_review 表示未知或争议；invalid 表示评分器执行失败。这些状态不替代最后的 Case 数值分。记录重新读取时会核验 LLM 维度与过程汇总确由原始 findings 计算，不能手改汇总掩盖条目失败。

quality-report.results[*].penalty 记录统一 0–100 分及各项扣分。原始 Case 批次尚缺评委记录时保持待评分，不默认 100；不得从旧 1–5 分换算过程次数。图示公式以确认的逐项过程判定计算，代码不能根据自由文本猜错误次数。

单次 >=80 数值达标；N 次全部达标才取平均，否则用例总分 0。缺 Trial、未知、冲突或未完成评审不会成为已完成样本；数值门禁要求完整计划全部达标。P0 证据/安全硬边界及显式 required/hardFail 要求保留，发布还要求标准获批。过程出现一两项扣分不会单独导致整例失败，按综合分判断。

每位评委取最后完成的一次记录，保留完整历史，不挑最好结果。不同评分规则版本不直接比较；新报告不覆盖旧结果或 Trace。实际费用、失败重试率或幻觉率没有可信数据时保持 null。

## 运行顺序

日常使用 eval:run --gate automatic 或 eval:regression，一条命令完成执行、代码检查、Judge 与自动报告，无需逐次人工评分。需要人工审核时显式使用 eval:run -- --report <report> --gate final，再通过 eval:human 导入并重新汇总。不适用的评委会跳过。eval:score --kind rules 仅登记规则检查，不会代替当前模式所需的评审。Case 命令的旧 --score-gate 会拒绝执行，避免在评委尚未完成时宣称数值门禁通过。

2026-10-30 已完成 Case 1 首次真实执行及真实 LLM Judge，人工审核待完成；独立 Judge 配置为显式 JUDGE_*，本次与被测模型同为 stepfun/step-5-preview，报告记录 sameModelAsSubject=true，不声称独立模型校准。v4 Case/题单和旧评分记录不会被默认为 v5 输入；迁移时必须显式确认 rubric 与 humanReview 分配。
