# 搜索 API 配置迁移

专用 Search / Fetch API 已改为宿主本地工具直接调用 REST API，详见 [web-api.md](web-api.md)。

推荐配置为 `webApi: { search, fetch }`。旧 `searchMcp: { type: "api", search, fetch }` 仍可读取，执行同一条本地 API 路径；Trace 改为 `backend=web.api`，不再记录进程内 MCP initialize/list/call。显式 API 配置优先于模型原生工具，不会因更换规划模型切换后端。

历史 API→MCP 实现和旧探测记录属于先前版本。通用平台 API / GitHub 的 MCP 包装见 [platform-api-mcp.md](platform-api-mcp.md)，本次没有改动该路径。
