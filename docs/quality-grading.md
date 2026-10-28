# 三类评分器

代码规则、独立 LLM Judge 和逐次运行的人工评分共用已归档的 Case、runId、attempt 与证据哈希。它们用于 `eval:cases` / `eval:model` 生成的批次，不能直接拿任意 Trace 文件替代完整证据包。原报告、Result、Case 和审批状态保持原样，新增评分另存。

## 运行

先运行已有评测取得 `batch/report.json`。以下 `<report>` 指这个文件，`<case>` 指其中一个 Case ID；默认 attempt 为 1，可以显式添加 `--attempt 2`。

```powershell
# 规则评分：根据冻结证据重新检查，保留原控制器已发现的失败
npm run eval:score -- --kind rules --report <report> --case <case>

# 独立模型评分：一次请求，没有工具、共享会话或可写 Memory
npm run eval:judge -- --report <report> --case <case>

# 创建供真人填写的评分模板，同时返回可阅读的 subject.json
npm run eval:human -- --report <report> --case <case> --template

# 真人阅读证据、填写模板后提交；不要让被测模型代填
npm run eval:human -- --report <report> --case <case> --input <human-input.json>

# 汇总整个批次的三类评分，输出新的 JSON 和 Markdown
npm run eval:score -- --report <report>
```

`eval:judge` 只读取专用配置，填写在本机 `.env` 或环境变量中：

```dotenv
JUDGE_MODEL_PROVIDER=your-provider
JUDGE_MODEL_ID=your-pinned-model-id
JUDGE_API_KEY=your-local-key
JUDGE_BASE_URL=https://your-endpoint.example/v1
```

不自动回退到被测模型配置。可以明确配置相同模型，但报告会保留被测/评分模型标识及是否相同；独立请求不意味着建立了独立真值。为可复核性应使用供应商可固定的模型版本，别名本身不能保证供应商实现不变。

默认 60 秒、最多 2048 输出 Token、120000 输入字符，最多单次物理请求，无自动重试。可用 `--timeout 90000 --max-output-tokens 4096` 调整，上限分别为 180 秒和 4096 Token。输入不能容纳时直接拒绝，不静默裁掉证据。超时、取消、非法 JSON、工具调用、输出截断与未知证据引用都保存为 `invalid` 评分，不能当作通过。这里的 invalid 是评分器失败，不会把被测系统已有的 fail 改成设施失败。

## 量表与人工输入

固定量表 `cwatch.quality-rubric.v1`：

| 维度 | 权重 | 评判内容 |
|---|---:|---|
| correctness | 40% | 是否满足冻结任务和最终要求，是否自相矛盾 |
| groundedness | 30% | 事实与引用是否受实际工具证据支持 |
| uncertainty | 20% | 是否诚实表达错误、未知和覆盖缺口 |
| clarity | 10% | 表达是否清晰、相关并符合交付要求 |

每维 1–5 分：1 严重错误，2 实质缺陷，3 满足要求，4 准确充分，5 支持完整且清晰。无法判断填 `null`，不要用中间分代替未知。每维都必须至少 3 分才通过，不能靠其他维度拉高均分；任一未知则总质量分为 null。`qualityScore` 为加权后的 1–5 分，与规则门禁分开。

模板自动填好 `subjectSha256`、`rubricVersion` 和四个维度。真人填写 `reviewer`、各维 `score`、简短 `reason`、`evidence`；空白模板不能提交。每条 evidence 至少引用一个允许的 ID：`task`、`requirements`、`final-answer`、`rules` 或 subject.json 中存在的 `trace:<sequence>`。例如某条判断可填写：

```json
{
  "dimension": "uncertainty",
  "score": 4,
  "reason": "答复说明来源限流，并将窗口内是否更新保留为未知。",
  "evidence": ["final-answer", "requirements"]
}
```

`answer.concerns` 可填 `factual_dispute` 或 `safety_concern`，或空数组。存在争议时保留待复核，不由模型自动裁定安全/事实真值。`notes` 保存人工补充说明。人工署名是本机声明，程序不认证身份；这与 `eval:review` 对题目和标准的批准是两个操作。给某次答复打分不会批准 Case。

## 综合判定

- 规则已确认失败或人工给出低分：综合 fail。规则中的安全失败不能被质量分抵消。
- 缺少任一质量评分、评分器 invalid、证据不足、未完成的 Judge 请求、Case 标准未经批准、两类评分冲突：needs_review。
- 规则通过、Case 已批准、LLM 和人工评分均通过：pass，满足新的质量发布门禁。
- Memory/discovery 等组件 Case 或没有最终回答的运行不做自然语言质量评分，报告明确标记 `semanticApplicable=false`，继续使用其规则门禁。

每类使用最后完成的评分，报告保留全部历史，不选最好的一次。新评分替代旧评分只影响新生成的综合报告，不修改旧文件。原来的 `eval:cases --require-approved` 仍检查原规则发布门禁；包含三类评分的新发布门禁应使用 `eval:score` 的 `metrics.releaseGate`。单项评分命令非 pass、或综合报告发布门禁未通过时退出码为 1；模板生成成功退出 0。

## 归档与边界

```text
<batch>/
  report.json                         # 原报告不变
  assessments/<uuid>/
    request.json / wire-request.json   # Judge 请求；模板目录没有此项
    response.json                     # 仅可见评分文本和用量，不归档内部思考
    subject.json                      # 冻结评分输入，包含量表与原报告哈希
    record.json                       # 评分结果、模型版本、理由、证据引用、用量
    manifest.json                     # 新评分文件的字节哈希
  quality-report-<uuid>.json / .md     # 三类评分汇总
```

人工模板目录仅含 subject.json 和 human-input.json，提交后另建不可覆盖的评分目录。读取时重新验证原证据包和评分哈希，拒绝篡改与路径越界。它是可检查的本地审计归档，不是外部签名或身份认证系统。

LLM 仅接收冻结任务、工具响应、要求、公开执行事件与最终答复；不读取私有 SDK 转录、内部思考、任意 oracle 引用文件或认证信息。Judge 的提示词、版本、量表、模型与端点指纹分别保存；Judge 请求不参与被测 Agent 会话或 Memory。模型输出和工具文本始终作为不可信数据处理。

Judge 用量与主任务分别记录，包含已失败请求；缺失用量为 null，已知 Token 求和同时列出未知请求数，实际费用未核实则为 null。进程被强杀留下的请求没有完成评分，报告单列 `incompleteJudgeAssessments`，不虚构用量或成功记录。证据引用校验只能证明引用存在，不能证明模型的语义判断正确。

本次验证包括合成正确/低分/未知/争议判定、硬失败优先级、人工绑定、脱敏、超时取消、完整性和本地 HTTP + 真实 Pi SDK 请求。没有调用外部评分模型，也没有把这些测试当作 Judge 语义准确率；正式使用前仍需要人工标注样本上的模型校准。
