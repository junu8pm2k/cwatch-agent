/** Project policy: GitHub API access is disabled until the operator restores it in code. */
export function assertNetworkUrlAllowed(value: string | URL): void {
  const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = decodeURIComponent(url.pathname);
  if (host === 'api.github.com' || host.endsWith('.api.github.com') ||
      host === 'api.githubcopilot.com' || host.endsWith('.api.githubcopilot.com') ||
      /^\/api\/(?:v3|graphql)(?:\/|$)/i.test(path) ||
      (host === 'github.com' && /^\/(?:api|graphql)(?:\/|$)/i.test(path))) {
    throw new Error('github_api_disabled_by_project_policy');
  }
}

export function assertMcpIntegrationAllowed(slug: string, command = '', args: string[] = []): void {
  if (/github/i.test(slug) || /(?:server-github|github-mcp-server|api\.github\.com|api\.githubcopilot\.com)/i.test([command, ...args].join(' '))) {
    throw new Error('github_api_disabled_by_project_policy');
  }
}
