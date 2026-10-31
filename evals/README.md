# Eval case 状态

2026-10-29 按项目所有者要求清空全部旧 eval case。当前从新设计注册了 **2 个用例：activation-001、activation-002**，见 [触发题单](activation/dataset.json)。

原契约回归、模型诊断、四类场景题库，以及题单、catalog、材料、候选、历史快照和对应评测归档均已删除；旧草案模板与 8 个领域评测 case 也已删除。

新增用例从设计稿重新建立，见 [新用例集设计](drafts/README.md)。共有 **4 个触发设计稿（正 2、反 2）**；当前 Case 1 revision 4 与 Case 2 revision 2 均经用户确认新版基线，并各自独立完成五次均 100 分的严格自动门禁，程序已纳入 [正式回归集](regression/suite.json)。旧修订、基线及失败记录保留。回归测试全自动，不逐次请求人工。Case 3、4 仍为设计稿。旧案例不会自动恢复。

普通工程测试与通用评测框架仍在，后续评测必须显式提供新的题单文件。详见 [评测状态](../docs/evaluation.md)。
