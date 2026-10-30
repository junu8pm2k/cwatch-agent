# 真实竞品调查验收

2026-10-29：项目已移除 GitHub API 接入、来源配置和联网探测入口，并拦截内建网络通道的 GitHub API 地址。旧离线 fixture 与历史验收记录仅用于审计，不代表当前可用能力。详见 [停用说明](github-api-disabled.md)。

首轮目标：ZCode、Kimi Code、MiniMax Code。配置冻结于 2026-10-24，采用 Asia/Shanghai 时间。

## 本轮范围

验证指定产品能否通过当前 Cwatch 调查 Runtime 生成可核验的单次调查草稿。时间窗为 `[2026-09-24 00:00, 2026-10-25 00:00)`，依据发布时间。执行时尚未发生的事件不得作为事实；当前产品能力与窗口内更新分开记录，缺少发布时间不以采集时间代替。

- 产品目录：`examples/competitor-acceptance/targets.json`。
- 三组 `*.task.json` 和 `*.sources.json` 分别限定实体、官方域名与官方仓库。
- Kimi Code 使用 `MoonshotAI/kimi-code`；旧 `kimi-cli` 的历史状态不能直接归给现版本。
- GitHub CLI/源码发布不等于桌面产品同步发布，必须标注具体产品形态。
- 官网界面示例和任务演示的相对时间不是发布日期。
- 使用真实模型、当前配置的搜索 MCP 和公共 GitHub API；保留失败、空结果和未确认项。
- 外部预查仅用于确定身份和来源，不作为 Cwatch 自行采集成功的证据。

## 执行与证据

每个目标独立输出目录，避免事实和版本跨实体混用。首轮每个目标执行一次，记录配置、模型、权限、runId、运行终态、轮数、工具调用、提供方用量、Trace 校验、快照和报告位置。任务级 `complete` 不自动等于业务验收通过。

```powershell
node --use-env-proxy --experimental-transform-types apps/cli/src/index.ts run --mode live --permission explore --task examples/competitor-acceptance/zcode.task.json --sources examples/competitor-acceptance/zcode.sources.json --out artifacts/competitor-live/20261024/zcode --timeout 240000 --model-timeout 60000 --tool-timeout 45000 --max-tokens 80000 --max-output-tokens 2048
```

另外两个目标将命令中的 `zcode` 分别替换为 `kimi-code` 和 `minimax-code`。首轮不修改生产逻辑掩盖问题，也不自动重放可能有副作用的工具。单次输入用量无法精确预估，累计 Token 门禁不等于硬计费上限。

## 人工核验方法

由独立官方资料建立有边界的参考事件清单，保存 URL、标题、产品形态、发布时间和核对日期，再与 Agent 输出逐项比对。未形成参考清单时，遗漏率记为未评估；搜索未返回不算“无更新”。

| 维度 | 满分条件 | 最高分 |
|---|---|---:|
| 来源与覆盖 | 参考清单中全部必要官方入口已核验，失败来源明确披露；召回仅相对参考清单计算 | 20 |
| 实体与时间 | 产品、仓库、版本和时间归因正确；未知日期不进入时间窗内事实 | 20 |
| 证据与引用 | 每条关键事实可回到支持该表述的原文、URL 与快照；事实与推断明确区分 | 20 |
| 去重与变化 | 同一事件不因转载重复计数；基线、当前状态和本期变化有依据；无历史时不虚构差异 | 20 |
| 报告可用性 | 结论、影响、反向证据和缺口清晰；无依据的解释标为待核对 | 20 |

每项人工评为 0–4 级后乘 5：0=未交付或严重错误，1=大部分不满足，2=部分满足，3=基本满足且有明确缺口，4=上述条件均满足。每项必须写证据和扣分原因，不按工具调用次数打分。

建议通过门槛为总分至少 80，且没有硬性失败。此门槛是本项目首轮验收约定，不是行业标准。没有报告、没有足够参考材料或来源整体不可达时标为“未具备评分条件”，不能填零后当成模型准确率，也不能按满分处理。

硬性失败：虚构事实或引用；错误实体/产品形态归因；把采集时间当发布时间；把来源失败或空结果写成无动态；fixture 冒充真实来源；越权修改、发送或发布；未决写操作被宣称已回滚。

## 结果表

| 目标 | runId | Runtime 终态 | 有效报告 | 人工评分 | 业务验收 | 证据 |
|---|---|---|---|---|---|---|
| ZCode | `2e88d6ac-8e33-4756-bb98-b2455cbadd21` | failed | 无 | 无报告，未评分 | 未通过 | `artifacts/competitor-live/20261024/zcode/` |
| Kimi Code | `e2f0e95e-a216-463b-985c-b4f3827e6bb9` | failed | 无 | 无报告，未评分 | 未通过 | `artifacts/competitor-live/20261024/kimi-code/` |
| MiniMax Code | `b679b573-d2b5-46d4-9358-bc455510d431` | failed | 无 | 无报告，未评分 | 未通过 | `artifacts/competitor-live/20261024/minimax-code/` |

首轮已于 2026-10-24 执行完毕。结果与修复优先级见 [首轮验收报告](competitor-live-acceptance-report-2026-10-24.md)。

工程回归、来源连通性、模型执行和人工质量评分分别报告。首轮三个真实任务只是样本，不代表完整黄金集或线上成功率。重复运行应使用独立运行目录；增量版本测试另外显式复用同一目标的事实目录。
