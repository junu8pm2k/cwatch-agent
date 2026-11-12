# Case 1 首次执行

2026-11-01：用户要求重新设计触发场景。新版 [Case 1 r5 设计](../drafts/v2/case-01.md)及配对反例属于[14 题新方案](../drafts/v2/README.md)，尚未试跑、评分或确认基线。本目录的 dataset 继续固定历史 r4/r2，不把既有通过记录迁移到新设计；下文为历史执行记录。

当前 activation-001 为 revision 4：保留 Prompt、量表、代码检查、总 Token 预算 30000 与单次输出上限 8192，更新冻结的专家 Skill，明确不从发布日期或“新增”推断准确/近似上线日期；旧 revision 2 和 revision 3 文件及既有运行证据保持原样。宿主通用 Skill 另要求按需读取历史，只使用实际披露的转录锚点。

题单为 dataset.json，当前含 activation-001 revision 4、activation-002 revision 2，标准状态均为 needs_review。任务使用仓库 competitor-review Skill 与检查表的冻结快照；宿主通过真实 SessionTools 提供资源读取，不用预设工具调用或答案。模型只收到输入与 Skill，量表保存在评审侧。

本修订的基线登记为 [activation-001.r4.json](../baselines/activation-001.r4.json)，用户在看到纯执行试跑的实际回答和 Trace 后明确认可并要求继续自动验证。基线随仓库版本管理，报告读取实际状态和指标；后续五次回归全自动，不创建逐次人工待办，也不改变冻结 Case 中的原审核状态。历史 r2 基线仍保留。操作说明见 [基线工作流](../../docs/evaluation-baselines.md)。

Case 1 已在新一轮五次真实执行及 Judge 均通过严格自动门禁后，正式纳入 [自动回归清单](../regression/suite.json)。CI 使用 npm run eval:regression 运行整个正式清单，每例五次、每次 100 分、代码和 Rubric 全通过；人工评分与完整发布门禁仍单独保留。准入条件和远程 CI 配置见 [回归集说明](../regression/README.md)。

统一入口：npm run eval:run -- --dataset evals/activation/dataset.json --case activation-001 --repeat 1 --gate automatic。一条命令完成真实执行、代码检查、Judge、自动评分报告和 ZIP 归档；默认 gate=automatic，不创建人工待办。需要人工审核时显式使用 --gate final，先生成 Case 指定人工模板并停在审核检查点，导入真实审核结论后才生成综合报告和 ZIP。

补齐已有批次：npm run eval:run -- --report <batch/report.json> --gate automatic。匹配当前量表、评委配置和评分器版本的已完成 Judge 记录会复用，不重跑 Agent。只有需要人工审核时才显式使用 --gate final 派单，填写模板并通过 eval:human 导入，再用 --gate final 更新人工综合报告与归档。eval:report 仅用于从已有记录重新生成报告，默认自动模式，人工视图可用 --mode human_review。

每批次使用独立输出目录、新会话与输入快照。失败批次和重试批次分别保留，不能用成功记录覆盖失败记录。现有 Node 权限限制不代表操作系统网络隔离；模型服务需要实际连接。

完整归档包含批次报告、输入、模型回答、原始/结构化 Trace、日志、逐项评分、冻结 Case/Skill/量表和受限脱敏会话。压缩包及校验摘要保存在本地 artifacts 下；归档不要求 git commit，也不会自动将运行确认为基线。

2026-10-31：activation-002 revision 1 按原设计稿注册，使用与 Case 1 相同的总 Token 预算 30000 和单次输出上限 8192。首次批次 batch-c834fcf5-ebbd-4d1b-b06a-728b45aec16f 因 provider_unavailable:Connection error 在产生回答和工具调用前失败；Judge 未调用，报告及 ZIP 已保留。该记录属于连接失败，不能据此判断模型是否能识别隐式审阅意图，也不建立基线。后续使用同一入口，将 --case 改为 activation-002；重跑生成独立批次。

