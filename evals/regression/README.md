# 自动回归集

正式清单为 [suite.json](suite.json)，只有经程序新跑五次并通过严格门禁的 Case 才写入。admissions 目录保留紧凑的入集证据，包含五个独立 runId、逐次判定、输入和基线哈希、模型与 Judge 身份；完整运行日志和 ZIP 保存在 artifacts/agent-eval。

当前清单包含 activation-001 revision 4 与 activation-002 revision 2，两例均独立完成五次真实执行与 Judge，每次 100 分，每例代码检查 40/40、Rubric 15/15，人工待办 0。Case 1 新版准入批次为 batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5，见 [Case 1 准入记录](admissions/activation-001.r4.eb3c4659-3152-4f88-86d2-036ada872905.json)；Case 2 批次为 batch-a2619244-1ba1-4548-ac38-d03daaaf01a7，见 [Case 2 准入记录](admissions/activation-002.r2.2c043382-3eac-4ed8-b682-5329e8270563.json)。Case、冻结 Skill、量表、基线及确认记录一起随 Git 管理，生成的完整 ZIP/Trace 继续由 artifacts 保存。旧 Case 1 r2 准入证据及后续失败批次作为历史保留，不与新版五次混合统计。

## 条件与命令

```powershell
# 新跑五次，全部通过才入集或更新登记
npm run eval:regression -- --qualify --dataset evals/activation/dataset.json --case activation-001

# 只核对清单、证据和模型配置，不调用模型
npm run eval:regression -- --check

# 真正运行整个回归集：每例五次真实执行和独立的真实 Judge
npm run eval:regression
```

每次必须正常完成，自动项为 100 分，所有必需代码检查及分配的 Rubric 条目均 pass，并且 Case 有兼容的人工确认基线。五次均满足才通过；任意一次已知失败，用例为 0；评分未知、缺记录、重复 runId、少跑或空清单均不能通过。失败保留，不自动重试，也不以四次成功抵消一次失败。

LLM Judge 的默认输出预算为 16384 tokens，单次超时为 180 秒，独立命令和流水线使用相同默认值。官方 Step 5 Preview 端点在 Judge 内按其 64k 最大输出声明能力，避免被通用自定义模型的 4096 默认值再次截断；这不修改任务模型的运行预算。若 Judge 仍返回 length，记录为 judge_response_truncated，控制台、报告和归档保留错误；评分为未知并阻塞门禁，不当作能力失败或成功，也不自动重试。独立命令可用 --max-output-tokens 显式设置预算（上限 32768）。

有 Evidence 判据时，Judge 另发一次独立证据审核，两次请求共享 180 秒总超时，实际请求数和 Token 分别留证并合并统计。审核涵盖建议文案中的事实；逐处日期角色明细缺失时评分无效，不能默认满分。自动回归不会因这些异常要求人工补签，失败/待判直接反映在门禁与归档中。

统一评分体系仍以 80 分为达标线。自动回归使用更严格的门禁，要求 100 分及全部条目通过。基线、Case、模型或 Judge 身份变化时须重新确认对应基线并重新准入，旧的成功记录不能静默覆盖新条件。

这是 automatic_regression 范围的能力检查，本轮不创建人工过程/安全待办。报告按自动范围显示已完成的得分与稳定性，不因缺少人工意见而显示待评分；既有人工记录保留为历史证据。基线已人工确认的参考标准用于冻结评判条件，真实 LLM Judge 仍按当前 Case 的结构化量表评审。修改 Case/量表、异常或抽样审核时可显式使用 eval:run -- --report <report.json> --gate final。此自动门禁不代表完整人工发布审核，也不声称通过五次就保证未来永不退化。

## CI

[ci.yaml](../../.github/workflows/ci.yaml) 在 push 和 PR 时运行 `npm run verify`。CI 已暂停自动运行真实 Agent 回归。有需要时可配好本地模型和 Judge，再执行上面的 `npm run eval:regression`。
