# ZCode official GitHub release source

Read this guide using session__read_source_guide with source zcode_github.
Use mcp__zcode_github__api_zcode_github.

GET /repos/zai-org/ZCode/releases
params: {"per_page":10}. per_page must be an integer from 1 to 10.

This configured endpoint maps public GitHub release objects to structured release signals. Attribute them to ZCode and the exact repository zai-org/ZCode; repository releases do not establish desktop release parity or all product capabilities. Use html_url and published_at; retrieval time is not publication time.
Other GET endpoints under /repos/zai-org/ZCode/ are discovery only; no write operation is required or authorized.
An empty releases response does not establish that the product had no updates.
HTTP rate_limited means collection is unavailable and update status is unknown; keep it as a source gap, never success_empty or no updates. http.rateLimit.retryAt is an earliest retry hint, not a promise of quota or success; retrySource distinguishes server headers from a recommended minimum. The host does not automatically retry. Authentication or permission failures remain separate.

Official discovery starting URLs:
- https://zcode.z.ai/en
- https://zcode.z.ai/cn/docs/install
- https://github.com/zai-org/ZCode

Current capabilities with unknown publication dates are background observations. Homepage task mockups, relative timestamps, pricing snapshots and third-party mentions are not dated product announcements. The investigation window is governed by the task, not this guide.
