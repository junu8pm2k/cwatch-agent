# Cwatch 提交历史回溯（根据 Session 重建）

整理日期：2026-10-28。日期和时间按 Asia/Shanghai（北京时间）展示。

## 结论与证据边界

从工作区对应会话中确认了 **21 条提交记录：旧仓库 20 条，重新初始化的新仓库 1 条**。这是会话中可以确认的数量，不保证包含所有在会话外执行的提交。

- 旧仓库：分支 `main`，最后可确认的完整 HEAD 为 `4fee06915386137bc8b1608f9213602b80f0dd3a`。
- 新仓库：2026-10-27 重新初始化为 `codex/initial`，首个提交为 `59311d4`。
- 两者属于两段仓库历史；没有证据表明 `59311d4` 是 `4fee069` 的子提交。新仓库当时的 `git rev-list --count HEAD` 输出为 `1`。
- 当前检查确认项目根目录没有 `.git`。本文恢复的是提交信息和开发时间线，没有恢复 Git 对象、历史文件快照或可 checkout 的提交。
- 下表日期取自对应 Session 的会话日期；旧提交的精确 commit 时间、作者、完整 SHA 和父提交关系无法逐项核验。
- 下文测试数量是历史会话当时报告的工程回归结果，本次整理没有重新运行项目测试，也不将这些数字视为生产准确率。

原始提交标题、成功命令事件 ID 和会话中的交付说明保存在 [证据索引](commit-history-recovered-evidence.json)。

## 一、旧仓库的 20 条实际提交

以下按会话记录的先后排列，不视为已经验证的 Git 父子链。项目当时依次使用过 `竞品情报agent-project`、`cint-agent` 等目录名称；通过同一聊天中的实际命令工作目录和后续改名会话关联到当前 Cwatch 项目。

| 1 | 2026-10-17 | `c2ab225` | 初始化竞品情报 CLI、权限审批、计划、证据及草稿闭环 |
| 2 | 2026-10-17 | `e854455` | 统一 API_KEY / BASE_URL 等模型环境变量 |
| 3 | 2026-10-17 | `0929ec4` | 实现受控联网优先路由及本地搜索、抓取保底 |
| 4 | 2026-10-17 | `fc495c5` | 接入 StepSearch MCP |
| 5 | 2026-10-17 | `d9932a8` | 搜索 MCP 改为通用 URL / Token 配置 |
| 6 | 2026-10-17 | `c9b47ea` | 移除本地搜索、抓取保底 |
| 7 | 2026-10-17 | `34afac1` | 配置式 REST 搜索、抓取 API 包装为 MCP |
| 8 | 2026-10-17 | `3f38a43` | 迁移调查执行到 Pi AgentSession |
| 9 | 2026-10-17 | `5515781` | 增加 explore / ask / allow-all 三种权限模式 |
| 10 | 2026-10-17 | `15d8ec9` | 对齐工具 Hook 与 PreToolUse 检查结构 |
| 11 | 2026-10-17 | `8b978e9` | Pi 会话迁入受监督子进程，宿主负责执行与故障收尾 |
| 12 | 2026-10-17 | `d10bad2` | 增加用户 MCP 管理及本地 / GitHub Skill 安装 |
| 13 | 2026-10-18 | `39fe8b7` | 统一 *.test.ts 命名及 MCP 传输术语 |
| 14 | 2026-10-18 | `cdf3c7b` | 增加 Token、字符、工具次数及超时预算 |
| 15 | 2026-10-18 | `86a2804` | 梳理后端职责与实现缺口 |
| 16 | 2026-10-18 | `ac55584` | 补齐浏览器、来源适配、每轮上下文与事件契约 |
| 17 | 2026-10-18 | `78bfbdd` | 平台 API 统一经过 MCP，移除 CLI 采集来源 |
| 18 | 2026-10-18 | `1e2ec76` | 重构为 Craft 风格 npm workspaces |
| 19 | 2026-10-18 | `1874656` | API 来源采用 config.json + guide.md 和通用 API 工具 |
| 20 | 2026-10-18 | `4fee069` | 增加本地 Web 工作台、RunService、审批、进度及报告 |

这些条目均能对应到「查看参考仓库」聊天中的 `git commit` 成功命令和交付消息。聊天 ID：`01a1481c-0b13-7332-9f63-b7f60b6a869e`。

