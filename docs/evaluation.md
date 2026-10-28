# 运行评测与审核案例

2026-10-27：新增四类场景题集，当前总计 57 个注册用例；其中新增 25 题覆盖工具触发正负例、模型自主工具序列/参数、完整报告与运行时容错。统一覆盖索引、运行入口、工程测试边界见 [四类场景覆盖](scenario-coverage.md)。下文保留原始 12＋20 题集的说明。

同日新增 [负分制与稳定性统计](penalty-scoring.md)：每次运行附带 0–100 分、扣分依据和 80 分阈值；批次按全部 Trial 计算用例分，并分别报告 pass@k、pass^k、Agent 类型容忍度。使用 `--score-gate` 选择数值门禁，`--require-approved` 继续保留人工审核要求。

2026-10-25：已实现六要素 Case 校验、实际执行、Trace 证据包、确定性评分、分层报告、归档重评分和失败候选入库。当前有 **12 个契约候选 Case、20 个真实模型诊断候选 Case**，全部需要人工核验标签。模型集按时间与实体、证据综合、错误处理、安全边界分为四类，各 5 题；题目、候选标准及边界见 [模型集说明](../evals/model-diagnostic/README.md)。工程检查通过不会自动成为 Golden 通过。

## 运行入口

```powershell
npm run eval:cases:lint
npm run test:evaluation
npm run eval:cases
npm run eval:cases -- --case batch-denial --repeat 2
```

默认评测不会调用外部模型或真实来源。它通过现有 `runAgent`、`ToolExecutor`、API MCP 适配器、`PiSessionMemory` 和 `summarizeDiscovery` 运行固定输入，验证协议与状态语义。主任务决策使用脚本；Memory 的模型响应与用量为明确标记的 fixture。

```powershell
npm run eval:model
npm run eval:model -- --repeat 3 --out artifacts/agent-eval-model
```

真实模型入口显式读取当前 `.env` 的模型配置，沿用 Pi `runPiSession` 会话、主任务预算与默认开启的 Memory；工具响应仍为固定 fixture，不请求真实 GitHub。模型独立选择工具和生成结构化答复，不收到脚本答案轨迹或评分标签。单次运行限制为最多 8 轮、30000 累计 Token 请求门禁、2048 单请求输出额度、60 秒模型时限、180 秒任务时限；门禁不是绝不超支的计费硬上限。

短任务可能不触发 Memory，不能据此宣称维护功能实测通过；维护恢复、非法提交和取消由另行标记的组件 Case 验证。该入口使用同一 SDK 会话适配器在受限评测进程内运行，生产 Node IPC 传输仍由独立工程测试覆盖。

规则评分验证结构化字段、执行身份、指南前置条件、调用次数和状态。自然语言的可读性、事实支持与未知表达可通过新增 `eval:judge` 与 `eval:human` 分别进行独立模型和逐次运行人工评分，再用 `eval:score` 生成三类评分综合报告；用法及边界见 [三类评分器](quality-grading.md)。LLM Judge 已实现，尚未完成外部真实模型上的语义准确率校准。

## 输出格式必须提前声明

格式只在 `expected_final.outputContract` 声明一次，执行器用同一字段生成实际给模型的指令和格式评分。它是可见的交付要求，不是隐藏答案；最终 `input.json` 会保存完整指令。

本轮修订、历史判分订正和实跑结果见 [输出契约验收](evaluation-output-contract-2026-10-25.md)。

| outputContract | 允许的最终答复 |
|---|---|
| json_object_only | 仅一个 JSON 对象及外层空白；不允许代码围栏或额外说明 |
| single_json_block | 纯 JSON 或唯一 JSON 代码块；代码块外不允许说明 |
| json_artifact_with_prose | 纯 JSON，或唯一 JSON 代码块加说明；多个候选块仍不合法 |

20题首批发布时，原三个模型 Case 保留 revision 2 和原始字节，新增十七题为 revision 1，题单版本为 2026-10-25.4；后续审核会增加修订，当前版本以 dataset.json 为准。全部明确采用 json_object_only。扩题前的题单和三个 Case 已快照到 history/model-diagnostic/2026-10-25.3。新执行会看到“禁止 Markdown 代码围栏、解释、标题以及任何前后缀文字”。事实提取与格式合规仍分开评分，不从多个候选块中挑一个正确答案。

旧 revision 1 没有显式声明这项格式要求。其格式检查重评为 unknown，记录 `oracle.output_contract_missing`，不能据此认定模型失败或把旧执行按 revision 2 的更严格要求评分。原 Trace、原 Result、旧 Case 字节均保留；曾由这个争议生成的失败候选已撤回为 retired。失败入库会用当前评分器复核，活动合成案例不得引用已撤回父例。

新题单若配置 `facts.finalJsonValid` 检查却没有声明 outputContract，lint 会拒绝执行。历史 Case 保持可读，供归档审计和更正重评分。

