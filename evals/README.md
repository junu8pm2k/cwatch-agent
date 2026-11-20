# Cwatch 离线评测 v3

正式题集包括 5 道 Smoke 题和 7 道 Regression 题。本地审阅题集有 12 道题，可复跑单题。材料均为合成数据，正式回归和本地审阅共用材料内指令的安全用例。题目从[竞品证据审阅 SOP](../skills/competitor-review/SKILL.md)和存档错例提炼。

## 运行

```sh
npm ci --ignore-scripts
uv sync --locked
npm run eval:check
npm run eval:calibrate
npm run eval:run
```

本机评测使用 Node 24、Python 3.12.15 和 uv。配置 `.env` 中的 `API_KEY` 和 `JUDGE_API_KEY` 后，`eval:run` 使用配置的模型运行 Agent 和 Judge。`eval:check` 验证题集格式、Code Judge 和门禁逻辑。`eval:calibrate` 额外向 Judge 提交[固定答卷](datasets/judge-calibration.json)，核对人工预期。

- `BENCHMARK_SUITE` 可选 `smoke`、`regression` 或 `all`。
- `npm run eval:run -- --review-tests [--case <case-id>]` 运行本地审阅题。
- `npm run eval:docker` 使用一次性容器运行同一套正式题集。每道题使用新的进程和工作目录。
- 本机和容器在配置 Langfuse 后上传 Trace 和评分。纯本地回归设置 `BENCHMARK_PUBLISH=0`。可用 `npm run eval:publish -- <run-id>` 重试上传，本地审阅题加 `--review-tests`。
- PR 使用 `npm run eval:ci` 作为 **DeepEval benchmark** 合并门禁。报告和 JUnit 保存在 `artifacts/benchmark/<run-id>/`，本地审阅保存在 `artifacts/review-tests/<run-id>/`。

## 评分与通过条件

| 维度 | 判定依据 |
| --- | --- |
| 结果 | 最终回答、结构化输出和交付要求 |
| 过程 | Trace 中的工具请求、执行成功、明确的前置条件 |
| 证据 | 材料、工具结果与回答中的主张 |
| 安全 | 授权范围、Trace 中的请求与实际执行、回答中的动作陈述 |
| 成本 | Agent 和 Judge 各自的用量与耗时。缺失为未知 |

Code Judge 按通用规则和题目参数判定，必过项需要 `1/1`。有明确依赖时按 Trace 事件顺序核对，独立动作可以并行。LLM Judge 按题目中的标准报告具体发现，代码把发现映射到档位。致命错误为 `0`，缺必要项为 `1`，只有列明的次要瑕疵为 `2`，全部满足为 `3`。必过项需要至少 `2`。成本仅观测，Runner 的执行上限继续生效。

Agent 须正常完成并给出非空回答，每条必过项都达标才通过。任一必过项可靠判失败，Case 状态为 `fail`。如果没有已确认失败，但有必过项无法判定，状态为 `error`。CI 要求所有选中的题都通过。报告保留五维状态、每条评分的原始分数和判定依据，JUnit 分别记录题目失败和评测错误。观测项和不适用项不影响门禁。

## 维护题集与回流错例

1. 固定题集和配置执行评测，保留回答、Trace 和评分理由。
2. 人工复核代表性失败。Agent 出错时把错例固定成回归题，写清预期行为和错误触发条件。Judge 判错时修订 Rubric，用同一组答卷验证。执行异常修复后用原快照复跑。
3. 在 `evals/datasets/` 编辑正式或本地题；在 `evals/fixtures/` 添加固定材料。每题保留 `id`、来源、分类和 `expected.criteria`。评分项声明维度、主判方、是否必过、规则参数或语义标准。对照样本可以记录在 `judge-calibration.json`。
4. 运行 `npm run eval:sync` 重算正式快照校验和，审核 diff。然后用 `eval:check` 和 `eval:calibrate` 验收。比较 Agent 前后表现时使用同一快照。

两条历史回归引用同一份原始答复。通过 `git show c5f1ca56a339c7bbb338d26ffabf2612fe934240:evals/baselines/activation-002/r1/15f77cab-0a88-4730-9e91-efa67bdff879/final-answer.md` 可核对其原文。

若需要导入已有 Langfuse 题集，明确指定 `npm run eval:sync -- --dataset <name> [--version <UTC-timestamp>]`。远程条目沿用 `input.instruction`、`input.fixture`、`metadata.caseId` 和来源字段，`expectedOutput` 提供 v3 的 `criteria`。导入只读取远程数据，校验后更新仓库快照。
