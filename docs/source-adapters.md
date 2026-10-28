# 浏览器与 MCP 来源适配

当前采集仅有 builtin 与 mcp 两类执行通道，另有内部 workflow 工具。CLI 采集与独立 api 通道已删除；应用自身命令行入口保留。

| 通道 | 来源 |
|---|---|
| builtin | 通用 web_search / web_fetch、只读 browser_tool |
| mcp | stdio/远程 MCP、GitHub Releases 包装、通用 REST API 包装 |

McpConnectionPool 按运行与配置复用来源及用户 MCP 的连接/工具发现，最多 64 项，最后租约释放后关闭。平台 API 在池内使用真实 MCP Server/Client 与进程内传输。通用 web 路由的搜索 MCP 仍由专用适配器管理。

所有模型工具调用经同一个主进程 IPC 门禁。停用来源不启动后端、不解析凭据、不披露工具；这里没有对外 HTTP 池端点。

## browser_tool

配置 kind=browser，必须有 urls、allowedDomains、实体/产品映射。browser 可选字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| channel | chromium | chromium、msedge 或 chrome |
| executablePath | 未配置 | 操作者指定的浏览器路径 |
| readySelector | 未配置 | 操作者指定的页面就绪条件 |
| navigationTimeoutMs | 15000 | 启动/导航/就绪等待超时，最多 60000 |
| maxRequests | 40 | 包含拒绝请求的尝试次数，最多 100 |

工具名为 session__browser_tool，输入只允许配置过的 url。每次使用全新、无持久登录态的 headless 上下文。msedge/chrome 使用已安装的浏览器；默认 chromium 需要 npm run browser:install，不自动下载。

实际页面 JavaScript 会运行，但模型不能提供脚本、点击、填表或任意导航。页面最终 URL 必须与本次配置 URL 一致。固定宿主代码捕获渲染后的文本和 HTML，已有 JSON-LD/固定解析器支持时输出结构化信号；否则页面保留为 discovery/gap，不自动成为事实。未知发布时间不从采集时间推导。

页面 HTTP 请求由宿主中介：先校验 HTTPS、允许域名及 GET/HEAD，再执行 stage 权限复查。宿主手动获取响应，所有 3xx 在交给浏览器前拒绝，不依赖 Playwright 对重定向再次触发路由。每个资源最多 2 MB，总共 8 MB；请求次数耗尽关闭浏览器。Service Worker、WebSocket 不开放，弹出页关闭。这是 HTTP 读取门禁，不是 OS 或全网络防火墙。

用于匿名公开页面：不转发 Cookie、Authorization 或任意自定义请求头，不复用个人浏览器资料。宿主 HTTP 遵循 Node 的代理设置；浏览器不继承模型密钥。认证、下载、OCR、视觉点击和复杂会话需另做受控能力。取消时会关闭并等待浏览器，晚启动的浏览器也会回收。

实现：packages/shared/src/sources/browser-config.ts、packages/shared/src/sources/browser.ts。基础契约在 tests/browser-source.test.ts，实际浏览器验收在 tests/browser-live.test.ts。

## 平台 API 包装为 MCP

每个 API 来源用 sources/<slug>/config.json + guide.md 与单个 api_<slug> 工具，Agent 代理名为 mcp__<slug>__api_<slug>。模型经 session__read_source_guide 先读指南，再提交 path/method/params；指南未读或变化时硬阻断，权限由请求实际语义推导。配置、Craft 源码映射、调用图和边界见 [平台 API MCP](platform-api-mcp.md)。原 github_releases 配置自动走 MCP，通用 kind=api 模板见 examples/sources-platform-api.json；kind=cli 不再接受。

运行 npm run demo:adapters 可演示浏览器 fixture 与 GitHub API fixture 经 MCP 的完整调查。npm run verify:browser 运行真实浏览器、真实 Pi 子进程与真实进程内 MCP 协议，模型响应和业务页面仍是合成 fixture，不能称为真实模型质量验收。
