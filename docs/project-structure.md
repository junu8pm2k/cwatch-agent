# 项目目录与 Craft 对照

2026-10-29 清理说明：内置 eval case、题单、材料及对应评测归档已删除。下文中的旧案例数量、路径与成绩仅描述历史；当前状态见 [评测状态](evaluation.md)。

本项目按 Craft 的 apps/cli、packages/core、packages/shared、packages/server-core 职责组织为 npm workspaces。使用 Node.js 24 和现有依赖版本，根目录保留启动、验证、示例和数据目录。

## 当前目录

~~~text
.
├─ apps/
│  ├─ web/                               # 本地 HTTP/SSE 与 TypeScript 网页工作台
│  │  ├─ src/                            # index.ts、server.ts、client.ts
│  │  └─ public/                         # index.html、styles.css
│  └─ cli/
│     ├─ package.json
│     └─ src/
│        ├─ index.ts                       # 命令行入口、环境、审批交互与来源准备
│        └─ commands/extensions.ts          # MCP 与 Skill 管理命令
├─ packages/
│  ├─ core/
│  │  └─ src/
│  │     ├─ index.ts
│  │     └─ types/
│  │        ├─ domain.ts                    # 任务、信号、工具、模型与会话契约
│  │        ├─ permissions.ts               # 权限模式常量与类型
│  │        └─ pre-tool-use.ts              # IPC 权限请求、响应与握手契约
│  ├─ shared/
│  │  └─ src/
│  │     ├─ agent/
│  │     │  ├─ core/                        # 权限、指南前置校验、Prompt 与预算
│  │     │  ├─ backend/pi/                  # Pi 会话、活动上下文/压缩、IPC 代理与 worker
│  │     │  ├─ events.ts                    # AgentEvent Schema
│  │     │  ├─ models.ts                    # Pi/Replay 模型端口适配
│  │     │  └─ pre-tool-use.ts              # 主进程权限响应处理
│  │     ├─ sources/                       # ServerBuilder、API MCP、浏览器与联网
│  │     ├─ mcp/                           # 连接池、用户配置与来源客户端
│  │     ├─ skills/                        # 安装、选择、快照和资源读取
│  │     ├─ sessions/                      # FileStore、Trace、SessionTranscript 与回放校验
│  │     ├─ tools/                         # ToolRegistry 与 ToolExecutor
│  │     ├─ config/                        # 模型连接配置
│  │     ├─ intelligence/                  # 证据、事实版本、主张与规则审查
│  │     ├─ workspaces/                    # 受控文件路径和原子操作
│  │     └─ utils/                         # 子进程环境等公共工具
│  └─ server-core/
│     └─ src/
│        ├─ index.ts
│        └─ runtime/                       # 共享 TaskRuntime、通用 Agent、会话工具与调查模板
├─ tests/                                 # 跨包契约、语义和集成测试
│  ├─ *.test.ts
│  ├─ harness.ts                          # 原有辅助文件名保留
│  └─ fixtures/
├─ scripts/
│  ├─ eval.ts                             # 原有评测入口
│  ├─ eval-browser.ts
│  ├─ check-structure.ts                  # 包导出、依赖方向与资源路径门禁
│  └─ probe*.ts
├─ examples/                              # 可编辑任务、来源和 MCP 示例
├─ fixtures/                              # 明确标注的合成业务数据
├─ sources/                               # 每来源 config.json + guide.md
│  ├─ github/
│  └─ platform/                           # 停用的 API 模板
├─ skills/                                # 标准内置 Skill 包
│  ├─ general-agent/SKILL.md               # 通用任务与用户追问
│  └─ competitor-investigation/SKILL.md    # 竞品调查工作流
├─ docs/
├─ artifacts/                             # 报告与本地运行产物
├─ .env.example
├─ package.json
└─ package-lock.json
~~~

## 包的依赖方向

