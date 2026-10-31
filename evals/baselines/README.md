# 用例基线

此目录保存随仓库版本管理的参考快照。普通评测的 Trace、日志和 ZIP 仍在 artifacts/agent-eval；基线从已认可的一次真实运行中冻结，原始运行目录清理后仍可读取。

Case 1 当前修订的登记入口为 [activation-001.r4.json](activation-001.r4.json)，已获用户一次性明确确认。它按 Case ID、修订及内容哈希绑定到具体快照，记录基线元数据路径与校验值，并关联独立的人工确认记录；历史 [revision 2](activation-001.r2.json) 保留。

历史 revision 2 快照的 [最终回答](activation-001/r2/eb1b161b-65b4-4bf1-9880-622edab786c5/final-answer.md) 和 [元数据及文件清单](activation-001/r2/eb1b161b-65b4-4bf1-9880-622edab786c5/baseline.json) 来自 runId=aad1c3c5-898f-4cd9-a715-854d322bb607。用户已在对话中明确认可结果并确认为基线，确认记录保存在同一快照目录中。

Case 1 revision 4 来自一次不含预期、Rubric 或 Judge 的纯执行试跑 runId=9bf2daf5-afa7-48a9-9549-50457c4cbd1c，用户回复“认可，登记 Case 1 新基线并继续自动验证”。实际读取检查表一次，无外部采集；原回答、原始/结构化 Trace、Skill 输入及独立确认记录随快照保存。沿用 v1 快照格式的 raw trial 字段映射在 source-provenance.json 中声明，未捕获的源代码版本为 null，未编造评分或运行报告。后续五次回归使用全新独立执行，不继承这次人工评分。

快照包含 Case、Prompt/冻结 Skill、Rubric、原始及结构化 Trace、工具请求与结果、中间证据、最终回答、实际指标和评分记录。模型的私有 SDK 会话与凭据不进入这个可版本管理的目录；可观察的执行事实保留完整。文件哈希用于发现意外改动，Git 用于追踪有意变更。

操作入口见 [基线工作流](../../docs/evaluation-baselines.md)。一次人工认可即可建立基线；五次稳定性测试另行汇总，不是建立基线的前置条件。该目录不被 .gitignore 忽略；本轮没有自动 git add、commit 或 push。

Case 2 当前新版登记为 [activation-002.r2.json](activation-002.r2.json)，已确认。用户在正式报告生成前明确回复“认可，登记新版基线”，认可展示的流程、安全边界和最终回答。冻结快照绑定 runId=e188d855-9045-45e0-a4e3-8c11caf405f4；实际人审记录先导入，再通过标准 eval:baseline 入口冻结及确认，随后续行生成正式报告。r1 的基线和失败记录均保留。后续回归按自动模式执行，不逐次索要人工评分。

Case 2 的登记入口为 [activation-002.r1.json](activation-002.r1.json)，已确认。来源是用户要求重新执行的纯 Prompt 试跑 runId=667dbd08-2375-41e2-ba55-64aa00173fd1，执行时不加载评分预期、Rubric 或旧回答，也不调用 Judge。用户看到 Trace、Outcome 及两处已指出的问题后回复“ok”，该确认原文已转录至独立确认记录。快照共 16 份文件，包括原 Prompt、冻结 Skill、Trace、工具记录和原回答；既有 Case 仅用于身份及执行输入绑定，不代表量表获批。由于沿用 v1 快照格式，source.batchId 为原 trialId，source.reportSha256 为原 trial.json 的哈希，映射明确记录在快照 source-provenance.json 中；未生成虚构评分报告。运行时未捕获代码版本，sourceVersion 保留 null。
