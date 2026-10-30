# 本次依赖审计

2026-10-17 实际运行 `npm audit --json`，历史摘要现保存于 [dependency-audit-20261017.json](../artifacts/history-summary/dependency-audit-20261017.json)。这是当日已知漏洞清单，不代表当前依赖状态，也不替代工程行为测试。

初次安装报告 5 项。已将本工程直接依赖 MCP SDK 从 1.29.0 修复为 **1.32.1**，Ajv 从 8.17.1 修复为 **8.20.0**，锁文件已更新并重新通过完整测试。

仍有 3 个受影响包（2 high、1 moderate），都来自锁定的 `@earendil-works/pi-coding-agent@0.84.2` 及其自带 npm-shrinkwrap：

| 包 | 当前版本 | 审计结论 |
|---|---|---|
| undici | 8.9.0 | high；审计列出 WebSocket、重试、解压、缓存与连接选项等已知问题；8.10.2 有修复 |
| brace-expansion | 5.0.9 | high；嵌套括号导致 DoS 等；5.0.12 有修复 |
| pi-coding-agent | 0.84.2 | moderate；间接依赖 undici 导致 |

已尝试 npm scoped/global overrides，但本次实际 `npm ls` 证明 SDK shrinkwrap 内版本没有变化，因此删除了无效 overrides，**没有将其记成已修复**。不修改 node_modules 来制造不可复现的通过。审计建议的 Pi 升级涉及 SDK 主版本变化；本次保持已读技能/API 基线，并把该项保留为已知交付限制。升级需要重新检查公开 API、工具编解码、取消和端到端回归，不能宣称当前依赖已经安全放行。

本工程未启用 SDK 编码工具、插件发现、任意 glob 输入、WebSocket、重试拦截器或共享 HTTP 缓存；这些边界不等于消除了依赖风险。当前交付为本地验证项目，未部署生产或对不可信用户提供服务。

本次修复依据的原始公告地址保存在 audit JSON：MCP [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)、Ajv [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6)。其余公告亦可从该 JSON 逐条定位。
