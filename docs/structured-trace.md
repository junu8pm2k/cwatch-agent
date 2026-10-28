# 结构化 Trace

每次任务结束，自动生成 `traces/<runId>.json`，版本为 `cwatch.structured-trace.v1`。持续追加的 `traces/<runId>.jsonl` 保留为原始审计记录（事件版本 2）；JSON 是可重新生成的结构化视图。二者均经宿主脱敏，结构化视图只使用审计事件，不读取 SDK 私有思考内容。

可直接查看 [本地合成调用示例](../examples/structured-trace/README.md)，其中包含成对的 JSONL 与结构化 JSON。

## 获取方式

```powershell
npm run demo:agent
npm start -- trace --out artifacts/agent-demo --run <runId>
npm run test:trace
```

CLI 运行结果的 `trace` 是结构化 JSON 绝对路径，`traceEvents` 是 JSONL 路径。`traceArtifacts` 返回相对路径、是否导出成功以及脱敏错误；若写入失败，已持久化的审计日志和终态通知仍然有效。`trace` 命令可转换历史日志或获取执行中的快照，不执行模型和工具，不更改原始 JSONL。

Web 工作台的 `GET /api/runs/<工作台任务ID>/trace` 返回同一结构，沿用本地来源限制。这里使用工作台任务 ID；文档内的 `runId` 则是实际 Runtime 运行 ID。尚未开始生成 Trace 时返回未就绪错误。

## 顶层字段

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | `cwatch.structured-trace.v1` |
| `traceId / runId / taskId` | 本次执行及任务身份；当前 traceId 等于 runId |
| `status` | complete、partial、failed、cancelled 或 incomplete |
| `input` | 任务、运行模式、权限模式、引擎及可取得的模型标识 |
| `output` | 最终回答、报告相对路径、缺口列表 |
| `timing` | 起止时间及总耗时，单位毫秒 |
| `summary` | 模型轮数、辅助用量记录数、工具请求/实际执行数、后端执行数、Token 与成本可用性 |
| `steps` | run、model、tool、backend、process 步骤及父子关系 |
| `events` | 具有稳定身份、步骤关联、序号、状态、属性与错误的归一化审计事件 |
| `errors` | 事件与步骤关联的错误列表 |
| `source` | 原始 JSONL 路径、字节 SHA-256、事件版本及事件数 |
| `integrity` | 审计校验是否通过、是否存在终态及校验错误 |

任务可以业务失败但审计完整有效。`integrity.valid` 与业务成功分别判定；没有终态的快照为 incomplete，并保留原有审计校验错误。输出里没有导出时刻字段，同一日志重复导出具有确定性。

## 步骤与关联

`stepId / parentStepId` 组织 run → model → tool → backend；Agent 子进程作为 run 的 process 步骤。`correlation` 保存 iteration、requestId、sdkToolCallId、bindingId、stageId 和 sessionId。批量工具调用各自具有独立步骤，共同关联其模型轮次。

步骤包含 `input / output / status / error / resultStatus`，并通过 `attributes` 保存工具绑定、权限裁决、审批、参数哈希和上下文等信息。`eventIds` 可定位原始事件；`usage` 保留各次提供方用量。调用失败与来源业务状态分别记录：HTTP 调用正常结束但来源限流时，可以是 `status=completed`、`resultStatus=rate_limited`。

`timing` 区分 requestedAt（请求）、startedAt（实际开始）和 endedAt；durationMs 是请求全程耗时，executionDurationMs 是实际执行耗时。审批拒绝的工具为 blocked，实际开始和执行耗时为 null，不生成后端执行。错误统一为 code、message、category 和 retryable；来源未声明重试信息时 retryable 为 null。

`summary.knownTokens` 是可取得用量的合计，`totalTokens` 在用量不完整时为 null。模型轮次不等同供应商物理请求次数，无法确认时 physicalModelRequests 为 null；目前没有可信价格结算信息，actualCost 为 null。辅助 Memory/Compact 用量没有独立请求起始事件时，其步骤标为 unknown，不推测请求耗时或执行成功。

## 评测与校验

Runtime 评测保存 `structuredTracePath`。评分器验证 Schema，并依据原始 JSONL、精确字节哈希重新生成结构后逐字段比较；缺失、被修改或不一致都会使 Trace 完整性检查失败。评分器版本指纹包含投影实现。旧观测没有声明结构化路径时仍按既有 JSONL 规则处理。

`npm run test:trace` 覆盖批量调用关联、审批拒绝、工具异常与来源限流、模型失败收束、未知用量、历史转换、未完成快照、派生写入失败、篡改拒绝及 Web 接口。全量验证入口为 `npm run verify`。
