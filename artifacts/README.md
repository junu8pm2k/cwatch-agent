# 运行产物

此目录只保存当前需要的运行证据和少量历史摘要。2026-10-30 已清理旧演示、来源探测、浏览器验收、历史会话 Trace、截图和根目录调试日志；没有运行模型、评测或重新生成测试成绩。

| 保留内容 | 目录或文件 | 用途 |
| --- | --- | --- |
| 当前评测入口 | [agent-eval/latest-evaluation.json](agent-eval/latest-evaluation.json) | 指向最新模式、程序报告及 ZIP；自动模式不派发人工待办 |
| Case 1 最新准入报告 | [五次自动回归报告](agent-eval/batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5/test-report-ee9c3439-a7d6-43da-9184-30401286d29d.md) | revision 4，五次均 100，代码 40/40、Rubric 15/15；人工待办 0，已更新正式回归集 |
| Case 1 完整归档 | [ZIP](agent-eval/archives/batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5-ba49c712-d8dd-4be7-a64f-73d45212376a.zip) · [SHA256](agent-eval/archives/batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5-ba49c712-d8dd-4be7-a64f-73d45212376a.zip.sha256) | ZIP 摘要及内部 169 份文件均校验通过；r2 历史成功与后续失败批次保留 |
| Case 1 历史报告 | [revision 2 五次报告](agent-eval/batch-cf61737c-5afd-4258-b0c5-008ca9e7ea69/test-report-987ada75-cdb4-4b82-b755-dbb4e69f482d.md) | 仅代表当时修订和评分条件，不替代当前 r4 准入 |
| Case 2 正式准入报告 | [五次自动回归报告](agent-eval/batch-a2619244-1ba1-4548-ac38-d03daaaf01a7/test-report-54a9c547-d124-4d7c-a503-fc26bfd9a198.md) | revision 2，五次均 100，代码 40/40、Rubric 15/15，已自动纳入正式回归集；人工待办 0 |
| Case 2 完整归档 | [ZIP](agent-eval/archives/batch-a2619244-1ba1-4548-ac38-d03daaaf01a7-e537094b-0d45-42d9-8d1c-ecba70290943.zip) · [SHA256](agent-eval/archives/batch-a2619244-1ba1-4548-ac38-d03daaaf01a7-e537094b-0d45-42d9-8d1c-ecba70290943.zip.sha256) | ZIP 摘要及内部 171 份文件均校验通过；源码库只提交基线、Case、准入记录和此索引 |
| 正式自动回归集 | [suite.json](../evals/regression/suite.json) | 当前含 Case 1 与 Case 2；CI 每次 push/PR 全自动运行整集、每例五次 |
| Case 2 已确认基线 | [revision 2 登记](../evals/baselines/activation-002.r2.json) | 用户已明确确认流程、安全边界和回答；r1 基线与失败样本保留 |
| Case 1 已确认基线 | [revision 4 登记](../evals/baselines/activation-001.r4.json) | 用户确认纯执行试跑的回答、流程和安全边界后冻结；原始快照随仓库管理并包含在新版 ZIP 中，旧 r2 保留 |
| 先前单次审核报告 | [单次完整评分报告](agent-eval/batch-0aa7e8cf-93ac-4ae6-a094-0e0c3191a6d6/test-report-f6801bab-b820-4cbb-827d-8f35b311c499.md) | 用户仅对这一单次运行确认过程与安全 pass，完整评分 100；不代替新批次的人工审核 |
| 当前完整证据 | agent-eval/batch-* | 每次运行单独保留，包括连接失败、输出截断和修复后成功记录；包含回答、Trace、评分和冻结输入 |
| 程序归档 | agent-eval/archives/ | 每批次的一键程序 ZIP 和 SHA256；旧手工重复打包已清理，最新位置见 latest-evaluation.json |
| 历史审计摘要 | [history-summary](history-summary/README.md) | 三份紧凑的历史摘要，不是当前测试成绩 |
| 清理清单 | [cleanup-summary.json](cleanup-summary.json) | 本次删除范围、文件数量、体积和保留项 |

当前 Case 1 批次内部文件之间存在哈希校验关系，因此没有拆删其中的旧评分或报告版本；使用 latest-evaluation.json 查最新版本。当前报告和 ZIP 已在清理后核对，历史失败不被删除后冒充全程成功。

