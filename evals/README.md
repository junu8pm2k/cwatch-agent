# 可执行评测集合

运行方法与证据说明见 [评测使用指南](../docs/evaluation.md)。本目录的 v1 Case 是执行器实际读取的格式；`examples/evaluation/` 保留的是早期 v1-draft 说明样例，不混入成绩。

| 目录 | 内容 |
|---|---|
| regression/ | 12 个固定契约候选，包含手工标准候选、开发验收失败候选及合成变体 |
| model-diagnostic/ | 20 个真实模型＋固定工具响应候选；时间与实体、证据综合、错误处理、安全边界四类各 5 题，详见该目录 README |
| materials/ | 发布记录字段投影、上游原始字节哈希，以及新增模型题的合成材料、候选期望和推导理由 |
| candidates/ | 从已确认失败归档生成的待审核候选，不自动注册到题单 |
| history/ | 原始题单与已撤回候选的字节快照，仅供审计 |
| scenario-coverage/ | 25 个四类场景增补题：18 个模型模式、7 个脚本宿主契约；新增标准待人工审核 |

`coverage.json` 统一索引三个题集的 57 个活动 Case。运行 `npm run eval:coverage` 生成正负例设计清单；工程回归测试单列，不计入该数量。详细范围与运行方式见 [四类场景覆盖](../docs/scenario-coverage.md)。

初始发布的案例全部 status=needs_review；后续审核状态以各 Case 的 status/oracle.review 为准。争议的旧格式失败候选为 retired。没有生产流量，也没有在开发仓库内建立 Holdout。

## 一条命令登记人工审核

先阅读题目、材料、标准和评分，再由实际审核者执行：

```powershell
npm run eval:review
npm run eval:review -- --case model-kimi-window-boundary
npm run eval:review -- --case model-kimi-window-boundary --by Swing --approve
```

`--by` 填实际审核者；最后一条命令代表你已经核验该题并确认通过。增加 `--dry-run` 可以预览，完全不写文件。工具自动记录实际 UTC 时间、提升 Case 修订和题单版本、计算哈希、同步 catalog 并校验题单；旧题单、全部 Case 和 catalog 的字节快照写入 `evals/history/<题集>/<旧版本>/`。重复 `--case` 可一次批准多道已经核验的题。基础契约题增加 `--dataset evals/regression/dataset.json`。

这是本机声明式审核登记，不认证署名背后的身份；不会自行判定标准正确，也不会请求模型。历史运行报告仍保存当时状态，审核后重新运行对应 Case 才生成新结果。写入错误会回滚已修改文件；多文件修改不是断电/强杀安全事务。若强杀后遗留 `.review.lock`，先确认审核进程已结束，再核对历史快照与当前题单后恢复或清理单个锁文件。

新增案例可复制 regression/cases/github-auth.json，按以下顺序修改：

1. 更改 id、familyId、title；保留 status=needs_review、oracle.review=null。
2. 写 input：任务、固定工具数据、执行方式与预算，标明模拟还是已归档材料。
3. 写 expected_final、expected_process、safety_boundaries 的每条需求，给它们唯一 ID。若检查 JSON 格式，在 expected_final.outputContract 显式选定 json_object_only、single_json_block 或 json_artifact_with_prose；执行器会把同一要求写进实际任务。
4. 在 scoring.checks 逐项关联需求、指定观察字段、期望与失败分类，不能留未评分需求。
5. 核对 origin。失败案例保留原 runId；合成变体保留父 Case 并继承任务族和 split，不可依赖已撤回父例。
6. 人工复核 oracle.references 与标准。批准时记录实际审核者与时间，提升 revision。
7. 显式更新 dataset.version 与 cases 清单中的 revision、file、原始字节 SHA-256，再执行 lint。

文件请保存为 UTF-8。Windows 可用以下命令得到小写的字节哈希；哈希不等于审核批准：

```powershell
(Get-FileHash -LiteralPath evals/regression/cases/github-auth.json -Algorithm SHA256).Hash.ToLowerInvariant()
npm run eval:cases:lint
npm run eval:cases -- --case github-auth
```

目前支持 equals、non_empty_string、trace_valid、file_boundary、no_canary_leak 五种检查方法。non_empty_string 仅检查指定字段是去除首尾空白后仍非空的字符串，不判定文字含义。Runtime 终态和 Trace 完整性额外作为全局必过检查。新增需要语义理解的自然语言标准时，应先增加可复核的评分方式；不能给无法判定的标准默认满分。