### 原始提交标题

```text
c2ab225 feat: initialize competitor intelligence agent
e854455 fix: support API_KEY and BASE_URL model configuration
0929ec4 feat: add audited native-first web search and fetch
fc495c5 feat: add StepSearch MCP to audited web fallback chain
d9932a8 feat: make search MCP provider-independent with URL and token
c9b47ea refactor: remove local web search and fetch fallbacks
34afac1 feat: expose configured REST search and fetch APIs through MCP
3f38a43 refactor: run investigations through Pi AgentSession
5515781 feat: add explore ask and allow-all permission modes
15d8ec9 refactor: align tool hooks and pre-tool checks with Craft structure
8b978e9 Run Pi AgentSession in a supervised subprocess
d10bad2 Add user-managed MCP servers and skill installation
39fe8b7 Standardize test case filenames and MCP transport terminology
cdf3c7b Enforce configurable run limits for tokens tools lengths and timeouts
86a2804 Document backend responsibilities and implementation gaps
ac55584 Complete controlled source adapters and backend contracts
78bfbdd Unify platform API tools behind MCP and remove CLI sources
1e2ec76 Organize backend into Craft-style npm workspaces
1874656 Adopt Craft-style source guides and generic API MCP tools
4fee069 Add local web workbench with audited run management
```

## 二、旧 HEAD 之后的开发里程碑

以下是会话可以确认的改动，**没有找到各自独立的成功提交记录，因此不编造 commit hash 或提交标题**。10 月 20 日至 27 日多次 Session 的启动元数据仍记录旧 HEAD `4fee069`；启动元数据只作为旁证，不能证明会话运行期间始终没有提交。

| 日期 | 已完成的改动 | 会话中的验证或限制 |
|---|---|---|
| 10-18 | 项目统一改名 Cwatch，更新包引用、界面、文档与配置目录 | 317 项回归、7 项浏览器测试 |
| 10-20 | 完整 Transcript 归档；活动上下文与历史分离；工具结果裁剪、Microcompact、正式 Compact | 分阶段回归从 325 增至 344 |
| 10-20 | 压缩后重注入宿主状态；计划、工具结果和原始转录分页回查；增量 Session Memory | 后续回归增至 362；尚无自动崩溃续跑 |
| 10-20 | 长上下文拒绝后的有界恢复、熔断；稳定提示前缀与缓存用量统计 | 当日最终回归 380 |
| 10-21 至 10-22 | Web 搜索、抓取改为本地 API 工具；接入 Pi 七项工具；只为真实 MCP 工具保留 mcp__ 前缀；清理重复和 fixture 工具 | 统一注册、权限、执行和审计 |
| 10-22 | 从固定调查流程扩展为“通用 Agent + Skill”，调查流程保留为可选模板 | 408 项回归、8 项 Web、6 项浏览器来源测试 |
| 10-22 | 规范四份项目 Skill 的名称、描述、流程和资源加载 | 418 项回归 |
| 10-24 | Web 界面改为简洁浅色版；开展 ZCode、Kimi Code、MiniMax Code 真实验收 | 初轮三项均未产出报告，暴露多工具调用、Memory、抓取和限流问题 |
| 10-24 | 修复 Memory 截断恢复、抓取超时与正文解析、GitHub 限流分类，补充定向搜索和起始 URL 策略 | 回归逐步增至 466；完整业务验收仍有缺口 |
| 10-24 至 10-25 | 设计并落地六要素 Case、隔离执行、Trace 归档、逐项评分、分层报告、失败入库、重评分与版本比较 | 486 项回归；12 契约 Case 重复两轮共 24 次执行检查 |
| 10-25 | 统一题面与评分 outputContract，修正旧 Kimi 格式失败的误判 | 492 项回归；新版三个模型 Case 执行检查满足 |
| 10-25 | 模型诊断集扩展到 20 题，保留 12 道契约题；增加人工审核 CLI、修订与历史快照 | 495 项回归；20 题单轮基线满足执行检查，当时仍需人工审核 |
| 10-26 | 逐题人工审核并修订标准 | 该会话明确登记到 11/20，不能据此声称全部题目已批准 |
| 10-27 | 接入代码规则、独立 LLM Judge、人工评分三类评分器，并绑定运行证据 | 519 项回归；Judge 当时使用本地模拟服务验证 |
| 10-27 | 新增 25 道场景题，覆盖触发、核心逻辑、产物质量和异常容错，题单从 32 增至 57 | 528 项回归、62 项评测专项；新增标准仍待人工审核 |
| 10-27 | 百分制扣分、硬失败归零、耗时扣分、重复 Trial 聚合、pass@k / pass^k 与容忍度展示 | 541 项回归 |
| 10-27 | 结构化 Trace：运行、模型、工具及后端步骤关联，输入输出、错误、用量与完整性校验，导出和访问入口 | 最终工程回归 551/551 |

