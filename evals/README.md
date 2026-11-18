# Agent Benchmark v2.3

用例在 Langfuse 的 `cwatch/benchmark/v2.3` Dataset 中维护。业务题先从[竞品证据审阅 SOP](../skills/competitor-review/SKILL.md)拆任务，再从已记录的真实失效补边界。用例材料采用合成数据。

| Langfuse 字段 | 内容 |
| --- | --- |
| Input | `instruction`、固定材料 `fixture`，业务题使用 `profile: "competitor-review"` |
| Expected output | `answer` 记录成功标准，`toolPolicy` 规定读取审阅清单或在转录任务中直接停止，可用 `json` 指定精确输出 |
| Metadata | 稳定的 `caseId`、`category`、必需 `metrics`、`tags`（`smoke` 或 `regression`）及 `dataClass: "synthetic"`，业务题通过 `origin` 追溯 SOP 或原始失败运行 |

| 来源 | 场景 | 集合 | 判定 |
| --- | --- | --- | --- |
| 审阅 SOP | 正常核对导出权限和改写文案 | Smoke | Trace 验证读取清单，Judge 检查管理员与普通成员的权限范围 |
| 审阅 SOP | 产品归属不同，停止归因并说明补证据 | Smoke | Trace 验证读取清单，Judge 检查 console 与 desktop 的区分 |
| 审阅 SOP | 仅按给定材料转录 | Smoke | Trace 验证零工具调用，程序检查 JSON 键和值 |
| 审阅 SOP | 缺少官方连接时说明外部核验状态 | Regression | Trace 验证仅使用清单，Judge 检查能力边界 |
| 审阅 SOP | 两份材料不足以定论，形成内部交接稿 | Regression | Trace 验证仅使用清单，Judge 检查证据缺口、核验事项和交接范围 |
| 真实 Bad Case | 用材料发布日期回答上线时间 | Regression | Trace 验证读取清单，Judge 审查结论及改写中的日期角色 |
| 真实 Bad Case | 把合成摘录及其转述当成官方独立证据 | Regression | Trace 验证读取清单，Judge 审查来源与引用依赖 |

两条 Bad Case 均可追溯到 [activation-002 r1 的实际答复](baselines/activation-002/r1/15f77cab-0a88-4730-9e91-efa67bdff879/final-answer.md)（run `667dbd08-2375-41e2-ba55-64aa00173fd1`）。原答复建议用材料日期回答何时开始，并把有合成标记的摘录判为一手材料。回归用例分别替换产品和材料形态，以覆盖同类错误。

业务题固定加载仓库中的竞品审阅 Skill 和清单，使用独立的 `explore` 会话，且无外部数据源。Runner 把材料提供给 Agent，把成功标准和来源记录留给评测。报告记录材料、Skill、量表和快照哈希，支持在相同条件下比较版本。原有四条文件读取用例继续校验工具执行和评测接线。

自动判定后，在 Langfuse 抽检 Trace、模型回答和评分理由。争议由人工在该 Trace 上记录依据与结论。把 Agent 行为问题回填为新的固定用例，把评分歧义修到 Rubric，再用相同快照复跑受影响的集合。

本地在 `.env` 中配置 Langfuse 项目密钥与宿主机地址（当前 Docker 映射为 `http://localhost:3002`），以及独立的 `API_KEY`、`JUDGE_API_KEY`。DeepEval Judge 复用 Langfuse 已配置的 StepFun `step-5-preview` 和 `https://api.stepfun.com/step_plan/v1` 接口。Agent、Judge、阈值和执行预算定义在 [config.json](config.json)，评分标准在 [rubrics](rubrics/)。

```sh
npm ci --ignore-scripts
npm run eval:sync
git diff -- evals/datasets
npm run eval:docker
```

- `eval:sync` 固定 Langfuse 读取时间，分页拉取后校验用例和完整性。每个 JSON 快照用临时文件原子替换，读取端会拒绝混合版本或校验和不一致的快照。可用 `npm run eval:sync -- --version <UTC-timestamp>` 获取指定历史版本。同步时间、版本时间和校验和记录在 `artifacts/benchmark/sync.json`。
- `eval:docker` 用一次性容器执行快照。每个 Case 启用新的 Agent 进程和工作目录，仅提供该 Case 的固定夹具。容器退出后由宿主机上传 Trace 和评分，因此可使用仅监听宿主机回环地址的 Langfuse。容器只接收模型凭据。
- `eval:local` 依次同步和运行 Docker 评测。准备提交快照时，先独立执行同步并审查 diff，再运行评测和提交。
- `eval:run` 使用本机 Node 24、Python 3.12.15 和 uv 从已同步快照运行评测。评分需要模型 API 连接。带旧评测参数的 `eval:run` 调用继续走原评测入口。
- `eval:publish -- <run-id>` 重试本地 Trace 和 Score 上传，使用稳定 ID。报告、JUnit 和上传结果都在 `artifacts/benchmark/<run-id>/`。Langfuse 中可按 Trace ID 查看，评分名称以 `benchmark.` 开头。

默认执行两个集合，也可通过 `BENCHMARK_SUITE=smoke` 或 `BENCHMARK_SUITE=regression` 选择。GitHub Actions 使用 `eval:ci` 直接在 Runner 上执行同一套 DeepEval。为仓库配置 `BENCHMARK_AGENT_API_KEY` 和 `BENCHMARK_JUDGE_API_KEY`，并将 **DeepEval benchmark** 设为合并必需检查。来自 Fork 的 PR 缺少仓库密钥时会报告失败，维护者可在可信分支复跑。Dataset、Rubric、夹具和阈值变更由 CODEOWNERS 审查。

## 既有 Eval Case

2026-11-01 当前题单为[14题完整设计](cwatch/README.md)：触发2、核心逻辑8、异常容错2、产物质量2。Case 1修订为r6，其他新题为r2；输入、逐题规则、评审分工与异常fixture均已配置，全部needs_review，没有新确认基线或成绩。Dataset只存题目与规则，Prompt Management只存三个维度Judge。旧drafts/v2已被替代，原r5纯执行试跑仍保留。以下为既有历史准入状态，不能迁移给新修订。

2026-10-29 按项目所有者要求清空全部旧 eval case。当前从新设计注册了 **2 个用例：activation-001、activation-002**，见 [触发题单](activation/dataset.json)。

原契约回归、模型诊断、四类场景题库，以及题单、catalog、材料、候选、历史快照和对应评测归档均已删除；旧草案模板与 8 个领域评测 case 也已删除。

2026-10-31 历史题组共有 **4 个触发设计稿（正 2、反 2）**；可执行 activation-001 revision 4 与 activation-002 revision 2 均经用户确认基线，并各自独立完成五次均 100 分的严格自动门禁，程序已纳入 [正式回归集](regression/suite.json)。旧修订、基线及失败记录保留。回归测试全自动，不逐次请求人工。旧 activation-003、004 仍为设计稿，不额外计入新版 14 题。旧案例不会自动恢复。

普通工程测试与通用评测框架仍在，后续评测必须显式提供新的题单文件。详见 [评测状态](../docs/evaluation.md)。
