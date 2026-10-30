# 评测状态与通用入口

2026-10-29 清空全部旧 Case；2026-10-30 从新设计注册 **1 个用例 activation-001**，用于首次真实执行。当前基线仍未建立。

新用例集见 [设计说明](../evals/drafts/README.md)：四类场景暂定共 32 例，触发已有 4 个设计稿（正反各 2）。Case 1 已形成 [可执行题单](../evals/activation/dataset.json)，其余三例未注册。Case 1 使用冻结的本地 Skill 和资源、无外部采集来源，真实执行与真实 Judge 请求分别归档；人工审核不由脚本代填。

报告入口为 eval:report -- --report <batch/report.json>，只读取归档，不调用模型。输出严格包含全局概览、用例列表、单例详情、用例汇总、稳定性评分、Trial 执行记录；未取得的基线/费用和未完成的人工判定保持空值并解释原因。批次目录及压缩归档无需 Git 提交。

统一自动化入口现为 [eval:run](automated-evaluation.md)：一条命令完成执行、规则检查、真实 Judge、人工待办、固定 v2 报告和 ZIP。人工待审核只影响最终综合分，不隐藏自动项的判定、扣分、得分和通过率。--report 可复用已有完整评分，避免再次请求模型。详细报告 v2、自动评分 v1、流水线结果 v1 的格式由仓库程序固定，不能用临时对话生成的报告替代。

清理范围包括原 57 个注册 Case、8 个领域评测 Case、全部题单与索引、参考材料、待审候选、历史副本、草案模板，以及 Case 评测批次中的题目快照、输入、Trace、评分和模型转录。依赖旧题库的专用检查与自动生成脚本已移除。

普通 `tests/*.test.ts` 工程回归、产品运行代码和通用评测框架保留。`npm run verify` 与 CI 不再加载已删除的 Case 题库；`eval:scenarios`、`eval:scenarios:model` 和 `test:evaluation` 已移除。

通用 Case 工具不会选择默认题单，未显式提供数据路径时会在执行或调用模型前退出。仅在另行准备并核验新的题单后使用：

```powershell
npm run eval:cases:lint -- --dataset <file>
npm run eval:cases -- --dataset <file>
npm run eval:model -- --dataset <file>
npm run eval:review -- --dataset <file>
npm run eval:coverage -- --index <file>
```

模型模式仍需模型配置，并可能产生实际用量。历史批次重评分和 LLM/人工评分工具仍要求显式的报告路径；仓库中已不再附带旧 Case 批次。

GitHub API 停用策略继续生效。普通工程 fixture 不属于本次清空的 Agent 题库，不代表模型质量成绩。

评测维度已修正为五类，见 [五类评测维度](evaluation-dimensions.md)。Case/题单、人工输入及质量评分记录采用 v5；通用评分政策为 cwatch.quality-rubric.v6，Case 结构化量表为 cwatch.eval-rubric.v1；规则 Result 和批次 Report 保持 v2。Case 显式指定 rubric 或 null，以及 humanReview.dimensions；评分器只评被分配的条目，不强制每例都调用 LLM。旧契约与旧四维/1–5 分记录不直接作为新版输入。统一 100 分负分制须完成本例指定的评审后汇总，见 [计分规则](penalty-scoring.md) 和 [LLM 结构化量表](quality-grading.md)。
