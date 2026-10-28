# 输出格式契约订正：2026-10-25

已修复题面与评分器严格程度不一致的问题。输出要求由 `expected_final.outputContract` 唯一声明，执行器据此生成实际模型指令，评分器也按同一政策检查，不从“输出 JSON”几个字猜测隐藏约束。

## 当前规范

三个模型案例均为 revision 2，题单为 `2026-10-25.3`，采用 `json_object_only`：只允许一个 JSON 对象和外层空白，明确禁止 Markdown 围栏、解释、标题和前后缀文字。代码同时支持唯一 JSON 代码块、代码块加说明两种显式政策。

格式政策属于公开的任务要求；执行输入不会包含参考版本列表或评分标签。实际 `input.json`、Trace 中的任务指令、冻结 Case 与评分投影已逐项核验一致。

## 历史记录如何处理

- 原 revision 1 Case 和题单字节保存在 `evals/history/model-diagnostic/2026-10-25.2/`，原始 Trace、Result、模型用量不变。
- 旧版本没有声明输出政策，因此三个历史格式检查均为 unknown，整例为 needs_review；Kimi 的事实检查正确，不能再将额外说明认定为已确认模型失败。
- 旧失败候选 `model-kimi-window-failure-0426e9f5` 已标为 retired，并保留原始候选快照。
- 失败入库会重新验证当前评分结论，拒绝争议记录。活动合成 Case 不能依赖已撤回父例。
- 新格式要求只用于新 Case 的新执行，历史输出不套用 revision 2，也不直接改为正式通过。

## 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 完整工程回归 | 492/492，含结构和 TypeScript 检查 | `artifacts/evaluation-output-contract-verify.log` |
| 评测专项 | 26/26；覆盖三种政策、单一投放来源、旧格式待复核、入库拒绝与撤回父例 | `npm run test:evaluation` |
| 契约案例重跑 | 12/12 执行检查满足 | `artifacts/agent-eval/batch-8602a566-7b67-4561-88e5-b125b69c77ab/report.json` |
| 修订模型案例新执行 | 三例各执行一次，3/3 执行检查满足；7 次请求、已报告 16878 Token | `artifacts/agent-eval-model/batch-f4a004ff-528f-4b21-9a8d-1cb97b1609ea/report.json` |
| 实际输入、Trace 与政策核对 | 三例全部一致，原始证据哈希有效 | `artifacts/evaluation-output-contract-input-audit.json` |
| 历史判分订正 | 三例格式 unknown，旧失败入库被拒绝 | `artifacts/evaluation-output-contract-correction.json` |

案例仍待人工金标审核，正式发布门禁保持阻断；上述执行检查结果不等于已批准 Golden 成绩，也不代表旧三站 live 调查通过。
