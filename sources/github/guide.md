# GitHub source guide

Use the generic MCP tool api_github (Agent proxy mcp__github__api_github).
First call session__read_source_guide with {"source":"github"}.

## Release investigation

GET /repos/nodejs/node/releases
params: {"per_page":5}; per_page must be an integer from 1 to 10.
This endpoint has an explicit structured release mapping. Use html_url and published_at from the response, never the retrieval timestamp as publication time.
Other GET endpoints under /repos/nodejs/node/ are discovery material until a domain mapping is implemented.
HTTP rate_limited means collection is unavailable and update status is unknown; retain a source gap, never infer no updates. http.rateLimit.retryAt is an earliest retry hint, not guaranteed quota or success; retrySource distinguishes server headers from a recommended minimum. The host performs no automatic retry. Authentication or permission failures remain separate.

## Permissions

The host fixes the API origin, repository scope and credentials. POST/PUT/PATCH/DELETE require host authorization; they are not needed for a release investigation. This guide does not grant write permission.
A changed guide must be read again. Replay results remain labeled fixture.
