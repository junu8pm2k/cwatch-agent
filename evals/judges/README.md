# 结果、过程、证据三个共享 Judge

评分角度与 case 场景是两条独立轴。四类场景为触发、核心逻辑、异常容错、产物质量；LLM Judge 的三个评分角度固定为结果、过程、证据。四类场景复用同一套三个 Judge，并且仅调用当前 case 已分配的维度。

| 评分角度 | 固定 Judge | 本地评审 Prompt |
| --- | --- | --- |
| 结果 | cwatch.judge.outcome | [outcome.md](outcome.md) |
| 过程 | cwatch.judge.trajectory | [trajectory.md](trajectory.md) |
| 证据 | cwatch.judge.evidence | [evidence.md](evidence.md) |

三个评委共用 `JUDGE_MODEL_PROVIDER` / `JUDGE_MODEL_ID`。[公共契约](common.md)约定统一结构化输出，每个评委只返回自己维度的 findings。具体评分标准来自冻结的 Case rubric，不在看到回答后追加。百分制扣分仍由原程序统一计算。

场景说明 [activation.md](activation.md)、[core_logic.md](core_logic.md)、[resilience.md](resilience.md)、[artifact_quality.md](artifact_quality.md) 只是 case 上下文，通过 packet.scenarioInstructions 传入，不各自创建 Judge。它们不能改变条目所属维度或增加评分项。安全与成本继续按原职责交给程序及适用人工审核，不额外创建这两个方向的 LLM Judge。

## 创建、复用和修改 Prompt

```powershell
npm run eval:langfuse -- --mode judges
```

程序按三个固定名称先查询，不存在才创建。重复运行复用原 ID，不运行评测，不创建全局自动触发规则。当前项目的配置快照保存在 `.runtime/langfuse-judges/catalog.json`，不含 API Key。

`npm run eval:langfuse -- --mode assets`将实际Evaluator的当前Prompt注册到`cwatch/judges`，同时向四个Dataset上传14份完整Case配置。只注册三个评分模板，不注册题目input副本。逐题Rubric在Dataset Metadata的evaluation.rubric中，执行时进入packet.rubric。修改注册模板后，给所需版本设置evaluation标签，再运行`--mode judges --apply-registered-prompts`才会更新原Evaluator；保存模板本身不会自动部署。详见[Langfuse说明](../../docs/langfuse.md)。

可以直接在 Langfuse 编辑对应角度的 Prompt，保留 `{{packet}}`、数据映射、dimension 与结构化输出约定。正常评测准备不会覆盖界面修改。平台保留同一个 ID 并产生新版本；每次实际评测绑定具体版本，避免混用。

如需以本地文件为来源，显式执行：

```powershell
npm run eval:langfuse -- --mode judges --update-prompts
```

只更新定义发生变化的原评委，不新建 ID。修改单个角度文件只影响该评委；修改 common.md 会影响三者。这个显式命令会用本地定义替换对应的界面修改。修改场景说明只改变后续新评分输入的背景，不新增评委。

## 评测时的分工

```powershell
npm run eval:langfuse -- --report <batch/report.json> --case core-001 --native
```

程序读取当前 rubric 中已分配的 outcome / trajectory / evidence 维度，准备相应 Judge。没有条目就不调用该角度；只有代码检查的 case 可以完全不调用 LLM。场景由 activation-/core-/resilience-/artifact- 前缀识别，自定义 ID 可用 `--scenario` 指定；这只决定上下文，不决定创建哪种评委。

主评审在 `agent.run` 上分别执行适用的结果、过程、证据 Judge。分配了证据条目时，宿主还准备 `eval.evidence_audit_input`，由**同一个证据 Judge、同一个版本**独立复核，不增加第四个 Judge。它是宿主生成的评审输入，不是新的 Agent 执行或工具调用，不携带先前判定。

在 Langfuse Tracing 中，对根观察项使用适用的三个维度 Judge；对证据复核输入只使用证据 Judge。binding.json 固定每个维度的评委 ID、版本和目标。程序拒绝跨维度 findings、混入其他执行、缺失必要复核或不匹配版本；随后按照原扣分制汇总。

## 纠正此前误建的四个场景评委

```powershell
npm run eval:langfuse -- --mode judges --retire-scenario-judges
```

这个一次性纠正命令将此前误建的 `cwatch.judge.activation/core_logic/resilience/artifact_quality` 改名为 `cwatch.legacy.scenario.*` 并明确标记弃用，保留原 ID 和记录，不删除历史。如果发现这些旧配置已有规则分配，会停止自动改名，避免改动用户另行建立的工作流。

原先逐条目评委及历史绑定继续兼容读取，不用新评分契约解释旧成绩。新版 Case 1 的纯执行基线也不会因此自动获得百分成绩。