上述里程碑按会话交付记录概括；没有单独提交记录不表示这些工作没有实现。它们是后来新仓库首次提交的主要开发背景。

## 三、10 月 27 日的新仓库首次提交

| 项目 | 确认内容 |
|---|---|
| 短 SHA | `59311d4` |
| 原始标题 | `初始化项目：完善 Agent 评测、负分制与结构化 Trace` |
| 分支 | `codex/initial` |
| 提交后检查时间 | 2026-10-27 19:03:47 左右，取自工具返回时间，不是精确 commit 时间 |
| 提交数 | `git rev-list --count HEAD` 输出 `1` |
| 工作区状态 | 当时 `git status --short` 无输出 |
| 回归 | 551/551 |
| 提交前清理 | 20,039 个临时文件，约 144.18 MiB |
| 本机配置 | 会话记录已核查 `.env`、运行状态和密钥未提交 |

对应聊天为「检查项目 Trace 记录」，ID：`01a17c56-3936-7280-8b20-81c5cb1adf19`。

该会话的关键时间点：

1. **18:46 左右**：用户要求继续完成 Trace，完成后重新初始化 Git 并创建第一个提交。
2. **18:47:28**：实际 `git status` / `git log` 返回 `fatal: not a git repository`，证明此时旧 Git 元数据已经不可用；日志不能说明是谁或通过什么方式删除了它。
3. **19:02:05**：`git init -b codex/initial` 成功，返回初始化空仓库信息。
4. **19:03:47**：提交成功，随后输出 `59311d4`、提交数 `1` 和分支名。
5. **10-28 本次检查**：项目目录再次没有 `.git`；目前没有足够证据确定这一次缺失的原因。

## 四、来源与可恢复范围

| 来源 | 定位 |
|---|---|
| 旧仓库提交命令与交付记录 | 「查看参考仓库」聊天，ID 见第一部分；已将与提交有关的字段摘录到证据索引 |
| 改名 | 「将项目旧名称改为 Cwatch」聊天，ID `01a14e68-eb43-7d00-82ab-b6744f1f7abe` |
| 上下文与 Memory 改造 | `C:/Users/Swing/.codex/sessions/2026/10/20/rollout-2026-10-20T16-01-17-01a15853-b342-7713-8edd-8db57e4db687_01a15854-3c3d-7902-a34e-9942f091c81f.jsonl` |
| 工具与通用 Agent 改造 | `C:/Users/Swing/.codex/sessions/2026/10/21/rollout-2026-10-21T20-38-27-01a15e78-572c-7ac1-8891-4bebb4e88334.jsonl` |
| 真实验收与评测主流程 | `C:/Users/Swing/.codex/sessions/2026/10/24/rollout-2026-10-24T20-15-53-01a16dd6-c32e-79c1-aa72-3e4e98db457a.jsonl` |
| 新仓库初始化与提交 | `C:/Users/Swing/.codex/sessions/2026/10/27/rollout-2026-10-27T15-49-53-01a17c56-3936-7280-8b20-81c5cb1adf19.jsonl`；初始化返回在第 1557 行，提交后检查在第 1597 行 |
| 项目保留的清理与验证记录 | [cleanup-summary.json](../artifacts/cleanup-summary.json)、[结构化 Trace 文档](structured-trace.md) |

Session 能恢复提交标题、短 SHA、改动概述和部分验证信息。仅凭这些内容，无法还原原始 commit/tree/blob 对象、每个版本的完整快照和分支关系。本次仅新增本文与证据索引，没有重新初始化 Git 或生成新的提交。
