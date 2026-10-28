import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const server = new McpServer({ name: 'competitor-news-fixture', version: '0.1.0' });
server.registerTool('search.news', { description: 'Local MCP sample: returns fixed news fixture, never live news.', inputSchema: { query: z.string().min(1).max(500) } }, async ({ query }) => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/news.json', import.meta.url)), 'utf8'));
  if (!/node|24/i.test(query)) { fixture.status = 'success_empty'; fixture.signals = []; }
  return { content: [{ type: 'text', text: JSON.stringify(fixture) }] };
});
await server.connect(new StdioServerTransport());
