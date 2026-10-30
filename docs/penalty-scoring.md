# 统一负分制与稳定性统计

规则版本 cwatch.penalty.v5，scope=combined_review。统一分数由代码按照确定的判定记录计算；结果/证据可用代码+Rubric，过程由 Rubric+人工，安全可用代码+人工，成本由代码负责。Rubric 指参考结构化量表的 LLM-as-a-Judge。各例显式分配评审项，不适用的评委不会成为缺失评审；本次版本升级保留数值公式，增加按 Case 分配评分的语义。

## 扣分表

| 维度 | 计分项 | 扣分规则 |
|---|---|---|
| 结果 | 任务结果 | 与预期不符扣 100，一票否决 |
| 过程 | 步骤遵循性 step_adherence | 每个与预设工作流不一致的步骤扣 10 |
| 过程 | 步骤输出结果 intermediate_output | 每个中间输出与预设不一致的步骤扣 10 |
| 过程 | 调用工具/知识库 tool_chain | 每个未按预设工具链执行的调用项扣 10 |
| 效率 | 分析耗时 | 基准 5 分钟，之后每开始 1 分钟扣 10 |
| 稳定性 | 一致性 | 同一任务 N 次，所有 Trial 均达标才取平均，否则用例总分为 0；建议 N=5 |

原有 P0 证据和安全硬边界继续保留：确认的证据破坏、越权、泄漏或安全要求失败也一票否决，不能靠过程和效率分抵消。结果/硬边界否决合并扣一次 100，不叠加多次 100。

Token、调用次数、重试率和费用仍记录。没有从参考表额外增加“每个成本预算不符扣 10”的规则；Case 明确声明的 required/hardFail 约束仍作为独立门禁，不能被数值达标掩盖。

## 公式

```text
单次得分 = max(0, 100 + 过程扣分 + 效率扣分 + 结果扣分)
单次数值达标 = 单次得分 >= 80
用例总分 = 所有计划 Trial 全部达标 ? 各次得分平均值 : 0
```

分析耗时取 Trace 中主任务的 durationMs，不包含 LLM 评委调用或人工审阅耗时。扣分为负数。5 分钟以内不扣耗时；5 分钟零 1 毫秒开始扣 10，6 分钟零 1 毫秒扣 20。总分最低为 0。

完整评分需要任务结果判定、过程判定和实际耗时；缺失或未知不按满分处理。已确认的任务结果/P0 失败可记 0，但其余未完成部分仍标记 complete=false。

## 过程判定和去重

Case 必须提前在 expected_process.criteria 声明逐步计分标准。每项包含 id、item、unitId、requirementRefs、expectation。item 只能是上表三个过程计分项；一个 item + unitId 只能出现一次，且必须覆盖过程要求。

LLM 对冻结 rubric.criteria 返回逐项 findings，代码按 processCriterionId 映射为过程判定；人工对本例分配的每个过程 criterionId 返回 pass/fail/unknown、理由和证据引用。不能自造条目、单位数或分值。两者同意 fail 才对该计分项扣一次 10，不因为两位评委重复指出同一项而扣两次。两者都 pass 不扣分；一方未知、缺失或结论冲突时记 unknown、待复核，完整总分为 null。未声明过程计分项时 requirements/criteria 可为空，不强制补过程评分。

不同计分项各有独立预设标准，分别计分。步骤数量从已冻结的 criteria 确定，不从模型自由文本猜次数；需要检查多个出错步骤时，提前为每步定义条目。过程偏差是可扣分项，不再因为任一过程 fail 就直接否决整个任务：两项已确认偏差且没有其他扣分时为 80 分，可以数值达标。

所有流程要求必须来自运行前的任务/Skill/公开约束；预期中间结果可作为评委的冻结标准，不得在看到输出后补流程或修改标签。代码记录 Trace 与计算扣分，不替代 Rubric/人工判断过程合理性。

## 评分完成与汇总

原始 Case 执行只有规则检查和 Trace；若该例仍缺少已分配的 Rubric/人工判定，Penalty.score 为 null（已确认硬失败除外），不会自动得到 100。仅代码检查的 Case 不要求额外评委；全部必需事实和耗时明确后可以计分。评分记录 ready 仅表示该评委记录已完成、可供汇总，不是用例通过。

```powershell
npm run eval:cases -- --dataset <file> --repeat 5
npm run eval:judge -- --report <report> --case <ID> --attempt <N>
npm run eval:human -- --report <report> --case <ID> --attempt <N> --template
npm run eval:human -- --report <report> --case <ID> --attempt <N> --input <human-input.json>
npm run eval:score -- --report <report>
```

为每个计划 attempt 完成指定评委记录后，quality-report.results[*].penalty 保存统一得分、三类扣分、证据与过程对齐结果；metrics.penalty.cases[*].caseScore 为用例总分。原始结果与 Trace 不覆盖。

原始 Case 命令不接受 --score-gate，它会在调用模型前提示应先运行 Case，再完成评委评分后用 eval:score 汇总。eval:score 的 numericGate 对全部计划 Trial 检查 >=80；releaseGate 还要求 Case 标准已批准、各 required/hardFail 门禁满足、没有未解决争议。

## N 次一致性

N 来自实际计划的 --repeat，当前支持 1..5，建议 5。必须具有同版本代码/量表及相同 Rubric 评委模型配置、同一 Case 修订、完整且不重复的 1..N attempt。缺 Trial、评分无效/未知、混用版本或存在未完成评分请求时，用例总分为 0，complete=false，不宣称一致性验证通过。

pass@k 表示至少一次综合数值达标，pass^k 表示全部综合数值达标；两者为本批观察值，不是概率估计。单次只能报告 pass^1。诊断平均分可以单列，但不能替代“全部达标才取平均”的 caseScore。

Agent 类型的失败率容忍度仅保留为诊断，不放松全部 Trial 达标的公式，也不放松证据/安全硬边界。旧版 1–5 分和旧 Penalty 记录不会自动换算为此规则。

当前新题库为 1 例 activation-001；已真实执行及完成 LLM 判定，人工过程和安全审核尚未完成，完整综合分仍为 null。单次试跑不构成已确认基线或稳定性验证。
