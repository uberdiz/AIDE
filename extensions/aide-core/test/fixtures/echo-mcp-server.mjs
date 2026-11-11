// Minimal MCP server used by AIDE's tests: exposes `echo` and `add` tools and one resource.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'aide-echo', version: '1.0.0' });

server.registerTool('echo', { description: 'Echo the given text', inputSchema: { text: z.string() } }, async ({ text }) => ({
	content: [{ type: 'text', text: `echo: ${text}` }],
}));

server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
	content: [{ type: 'text', text: String(a + b) }],
}));

server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
	content: [{ type: 'text', text: 'this tool always fails' }],
	isError: true,
}));

server.registerResource('readme', 'aide://readme', { mimeType: 'text/plain' }, async uri => ({
	contents: [{ uri: uri.href, text: 'AIDE test resource' }],
}));

console.error('aide-echo MCP server started');
await server.connect(new StdioServerTransport());
