# 评测初版落地验收：2026-10-25

已接通 Case → 实际执行 → Trace/产物 → 独立确定性评分 → Result → 分层汇总。新增的案例仍是待人工审核候选，正式 Agent 发布门禁保持阻断。

**格式判分订正：** 下面的旧批次曾将 Kimi 的额外说明文字判为格式失败，但 revision 1 题面与评分器严格程度没有对齐。该失败结论现已撤回为待复核，不能作为模型质量失败；原始报告保留作历史记录。订正证据为 `artifacts/evaluation-output-contract-correction.json`，当前运行政策见 [输出格式契约](evaluation.md)。

## 验证结果

| 验证 | 结果 | 证据 |
|---|---|---|
| 完整工程回归 | 486/486：contract 345、semantic 43、integration 98；结构和 TypeScript 检查通过 | `artifacts/evaluation-verify-complete.log`、`artifacts/eval/latest.json` |
| 评分、隔离、治理专项 | 20/20，包含正误校准、缺失证据、篡改、Holdout 拒绝、重评分、失败入库 | `npm run test:evaluation` |
| 固定契约执行 | 12 例各 2 次，24/24 执行检查满足；全部因人工标签待审记 needs_review | `artifacts/agent-eval/batch-3dc12933-6dce-4bab-8f37-07f322fdf00b/report.json` |
| 真实模型固定工具诊断（历史原始判分） | 原报告为 2 例满足、Kimi 格式失败；该格式结论已订正为待复核。7 次请求、已报告 16650 Token 的执行记录不变 | `artifacts/agent-eval-model/batch-155d0bdb-872d-44fd-a216-6bdfee21e5ff/report.json` |
| 原证据校验与独立重评分（历史旧政策） | 27 份归档通过原 manifest/快照校验；当时的 26/27 检查结果不作为修订后的质量结论 | `artifacts/evaluation-regrade-audit.json` |
| 历史输出契约订正 | 三份 revision 1 归档按其冻结 Case 重评，格式均为 unknown；Kimi 没有已确认失败，旧失败入库被拒绝 | `artifacts/evaluation-output-contract-correction.json` |
| 已配置模型凭据扫描 | 最终模型批次的 54 份公开文件命中 0；扫描范围明确排除私有原始转录 | `artifacts/evaluation-secret-audit.json` |
| 未审核标签发布门禁 | `--require-approved` 返回退出码 1，未把诊断通过冒充正式 Golden 通过 | `artifacts/evaluation-release-gate.log` |

历史计数是当时政策下候选的执行检查结果，不是模型准确率或正式 Golden 成绩。真实费用未核实，未从 Token 数推算金额。CI 已增加 lint/固定 Case 执行，远端 CI 未在本次触发。

## Kimi 历史格式判分为何撤回

模型从冻结的十条记录中正确选出四条窗口内 CLI Release，版本、发布时间和 URL 均正确。旧题面只写“输出 JSON 对象”，未明确禁止附带说明；此前将其表述为“任务要求仅返回 JSON”不准确，不能据此确认 `answer.invalid_format`。

订正后继续保留事实检查通过，格式检查改为 unknown，整例为 needs_review。新投影单独保存并带哈希，原 Trace、原 Result 和原投影不被覆盖。revision 2 显式声明输出政策并重新执行，旧输出不套用新标准，也不直接改判为通过。

曾生成的 `evals/candidates/model-kimi-window-failure-0426e9f5.json` 已升 revision 2 并标为 retired，保留原 runId 与撤回原因；其原始字节保存在 history/。当前入库入口会复核现行判分，拒绝再次把该争议记录当作已确认模型失败。

## 修复与限制

- 修复同步取消时已创建 Promise 的拒绝未被消费，导致终态落盘后进程崩溃的问题。
- SDK 资源加载改为显式宿主 ResourceLoader，解决默认加载器仍扫描全局 Skill 的问题，保留已有显式 Skill/工具流程。
- 评分以 Trace 序号重建执行顺序，避免将文件目录枚举顺序误判为批次重排。
- 缺少评测证据记 unknown；已观察到 JSON 缺少必要字段判 fail；被测进程崩溃不能被改记为无效设施样本。
- 实际验证 Node 文件/子进程权限边界；没有操作系统级网络沙箱的证明。
- 人工 Golden 标签、独立 Holdout 仍需独立人员和材料；自然语言开放式质量 Judge 尚待扩展。当前真实模型测试使用固定工具，不代表三站 live 调查或全站事实召回已通过。

使用入口见 [运行评测](evaluation.md)，可执行数据与填写说明见 [evals](../evals/README.md)。
