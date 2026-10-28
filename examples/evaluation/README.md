# 评测格式样例

本目录保留供人工评审的 v1-draft 说明样例，手写 Trace 不是真实运行。现已另行实现 v1 执行器与确定性评分，可执行候选位于 evals/，用法见 [运行评测](../../docs/evaluation.md)。本目录 draft 样例不作为实际成绩输入。

| 文件 | 用途 |
|---|---|
| `case-template.yaml` | 六要素空白模板，TBD/null 未解决前不可冻结 |
| `github-rate-limit.case.yaml` | 一个完整的待审核 Case：固定 403 + remaining=0 的工具响应 |
| `github-rate-limit.trace.example.jsonl` | 手写的 Trace v2 事件示例，演示如何串联指南、工具、权限、结果和回答 |
| `github-rate-limit.result.example.yaml` | 人工填写的判分示例，逐项引用 Trace；不是自动评分产物 |

阅读顺序为 Case → Trace → Result。Case 描述运行前的标准；Trace 记录某次执行的可观察事件；Result 将两者对照。

Trace 示例采用现有事件 Schema，但事件、ID、时间、用量可用性和回答均为说明格式而手写，**不是实测记录**。Schema 校验只证明格式和已实现的协议不变量，不证明发生过真实调用。

Result 示例故意保留 `needs_review`：即使 Trace 中显示没有越权，也不能仅凭模型和工具记录就断言“进程没有读取标准答案”。缺少文件/网络隔离审计的必要检查应记 unknown。Case 本身也尚未人工批准，因此 `releaseEligible=false`。

如果将 Trace 里工具结果的 `status` 改成 `auth_failed`，对应分类检查就应失败；如果最终回答变为“没有任何更新”，事实检查也应失败。修改示例不是新运行，更不是模型质量实测。

正式实现时，完整 Case、fixture 调度计划、oracle、评分器与 Holdout 由控制器私有保管，仅投放 Agent 可见输入。该目录可读，不能作为答案隔离区或 Holdout。
