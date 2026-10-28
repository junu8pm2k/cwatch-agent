# P0：提供方多调用与 Runtime 契约兼容

日期：2026-10-24，Asia/Shanghai。

## 结果

已实现“接收多调用、按原顺序逐项授权并串行执行”。真实 ZCode/Kimi 任务均已通过原先阻塞的多调用阶段；两次调查随后因独立的 Session Memory 截断问题失败，没有生成报告。因此此 P0 的兼容修复成立，完整竞品调查质量验收仍未通过。

本次使用现有模型配置，没有切换模型、禁用 Memory、放宽权限、忽略后续调用或伪造结果。原始失败记录保留在 `artifacts/competitor-live/20261024/`；修复后任务另存 `p0-multicall/` 子目录。

## 实现契约

- 单调用继续使用 `call_tool`；多调用使用 `call_tools`，每项包含 SDK call ID、工具名和参数。批内 ID 唯一，最多 64 项。
- `decodePiMessage` 验证整批 SDK 响应，拒绝截断、非法批次、缺失/重复 ID。检查针对 SDK 解码后的调用对象；底层供应商流解析仍归 SDK 负责。
- 子进程将整批决策发送给宿主；宿主保存队列，每次只接受队首身份、参数和名称匹配的请求，Observation 按 ID 确认后才消费该项。
- 每项继续走现有 Schema、来源范围、权限、一次性审批和执行握手。SDK 明确拒绝的未知工具或参数错误保留失败结果；没有执行握手的调用不能上报成功 Observation。
- 整批按一轮模型决策计数，每项分别预留工具预算；预算不够时首项执行前停止。批内撤权、取消和异常保持原有保守处理，不重放已完成操作。
- 批次未完成时禁止覆盖决策、发起下一轮、压缩、更新 Memory 或宣称完成。Trace 检查批次身份、顺序与结果完整性。
- 对重复无进展的判断忽略 SDK ID，避免更换 ID 绕过已有熔断。
- 工作台记录批内每个工具的准备活动；Replay/单步调用入口也按顺序执行整批。

本实现不依赖供应商支持 `parallel_tool_calls`，保持现有供应商请求格式；Pi SDK 执行模式固定为 sequential。依赖前一项实际返回值的调用应在后一轮构造参数。

## 验证

最终 `npm run verify` **435/435**（contract 314、semantic 30、integration 91），包含类型检查和包结构检查；`npm run eval:web` **9/9**。另外验证了 Replay 批次入口、逐项工作台活动、报告与 Trace。目标文件 `git diff --check` 通过。

专项用例覆盖：完整多调用结果配对、相同工具参数的独立审批、总次数及同工具预算、截断响应、非法批次、SDK 未知工具结果保留、批内来源撤销和取消、重复无进展；故障 Worker 覆盖调用 ID 错配、重排、重复 ID、提前结束、提前请求模型、覆盖未完成批次、伪造 Observation 以及未执行却伪造成功。

工程回归与工作台日志分别保存在：

- `artifacts/p0-multicall-targeted.log`
- `artifacts/p0-multicall-verify.log`
- `artifacts/p0-multicall-web.log`

最终计数以日志和 `artifacts/eval/latest.json`、`artifacts/web-eval/latest.json` 为准；工程用例使用本地协议桩，不冒充真实调查通过。

## 真实任务复跑

任务、来源和预算沿用首轮配置：explore，240 秒总时限、60 秒模型时限、45 秒工具时限，80000 累计 Token 门禁与 2048 单请求输出额度。Memory 保持启用。

| 目标 | 新 runId | 多调用实测 | 后续结果 |
|---|---|---|---|
| ZCode | `b51243f7-4873-4a30-b902-5f870a562271` | 同一批读取 Memory、来源指南、列目录，3 项均完成并保留各自 ID | 已提交计划；后续 Memory 辅助响应截断，调查 failed |
| Kimi Code | `c34c8e1a-318a-4016-891c-58ab54f6aaa9` | 第一批 2 项、第二批 GitHub 发布读取及两次搜索共 3 项，全部产生对应 Observation | GitHub 和一次搜索返回数据；后续 Memory 响应截断，调查 failed |

两份 Trace 均校验通过。ZCode 记录 5 项工具预算、28542 Token；Kimi 记录 6 项工具预算、21424 Token，价格未独立核验。两次均没有再出现 `one call per decision required`。

机器汇总：`artifacts/competitor-live/20261024/p0-multicall/summary.json`。完整 Trace、transcript、执行记录和计划位于对应目标目录，原始调用 ID 与结果可逐项核对。

## 剩余工作

Session Memory 的辅助响应预算、推理行为及截断恢复属于下一项独立 P0，仍需修复后再次验收。官网抓取超时、搜索召回与 GitHub 限流诊断也未由此修复。当前没有真实报告，不进行报告质量打分，不将本次多调用成功解释为端到端竞品调查已完成。