同日用户明确授权发送至配置的阶跃星辰 step-5-preview 后，独立批次 batch-32af9ae0-da2d-469a-8fa6-4147e72bb376 完成真实执行和真实 Judge：8 项代码检查与 O1/T1/E1 全部通过，自动得分 100。实际执行耗时 19588 ms，成功读取检查表 1 次，外部资料调用 0 次；Agent 7027 Token、Judge 12510 Token，费用未知。完整报告见 [Case 2 自动报告](../../artifacts/agent-eval/batch-32af9ae0-da2d-469a-8fa6-4147e72bb376/test-report-8c6b3357-6f78-43e3-a4ef-fe8f14c77469.md)，ZIP 及 SHA256 保存在 artifacts/agent-eval/archives。执行模型与 Judge 使用同一型号；本轮仅测试一次，不确认人工基线，也不加入正式五次回归清单。

Case 2 此前进入过人工基线审核阶段：已用 --report 复用上述运行及 Judge，通过 --gate final 生成 [人工待审报告](../../artifacts/agent-eval/batch-32af9ae0-da2d-469a-8fa6-4147e72bb376/test-report-a2217eb0-b650-474b-b418-e79f823ecf1d.md) 和人工输入模板。该次运行和自动 100 分保留为历史诊断，未登记为基线；用户随后要求重新进行纯 Prompt 试跑。

随后按用户明确要求另跑一次纯执行基线试跑，trialId=1daba64a-9752-4c05-9fa8-cd00063e0a4a、runId=667dbd08-2375-41e2-ba55-64aa00173fd1。仅输入原 Prompt 和所选 Skill，不加载 expected、Rubric、旧回答，不调用 Judge。原始材料保存于 artifacts/baseline-trials/activation-002/1daba64a-9752-4c05-9fa8-cd00063e0a4a/。用户在收到 [实际回答](../../artifacts/baseline-trials/activation-002/1daba64a-9752-4c05-9fa8-cd00063e0a4a/outcome.md)、[结构化 Trace](../../artifacts/baseline-trials/activation-002/1daba64a-9752-4c05-9fa8-cd00063e0a4a/traces/667dbd08-2375-41e2-ba55-64aa00173fd1.json) 及两处来源/日期问题提示后回复“ok”，现已确认并登记 [基线](../baselines/activation-002.r1.json)。耗时 18644 ms，读取检查表 1 次，外部资料调用 0 次，实际 6773 Token。原回答及问题原样冻结；本次确认仅针对这次执行的过程与结果，不代表旧量表获批或完成五次稳定性验证。

基线确认后，用户要求测试，批次 batch-70a95ec7-657c-4a77-a6b1-e26c6f67fb0e、runId=73c6b470-4f7f-40d3-a59b-7d5429c91ed3 完成一次真实执行与 Judge，自动项为 100。复核发现回答将 M1 发布日期改写为功能开始日期，用户对该具体 E1 失败判定回复“不通过”；已独立登记人工裁决，按 E1 否决扣 100，单次人工裁决得分为 0。原 Judge 的 pass 和自动 100 分保留为历史事实，不改变已确认基线；其他未审核项保持未知，不据此声称完整人审通过。当前结论为这次测试不通过，不能加入正式回归集。

用户要求修复并重测后，Case 2 升为 revision 2，原 revision 1 文件保存在 cases/revisions/activation-002.r1.json，r1 基线与失败记录不变。修复仅更新公开 Skill/检查表的日期角色和合成来源约束，提示词、Rubric、代码检查及扣分标准保持不变；另加强 Judge 对建议文案的证据核验，并增加独立日期逐处审核。新修订须独立确认基线，旧 r1 的确认不会自动转移。修复验证的真实执行为 batch-d34214e7-d925-4124-b244-c80c06669dee、runId=e188d855-9045-45e0-a4e3-8c11caf405f4，原回答、全部评分尝试和归档保留；修改 Judge 后只复用该执行进行重新评分，不覆盖已生成报告。

