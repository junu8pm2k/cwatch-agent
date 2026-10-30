# 五类评测维度

2026-10-29 按项目所有者提供的参考图修正。维度定义集中在 `scripts/evaluation/dimensions.ts`，规则结果、结构化量表、覆盖索引和报告共用该定义。当前内置 eval Case 仍为 **0**。

| 大类 | 子维度 | 负责评分器 | 默认优先级 |
|---|---|---|---|
| Outcome 结果 | 结果正确性、任务完成度、指令遵循、交付格式 | 代码 + Rubric | P0 |
| Trajectory 过程 | 推理合理性、步骤、工具调用、上下文利用率 | Rubric + 人工 | P1 |
| Evidence 证据 | 来源、证据完整性、结论与材料/Tool Result 的对应 | 代码 + Rubric | P0 |
| Safety 安全 | 一致性（pass^k）、异常恢复、抗对抗扰动、幻觉率、越权风险 | 代码 + 人工 | P0 |
| Cost 成本 | Token 消耗、工具调用次数、延迟、失败重试率 | 代码 | P1 |

五类只包含表中列出的子维度，不额外增加可用性、交互过程或未知表达等独立子维度。这些要求在既有子维度中按任务标准判断，用户体验不单列第六类。原 correctness、groundedness、uncertainty、clarity 四项不再作为顶层评分维度：正确性/清晰度归入 Outcome，证据支撑/未知表达归入 Evidence。

P0 要求必须关联 required 检查；失败不能被其他维度或更低成本抵消。P1 表示实施优先级，不自动取消显式声明的 required 门禁。过程偏差按负分制扣分而非任一偏差直接否决；当前综合发布要求指定评委记录齐全、数值达标且硬门禁满足；此次维度修正没有实现按风险自动抽样人工评审，也没有声称完成 LLM 评委校准。

Rubric 明确指参考结构化量表的 LLM-as-a-Judge，不是人工评分器，也不是第四类评分器。统一职责矩阵以代码中的 SCORER_DIMENSIONS 为准。

## 结构化量表与评委分工

`cwatch.quality-rubric.v6` 保存通用五类元数据、子维度、优先级和评分政策。Case 的 rubric 为 `cwatch.eval-rubric.v1` 或 null，具体声明每个条目的问题、通过/失败/未知标准、证据类型和边界。LLM 只返回本例分配的 findings，代码生成适用的 Outcome/Trajectory/Evidence 汇总；人工模板只包含 humanReview.dimensions 分配的 Trajectory/Safety 和适用过程 checklist；Cost 仅接受代码测量和预先声明的约束。职责表表示可用范围，不是每例必须全部启用。

评委按冻结标准返回 pass/fail/unknown、理由和证据。过程逐项使用 expected_process.criteria，不自由填写次数或分值。两位评委确认的偏差按三种计分项每步/项扣 10，效率按 5 分钟基准扣分，结果不符扣 100。统一分数 max(0,100+过程扣分+效率扣分+结果扣分)，80 达标；所有 Trial 达标才取平均，否则用例总分 0。旧 1–5 分已移除，详见 [计分规则](penalty-scoring.md)。

Trajectory 仅依据计划、工具请求/执行、观察、上下文事件与可见交互判断，不读取或推断模型私有思维链。幻觉由 Evidence 的支持度检查提供线索，Safety 记录风险和人工结论，不能把缺少某条引用直接当成已确认越权。

## 规则契约和数据来源

Case 的五类需求位置分别为 `expected_final`、`expected_process`、`expected_evidence`、`safety_boundaries`、`expected_cost`。后两处新增的 evidence/cost 要求列表可为空；代码检查可显式写 dimension，不写时按其引用的需求组归类；只允许结果、证据、安全和成本。过程要求直接提供给 Rubric 与人工，不允许在 scoring.checks 中作为代码评分项；代码仍记录工具、参数、顺序与上下文事实。一个检查不能混用不同维度的需求。Trace 完整性归 Evidence，文件/进程权限与泄漏检查归 Safety。

Cost 测量保存在 Result.cost 与 projection.facts.cost，包含 totalTokens、knownTokens、toolCalls、latencyMs、physicalModelRequests、actualCost、failedRetryRate。实际费用未核实则为 null；fixture 与真实模型用量分别标记。成本上限可用 at_most 检查，阈值必须提前声明；没有成本约束时记录为未设置检查，不宣称通过成本验收。

当前没有明确的重试次数埋点，failedRetryRate 为 null，不把重复调用猜成重试。没有逐事实的人工真值标注与分母，幻觉率也为 null。没有上下文容量与利用量的可靠依据时，不编造上下文利用率。

批次 metrics.dimensions 按五维分别记录通过、失败、未知和未设置检查，并按 caseId + revision 的完整、同评分器版本 Trial 计算 pass^k。这里的 basis=required_rule_checks，仅代表该维度规则检查的一致性，不能替代 LLM/人工判断；k 是实际计划次数，单次运行只能表示 pass^1。

## 版本与验证边界

Case/题单契约、人工输入、评分记录与质量报告采用 v5；子维度定义为 cwatch.eval-dimensions.v3，通用政策为 cwatch.quality-rubric.v6，Case 量表契约为 cwatch.eval-rubric.v1；规则 Result、批次 Report、覆盖索引与清单保持 v2。旧题目契约须显式迁移，不会自动获得新量表。没有注册新 Case、修改原始 Trace，或请求被测模型和评分模型。

本次只做静态类型、引用和差异检查，没有执行测试或评测。
