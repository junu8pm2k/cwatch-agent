# Memory 输出预算 P0 修复与实跑：2026-10-24

结论：已实现有界恢复、请求参数审计、独立计量与明确停止，MiniMax 实跑中两次恢复成功、累计提交三个合法检查点。**整项调查仍 failed**：最后一次维护请求的实际输入/输出计量将总用量推至 91035/80000，宿主预算门禁停止；未生成报告，不宣称原竞品调查功能通过。

## 根因与请求契约

原 MiniMax runId 为 b679b573-d2b5-46d4-9358-bc455510d431，Memory 返回 length，output=1024，content 仅 thinking，没有正文。运行实际使用项目配置的 StepFun step-5-preview，并非 MiniMax 模型；MiniMax 是调查对象。

旧实现固定辅助输出上限 1024，注册自定义模型 reasoning=false，业务会话 thinkingLevel=off；这些本地声明没有向 StepFun 发出控制推理的请求参数，且独立 completeSimple 请求不继承业务 AgentSession 的配置。不能以此认定供应商关闭了推理。

已核对本地 Pi 0.84.2 的 completeSimple、SimpleStreamOptions、OpenAI-compatible 编码器与 samplingParams 合并行为，并核对 [Step 5 官方说明](https://platform.stepfun.com/cookbook/step-5-reasoning)：reasoning_effort 支持 low/medium/high，max_tokens 控制输出上限，JSON 格式可使用 response_format。

仅匹配 HTTPS 官方 api.stepfun.com / api.stepfun.ai、模型 step-5-preview、openai-completions 时，维护请求通过 SDK samplingParams 发送 reasoning_effort=low 与 response_format=json_object。low 不承诺关闭 thinking；输出预算仍由 thinking 与正文共享。其他端点/模型不注入猜测的供应商参数。模型、凭据、业务请求及 Memory 开关均未替换。

## 恢复与停止

1. 首次维护输出最多 1024 token。每次物理请求都经过 beforeRequest，取调用者输出额度、模型上限、剩余预算的最小值；SDK 通用重试关闭。
2. 已返回的 usage 在判断恢复前送宿主累计计量。只有 stopReason=length 且用量、字符预算及工具限制合法时，允许一次恢复。
3. 第二次输出最多 4096 token，继续受调用者额度限制，本次实跑仍最多 2048。输入缩小到首个完整 API round，保留旧记忆和原游标；不将截断 thinking/正文喂回模型。其余消息保留 pendingMessages，不跳过、拆分或重放工具。
4. 第二次仍截断明确停止。非法 JSON/Schema、工具调用、缺失正用量、字符/Token 预算、取消、超时或持久化冲突均停止，不提交非法状态，不发第三次请求，不静默关闭 Memory。
5. 同一取消信号覆盖两次请求；恢复前重新获取预算与模型计时。取消且没有返回 usage 的请求保留请求记录，不伪造零用量；此前返回的用量仍保留。

归档增加 cwatch.memory_wire_request（安全字段：实际输出上限、推理档位、格式、工具数）与 cwatch.memory_recovery（retry/stop、thinking/正文字符数）。检查点身份、版本、哈希、原生完整轮次游标及原子写入校验继续由宿主掌握。

实现：packages/shared/src/agent/backend/pi/session-memory.ts。测试：tests/session-memory.test.ts、tests/pi-session.test.ts。

## MiniMax 原约束真实复跑

使用原 task/sources、explore 权限、Memory 默认开启；timeout=240000、model-timeout=60000、tool-timeout=45000、max-tokens=80000、max-output-tokens=2048。新目录 artifacts/competitor-live/20261024/p0-memory/minimax-code，未覆盖原失败记录。

| 项目 | 实际结果 |
|---|---|
| runId | 561533d0-b426-4c68-986b-12f603b154dd |
| 时长 / 工具尝试 | 223786 ms / 15 |
| 维护物理请求 | 6，全部使用 low、JSON 格式且无工具 |
| 维护响应顺序 | length → stop；length → stop；stop；length 后预算停止 |
| 有效检查点 | revision 1、2、3 |
| 维护已报告用量 | 48363 token，含失败/截断请求 |
| 全部已报告用量 | 91035 token |
| 终止原因 | budget_tokens: 91035/80000 |
| Trace 校验 | 无问题 |
| 调查报告 | 无，整项调查未通过 |

前两次恢复的维护用量分别为 8608+4284 与 7358+2893；第三次更新一次成功，用量 7824。最后一次返回 length、用量 17396，宿主计量即超限，因此没有再恢复或推进检查点。累计预算是请求间的门禁，实际输入未知时当前请求可能超出门禁；本次没有隐瞒超量或扩大验收预算。维护开销与调查收敛仍需后续优化。

证据：artifacts/competitor-live/20261024/p0-memory/summary.json，以及该目录内原生 sessions、traces、session-memory 和执行快照。命令日志 artifacts/p0-memory-minimax-live.log。

## 回归验证

Memory 专项 16/16，覆盖完整轮次、恢复后待处理消息、最多两次、重新获取预算、非法状态、用量缺失、取消、真实 SDK wire 参数、worker 恢复与不提交等。日志 artifacts/p0-memory-targeted.log。最终 npm run verify 442/442（contract 318、semantic 30、integration 94），结构、类型及 git diff --check 通过。日志 artifacts/p0-memory-verify.log。本轮未改前端，未额外重跑独立浏览器视觉检查。