修复验证结果：新回答明确区分发布日期和上线日期，并保留合成来源说明；最终自动报告 [test-report-5da96002-174d-43f0-b47e-06db732aaea2.md](../../artifacts/agent-eval/batch-d34214e7-d925-4124-b244-c80c06669dee/test-report-5da96002-174d-43f0-b47e-06db732aaea2.md) 为 100 分，O1/T1/E1 全 pass。独立证据审核记录回答中四处 ISO 日期的角色，均为材料发布日期；完整审核记录为 assessments/fbaa09ff-689b-4466-93cb-c1c27789e3f6。用于核验评分侧修复的旧失败回答现被 assessments/fba4dabe-be68-46dc-a41a-3296c3e04df3 正确判为 E1 fail，明确定位到 offset=726 的“起支持”错误。中间漏判和缺失日期审核明细的无效评分均保留，没有用后续成功覆盖。当前 revision 2 仅完成单次修复验证，等待用户审核新 Trace 与 Outcome 以确认新版基线；尚未进行五次稳定性测试或入集。

人工流程调整后，实际运行先停在 review-checkpoint-c8662373-24d3-4320-977b-815576314c8e.json，没有在该次等待阶段生成新报告或 ZIP。用户随后明确回复“认可，登记新版基线”，已导入流程/安全人审，登记并确认 [activation-002.r2.json](../baselines/activation-002.r2.json)，再生成 [正式人审报告](../../artifacts/agent-eval/batch-d34214e7-d925-4124-b244-c80c06669dee/test-report-f7e575c4-d57f-4b8b-ac88-efc7131fe159.md) 与新归档。单次综合分 100，基线 confirmed；Case 的标准审核状态独立保留为 needs_review，不冒充完整发布门禁获批。后续回归全自动，尚未执行五次准入测试。

用户要求准备 CI、回归集与归档后，新建 batch-a2619244-1ba1-4548-ac38-d03daaaf01a7，Case 2 revision 2 真实独立执行五次，全部自动项 100 分、代码检查 40/40、Rubric 15/15、人工待办 0。程序严格准入成功并写入 suite.json 与 admissions/activation-002.r2.2c043382-3eac-4ed8-b682-5329e8270563.json。[五次准入报告](../../artifacts/agent-eval/batch-a2619244-1ba1-4548-ac38-d03daaaf01a7/test-report-54a9c547-d124-4d7c-a503-fc26bfd9a198.md) 和完整 ZIP 已生成，逐文件校验 171 项通过，ZIP SHA256=02e968a2ea53970e0d991be99dd0210658ead8b05b865d9db09c31ceabdaa0a5。Agent 42587 Token、Judge 117211 Token；费用未知。旧失败记录及基线原样保留，正式回归无需逐次人工。

2026-10-31 最终准入：旧 Case 1 在预检中暴露虚构转录锚点和近似上线日期推断，失败批次完整保留。修复宿主历史读取约束和专家 Skill 后，revision 4 先做纯执行试跑；用户明确回复“认可，登记 Case 1 新基线并继续自动验证”，据此登记基线，再独立运行 batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5。五次均 100 分、代码 40/40、Rubric 15/15，人工待办 0，程序已用 r4 更新回归清单。[本轮报告](../../artifacts/agent-eval/batch-ef79574b-98c7-45ca-8952-0bf5dcc3dba5/test-report-ee9c3439-a7d6-43da-9184-30401286d29d.md) 对应 ZIP SHA256=6308d4b806b988e81d88fa13e4f66e8bfcf001906b47fb398e267de9cb0ebf93，ZIP 摘要与内部 169 项文件校验通过；Agent 42819 Token、Judge 124779 Token，费用未知。整集配置检查同时验证 Case 1 r4 与 Case 2 r2 有效。历史失败不重写，不降低量表或扣分门槛，不拼接不同批次。
