# 四类场景覆盖清单

已注册 57 个 Agent Eval 用例。下表是设计覆盖，不是执行通过率。

| 场景 | 正例 | 负例 | 真实模型模式用例 |
|---|---:|---:|---:|
| activation | 4 | 4 | 8 |
| core_logic | 5 | 12 | 9 |
| artifact_quality | 3 | 8 | 11 |
| resilience | 2 | 19 | 10 |

## cwatch-contract-regression

版本 2026-10-25.2；题单 SHA-256：2e29cc8735884e87654f4e6f7d01ea545ac97130f4c1191ceec878e893c75649

| Case | 场景 | 正负 | 模式 | 标准状态 |
|---|---|---|---|---|
| github-rate-limit | resilience | negative | deterministic | needs_review |
| github-auth | resilience | negative | deterministic | needs_review |
| batch-read | core_logic | positive | deterministic | needs_review |
| batch-denial | core_logic | negative | deterministic | needs_review |
| batch-cancel | resilience | negative | deterministic | needs_review |
| tool-timeout | resilience | negative | deterministic | needs_review |
| memory-recovery | resilience | positive | deterministic | needs_review |
| memory-exhausted | resilience | negative | deterministic | needs_review |
| memory-cancel | resilience | negative | deterministic | needs_review |
| memory-invalid | resilience | negative | deterministic | needs_review |
| batch-budget | core_logic | negative | deterministic | needs_review |
| discovery-empty | core_logic | negative | deterministic | needs_review |

## cwatch-frozen-model-diagnostic

版本 2026-10-25.21；题单 SHA-256：376bef170698f064bf168499f77dfcfbcff534921e61f5a3ef0844cad84ec672

| Case | 场景 | 正负 | 模式 | 标准状态 |
|---|---|---|---|---|
| model-github-rate-limit | resilience | negative | frozen_tools_live_model | approved |
| model-untrusted-document | resilience | negative | frozen_tools_live_model | approved |
| model-kimi-window | core_logic | positive | frozen_tools_live_model | approved |
| model-kimi-window-boundary | core_logic | negative | frozen_tools_live_model | approved |
| model-release-missing-date | core_logic | negative | frozen_tools_live_model | approved |
| model-release-entity-scope | core_logic | negative | frozen_tools_live_model | approved |
| model-release-timezone-order | core_logic | positive | frozen_tools_live_model | approved |
| model-evidence-dedup | artifact_quality | positive | frozen_tools_live_model | approved |
| model-evidence-conflict | artifact_quality | negative | frozen_tools_live_model | approved |
| model-evidence-unsupported | artifact_quality | negative | frozen_tools_live_model | approved |
| model-evidence-citation-linking | artifact_quality | positive | frozen_tools_live_model | approved |
| model-evidence-coverage-gap | artifact_quality | negative | frozen_tools_live_model | needs_review |
| model-github-auth | resilience | negative | frozen_tools_live_model | needs_review |
| model-github-forbidden | resilience | negative | frozen_tools_live_model | needs_review |
| model-github-server-error | resilience | negative | frozen_tools_live_model | needs_review |
| model-source-empty | resilience | negative | frozen_tools_live_model | needs_review |
| model-safety-system-spoof | resilience | negative | frozen_tools_live_model | needs_review |
| model-safety-write-request | resilience | negative | frozen_tools_live_model | needs_review |
| model-safety-exfiltration | resilience | negative | frozen_tools_live_model | needs_review |
| model-safety-format-hijack | resilience | negative | frozen_tools_live_model | needs_review |

## cwatch-four-scenario-coverage

版本 2026-10-27.3；题单 SHA-256：cdd883e65545394370f7d5a1e2b2b9aa286a0b354f53a9c27615855b81d16ec6

| Case | 场景 | 正负 | 模式 | 标准状态 |
|---|---|---|---|---|
| activation-direct | activation | positive | frozen_tools_live_model | needs_review |
| activation-paraphrase | activation | positive | frozen_tools_live_model | needs_review |
| activation-deliverable | activation | positive | frozen_tools_live_model | needs_review |
| activation-english | activation | positive | frozen_tools_live_model | needs_review |
| activation-definition | activation | negative | frozen_tools_live_model | needs_review |
| activation-negated | activation | negative | frozen_tools_live_model | needs_review |
| activation-quotation | activation | negative | frozen_tools_live_model | needs_review |
| activation-coding | activation | negative | frozen_tools_live_model | needs_review |
| core-ordered-arguments | core_logic | positive | deterministic | needs_review |
| core-missing-step | core_logic | negative | deterministic | needs_review |
| core-wrong-tool | core_logic | negative | deterministic | needs_review |
| core-invalid-arguments | core_logic | negative | deterministic | needs_review |
| report-complete | artifact_quality | positive | frozen_tools_live_model | needs_review |
| report-missing-date | artifact_quality | negative | frozen_tools_live_model | needs_review |
| report-conflicting-version | artifact_quality | negative | frozen_tools_live_model | needs_review |
| report-injected-content | artifact_quality | negative | frozen_tools_live_model | needs_review |
| report-partial-source | artifact_quality | negative | frozen_tools_live_model | needs_review |
| report-empty-material | artifact_quality | negative | frozen_tools_live_model | needs_review |
| resilience-partial-fallback | resilience | positive | deterministic | needs_review |
| resilience-tool-exception | resilience | negative | deterministic | needs_review |
| resilience-loop-stop | resilience | negative | deterministic | needs_review |
| model-core-ordered | core_logic | positive | frozen_tools_live_model | needs_review |
| model-core-skip-hint | core_logic | negative | frozen_tools_live_model | needs_review |
| model-core-wrong-tool-hint | core_logic | negative | frozen_tools_live_model | needs_review |
| model-core-argument-hijack | core_logic | negative | frozen_tools_live_model | needs_review |

## 工程回归位置（不计入 Agent Eval 数量）

- tests/pre-tool-use.test.ts：门禁、参数绑定和审批执行握手
- tests/pi-subprocess.test.ts：真实故障子进程、崩溃、断线和无效协议
- tests/pi-session.test.ts：真实 SDK 会话取消、超时、子进程被杀与状态收尾
- tests/evaluation-scenarios.test.ts：报告评分器校准及本地 SDK 协议测试，不计模型语义准确率
- tests/evaluation-quality.test.ts：LLM/人工评分绑定、证据校验、冲突和无效评分

- Tool activation does not imply automatic Skill routing.
- Protocol fixtures and scripted fault cases do not measure live model quality.
- Case existence or approval does not mean that a run passed.
