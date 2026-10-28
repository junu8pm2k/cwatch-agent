# 四类场景增补用例

当前版本 `2026-10-27.3`，25 个新用例：18 个真实模型模式、7 个确定性宿主契约。所有新增标准都是待真人核验的候选，`status=needs_review`、`oracle.review=null`。未修改已有 12 个契约和 20 个模型题的标准或审核记录。

| 类别 | 正例 | 负例 | 模式与观察点 |
|---|---:|---:|---|
| 触发 activation | 4 | 4 | 模型模式；根据实际入口工具调用判断，不采信回答自报 |
| 核心逻辑 core_logic | 2 | 6 | 4 个模型决策题＋4 个脚本宿主门禁题；工具、参数、顺序、前置步骤 |
| 产物质量 artifact_quality | 1 | 5 | 模型模式；完整 Markdown 报告、实际文件、事实与引用配对 |
| 异常容错 resilience | 1 | 2 | 脚本宿主契约；部分来源降级、工具异常、无进展停止 |

负例指容易误触发、带错误或恶意材料、异常环境等输入。成功处理负例应通过检查，不是要求 Agent 输出错误。评分器对缺章节、错引用、编造版本等已知坏输出的校准位于工程测试，不混入模型成绩。

## 触发

正例是直接、口语化、交付物导向、英文四种调查请求。负例是问概念、明确不调查、仅翻译引用请求、编写代码。工具说明公开适用范围，模型自行决定是否调用 `mcp__fixture__investigate`。参数须为指定产品，宿主记录实际请求和执行。

这是现有通用 Agent 对已披露工具的激活评测。入口返回明确合成的受理回执，不启动真实外部采集，也不代表系统新增了自动 Skill 路由或通用意图分类器。没有把审批/预算/Memory 的内部条件充作意图触发题。

## 核心逻辑

- `core-*` 四题通过明确脚本驱动真实 Runtime/ToolExecutor，检查正确序列、缺前置步骤、未知工具、参数错误时的实际执行和阻断。
- `model-core-*` 四题让模型自行先 read_context，再以 query=releases 调用 collect；负例分别提供跳过步骤、错误工具和恶意参数诱导。验证实际 Trace 中的请求、执行、参数和后端次数。

脚本题不会记为真实模型决策质量。前置条件在真实 SourceClient/宿主门禁实现，返回失败后不计为成功执行。

## 完整报告

六题分别提供完整事实、缺日期、冲突版本、恶意指令、部分限流、空资料。所有材料明确为合成 fixture，不访问 URL，不代表现实产品发布情况。

格式只在 `expected_final.reportContract` 声明一次，执行器据此向模型公开必需章节、事实表列、缺失值表示和排序。代码评分验证：

1. `摘要 / 核验事实 / 证据与引用 / 覆盖与缺口` 章节存在、顺序正确、正文非空，代码围栏里的伪标题不算章节。
2. 事件 ID、产品、版本、时间、来源逐行对应冻结资料，无重复或虚构行；来源为实际可解析的 HTTP(S) Markdown 引用。
3. 本次 run 的 Markdown 文件实际存在，文件内容与最终答复一致，保存路径和字节哈希。

规则不对任意自由叙述做语义真实性保证。正文是否充分支持结论、诚实表达未知、清晰可用，仍需要 `eval:judge` 与实际真人的 `eval:human` 评分；没有相应评分时不能宣称完整质量验收通过。

## 命令与审核

```powershell
npm run eval:coverage
npm run eval:scenarios
npm run eval:scenarios:model -- --case activation-direct
npm run eval:scenarios:model
npm run eval:cases -- --dataset evals/scenario-coverage/dataset.json --lint
npm run eval:review -- --dataset evals/scenario-coverage/dataset.json --case report-complete
```

`eval:scenarios` 默认只执行 7 个脚本宿主题。`:model` 读取本机任务模型配置并产生实际用量，默认执行 18 个模型题。发布检查使用 `--require-approved`；未审核的案例只会产生 needs_review。结果另存 `artifacts/scenario-eval[-model]/`，批次报告按四类场景和正负例分别统计实际执行结果。

`2026-10-27.1` 的 21 题原始字节保存在 `evals/history/scenario-coverage/2026-10-27.1/`。`.2` 只新增四个模型核心逻辑题，原 21 题字节保持一致。创作脚本位于 worker 无权读取的 `scripts/` 顶层；原始标签和判断标准不投放给被测 Agent。

首个真实报告 smoke 在 2048 输出 Token 时发生 provider truncated_response，记录保留为 fail。`.3` 将六个报告题的单次输出额度改为 4096，分别提升 Case 修订；事实、格式和判定标准保持原样，`.2` 全量字节已快照。新额度只用于新执行，不重写旧失败或按新条件重评它。
