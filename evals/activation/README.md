# Case 1 首次执行

当前 activation-001 为 revision 2：仅将主模型每次请求的输出上限从 2048 调至 8192，总 Token 预算仍为 30000；Prompt、Skill 快照、量表及检查规则不变。旧 revision 1 的运行证据保持原样，新旧预算下的运行不能直接视为同条件稳定性样本。

题单为 dataset.json，当前仅含 activation-001，标准状态为 needs_review。任务使用仓库 competitor-review Skill 与检查表的冻结快照；宿主通过真实 SessionTools 提供资源读取，不用预设工具调用或答案。模型只收到输入与 Skill，量表保存在评审侧。

本修订的基线登记为 [activation-001.r2.json](../baselines/activation-001.r2.json)，已按用户明确确认绑定到此前单次运行的完整可观察快照。基线随仓库版本管理，报告会读取实际状态和指标；它不代替后续五次运行的人审，也不改变冻结 Case 中的原审核状态。操作说明见 [基线工作流](../../docs/evaluation-baselines.md)。

Case 1 已在新一轮五次真实执行及 Judge 均通过严格自动门禁后，正式纳入 [自动回归清单](../regression/suite.json)。CI 使用 npm run eval:regression 运行整个正式清单，每例五次、每次 100 分、代码和 Rubric 全通过；人工评分与完整发布门禁仍单独保留。准入条件和远程 CI 配置见 [回归集说明](../regression/README.md)。

统一入口：npm run eval:run -- --dataset evals/activation/dataset.json --case activation-001 --repeat 1 --gate automatic。一条命令完成真实执行、代码检查、Judge、自动评分报告和 ZIP 归档；默认 gate=automatic，不创建人工待办。需要人工审核时显式使用 --gate final，才会生成 Case 指定的人工模板和综合报告。

补齐已有批次：npm run eval:run -- --report <batch/report.json> --gate automatic。匹配当前量表、评委配置和评分器版本的已完成 Judge 记录会复用，不重跑 Agent。只有需要人工审核时才显式使用 --gate final 派单，填写模板并通过 eval:human 导入，再用 --gate final 更新人工综合报告与归档。eval:report 仅用于从已有记录重新生成报告，默认自动模式，人工视图可用 --mode human_review。

每批次使用独立输出目录、新会话与输入快照。失败批次和重试批次分别保留，不能用成功记录覆盖失败记录。现有 Node 权限限制不代表操作系统网络隔离；模型服务需要实际连接。

完整归档包含批次报告、输入、模型回答、原始/结构化 Trace、日志、逐项评分、冻结 Case/Skill/量表和受限脱敏会话。压缩包及校验摘要保存在本地 artifacts 下；归档不要求 git commit，也不会自动将运行确认为基线。
