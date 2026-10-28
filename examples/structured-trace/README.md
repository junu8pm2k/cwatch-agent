# 结构化 Trace 示例

来自本地固定 ReplayModel 与合成来源的双工具调用测试；没有外部模型或真实业务数据。参数、工具结果及回答中的测试凭据已脱敏。保留 JSONL 原始字节与 JSON 视图以便验证 source.sha256。

```powershell
npm start -- trace --out examples/structured-trace --run 2c22f645-8f89-43ae-b111-5c580d9b67f2
```

该命令重新导出结构化视图，不调用模型或工具。字段见 [结构化 Trace](../../docs/structured-trace.md)。
