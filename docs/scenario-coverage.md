# 场景与五维覆盖状态

2026-10-29 已清空旧题库及归档；2026-10-30 从新设计注册 **1 例 activation-001**，已完成真实执行及 LLM 判定，人工与基线待确认。旧案例与旧运行批次没有恢复。

新用例集按用户要求重新采用四类场景：触发 activation、核心逻辑 core_logic、产物质量 artifact_quality、异常容错 resilience。暂定总计 32 例（4/24/2/2），本轮只编写触发 4 例设计稿，正反各 2，均未运行、未建立基线。见 [用例集设计](../evals/drafts/README.md)。

评分维度仍为 Outcome、Trajectory、Evidence、Safety、Cost，详见 [五类评测维度](evaluation-dimensions.md)。四类场景与五类评分维度是独立分类，不能相互替代。

当前可执行 Case 的 coverage.category 只接受五维主要覆盖维度，polarity 标记正负输入；实际评分的每项检查独立归入五类。四场景元数据目前只记录在新设计稿中，尚未接入可执行 Schema 或覆盖索引；不能把 activation 填入现有 coverage.category。新版覆盖索引及清单为 v2，检查唯一引用、正负覆盖和数据一致性，不代表执行通过率。

`eval:scenarios` 与 `eval:scenarios:model` 保持移除；通用覆盖入口必须显式提供 --index <file>。普通工程测试保留，不计入 Agent 题库分母。
