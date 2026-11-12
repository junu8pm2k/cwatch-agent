# 从 Langfuse 界面运行完整 Agent Case

这是可选的试验入口。本地 `eval:model`、`eval:run`、`eval:regression` 和 `.github/workflows/ci.yaml` 继续使用原执行器、CaseSchema、Judge 与扣分程序，不要求 Langfuse 服务或密钥。Langfuse 路径复用同一套 Agent 和评分逻辑，只把题目/提示词读取、触发、平台 Judge 和结果展示接到平台。

## 现在怎样操作

1. 本机启动 Docker 中原有的 Langfuse，在项目根目录运行一次：

```powershell
npm run experiments:langfuse:start
```

服务在后台运行。本地执行状态：`http://127.0.0.1:4311/jobs`。重启电脑后需要重新启动执行服务；仅打开 Langfuse 页面不会启动本机 Node 进程。该启动脚本供 Windows + Docker Desktop 本地试用，不是 CI 的入口。

2. 在 Langfuse 打开 Datasets → cwatch → current → 任一 Dataset → Experiments → Run experiment → **via Webhook → Run**。
3. 默认配置会运行当前 Dataset 中的题目：

```json
{
  "scope": "dataset",
  "repeat": 1,
  "promptLabel": "prompt-eval",
  "queueHuman": true
}
```

四个 Dataset 分别为 activation 2题、core_logic 8题、resilience 2题、artifact_quality 2题。

**一次跑完 Case 1–14**：在同一个 Run 配置框把 scope 改为 all，可加一个便于比较的实验名称：

```json
{
  "scope": "all",
  "name": "agent-prompt-v2",
  "repeat": 1,
  "promptLabel": "prompt-eval",
  "queueHuman": true
}
```

每次会按四个 Dataset 建立四份实验；同名方便查找。repeat 大于1时，每次 Trial 建独立实验，避免同一 Item 在一个实验中合并。可以通过 caseIds 指定子集，例如 `["core-001"]`；子集必须属于 scope 包含的 Dataset。

4. 点击 Run 后，页面的 triggered 只表示任务已接收。到本地 `/jobs` 看 executing/publishing/judging 的状态，完成后到 Langfuse **Experiments** 查找实验名称，打开结果查看回答、完整 Trace、程序检查和分数。

## 提示词版本

把 Prompts → cwatch/agent 中要测试的版本打上 prompt-eval 标签。界面触发时会自动拉取四份指定版本并固定快照，无需先手动 pull。也可在 Run 配置中加：

```json
"promptVersions": {
  "general-agent": 1,
  "competitor-review": 2,
  "review-checklist": 1
}
```

未指定的仍按 promptLabel 读取。每个 Job 固定 Dataset 的完整 Case、rubric、Item 版本与 Agent Prompt 版本。更改评分标准后必须重新运行，不能用新标准悄悄替换旧成绩。模型和执行预算仍使用原 .env/Case 配置，不允许 Webhook 传入命令、任意文件路径、工具或凭证。

## Judge、程序检查与人工审核

平台使用原有结果、过程、证据三个固定 Evaluator，按每题 rubric 实际声明的维度运行。三道纯格式/去重题不用 LLM。每批只创建精确报告哈希和维度匹配的临时规则；评分完成或异常退出后关闭规则，不影响其他流量。

- `automatic.total`：程序与 LLM 的自动分，按原百分制扣分算法计算。
- `trial.total`：每次 Trial 当前自动分的唯一汇总，用于实验列表/对比的平均分；与 automatic 使用同一原扣分结果，仅在对应 Judge 全部结束后发布，不将同步过程中的中间历史重复计入平均。
- `final.total`：已要求的真实人工审核也完成后的综合分；缺少审核时不生成可用最终分。
- `automatic.score_available` / `final.score_available`：与同一 aggregationVersion 的分数一起读取，避免把历史分数当作当前分数。
- `awaiting_human`：自动评分流程已经结束，但该批还有指定的人工项。到 Human Annotation 完成对应队列，再同步。

人工审核后无需重跑 Agent：

```powershell
npm run experiments:langfuse -- --mode sync --job <本地jobs显示的任务UUID>
```

不会伪造真人、自动代审或确认基线。自动评分失败、unknown 或 Judge 格式无效会保留原答复、Trace 和平台原始输出，不自动修改成通过。网络/格式故障时查看任务 error 与其 bindings，仍可用原 `eval:langfuse --mode sync --binding ...` 恢复评分同步；不要重发已接收的 OTLP Span。

## 本地连接结构

```text
Langfuse Dataset 页面点击 via Webhook → Run
  → Docker 内 cwatch-langfuse-hook:80（专用 bearer 鉴权、无公开端口）
  → 唯一挂载的回调队列
  → 本机环回执行服务 127.0.0.1:4311
  → 原本地 Agent 执行器和文件/进程边界
  → 平台三个 Judge + 原扣分程序
  → Langfuse Experiments / Scores / Human Annotation
```

回调地址 `http://cwatch-langfuse-hook/langfuse/experiments` 供 Langfuse 容器解析，Windows 浏览器一般不能直接打开。额外容器复用当前已安装的官方 Langfuse 镜像，仅运行接收器，没有模型或 Langfuse API 密钥；只有回调队列可写，脚本和专用令牌只读挂载。没有挂载整个项目或 Docker socket。host 服务只监听环回地址，不开放局域网端口。

`ops/langfuse-webhook.override.yaml` 为现有 Langfuse Compose 增加唯一受信任的内部 Webhook 主机；数据库、数据卷、其他容器和 LLM 连接不改。启动脚本默认寻找项目旁边的 `../langfuse/docker-compose.yml`，可传 `-LangfuseDirectory` 指定其他目录。专用令牌保存在被 Git 忽略的 `.runtime/langfuse-experiments/webhook-token`，平台请求头 Authorization 设为 Secret，由 Langfuse 加密保存；不要提交或复制令牌到日志。

## 本地与 CI 入口仍独立

```powershell
# 本地 Agent + 本地 Judge，不依赖 Langfuse
npm run eval:run -- --dataset evals/cwatch/dataset.json --gate automatic

# 原有合格用例回归入口；仍按原有准入和基线要求运行
npm run eval:regression

# 工程与适配器检查；Langfuse 测试使用 mock/本地合成数据
npm run verify
```

本次不修改 CI 工作流，不给新的14题伪造已准入状态；新题仍按原基线审核流程准入。两条路径共用 Case 和扣分实现，LLM 可能有随机性，不能保证本地 Judge 与平台 Judge 每次逐条一致。
