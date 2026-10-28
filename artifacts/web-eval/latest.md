# Web 工作台验收

2026-10-24T13:08:00.167Z

通过 9/9，门禁 PASS

真实浏览器、真实 HTTP/SSE、真实 RunService 与权限链；模型及业务页面为明确合成 fixture，不证明线上模型质量。

- PASS Web defaults to generic Agent, runs without investigation fields and restores its result
- PASS Web conversation sends real user follow-ups through one Pi worker and survives browser refresh
- PASS Web UI starts a real offline investigation, shows citations, downloads its report and restores after refresh
- PASS Web UI approves a real host permission request without bypassing the tool gate
- PASS Web UI rejects a real host permission request without bypassing the tool gate
- PASS Web UI cancels a pending approval and restores the cancelled state with zero writes
- PASS Web UI cancels a running investigation and releases its execution capacity
- PASS Web UI remains usable on mobile, supports keyboard tabs and renders untrusted task text without HTML execution
- PASS Web live mode runs a real Pi worker and the unified Web tool through explicit local fixtures
