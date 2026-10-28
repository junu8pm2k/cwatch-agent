import type { ToolBinding, ToolDefinition } from '@cwatch/core/types';

const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

/** MCP-only opaque key. Never split this name to recover the source/tool. */
export function proxyToolName(slug: string, originalName: string): string {
  return sanitize(`mcp__${slug}__${originalName}`);
}

export function registeredToolName(slug: string, channel: ToolBinding['channel'], tool: ToolDefinition): string {
  // Namespace selection is trusted only for host-owned tools, not remote MCP data.
  if (channel === 'mcp') return proxyToolName(slug, tool.name);
  const name = tool.namespace === 'native' ? sanitize(tool.name)
    : tool.namespace === 'session' ? sanitize(`session__${tool.name}`)
    : channel === 'workflow' ? sanitize(`workflow__${tool.name}`)
    : sanitize(`${slug}__${tool.name}`);
  if (name.startsWith('mcp__')) throw new Error('reserved_mcp_tool_prefix: ' + name);
  return name;
}
