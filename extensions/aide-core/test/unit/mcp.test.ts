import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { McpManager, toolNameFor } from '../../src/mcp/manager';
import { ToolRegistry } from '../../src/tools/registry';

const fixture = path.resolve(__dirname, '../fixtures/echo-mcp-server.mjs');
const registry = new ToolRegistry();
const logs: string[] = [];
const mgr = new McpManager({
	registry,
	resolveValue: async v => v.replace(/\$\{env:(\w+)\}/g, (_, n) => process.env[n] ?? ''),
	log: (l, m) => logs.push(`${l}: ${m}`),
	onChange: () => undefined,
	clientInfo: { name: 'aide-test', version: '0.0.0' },
	trustWorkspace: async () => true,
});

afterAll(() => mgr.disposeAll());

describe('McpManager', () => {
	it('starts a stdio server, registers its tools and calls them', async () => {
		await mgr.configure([{ name: 'echo', scope: 'user', config: { command: process.execPath, args: [fixture] } }]);
		await mgr.start('echo');
		const st = mgr.get('echo')!;
		expect(st.status).toBe('running');
		expect(st.tools.map(t => t.name).sort()).toEqual(['add', 'echo', 'fail']);
		expect(st.resources[0].uri).toBe('aide://readme');
		const tool = registry.get(toolNameFor('echo', 'add'))!;
		expect(tool.toolset).toBe('mcp:echo');
		expect(tool.category).toBe('mcp');
		const r = await tool.run({ a: 2, b: 40 }, { signal: new AbortController().signal } as any);
		expect(r).toEqual({ content: '42', isError: false, images: undefined });
		const f = await mgr.callTool('echo', 'fail', {});
		expect(f.isError).toBe(true);
		expect(await mgr.readResource('echo', 'aide://readme')).toBe('AIDE test resource');
		expect(registry.select(['mcp:*']).length).toBe(3);
	});

	it('stops a server and removes its tools', async () => {
		await mgr.stop('echo');
		expect(mgr.get('echo')!.status).toBe('stopped');
		expect(registry.select(['mcp:echo'])).toHaveLength(0);
	});

	it('isolates failures of a broken server', async () => {
		await mgr.configure([
			{ name: 'echo', scope: 'user', config: { command: process.execPath, args: [fixture] } },
			{ name: 'broken', scope: 'user', config: { command: 'definitely-not-a-real-command-aide' } },
		]);
		const errors = await mgr.ensureForSelectors(['mcp:*']);
		expect(errors.some(e => e.startsWith('broken'))).toBe(true);
		expect(mgr.get('broken')!.status).toBe('error');
		expect(mgr.get('echo')!.status).toBe('running');
		const t = await mgr.test('broken');
		expect(t.ok).toBe(false);
	});

	it('names tools safely', () => {
		expect(toolNameFor('my server', 'do.thing')).toBe('mcp__my_server__do_thing');
		expect(toolNameFor('x'.repeat(40), 'y'.repeat(40)).length).toBeLessThanOrEqual(64);
	});
});
