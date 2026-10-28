# Pi SDK 内建工具

原实现只开放调查业务工具，关闭了 Pi 自动注册的编码工具。现在默认显式注册 SDK 提供的 read、write、edit、bash、grep、find、ls，用于读取资料、生成工作文件、处理数据和执行命令。

这些是 `@earendil-works/pi-coding-agent@0.84.2` 的真实工具实现。`PiBuiltinSource` 调用 SDK 的 `create*ToolDefinition` 工厂，复用参数定义、读文件分页、精确编辑、搜索、输出截断和 shell 取消逻辑；不是用同名函数重新实现一套工具，也不包装成 MCP。

## 调用路径

```text
runInvestigation
  → 注册 PiBuiltinSource：source_slug=pi，channel=builtin
  → ToolRegistry：read / write / edit / bash / grep / find / ls
  → 按权限筛选，披露到 Pi AgentSession
  → SDK 代理 execute
  → Node IPC：PreToolUse + 执行握手
  → 宿主 ToolExecutor
  → PiBuiltinSource：pi.builtin.<工具名> 阶段复查
  → SDK 工具实现
  → 保存快照与 Trace，返回 SDK 原生 content blocks
```

AgentSession 的 `noTools: 'builtin'` 仍用于禁止 SDK 自动加入未经包装的默认工具。实际可用的 SDK 工具已经通过 `customTools` 显式注册；同名工具只有一个受控入口。子进程仍不持有来源客户端或搜索 API 凭据。

## 权限

| 工具 | 宿主 action | explore | ask | allow-all |
|---|---|---|---|---|
| read / grep / find / ls | analyze，本地检查 | 可用 | 可用 | 可用 |
| write / edit | modify | 不披露，乱报调用也拒绝 | 每次审批后执行 | 直接执行 |
| bash | modify | 不披露，乱报调用也拒绝 | 每次审批后执行 | 直接执行 |

bash 一律按可能修改系统的命令处理，不用字符串规则猜测命令是否只读。已有审批、参数哈希、执行前与阶段权限复查、超时、取消机制继续生效。写操作中途取消记为 unknown，不声称已经回滚。

本地文件检查不是外部来源采集，不要求先保存调查计划，也不把 `pi` 加入 `plan.sources`。命令输出和本地文件不会自动升级为结构化情报事实。API 指南前置条件仍由专用的 read_source_guide 工具记录；普通 read 不会改变“已读指南”状态。

CLI 可以这样启用需要审批的写入和 shell：

```powershell
npm start -- run --mode live --permission ask --workspace . --task examples/task-web.json --sources examples/sources-web-api.json --out artifacts/live-web-api --tool-timeout 45000
```

Web 工作台使用现有的 ask 审批流程。`RuntimeOptions.builtinTools=false` 可针对专用宿主关闭这组能力；默认开启。`workspaceRoot` 决定相对路径根目录，CLI 传入 `--workspace`，RunService 传入配置的项目根目录。

## 文件与进程边界

- 文件工具检查路径位于所选工作区，拒绝越界路径及指向工作区外的符号链接或 junction。
- `.env` 系列文件和工作区根部 `.ssh`、`.aws`、`.cwatch` 为私有路径；写入另保护根部 `.git`、`.codex`、`.agents`、`sources`、`skills` 及当前运行的审计输出目录。
- write / edit 在实际文件操作前再次检查路径；所有工具也有统一执行阶段检查。路径检查不是防止恶意并发换链、硬链接或任意本地进程的操作系统沙箱。
- bash 工作目录固定为所选工作区，但获批命令仍以当前用户权限运行，可以自行改变目录或访问其他文件。权限检查约束整条命令的执行，不能逐个拦截它内部的文件与网络动作。
- shell 环境仅保留运行所需的系统、PATH、代理和证书变量，不自动继承模型 Key、来源 Token 或其他宿主凭据；这不等于阻止命令从磁盘自行读取凭据。
- grep / find 沿用 SDK 的 rg / fd 依赖及可用性处理，bash 沿用 SDK 的本地 shell 选择；Windows 使用可用的 Git Bash。当前机器已存在对应程序。

## 结果与源码

文件、编辑和 shell 结果由 SDK 生成。宿主保存原始工具响应快照，沿用统一 Trace；代理把 content blocks 返回 SDK，避免将本地文本再套一层 JSON。响应超过 IPC 预算时明确失败。SDK 的长输出仍受自身截断规则约束，快照保存的是工具响应，并非整个被读取文件。

- SDK 适配与路径检查：`packages/shared/src/tools/pi-builtins.ts`
- 默认注册与业务流程：`packages/server-core/src/runtime/investigation.ts`
- 权限分类：`packages/shared/src/agent/core/permission-manager.ts`
- SDK 代理结果回填：`packages/shared/src/agent/backend/pi/tool-hooks.ts`
- 单独回归：`npm run test:pi-builtins`
- 完整回归：`npm run verify`

测试覆盖真实 SDK 文件操作、七种工具、权限模式与拒绝、目录越界、junction、命令环境、shell 取消，以及真实 Pi 子进程连续调用七个工具后继续完成调查的完整合成流程。

验证记录（2026-10-21）：

- `npm run verify`：396/396，通过结构检查与 TypeScript；新增 6 项内建工具用例和 1 项真实 Pi 子进程完整流程用例。
- 最终 junction 审计路径检查修正后，重新执行 TypeScript 检查和 `npm run test:pi-builtins`，6/6 通过。
- 文件、shell 和子进程均使用真实 SDK 实现；模型响应使用本地 HTTP/SSE 协议 fixture，没有调用真实规划模型。Windows 沙箱不能启动 Git Bash 或创建 junction，相关验证在沙箱外执行。
