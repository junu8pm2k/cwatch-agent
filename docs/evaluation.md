# 评测入口

## Agent Benchmark v3

日常回归使用 `npm run eval:run`。通过 `BENCHMARK_SUITE` 选择 `smoke`、`regression` 或 `all`。本地和 PR 质量门禁读取 `evals/datasets/` 的题集快照，按每题 Rubric 运行 Code Judge 和 LLM Judge。编辑正式题后运行 `npm run eval:sync`，重新生成快照校验和。 [题集、通过标准与错例回流](../evals/README.md)

使用 `npm run eval:check` 检查确定性评分，使用 `npm run eval:calibrate` 让 LLM Judge 为固定正反答卷评分。`DeepEval benchmark` 作业运行正式题集并保存报告。Langfuse 可用于查看宿主上传的 Trace 和分数。 [项目检查工作流](../.github/workflows/ci.yaml)

## 工程检查

`npm run verify` 运行结构、类型和工程测试，包括对产品 Trace 与 Langfuse 上报的离线检查。
