# 运行产物

此目录保存运行结果和验收材料，源码位于 apps、packages、scripts 等目录。Git 仅纳入 `.gitignore` 明确允许的交付样例、紧凑报告及审计材料；本地运行会继续产生被忽略的文件。

| 类型 | 目录或文件 | 用途与清理方式 |
| --- | --- | --- |
| 工程回归 | eval/latest.json、latest.md | 最近一次完整回归结果，保留 |
| 场景覆盖 | coverage/latest.json、latest.md | 触发、核心逻辑、产物质量、异常容错的用例清单，保留 |
| 交付与历史审计 | delivery-demo、audit、verification-manifest.json | 初始交付及材料对应关系证明，保留其历史时间和范围 |
| 真实调用与评测证据 | competitor-live、agent-eval-model、model-suite-*、scenario-smoke 等 | 来源、模型或隔离评测的原始证据，本地保留；不因新运行覆盖历史结论 |
| 评分演示 | penalty-demo、penalty-demo-final | 负分制重评分和多 Trial 聚合的回放样例，本地保留 |
| 工具与界面验收 | *-probe、browser-eval、web-eval、*-live | 保留紧凑验收报告；无引用的调试截图和浏览器录像可清理 |
| 临时测试数据 | test-work/case-*、clean-install-* | 测试完成且没有进程占用后可删除，下次测试自动生成 |
| 重复演示及一次性调试 | design-preview、skill-validation、临时服务目录、无引用旧日志 | 验证结束后可删除，不作为业务数据使用 |

`cleanup-summary.json` 记录最近清理的范围和实际数量。被文档引用的验收日志与真实模型证据保留。`.env`、`.runtime` 和 node_modules 位于根目录，分别用于本机配置、用户运行状态和本地依赖，继续忽略 Git。

结构化 Trace 的可移植合成样例放在 [examples/structured-trace](../examples/structured-trace/README.md)，字段说明见 [docs/structured-trace.md](../docs/structured-trace.md)。
