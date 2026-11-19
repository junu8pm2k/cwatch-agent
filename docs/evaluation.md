# 评测入口

## Agent Benchmark v2.3

日常回归使用 `npm run eval:run`。通过 `BENCHMARK_SUITE` 选择 `smoke`、`regression` 或 `all`。本地和 PR 质量门禁都读取 `evals/datasets/` 快照，按题校验工具调用、输出格式或语义评分。用例在 Langfuse 中编辑后通过 `npm run eval:sync` 更新。 [题集与通过标准](../evals/README.md)

本地和 PR 都用 DeepEval 执行语义评分。Langfuse 用于维护 Dataset，以及查看本机和容器评测回传的 Trace 和分数。PR 的真实模型评测由 `DeepEval benchmark` 作业执行。 [项目检查工作流](../.github/workflows/ci.yaml)

## 工程检查

`npm run verify` 运行结构、类型和工程测试，包括对产品 Trace 与 Langfuse 上报的离线检查。
