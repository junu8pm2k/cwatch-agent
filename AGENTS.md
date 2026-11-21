# Git 提交规范

## 提交消息

使用 Conventional Commits 格式 `type(scope): 中文摘要`，`scope` 可省略。类型和范围使用小写英文。用半角冒号 `:` 加一个空格分隔前缀和摘要。冒号后的摘要必须用中文简短说明实际改动，可保留 `CI`、`Langfuse` 等技术术语和专有名词。

- `feat` 新增功能，`fix` 修复问题，`docs` 更新文档，`refactor` 重构实现。
- `test` 调整测试，`ci` 调整持续集成，`build` 调整构建或依赖，`chore` 维护仓库。
- 范围使用实际模块，如 `web`、`eval` 或 `deps`。例如 `fix(eval): 记录 Judge 输出截断原因`。
- 需要补充背景或验证结果时，在标题后空一行写正文。可用 `Refs #123` 关联 Issue，用 `Closes #123` 标明合并后应关闭的 Issue。破坏性变更用 `!` 和 `BREAKING CHANGE:` 说明影响与迁移方式。

## 提交与合并

- 每条提交聚焦一项可独立审查的改动，将实现、对应测试和文档放在一起。合并前可整理同一改动的临时提交和反复修订。
- 提交前用 `git status`、`git diff --cached` 和 `git diff --cached --check` 核对暂存内容，并运行与改动相关的检查。排除密钥、`.env` 和本地生成产物。
- 从 `main` 建立 `<agent>/<简短主题>` 分支（前缀与当前使用的 agent 保持一致不要大写，如 `antigravity/<简短主题>`、`codex/<简短主题>`、`claude/<简短主题>` 、`dsh/<简短主题>`等），在 PR 中记录改动和验证结果。合并后清理已完成的分支，使用 `git fetch --prune origin` 同步本地远端跟踪引用。
- 重写已推送的历史前先确认影响范围、核对远端最新提交并备份旧引用。需要强制推送时，为每个分支使用带预期旧 SHA 的 `--force-with-lease`。删除分支前确认 PR 状态和独有提交的去向。
