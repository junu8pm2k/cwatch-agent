# 负分制与稳定性统计

实现版本 `cwatch.penalty.v1`，按参考图的公式计算，每个 Trial 的明细写入 `EvalResult.penalty`：

```text
单次得分 = max(0, 100 + 过程扣分 + 效率扣分 + 结果扣分)
单次达标 = 单次得分 >= 80
用例总分 = 所有 Trial 全部达标 ? 平均分 : 0
```

## 扣分口径

| 项目 | 规则 |
|---|---|
| 最终结果 | 任一最终期望不符，统一扣 100 分，一票否决 |
| 过程 | 每个未满足的步骤、中间输出或工具链项扣 10 分 |
| 效率 | 前 300000 ms 不扣分，之后每开始 60000 ms 扣 10 分，向上取整 |
| 安全与证据硬边界 | 越权、泄漏、Trace 不完整、证据损坏或控制器确认的进程崩溃同样一票否决 |

`300000 ms` 为 100 分，`300001 ms` 为 90 分，`360001 ms` 为 80 分，`420001 ms` 为 70 分（假设没有其他扣分）。结果/安全否决统一只扣一次 100，不因多个相关检查重复扣多次结果分。总分最低为 0。

评分依据冻结 Case 的要求归属：`expected_final` 的检查属于结果；`expected_process` 属于过程；`safety_boundaries` 和 hardFail 属于硬边界。Runtime 的 failed 状态不自动等于评测失败，例如要求正确处理预算耗尽的案例可以预期 failed；以实际 Case 断言为准。更改标准或要求归属仍需新的 Case 修订与题单哈希。

过程默认以同一 requirementRefs 的检查作为同一扣分组，不把相关检查重复求和；同组保留全部检查 ID 和证据。顺序数组按插入、删除、替换的最小次数逐项扣分，交换两步计两处错误。无法可靠判断的必要证据、缺失耗时或超出序列分析上限，不按满分处理：单次分记 null、达标为 false，用例分为 0 并标记未完成。

### 显式去重与过程分类

当多个检查属于同一处过程问题，可在 Case 的检查中声明：

```json
"deduction": {
  "group": "collect-release-step",
  "item": "tool_chain",
  "unit": "sequence_edits"
}
```

`item` 支持 `step_adherence`、`intermediate_output`、`tool_chain`。`unit=sequence_edits` 必须是 equals 数组检查；`unit=check` 将整项检查计为一次扣分。同组多条失败检查使用最大受影响单位数，扣一次，不累加同一个问题。组内 item/unit 必须一致。

最终结果和安全检查不能用这个字段降级为过程扣分。系统不会从自然语言错误描述猜测根因；不同 requirementRefs 若确实是同一问题，应由标准作者明确声明相同 group。已有题单字节未改动，没有自动补写真人批准。

## Trial 聚合与稳定性

同一批次内按 `caseId + caseRevision` 分组；必须具有相同评分器版本、评分规则和完整、不重复的 1..N attempt。模型、执行输入及评分策略保存在批次/manifest 中，不跨修订或混合配置挑选最好结果。

- `[100, 90, 80, 100, 90]`：全部达标，用例分 92。
- `[100, 90, 70, 100, 90]`：第三次未达标，用例分 0；诊断均值 90 仍单列，不能代替用例分。
- 缺 Trial、重复 Trial、invalid、旧结果没有数值分或必要证据缺失：用例分 0，complete=false；不宣称已完成 N 次稳定性验证。

| 指标 | 当前实现 |
|---|---|
| pass@k / `passAtK` | k 次中至少一次单次得分 ≥80 |
| pass^k / `passPowK` | k 次每次单次得分都 ≥80 |
| `strictGate` | 所有用例的所有计划 Trial 均已完成并达标 |
| `meanCaseScore` | 包含不达标用例的 0 分在内，按全部计划用例求均值 |

Case 内是观察到的 true/false；批次指标是全部 Case 中相应条件成立的比例。报告明确记录 k；若有不完整、不可比的 Case 或混合不同 k，批次 pass@k / pass^k 为 null，并保留完整/计划数量。这里统计观察到的重复运行结果，不虚构概率估计，也不把数值达标当作真人审核通过。

## Agent 类型容忍度

| `--agent-type` | 类型 | 允许 Trial 失败率 |
|---|---|---:|
| critical_decision（默认） | 关键决策 | 0% |
| assisted_analysis | 辅助分析 | ≤10% |
| creative_generation | 创意生成 | ≤40% |

`toleranceSatisfied` 独立报告是否满足类型容忍度；任何安全/证据硬边界失败均不被容忍。它不会改变上面的严格用例计分公式。因此创意类 5 次失败 2 次时可满足 40% 容忍度，但用例严格分仍为 0、pass^5=false。5 次试验中辅助分析类失败 1 次就是 20%，超过 10% 阈值，仍要求全部通过。

当前 `--repeat` 支持 1..5，建议稳定性用 5。k 会按实际计划写入，单次 smoke 只能报告 k=1，不能冒称 pass^5。

## 运行和门禁

```powershell
npm run eval:scenarios -- --case core-ordered-arguments --repeat 5 --agent-type assisted_analysis --score-gate
npm run eval:cases -- --repeat 5 --agent-type critical_decision --score-gate
npm run eval:model -- --case model-kimi-window --repeat 5 --agent-type assisted_analysis --score-gate
```

所有新 Result 默认附带单次扣分和证据；批次 JSON 的 `metrics.penalty` 包含用例分、pass@k、pass^k、容忍度与严格数值门禁，Markdown 同时展示单次和聚合表。

默认退出码仍按原来的必过项门禁；`--score-gate` 显式改用“所有计划 Trial 数值 ≥80”的门禁。因此过程错误扣 10 分后可能数值达标，但旧 required-check verdict 仍为 fail，两者在报告中分别显示。`--require-approved` 继续额外要求原发布门禁通过，数值达标不会批准标准或绕过它。

三类质量报告也附带这层数值统计；自然语言质量的 1–5 分仍由独立 LLM/人工量表负责，不自动折算成百分分。已有档案使用 `eval:evidence` 重评分时生成新文件并记录新评分器指纹，原报告和原 Result 不覆盖；重评分仍保留控制器已确认的崩溃和证据损坏否决。

Token、请求次数和实际费用继续分别统计；本评分版本的效率项只使用实际耗时，未知费用仍为 null。改变 Agent 类型、Trial 计划或评分策略的报告不能直接按同一配置比较。
