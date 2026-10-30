# 用例基线

此目录保存随仓库版本管理的参考快照。普通评测的 Trace、日志和 ZIP 仍在 artifacts/agent-eval；基线从已认可的一次真实运行中冻结，原始运行目录清理后仍可读取。

Case 1 的登记入口为 [activation-001.r2.json](activation-001.r2.json)，状态以登记文件为准。它按 Case ID、修订及内容哈希绑定到具体快照，记录基线元数据路径与校验值，并关联独立的人工确认记录。

当前快照的 [最终回答](activation-001/r2/eb1b161b-65b4-4bf1-9880-622edab786c5/final-answer.md) 和 [元数据及文件清单](activation-001/r2/eb1b161b-65b4-4bf1-9880-622edab786c5/baseline.json) 来自 runId=aad1c3c5-898f-4cd9-a715-854d322bb607。用户已在对话中明确认可结果并确认为基线，确认记录保存在同一快照目录中。

快照包含 Case、Prompt/冻结 Skill、Rubric、原始及结构化 Trace、工具请求与结果、中间证据、最终回答、实际指标和评分记录。模型的私有 SDK 会话与凭据不进入这个可版本管理的目录；可观察的执行事实保留完整。文件哈希用于发现意外改动，Git 用于追踪有意变更。

操作入口见 [基线工作流](../../docs/evaluation-baselines.md)。一次人工认可即可建立基线；五次稳定性测试另行汇总，不是建立基线的前置条件。该目录不被 .gitignore 忽略；本轮没有自动 git add、commit 或 push。
