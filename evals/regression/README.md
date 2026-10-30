# 自动回归集

正式清单为 [suite.json](suite.json)，只有经程序新跑五次并通过严格门禁的 Case 才写入。admissions 目录保留紧凑的入集证据，包含五个独立 runId、逐次判定、输入和基线哈希、模型与 Judge 身份；完整运行日志和 ZIP 保存在 artifacts/agent-eval。

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

统一评分体系仍以 80 分为达标线；CI 在此基础上使用更严格的 100 分及全部条目 pass 门禁。基线、Case、模型或 Judge 身份变化时须重新确认对应基线并重新准入，旧的成功记录不能静默覆盖新条件。

这是 automatic_regression 范围的能力检查，本轮不创建人工过程/安全待办。报告按自动范围显示已完成的得分与稳定性，不因缺少人工意见而显示待评分；既有人工记录保留为历史证据。基线已人工确认的参考标准用于冻结评判条件，真实 LLM Judge 仍按当前 Case 的结构化量表评审。修改 Case/量表、异常或抽样审核时可显式使用 eval:run -- --report <report.json> --gate final。此自动门禁不代表完整人工发布审核，也不声称通过五次就保证未来永不退化。

## CI

[ci.yaml](../../.github/workflows/ci.yaml) 使用 GitHub Actions 的 Ubuntu 托管 runner，在 Node 24 / Debian Trixie 容器中运行。“智能体能力回归”（任务 ID 为 agent-regression）在每次 push、pull_request 时执行 npm run eval:regression。任务失败会使 CI 失败，报告、Trace、评分、基线引用和 ZIP 始终尝试上传为“智能体回归产物”。“工程检查”和“浏览器与网页检查”作为另外两条独立任务运行。

在 GitHub 仓库的 Actions Secrets 中配置两个秘密变量：EVAL_API_KEY（主模型）和 JUDGE_API_KEY（评分模型）。模型和接口地址已按当前确认条件固定在 workflow 中。秘密变量缺失时明确失败，不跳过评测后显示成功。密钥不写入题单、清单、日志或归档。

本地修改 workflow 不会自动发布或触发远程 CI。将清单、准入记录、Case、基线和代码一起按项目正常流程提交到 GitHub 后才能运行；整理工作流不自动更改远程设置。

如需 CI 失败时阻止合并，应在 GitHub 分支规则中将显示名称“智能体能力回归”设为必需检查；如之前使用旧显示名称 agent-regression，需要同步更新所选检查。本地 workflow 文件不会自动更改分支保护设置。
