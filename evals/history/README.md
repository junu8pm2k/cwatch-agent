# 历史评测契约

`model-diagnostic/2026-10-25.2/` 保存三个 revision 1 Case 和原题单的完整字节，SHA-256 与原始题单一致。它们没有声明机器可读的输出格式契约；保留供审计，不作为新运行的题单。

当前可执行版本位于 model-diagnostic/，revision 2 明确采用 json_object_only。禁止把新版本的更严格格式要求追溯到旧模型输出。

`candidates/` 保留争议格式失败候选的原始 revision 1。当前候选 revision 2 已标为 retired；不进入正式回归，也不可作为活动合成案例的父本。

历史原始评分保持不变，订正重评分单独保存。待复核不等于通过，人工 Golden 审核状态仍未改变。