~~~mermaid
flowchart TD
    Web["@cwatch/web · apps/web"] --> Host["@cwatch/server-core · 调查 Runtime"]
    Web --> Shared["@cwatch/shared · Agent 与公共能力"]
    Web --> Core["@cwatch/core · 契约"]
    CLI["@cwatch/cli · apps/cli"] --> Host["@cwatch/server-core · 调查 Runtime"]
    CLI --> Shared["@cwatch/shared · Agent 与公共能力"]
    CLI --> Core["@cwatch/core · 契约"]
    Host --> Shared
    Host --> Core
    Shared --> Core
~~~

跨包通过 package.json 的显式 exports 和 @cwatch/* 引用；包内使用相对路径。core 不引用 shared 或 server-core，shared 不引用应用入口或宿主调查 Runtime。权限模式及 pre_tool_use_request/response 类型放在 core，主进程审批逻辑仍在 shared，避免契约反向依赖执行实现。

server-core 提供主进程运行库和 RunService，本地 HTTP/SSE 入口位于 apps/web。Pi worker 的实际入口在 packages/shared/src/agent/backend/pi/worker.ts，由同目录 subprocess.ts 使用相对 URL fork；仍是独立 Node 子进程。主进程继续拥有工具客户端、凭据、执行器和状态。

## 与 Craft 的对应

| Craft 目录 | 本项目的职责 |
|---|---|
| apps/cli | 可执行命令行入口与用户交互 |
| packages/core/src/types | 任务、信号与工具契约 |
| packages/shared/src/agent/core | 权限、Prompt、预算与调用前检查 |
| packages/shared/src/agent/backend/pi | Pi SDK 适配与当前 Node IPC 子进程 |
| packages/shared/src/sources | 来源装配、API Tool → MCP Server、浏览器和联网 |
| packages/shared/src/mcp、skills、sessions | MCP、技能与会话存储能力 |
| packages/server-core/src/runtime | 共享任务生命周期、通用 Agent、可选调查 workflow 与故障终态；RunService 提供 Web 任务管理 |

只创建承载现有代码的包。已增加本地 Web UI 与仅绑定 loopback 的 HTTP/SSE 传输，使用 RunService 包装调查生命周期。Electron、公网服务和多租户仍未实现。顶层 tests 保留跨包验收，继续使用 *.test.ts 和原有 harness/fixture 名称。

## 开发命令

在仓库根目录执行；.env、.cwatch、examples、fixtures、sources、skills 与 artifacts 的位置不变。

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
npm start -- run --mode replay
npm run demo:adapters
npm run verify
npm run verify:browser
npm run typecheck:workspaces
~~~

npm run verify 先检查包结构，再运行原有 TypeScript 与完整回归。scripts/eval.ts 的运行方式保持不变。离线 clean-install 复制脚本包含 apps、packages 与 sources。

Node 使用真实 workspace 包链接解析 @cwatch/*，不是仅对编辑器生效的 tsconfig.paths 别名。公开包导出直接指向 TypeScript 源码，Node 调用继续带 --experimental-transform-types，不需要新构建工具。

## 运行产物与临时文件

`artifacts/test-work/` 由测试和 `scripts/stage-clean.ts` 自动生成，包含 `case-*` 临时状态及 `clean-install-*` 隔离安装副本；在没有测试或隔离安装进程使用它们时可清理。`artifacts/clean-install-path.txt` 只是最近一次隔离安装位置的临时指针。2026-10-25 已清理积累的 20907 个测试目录、5 份隔离安装副本，以及无引用的一次性迁移脚本和 StepSearch 调试下载文件。2026-10-27 在 551 项回归通过后再次清理临时工作目录、一次性调试文件及无引用日志，保留验收与真实评测证据；实际清单和数量见 [清理记录](../artifacts/cleanup-summary.json)，产物分类见 [artifacts 说明](../artifacts/README.md)。

2026-10-29 已删除 Case 评测归档，包括 agent-eval、agent-eval-model、tutorial-eval、model-suite、scenario 和 penalty 演示。`delivery-demo/` 与普通工程运行材料保留。清理临时目录不等于删除全部 artifacts。`.runtime/` 保存工作台历史，`.env` 保存本机配置，均不属于此次清理范围。

2026-10-30 按用户要求再次清理历史生成物：旧 delivery/demo、probe、浏览器及会话输出和根目录日志已删除；现在只保留新建 Case 1 的 agent-eval 完整证据、三份 history-summary 历史摘要及清理索引。Case 1 的旧批次文件受完整性校验保护，不单独拆删；README 与 latest-evaluation.json 指向最新报告。旧运行输出下次执行对应命令时再生成，默认不纳入 Git。

## 文件迁移索引

| 原路径 | 当前路径 |
|---|---|
| src/cli.ts | apps/cli/src/index.ts |
| src/extension-cli.ts | apps/cli/src/commands/extensions.ts |
| src/domain.ts | packages/core/src/types/domain.ts |
| src/runtime.ts | packages/server-core/src/runtime/investigation.ts |
| src/policy.ts | packages/shared/src/agent/core/permission-manager.ts |
| src/context.ts | packages/shared/src/agent/core/prompt-builder.ts |
| src/budgets.ts | packages/shared/src/agent/core/budgets.ts |
| src/models.ts | packages/shared/src/agent/models.ts |
| src/pi-session.ts | packages/shared/src/agent/backend/pi/session.ts |
| src/agent/pre-tool-use.ts | packages/shared/src/agent/pre-tool-use.ts |
| src/agent/events.ts | packages/shared/src/agent/events.ts |
| src/agent/core/pre-tool-use.ts | packages/shared/src/agent/core/pre-tool-use.ts |
| src/agent/backend/pi/worker.ts | packages/shared/src/agent/backend/pi/worker.ts |
| src/agent/backend/pi/subprocess.ts | packages/shared/src/agent/backend/pi/subprocess.ts |
| src/agent/backend/pi/model-runtime.ts | packages/shared/src/agent/backend/pi/model-runtime.ts |
| src/agent/backend/pi/protocol.ts | packages/shared/src/agent/backend/pi/protocol.ts |
| src/agent/backend/pi/tool-hooks.ts | packages/shared/src/agent/backend/pi/tool-hooks.ts |
| src/sources.ts | packages/shared/src/sources/server-builder.ts |
| src/api-mcp.ts | packages/shared/src/sources/api-tools.ts |
| src/browser-source.ts | packages/shared/src/sources/browser.ts |
| src/browser-config.ts | packages/shared/src/sources/browser-config.ts |
| src/web.ts | packages/shared/src/sources/web.ts |
| src/web-mcp.ts | packages/shared/src/sources/web-mcp.ts |
| src/web-mcp-results.ts | packages/shared/src/sources/web-mcp-results.ts |
| src/web-errors.ts | packages/shared/src/sources/web-errors.ts |
| src/web-api-config.ts | packages/shared/src/sources/web-api-config.ts |
| src/web-api-mcp.ts | packages/shared/src/sources/web-api-mcp.ts |
| src/mcp-pool.ts | packages/shared/src/mcp/client-pool.ts |
| src/user-mcp.ts | packages/shared/src/mcp/storage.ts |
| src/user-mcp-source.ts | packages/shared/src/mcp/source.ts |
| src/skills.ts | packages/shared/src/skills/storage.ts |
| src/managed-workspace.ts | packages/shared/src/workspaces/managed-workspace.ts |
| src/source-process.ts | packages/shared/src/utils/process-environment.ts |
| src/config.ts | packages/shared/src/config/models.ts |
| src/store.ts | packages/shared/src/sessions/storage.ts |
| src/trace.ts | packages/shared/src/sessions/trace.ts |
| src/registry.ts | packages/shared/src/tools/registry.ts |
| src/executor.ts | packages/shared/src/tools/executor.ts |
| src/evidence.ts | packages/shared/src/intelligence/evidence.ts |
