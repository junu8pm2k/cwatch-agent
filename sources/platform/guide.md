# Platform API guide

The MCP tool is api_platform; its Agent proxy is platform__api_platform.
Read this guide with session__read_source_guide before making requests.

## Example endpoints

GET /releases with params {"per_page":5} reads releases.
POST /search with params {"query":"Node.js"} is read-only only because the host config contains an explicit rule for this exact method and path.
Other POST/PUT/PATCH/DELETE calls are classified as writes by the host.

The host fixes the origin and injects PLATFORM_API_TOKEN. Do not pass credentials in params.
The example domain is a placeholder. Replace it and this guide with the real platform's documented endpoints before enabling the source.
Raw JSON remains discovery, not verified competitor facts.
