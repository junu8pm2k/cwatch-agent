# Agent 提示词与 Langfuse

这里管理 CLI 和 Web 中 Agent 使用的行为提示词。可在 Langfuse 编辑版本，并拉取到本机供运行时使用。

## 已同步的实际来源

| Langfuse Prompt | 本地来源 | 用途 |
|---|---|---|
| `cwatch/agent/general-agent` | `skills/general-agent/SKILL.md` | 通用 Agent 基础行为 |
| `cwatch/agent/competitor-investigation` | `skills/competitor-investigation/SKILL.md` | 调研工作流行为 |
| `cwatch/agent/competitor-review` | `skills/competitor-review/SKILL.md` | 已选中的审核 Skill |
| `cwatch/agent/review-checklist` | `skills/competitor-review/references/checklist.md` | 审核 Skill 的清单读取内容 |

Prompt 类型为 text，Skill 条目保留 YAML 头，运行时使用 Skill 解析器读取。可以编辑 description、正文和清单内容，Skill 的 name 必须匹配本地定义。

宿主权限、工具注册及 Schema、预算、上下文拼装规则、SDK 补充指令和压缩/记忆提示词仍由代码管理。这四份是主要行为指导，并不代表完整模型请求的全部内容。快照只替换已选中的 Skill，不会自动加载未选中的 Skill 或授予工具权限。

## 首次同步与本地改动发布

```powershell
npm run prompts:langfuse -- --mode push
```

首次创建四个 Prompt 的 v1，打上 `prompt-eval` 标签。内容相同则复用原版本。如果平台内容与本地不同，默认停止，避免覆盖界面编辑；确认以本地文件为准时才使用：

```powershell
npm run prompts:langfuse -- --mode push --update
```

## 拉取提示词版本

1. 打开 Langfuse → Prompts → `cwatch/agent`。
2. 修改要比较的提示词，保存新版本。将该版本的标签设为 `prompt-eval`；其他三份仍使用各自当前带此标签的版本。
3. 拉取所选版本：

```powershell
npm run prompts:langfuse -- --mode pull
```

这会读取四个指定标签版本，生成不可变的 `artifacts/agent-prompts/<sha256>/snapshot.json`，并更新方便使用的 `artifacts/agent-prompts/current.json`。版本、来源项目和文本哈希全部记录。单独保存界面版本不会改变已经开始的运行，也不会自动覆盖本地 Skill 文件。

## 明确指定旧版本作对照

```powershell
npm run prompts:langfuse -- --mode pull --pin competitor-review=1
```

其余 Prompt 按 `prompt-eval` 标签读取。可重复传入 `--pin` 固定多个版本。要在 CLI 或 Web 中切换版本，使用命令输出的不可变快照路径。

## CLI / Web 的实际运行

可在 `.env` 中显式选择拉取好的快照并重启应用：

```dotenv
CWATCH_AGENT_PROMPT_SNAPSHOT=artifacts/agent-prompts/current.json
```

默认使用本地文件及已选 Skill。配置文件缺失或哈希校验失败时会报错。DeepEval Benchmark 使用仓库的 Skill 文件和固定题目快照。 [Benchmark 指南](../evals/README.md)

## 数据与追踪

```text
Langfuse Agent Prompt 的指定版本
  → 主进程拉取并验证
  → 保存 Agent 指导快照
  → CLI 或 Web 组装 Agent 上下文、读取 Skill 资源
  → 答复和 Trace
```

Langfuse 观测记录 `agentPromptSnapshot` 和实际使用的版本。主任务 Generation 通过 `prompt.name` 和 `prompt.version` 关联基础 Prompt，审核 Skill 及清单版本记录在 `metadata.agentPrompts.references`。
