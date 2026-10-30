# GitHub API 停用记录

2026-10-29，按项目所有者要求移除 GitHub API 接入，暂不使用该服务。

- 删除 GitHub Releases 专用适配器、四个来源目录、公开 GitHub 搜索配置和 GitHub 探测脚本。
- 默认任务、界面来源、调查示例和回放脚本不再选择 GitHub；官网发现示例不以 GitHub 页面替代 API。
- 清理 `.env.example` 及本机项目 `.env` 中的 GitHub 凭据变量，不输出或外发这些值；不操作账户上的令牌。
- 内建平台 API、Web API、网页/浏览器读取及远程 MCP 地址校验拒绝已知 GitHub API 地址，包括 REST、GraphQL 和官方远程 MCP 地址。旧 `github_releases` 配置不再接受；已知 GitHub MCP 服务配置和 GitHub 凭据向子进程的传递也被拒绝。
- 项目 Agent 指令禁止通过 gh CLI、本地命令或其他服务绕过停用要求。没有提供环境变量启用开关。

随后按所有者要求，所有 eval Case、题单、材料、候选、历史副本及对应评测归档已清理。HTTP 分类器与普通工程测试 fixture 保留；本次未运行评测。

通用 API 和 MCP 的其他服务仍可由操作者独立配置。现有从 GitHub 经 Git 克隆安装 Skill 的能力不调用 GitHub API，本次未改动；本次工作没有调用它。

本次仅进行静态类型检查、JSON 与差异检查；没有运行测试、eval、探测脚本或真实 GitHub 请求。已启动的旧进程需要关闭并重新启动才能加载本次代码与配置。以上为项目内建入口限制，不是操作系统级网络封锁。
