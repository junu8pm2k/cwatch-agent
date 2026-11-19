# 运行产物

| 目录 | 内容 |
| --- | --- |
| `artifacts/benchmark/<run-id>/` | Agent Benchmark 的 `report.json`、JUnit 和逐题 Trace，容器回传后还会写入 `langfuse.json` |
| `artifacts/benchmark/sync.json` | 最近一次 Dataset 同步的时间、版本与快照校验和 |
| `artifacts/eval/` | `npm test` 的工程测试报告 |
| `artifacts/test-work/` | 工程测试的临时工作目录 |

生成结果默认由 Git 忽略。Benchmark 的运行与回传命令见 [Agent Benchmark 指南](../evals/README.md)。

旧评测批次如仍在本机，可从 `artifacts/agent-eval/` 查阅。另见 [历史审计摘要](history-summary/README.md)、[历史清理记录](cleanup-summary.json) 和 [结构化 Trace 样例](../examples/structured-trace/README.md)。
