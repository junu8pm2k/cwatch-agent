import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const server = new McpServer({ name: 'user-mcp-fixture', version: '1.0.0' });
server.registerTool('get_release', { description: 'Read an explicitly labeled fixture release.', inputSchema: { query: z.string().min(1) }, annotations: { readOnlyHint: true } }, async () => {
  const data = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/official.json', import.meta.url)), 'utf8'));
  data.signals.forEach((signal: { sourceSlug: string }) => { signal.sourceSlug = 'custom'; });
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});
server.registerTool('inspect_environment', { description: 'Fixture for testing explicit environment mapping.', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ mapped: process.env.CUSTOM_SERVER_SECRET ?? null, hostModelKey: process.env.API_KEY ?? null }) }],
}));
await server.connect(new StdioServerTransport());