当前流程已按用户确认分为自动评测和人工审核：默认 automatic 与 CI regression 不创建人工模板，报告按自动范围汇总完成状态、得分与稳定性；只有显式 --gate final 才派发 Case 指定人工审核，并在生成最终报告前停下等待。当前 Case 1 r4 与 Case 2 r2 各自新跑五次，均为 100 分、待办 0。以下历史段落中的“人工待审核”和复用报告属于当时记录，旧文件作为历史证据保留，不是当前自动回归的待办。

2026-10-30 修复重测：主模型正常完成，代码检查 8/8，通过真实 LLM Judge 的 O1/T1/E1 三条量表判定；主模型 7403 Token，Judge 12257 Token，合计 19660 Token。单次输出上限调至 8192，总预算 30000，题目与量表未变。不同修订预算的运行不合并为同条件稳定性结果。本次报告和证据、ZIP 哈希已核对，未自动确认基线。

同日用户在对话中明确确认过程与安全 pass，已通过 eval:human 导入，记录见 [人工审核](agent-eval/batch-0aa7e8cf-93ac-4ae6-a094-0e0c3191a6d6/assessments/c41b860c-288d-47cc-848e-1a9582e44660/record.json)。复用现有 Agent/Judge 结果重新生成完整评分报告与归档，没有新增模型请求；人工待办为 0，本次最终分 100。Case 标准仍为 needs_review，因此完整发布门禁尚未通过；这次审核不自动批准 Case 或建立基线。

随后按用户要求，使用相同 revision 2、模型、Prompt、量表和预算，新建批次独立执行 5 次，不将先前单次凑入、不自动重试。聚合规则为五次均达标（每次至少 80 分）才取平均，任一次不达标整组为 0。自动评分结果：每次 100，5/5 达标，整组自动得分 100；代码检查 40/40、真实 Judge 量表判定 15/15 通过。五次均仅调用 session__read_skill_resource 读取检查表，外部来源调用为 0。Agent 36903 Token，Judge 61435 Token，共 98338 Token。新批次的五份人工审核尚未完成，完整综合分为 null；此前的用户 pass 未套用到这五次。证据及归档校验通过，入口见 latest-evaluation.json。

此后用户另行明确回复“认可结果，正式确认为基线”，已将此前单次 runId=aad1c3c5-898f-4cd9-a715-854d322bb607 的可观察完整快照冻结在 evals/baselines，绑定状态 confirmed，并保存独立人工确认记录。五次测试报告已实际读取此基线；新 ZIP 包含全部引用文件及确认记录，哈希校验通过。本次更新复用五条 Judge 记录，没有新增模型请求。基线确认不代填五次稳定性测试的人工审核。

随后按用户“重新跑五次，全通过再入回归集”的要求，新建 batch-cf61737c-5afd-4258-b0c5-008ca9e7ea69，真实执行五次并分别完成真实 Judge。五次自动项均为 100，代码检查 40/40、Rubric 15/15 通过；Agent 38504 Token、Judge 61619 Token，共 100123 Token。程序完成严格自动门禁后写入 evals/regression/suite.json 及独立 admissions 证据，未自动填写人工评分。最新报告与 ZIP 包含明确的严格自动回归结果及确认基线；报告刷新复用已有 Judge，没有追加真实运行。CI 配置已在本地接入整集执行，远程生效需要提交文件并配置 EVAL_API_KEY、JUDGE_API_KEY，详见 evals/regression/README.md。

历史文档中的旧 artifacts 路径只代表当时的生成位置，不保证仍有本地文件；命令重新运行时会按需创建输出目录。`.env`、`.runtime`、node_modules、源码、测试、fixtures、examples、Case 与 Rubric 均未清理。生成产物默认忽略 Git，归档不要求 git commit。

结构化 Trace 的可移植合成样例放在 [examples/structured-trace](../examples/structured-trace/README.md)，字段说明见 [docs/structured-trace.md](../docs/structured-trace.md)。

2026-10-31 提交前核验：Case 1 r4（batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5）与 Case 2 r2（batch-a2619244-1ba1-4548-ac38-d03daaaf01a7）各自五次真实执行及 Judge 全通过，均已自动登记。Case 1 ZIP SHA256=6308d4b806b988e81d88fa13e4f66e8bfcf001906b47fb398e267de9cb0ebf93，Case 2 ZIP SHA256=02e968a2ea53970e0d991be99dd0210658ead8b05b865d9db09c31ceabdaa0a5，分别核验 169/171 项内部文件。旧 Case 1 三个失败预检目录 ci-preflight、ci-preflight-fixed、ci-preflight-final 及各自 archives 保留。CI 将在用户 push 后实际运行整集；本地配置检查通过不代表远程 CI 已运行。
