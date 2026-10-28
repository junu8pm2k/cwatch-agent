# 简历四条描述与本轮后端对齐

按用户提供的四条描述核对当前独立项目。实现证据不倒推历史生产效果、个人职责或人工负担的量化改善；参考仓库和外部简历材料均未改写。

| 简历重点 | 本轮补齐 | 证据与入口 | 表述边界 |
|---|---|---|---|
| 多源情报工具调用接入 | 只读 browser_tool、API MCP、每运行 MCP 池；统一 builtin/mcp 归类，停用来源不启动后端 | packages/shared/src/sources/browser.ts、packages/shared/src/sources/api-tools.ts、packages/shared/src/mcp/client-pool.ts、packages/shared/src/sources/server-builder.ts；demo:adapters、verify:browser | 不自动理解任意 API 业务数据；单一子进程入口是受控 Node IPC，不是外部 HTTP MCP 池 |
| 工具调用硬拦截门禁权限 | visibleTools 决定模式与任务的披露面；运行内固定绑定上限；ToolExecutor 继续独立硬检查、审批和阶段复查 | packages/shared/src/agent/core/permission-manager.ts、packages/shared/src/agent/core/prompt-builder.ts、packages/shared/src/tools/executor.ts、packages/shared/src/agent/core/pre-tool-use.ts；tests/backend-contracts.test.ts、tests/pi-session.test.ts | explore 允许必要本地计划/草稿；allow-all 不跳过范围校验。工具门禁不是 OS 沙箱 |
| 上下文工程 | prepareTurn 每轮校验冻结 Skill 正文、注入权限分支/实体/来源/时间/来源状态，再做体积检查；Pi 续轮实际刷新提示，计划落盘与提交回调保留 | packages/shared/src/agent/core/prompt-builder.ts、packages/server-core/src/runtime/investigation.ts、packages/shared/src/agent/backend/pi/session.ts；context_prepared 保存哈希与工具面 | Skill 在安装/选择时解析 YAML，运行中使用冻结正文；不声称每轮从磁盘重新解析或继承 Craft BaseAgent |
| Agent Eval 契约回归门禁 | AgentEventSchema 覆盖权限/工具/模型/上下文事件；Trace v2 写入前验证载荷，兼容旧格式；新增独立标签及实际浏览器门禁 | packages/shared/src/agent/events.ts、packages/shared/src/sessions/trace.ts、fixtures/eval-cases.json、tests/domain-dataset.test.ts、tests/browser-live.test.ts | “Trace Schema 仍为设计”已过时；固定标签和协议模型不是实际模型质量 Golden Cases |

## 可以演示和复核的机制

1. explore 下只有写入能力的工具不进入模型工具面；通用 API 工具保留读取入口，实际写请求仍硬阻断；即使模型乱报名称，也不能靠提示词或网页内容获得权限，执行层仍独立校验。
2. allow-all 降为 explore 后，下一次真实模型请求同时更新 system prompt 和工具列表；初始未披露或后来替换的绑定不自动扩权。
3. 浏览器实际执行 JavaScript，但 HTTP 响应先由主进程受控获取，拒绝重定向、POST、越域和超大资源；真实 Pi 子进程可以在同一调查中调用浏览器和 API MCP，经相同 PreToolUse 与证据链保存草稿。
4. 官网/转载去重、同快照去重、错误/模糊归因、未知发布时间、时间窗右端点、来源失败、反向证据有独立输入和预期标签。漏采产生 partial；历史证据在来源/信号范围缩小时不能越界进入主张。

## 仍需收敛的表述

- “实时追踪”：目前按任务采集，重复运行比较历史；没有常驻订阅、调度器或实时 SLA。
- “减少人工负担”：是目标，没有用户对照或生产统计，不能写节省比例和使用规模。
- “可行动简报”：当前是有结构化主张与引用的本地草稿，自由文字仍待人工核对，Reviewer 是规则函数。
- 浏览器是匿名公开页面只读采集，不含登录、表单、任意脚本、视觉操作或通用网站结构化理解。
- 纯真实来源完整质量验收、真实模型黄金集、Langfuse、长期会话恢复仍是独立待办。本轮开发不补造既往参与历史。

## 复核位置

后端：docs/backend-overview.md、docs/architecture.md、docs/tool-call-pipeline.md。
来源配置：docs/source-adapters.md、examples/sources-adapters.json。
用户扩展：docs/user-extensions.md。
最终数字：artifacts/eval/latest.json、artifacts/browser-eval/latest.json。
实现与验收：docs/acceptance-report.md。

## API 通用工具补充

API 来源现采用 Craft 风格 config.json + guide.md + 单个 api_<slug>，通过受控读取工具按需加载指南。PreToolUse 将来源指南前置条件与动态 method/path/params 权限分类合并进既有检查链；ExecutionRecord 保存实际动作，Trace 关联指南快照与请求。保留严格未读/变更阻断，与参考实现的普通指南软重试策略有区别，不宣称逐行复刻。
