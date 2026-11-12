# Agent 提示词与 Langfuse

这里管理的是**被测 Agent 的行为提示词**，不是 Judge 评分标准，也不是 Dataset 的任务输入。Case rubric、预期结果和扣分程序不随提示词版本改变。

## 已同步的实际来源

| Langfuse Prompt | 本地来源 | 用途 |
|---|---|---|
| `cwatch/agent/general-agent` | `skills/general-agent/SKILL.md` | 通用 Agent 基础行为 |
| `cwatch/agent/competitor-investigation` | `skills/competitor-investigation/SKILL.md` | 调研工作流行为 |
| `cwatch/agent/competitor-review` | `skills/competitor-review/SKILL.md` | 已选中的审核 Skill |
| `cwatch/agent/review-checklist` | `skills/competitor-review/references/checklist.md` | 审核 Skill 的清单读取内容 |

Prompt 类型为 text，Skill 条目保留 YAML 头，运行时按原 Skill 解析器读取。不要修改 Skill 的 name；可以修改 description、正文和清单内容。审核 Skill 原先只以相同快照嵌在 12 个 Case 中，本次提取出独立可维护源文件，内容与原快照逐字节相同；原 Case 文件没有被改写。

宿主权限、工具注册及 Schema、预算、上下文拼装规则、SDK 补充指令和压缩/记忆提示词仍由代码管理。这四份是主要行为指导，并不代表完整模型请求的全部内容。快照只替换已选中的 Skill，不会自动加载未选中的 Skill 或授予工具权限。

## 首次同步与本地改动发布

```powershell
npm run prompts:langfuse -- --mode push
```

首次创建四个 Prompt 的 v1，打上 `prompt-eval` 标签。内容相同则复用原版本。如果平台内容与本地不同，默认停止，避免覆盖界面编辑；确认以本地文件为准时才使用：

```powershell
npm run prompts:langfuse -- --mode push --update
```

## 在界面改进，再实际测评

现在也可以直接从 Dataset → Experiments → Run experiment → via Webhook 触发完整 Agent，自动拉取并固定提示词版本；操作见 [界面运行 Case 1–14](langfuse-experiments.md)。下面的命令行方式继续保留。

1. 打开 Langfuse → Prompts → `cwatch/agent`。
2. 修改要比较的提示词，保存新版本。将该版本的标签设为 `prompt-eval`；其他三份仍使用各自当前带此标签的版本。
3. 拉取所选版本：

```powershell
npm run prompts:langfuse -- --mode pull
```

这会读取四个指定标签版本，生成不可变的 `artifacts/agent-prompts/<sha256>/snapshot.json`，并更新方便使用的 `artifacts/agent-prompts/current.json`。版本、来源项目和文本哈希全部记录。单独保存界面版本不会改变已经开始的运行，也不会自动覆盖本地 Skill 文件。

4. 用刚拉下来的提示词跑原 Case：

```powershell
npm run eval:model -- --dataset evals/cwatch/dataset.json --case core-001 --repeat 1 --agent-prompts artifacts/agent-prompts/current.json
```

删除 `--case core-001` 即跑当前 14 题。`eval:model` 负责实际 Agent 执行和程序检查，语义项仍等待 Judge；不把程序检查成功宣称为完成全部评分。随后沿用原 Langfuse 原生 Judge 准备、触发、同步流程：

```powershell
npm run eval:langfuse -- --report <batch/report.json> --case core-001 --native
```

该命令准备冻结的评分包和对应 Evaluator，不会仅因准备成功就触发 Judge；后续使用项目现有的规则/实验和同步流程，详见 [Langfuse 接入](langfuse.md)。也可以使用本地 Judge 完成原评分流水线：

```powershell
npm run eval:run -- --dataset evals/cwatch/dataset.json --case core-001 --gate automatic --agent-prompts artifacts/agent-prompts/current.json
```

`eval:run` 此处使用本地 Judge，不会自动改用 Langfuse Evaluator。恢复已有报告时不能换提示词，必须重新运行 Agent 才能比较新版本。

## 明确指定旧版本作对照

```powershell
npm run prompts:langfuse -- --mode pull --pin competitor-review=1
```

未指定的三份仍按 `prompt-eval` 标签读取；可重复传 `--pin general-agent=1 --pin review-checklist=1` 等。保存输出中的不可变快照路径，分别传给两次评测，比较时保持 Case、rubric、模型和运行参数一致。同一批次只在开始时读一次快照，后续界面标签变化不影响这一批。

## CLI / Web 的实际运行

可在 `.env` 中显式选择拉取好的快照并重启应用：

```dotenv
CWATCH_AGENT_PROMPT_SNAPSHOT=artifacts/agent-prompts/current.json
```

没有配置时仍用原本地文件与已选 Skill。评测命令的 `--agent-prompts` 优先于该环境变量；replay 工程测试不会自动采用这个环境变量。配置文件缺失/哈希不符会报错，不会悄悄回退成另一个版本。

## 数据与追踪

```text
Langfuse Agent Prompt 的指定版本
  → 主进程拉取并验证
  → 固定快照（只含 Agent 指导，不含 rubric/标准答案/密钥）
  → 评测进程组装实际 Agent 上下文、读取 Skill 资源
  → 答复和 Trace
  → 原 Judge / 程序 / 审核 / 扣分流程
```

受限评测 worker 不接收 Langfuse 密钥，不联网拉取 Prompt。批次与每次执行均保存快照；manifest 和 Judge packet 标明 Agent 变体及实际 Skill 哈希，同时保留原 Case 输入和 rubric。Langfuse 根/模型/工具观测记录 `agentPromptSnapshot` 和实际使用的版本列表，供过滤对照；主任务 Generation 使用官方 prompt.name/version 属性关联通用/调研基础 Prompt。审核 Skill 及清单版本在 metadata.agentPrompts.references 中，单个 Generation 不伪装成同时绑定多个原生 Prompt；记忆/压缩调用也不错误绑定主任务 Prompt。
