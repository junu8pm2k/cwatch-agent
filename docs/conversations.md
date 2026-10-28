# 同一会话中的用户追问

用户在通用 Agent 给出答复后，可以继续输入补充问题；后续请求必须带有同一会话之前的消息、工具结果及已提交的压缩边界，不重放已完成操作。

## 契约与 SDK 实锚

基线保持 `@earendil-works/pi-coding-agent@0.84.2`。已核对安装包 `dist/core/agent-session.js` 的 `prompt` / `_runAgentPrompt`，以及内嵌 pi-agent-core 的 `agent-loop.js` / `agent.d.ts`。

| 本工程端口 | SDK 行为及映射 |
|---|---|
| `AgentSessionHooks.nextUserMessage` | 一轮最终答复及转录落盘完成后，宿主等待用户下一条消息；返回 null 才结束会话，不向模型开放该端口 |
| 下一条用户消息 | 同一个 `AgentSession.prompt(text, {expandPromptTemplates:false})` 追加原生 user 消息，不重新创建 SessionManager、不重复最初任务 |
| 首次追问请求的上下文 | SDK `transformContext` 在 AgentMessage 转 LLM 消息之前执行；在这个位置运行既有治理、Memory 和 Compact，并同步当前循环消息与 agent state |
| 每轮的提示和工具 | 追问前调用宿主 beforeModel，复查当前权限及原来已披露的绑定；SDK prompt 会重置 base system prompt，streamFunction 必须使用当轮宿主规则和已核对的静态后缀 |
| 中间工具续轮 | 继续沿用 prepareNextTurnWithContext 和原执行器/IPC/审批，不绕过工具握手 |
| 等待、结束与取消 | 答复后等待用户时保留 worker；正常结束返回 null，取消通过原 AbortSignal 向 worker 和工具传播，最终统一 dispose |

## 状态与存储边界

当前采用最小的长驻会话：一个交互会话仍使用同一个 runId/sessionId，每次用户输入是一轮，最终答复意味着本轮完成；用户显式结束后才提交运行终态。Transcript、Memory、Trace 的身份、消息游标和序号都不重置。

通用 Agent 的交互模式通过 nextUserMessage 端口启用；原有单次任务 API 和调查工作流保持其原契约。工作台真实通用 Agent 默认开启交互，CLI 通过 --chat 开启。等待状态占用会话容量。工具数、模型轮数和 Token 预算按整个会话累计；调查/执行超时只累计活跃执行时间，等待用户期间暂停，模型计时器也停止。

工作台提供追加消息与正常结束接口。只在等待输入时接收追问，同一 messageId 重传不会执行第二次；忙碌、关闭和中断的会话拒绝新消息。浏览器刷新通过宿主现有会话继续，宿主重启后旧长驻进程已丢失，明确标记中断，不宣称自动恢复执行。

Memory 仍是带 lastMessageId 的状态检查点；上下文里的旧快照必须服从较新的用户消息、工具结果和宿主状态。用户多轮连续性由保留的原生会话提供，不以 Memory 是否达到更新阈值为前提。

## 产品与验证

沿用工作台现有字体、颜色和布局，在任务结果区域展示对话记录、追问输入与结束按钮；运行时禁用发送，失败保留输入。验证覆盖真实 SDK 子进程的连续用户消息、工具结果和压缩/Memory 协作，以及等待超时、取消、并发提交、重传、隔离、关闭和重启。
