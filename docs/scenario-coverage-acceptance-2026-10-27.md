# 四类场景覆盖验收记录

2026-10-27：新增 25 个场景候选，当前活动题单总计 57 个。设计覆盖、代码校准、实际执行和人工审核分别记录，不把用例数量或协议模拟当作模型准确率。

## 实现与验证

- 统一 `evals/coverage.json` 将三个活动题单各 Case 唯一映射到四类正负场景；工程测试单列。`npm run eval:coverage` 生成可核对的 57 题清单。
- 新增 8 个工具触发、8 个核心逻辑、6 个完整报告、3 个容错场景。其中 18 个模型模式、7 个脚本宿主契约，新标准均待真人核验。
- 从 Trace 提取实际请求、执行和参数，不以回答中的“已激活/已完成”为依据。完整报告检查真实文件、内容一致性、必需章节和事实/引用配对；保存产物路径和哈希。
- `npm run verify`：528/528（contract 370、semantic 57、integration 101），结构与类型检查通过。日志 `artifacts/scenario-coverage-verify.log`。
- 报告额度修订后 `npm run test:evaluation`：62/62，并再次通过类型检查。日志 `artifacts/scenario-coverage-tests-final.log`。包含已知坏报告校准、历史标签保留、7 个隔离 worker 场景、18 个本地真实 SDK 协议场景。
- 新增脚本宿主用例实际执行 7/7 检查通过，题目标准未批准，因此全部仍为 needs_review；不是正式 Golden 成绩。

## 当前配置的真实模型 smoke

使用现有任务模型配置，工具与来源仍为冻结 fixture，不访问资料 URL。四个不同 Case 共运行五次；以下每次运行都保留独立报告、Trace、输入、用量和 manifest。

| Case | 修订 | 运行检查 | 已知 Token | 物理请求 |
|---|---:|---|---:|---:|
| activation-direct | 1 | 通过；实际调用入口一次 | 4716 | 2 |
| activation-negated | 1 | 通过；没有调用入口 | 2851 | 1 |
| model-core-ordered | 1 | 通过；先 read_context，再 collect(query=releases) | 5476 | 3 |
| report-complete | 1 | 失败；2048 输出 Token 后 truncated_response，无可交付最终报告 | 6537 | 2 |
| report-complete | 2 | 通过；4096 输出额度下真实 Markdown 产物与事实表检查通过 | 5915 | 2 |

合计已知 Token 25495、物理请求 10，包含失败尝试，实际费用未核实为 null。逐次报告位置和 runId 保存在 `artifacts/scenario-smoke/summary.json`。这只是四题 smoke，尚未执行完整 18 题真实模型集合，也不报告整体模型准确率。

原报告截断失败没有撤销或重写。题单从 `.2` 发布到 `2026-10-27.3`，六个完整报告 Case 从 revision 1 提升到 2，仅将单次输出预算由 2048 改为 4096，事实、格式和判定标准不变；`.2` 的 25 题完整字节已快照。旧失败按旧修订保留，新额度只用于新运行。

## 仍需人工完成的验收

新增候选的标准批准、报告正文的 LLM/真人评分、完整真实模型集合和独立 Holdout 仍需分别执行。此次 smoke 只通过已声明的客观检查，没有把真人身份或语义评分自动补成通过。

触发评测范围为现有通用 Agent 对已披露入口工具的调用选择；系统没有新增自动 Skill 路由。真实崩溃/断线和 IPC 故障继续由现有工程测试验证，已列入覆盖清单的工程参考位置，不混入 57 题分母。
