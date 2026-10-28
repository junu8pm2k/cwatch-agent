# 四类场景与正负用例

本项目按触发、核心逻辑、产物质量、异常容错维护用例设计。统一索引是 `evals/coverage.json`，清单命令 `npm run eval:coverage` 会检查每个活动 Case 恰好出现一次、元数据与映射一致、没有孤立引用，且四类均有正负例；生成 `artifacts/coverage/latest.json` 和 `latest.md`。

当前共 57 个 Agent Eval：原 12 个契约、原 20 个模型诊断，加 25 个增补场景。38 个使用真实模型模式，19 个为明确的脚本/组件契约。数量是已注册设计覆盖，不能当成执行通过或模型准确率。

| 场景 | 正例 | 负例 | 关注点 |
|---|---:|---:|---|
| 触发 | 4 | 4 | 合法的不同表达应调用已披露调查入口；概念、否定、引用和代码请求不应误触发 |
| 核心逻辑 | 5 | 12 | 工具、参数、顺序、前置步骤、时间/实体和预算；负例检查缺步骤、错工具与参数诱导 |
| 产物质量 | 3 | 8 | 结构化答案和完整 Markdown 文件；缺失、冲突、虚构、错配引用与覆盖夸大 |
| 异常容错 | 2 | 19 | 正确降级和恢复；限流、认证/权限/服务失败、超时、取消、恶意材料、异常和循环停止 |

正负例描述输入条件，不表示预期评分：负例被正确拒绝或降级时应通过。候选标准需真人核验；新增 25 题没有自动批准。原 32 题以各自实际审核记录为准，不改写历史标签。

## 场景边界

**触发**测现有通用 Agent 是否根据用户请求选择入口工具，记录真正的 tool request/execution，而非只检查答复中的 activated。任务目前仍由宿主选择，没有自动 Skill 路由；增补题不把内部审批、预算和 Memory 条件冒充意图激活。

**核心逻辑**同时包含真实模型自主决策题与脚本注入的宿主门禁题，报告保留 executionMode。脚本可以证明错误参数或错序调用被阻断，不能证明模型不会提出这种调用。

**产物质量**新增完整报告契约。必需章节、表格与交付要求由同一 reportContract 同时驱动执行指令和解析，未向 Agent 投放标准答案。控制器从 Trace 提取最终答复，再核对本地实际产物的内容、路径与哈希。事实表自动检查不替代正文语义评分；完整说明见 [新增题集](../evals/scenario-coverage/README.md) 与 [三类评分器](quality-grading.md)。

**异常容错**业务题验证实际 Runtime/工具执行后的结果。进程启动崩溃、挂起、断线、畸形协议和被杀后的收尾继续由现有 `tests/pi-subprocess.test.ts`、`tests/pi-session.test.ts` 负责，统一清单列出工程测试引用，不将这些断言数混入 Agent Eval 分母。

## 运行与阅读结果

```powershell
npm run eval:coverage                  # 设计覆盖清单，读取当前题单与审核状态
npm run eval:scenarios                 # 7 个确定性宿主场景，无外部模型
npm run eval:scenarios:model           # 18 个模型场景，使用本机模型配置并产生用量
npm run eval:scenarios:model -- --case report-complete
npm run test:evaluation                # 评分器校准、隔离执行与本地 SDK 协议回归
```

批次 `report.json.metrics.scenarioCoverage` 按四类和正负例记录 planned、executionPassed、fail、needsReview、invalid；Markdown 显示对应分母。没有新场景元数据的旧归档尝试单列 `unclassifiedScenarioAttempts`，不会依据当前索引静默篡改冻结 Case。全局设计清单独立映射旧 32 题，不修改它们的字节或历史评分。

模型场景实际运行后，可对报告中的具体 case/attempt 使用 `eval:judge`、`eval:human`、`eval:score` 生成三类评分。主任务模型运行、评分模型调用与人工审核分别记录；默认脚本通过、协议模拟通过、题目标准批准均不能代替这一步。

本轮本地 SDK 测试使用脚本 HTTP 提供方生成已知响应，只验证真实 SDK、工具门禁、Trace、文件和评分链路；这些响应不计作外部模型语义质量证据。实际外部模型运行及真人评分应保留在独立批次中，按真实结果报告。

本轮另以现有任务模型配置实跑了触发正/负、多步执行和完整报告四题，保留报告首轮截断失败及预算修订后的新运行；具体分母、用量与未完成的人工验收见 [验收记录](scenario-coverage-acceptance-2026-10-27.md)。
