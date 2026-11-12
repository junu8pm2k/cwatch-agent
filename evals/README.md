# Eval case 状态

2026-11-01 当前题单为[14题完整设计](cwatch/README.md)：触发2、核心逻辑8、异常容错2、产物质量2。Case 1修订为r6，其他新题为r2；输入、逐题规则、评审分工与异常fixture均已配置，全部needs_review，没有新确认基线或成绩。Dataset只存题目与规则，Prompt Management只存三个维度Judge。旧drafts/v2已被替代，原r5纯执行试跑仍保留。以下为既有历史准入状态，不能迁移给新修订。

2026-10-29 按项目所有者要求清空全部旧 eval case。当前从新设计注册了 **2 个用例：activation-001、activation-002**，见 [触发题单](activation/dataset.json)。

原契约回归、模型诊断、四类场景题库，以及题单、catalog、材料、候选、历史快照和对应评测归档均已删除；旧草案模板与 8 个领域评测 case 也已删除。

2026-10-31 历史题组共有 **4 个触发设计稿（正 2、反 2）**；可执行 activation-001 revision 4 与 activation-002 revision 2 均经用户确认基线，并各自独立完成五次均 100 分的严格自动门禁，程序已纳入 [正式回归集](regression/suite.json)。旧修订、基线及失败记录保留。回归测试全自动，不逐次请求人工。旧 activation-003、004 仍为设计稿，不额外计入新版 14 题。旧案例不会自动恢复。

普通工程测试与通用评测框架仍在，后续评测必须显式提供新的题单文件。详见 [评测状态](../docs/evaluation.md)。