## 怎样读结果

默认目录为 `artifacts/agent-eval/<batchId>/`。每次运行创建新批次和独立状态目录，不覆盖历史；`latest.json` 仅是最近批次的指针。真实模型可用单独的 `--out` 保存。

```text
<batchId>/
  report.json / report.md             # 分层、任务族、逐 Case 稳定性与证据链接
  private/
    dataset.snapshot.json             # 控制器私有的题单
    cases/<caseId>.source             # 原始 Case 字节快照，保留标准答案和审核状态
    raw/<caseId-attempt>/             # 真实 SDK 会话原始审计，不放入共享证据文件集
    oracle-sentinel.txt               # 实际文件隔离探针，非用户凭据
  <caseId-attempt>/
    input.json                        # 仅执行输入；不含期望、标签或模型凭据
    traces/<runId>.jsonl               # 实际执行的 Trace v2
    fixture-access.jsonl              # 受控后端实际派发，不靠模型自报
    observed.json / projection.json   # 原始观测与可信控制器提取的事实
    boundary.json                     # 文件、子进程权限探针与脱敏扫描
    manifest.json                     # Case/输入/源码/依赖/评分器与证据哈希
    result.<graderVersion>.json        # 逐检查结果、证据路径、失败分类
```

归档包含 Case 原始字节、Git commit、工作源码摘要、锁文件与 SDK 版本、模型安全标识、评分器内容指纹。真实模型原始 SDK 转录移入控制器私有区域，保留逻辑路径、实际归档位置与字节哈希；不把内部思考复制到公开投影或最终报告。

`executionGate` 表示这批运行的必过检查是否都已满足，`releaseGate` 还要求每个 Case 已有人工审核记录。默认命令按 executionGate 返回退出码，方便开发回归；发布命令必须显式使用：

```powershell
npm run eval:cases -- --require-approved
```

当前候选没有人工批准，该命令应非零退出。报告中的 `needs_review` 不计正式通过；已证实的错误会判 fail，不能因为标签待审而被隐藏。无效设施样本保留数量，不从计划分母消失。被测进程已开始后发生崩溃或损坏 Trace，应归被测失败。

费用未核实则为 null。真实用量与 fixture 用量分别统计；缺失用量不写成零。真实模型质量准确率仍为 null，避免把一个待审核故障题或脚本通过率外推为产品准确率。

## 当前覆盖

| Case | 数据来源 | 自动验证的核心行为 |
|---|---|---|
| github-rate-limit | 开发验收失败的最小化候选 | 403/remaining=0 分类为限流，单次请求，先读指南 |
| github-auth | 手工标准候选 | 401 保留认证失败 |
| batch-read | 开发验收失败的最小化候选 | 多调用完整执行、观察身份与顺序 |
| batch-denial | 手工标准候选 | 同参数仍逐项审批，拒绝项不执行 |
| batch-cancel | 手工标准候选 | 批内取消停止后续派发、没有伪造观察 |
| tool-timeout | 开发验收失败的最小化候选 | 工具时限、失败持久化、不自动重试 |
| memory-recovery | 开发验收失败的最小化候选 | 两次请求均计量、合法检查点、输出上限和积压游标 |
| memory-exhausted | 手工标准候选 | 第二次截断停止，旧检查点不变 |
| memory-cancel | 手工标准候选 | 维护可取消、返回用量仍记录 |
| memory-invalid | 合成变体 | 非法正文不提交、不错误恢复 |
| batch-budget | 合成变体 | 整批预算不足时首项前停止 |
| discovery-empty | 手工标准候选 | 搜索召回、种子正文覆盖、结构化信号分别计量 |
| model-github-rate-limit | 真实模型诊断候选 | 模型自行选工具，最终结构化回答保留限流与未知 |
| model-untrusted-document | 真实模型诊断候选 | 从含恶意指令的合成文档提取事实，不采用伪造版本 |
| model-kimi-window | 真实模型诊断候选 | 对冻结十条真实发布记录筛选四条窗口内 CLI 版本，核验时间和引用 |

上述表格保留最初 15 个案例的说明；本轮另新增 17 个模型题，包括时间边界、缺失日期、同名实体、混合时区、事件去重、冲突、缺失事实、引用对应、覆盖缺口、401/403/503、空页及四种恶意材料。完整 20 题清单见模型集 README，catalog.json 提供四类阅读索引，实际注册以 dataset.json 为准。

失败材料明确标记为 development_acceptance；没有生产失败集。合成变体继承父 Case 的任务族和 split。Dataset loader 校验内容哈希、身份、引用、标签覆盖、来源、父子关系、循环和任务族跨 split 泄漏。

Kimi 的供人工核验材料见 `evals/materials/kimi-release-reference.json`，包含原始响应字节哈希和未改写的 tag、发布时间、URL 字段投影。它不是由模型报告反推的答案；最终四条标签仍待人工核验。

## 人工怎样审核第一层

审核登记现可使用普通CLI，无需AI或手工同步三份JSON：

```powershell
npm run eval:review
npm run eval:review -- --case model-kimi-window-boundary
npm run eval:review -- --case model-kimi-window-boundary --by Swing --approve --dry-run
npm run eval:review -- --case model-kimi-window-boundary --by Swing --approve
```

先用查看命令核对材料与六部分；完成真人审核后再执行最后一条。工具自动记录实际时间，更新Case状态/修订、题单版本/哈希和catalog，保存旧字节快照并校验；dry-run不写文件。审核不调用模型，旧归档状态不变。详细故障恢复及身份边界见 evals/README.md。

从 `evals/regression/cases/` 打开一个 Case，核对 `oracle.references` 指向的原始契约和证据，再检查六要素中的每条断言。先核验标准，再看待测版本的结果。建议先审限流、批次拒绝、Memory 二次截断三个风险较高的案例。

审核通过后，记录真实审核者、时间和 `kind=human`，把 status 改为 approved；增加 revision，并发布新的 dataset.version 与文件 SHA-256。格式标准需先选定 outputContract，再运行模型；不能在看到输出后追加未披露的禁止项。不能由程序、被测模型或本次 AI 编写过程自行填写真人审核。脚本只能校验记录结构，不能认证一个字符串背后的真实身份；正式协作应通过有人负责的代码审阅执行此约束。

```json
"review": { "by": "实际审核者", "kind": "human", "at": "实际审核时间，ISO 8601" }
```

每个评分检查有稳定 ID、关联需求、执行方法、期望值、是否必过以及失败代码。判定语义需要变化时发布新 Case 修订，不为了通过静默改旧答案。已批准案例仍可含明确标记的模拟故障，不能声称材料来自真实线上。

## 重评分、失败入库与版本比较

```powershell
npm run eval:evidence -- --report <batch目录/report.json> --case github-rate-limit
npm run eval:evidence -- --report <失败批次/report.json> --case <失败CaseId> --collect
npm run eval:cases -- --compare <上次批次/report.json>
```

重评分先验证报告中固定的 manifest 哈希、证据文件、受限原始转录和冻结 Case；随后从原始观测重新生成投影，写入新的 regrade 文件，不改原 Result，不执行模型。评分器版本包含内容指纹；标签或评分器版本不同时拒绝直接比较。比较会列出退化、改善和缺失的 attempt，不挑选最好的一次。

失败入库只接收已确认 fail、具有实际 runId 的记录；invalid 设施错误、needs_review 和通过样本不能冒充生产失败。候选写入 `evals/candidates/`，保留原 runId、父 Case、失败代码和原标准，等待人工确认，不自动注册到正式题单。

合成扩展应新增 Case，记录 synthetic、parentCaseIds、相同 familyId/split、具体变换和新的标准。当前实现了关系校验与两类示范，没有无审核的批量模型扩题器。

## 隔离与 Holdout

工作进程启用 Node Permission Model：仅可读取代码依赖、明确宿主 Skill 和自己的执行目录，仅可写自己的目录，子进程权限关闭；凭据不通过环境继承，真实模型所需的一份凭据经私有 stdin 传入，不保存到 input.json。每次执行实际尝试读取控制器私有探针和创建子进程，两者必须被拒绝。

这验证 Node 文件/进程边界，**不声称提供操作系统级网络沙箱**。固定工具使用注入的 fetcher 与受控工具实现，不切换生产来源。SDK 使用显式 ResourceLoader，完全避免隐式扫描用户目录；不会重设 HOME/USERPROFILE 或扩大工作进程的答案读取权限。

Holdout 案例必须在开发工作区外，运行产物也必须由保管者存入显式指定的外部私有目录。入口支持 `--split holdout --dataset <私有题单> --out <私有产物目录>`，控制台只返回汇总。未提供真正独立的材料和保管者，因此本次没有创建或执行 Holdout。案例已公开或用于调参后，必须退出未见集合。

## 已发现并修复的问题

- `abortable` 在 Promise 创建期间同步取消时，原先会在抛出取消前漏接该 Promise 的拒绝，可能在已记录 cancelled 后崩溃；现在仍保持取消语义，同时消费已创建 Promise 的拒绝。
- SDK DefaultResourceLoader 即使配置 noSkills，也会先扫描全局目录；改用满足 SDK ResourceLoader 接口的显式宿主资源加载器。宿主加载的用户 Skill 与工具仍沿原 ContextPipeline/SessionTools 提供。
- 执行记录目录枚举顺序不代表调用顺序；评分投影从 Trace 序号重建状态和身份顺序，不把文件名排序当行为错误。

原生产请求、权限、来源路由和 Memory 约束仍分别验证。标签批准、独立 Holdout、丰富业务事实 Golden、Judge 语义校准与真实三站完整报告评测仍需后续完成。三类评分入口不会自行完成这些人工工作。
