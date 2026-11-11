import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import { truncateMiddle } from '../ai/context/compress';
import type { ImagePart } from '../ai/types';
import type { ToolRegistry } from '../tools/registry';
import type { Tool, ToolResult } from '../tools/types';

export interface McpServerConfig {
	/** stdio servers */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** remote servers */
	url?: string;
	type?: 'stdio' | 'http' | 'sse';
	headers?: Record<string, string>;
	enabled?: boolean;
	description?: string;
	/** per-server tool call timeout (seconds) */
	timeout?: number;
}

export type McpScope = 'user' | 'workspace';

export interface McpServerState {
	name: string;
	scope: McpScope;
	config: McpServerConfig;
	status: 'stopped' | 'starting' | 'running' | 'error';
	error?: string;
	tools: { name: string; description?: string; registeredAs: string }[];
	resources: { uri: string; name?: string; mimeType?: string }[];
	stderr: string[];
	startedAt?: number;
	calls: number;
	failures: number;
}

export interface McpConfigFile {
	servers: Record<string, McpServerConfig>;
}

/** Reads `{ "servers": {...} }` or the common `{ "mcpServers": {...} }` layout. */
export function readMcpConfig(file: string): { config: McpConfigFile; error?: string } {
	try {
		const raw = fs.readFileSync(file, 'utf8');
		const j = JSON.parse(raw.replace(/^﻿/, ''));
		return { config: { servers: { ...(j.mcpServers ?? {}), ...(j.servers ?? {}) } } };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: { servers: {} } };
		return { config: { servers: {} }, error: `${file}: ${(e as Error).message}` };
	}
}

export function writeMcpConfig(file: string, config: McpConfigFile): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ servers: config.servers }, null, 2) + '\n');
}

export function toolNameFor(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
	const full = `mcp__${clean(server)}__${clean(tool)}`;
	return full.length <= 64 ? full : full.slice(0, 55) + '_' + hash(full);
}

function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36).slice(0, 8);
}

export interface McpManagerOptions {
	registry: ToolRegistry;
	/** Resolve ${secret:name} and ${env:NAME} placeholders in env/headers. */
	resolveValue: (v: string) => Promise<string>;
	log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
	onChange: () => void;
	clientInfo: { name: string; version: string };
	/** workspace servers only start after the user trusts them */
	trustWorkspace: (names: string[]) => Promise<boolean>;
}

/**
 * Runs MCP servers in isolation: each has its own client; a crash or hang
 * marks only that server as failed and removes its tools.
 */
export class McpManager {
	private states = new Map<string, McpServerState>();
	private clients = new Map<string, Client>();
	private disposers = new Map<string, (() => void)[]>();
	private starting = new Map<string, Promise<void>>();

	constructor(private readonly opts: McpManagerOptions) {}

	/** Replace the configured server set (from user + workspace config files). */
	async configure(servers: { name: string; scope: McpScope; config: McpServerConfig }[]): Promise<void> {
		const next = new Set(servers.map(s => s.name));
		for (const name of [...this.states.keys()]) if (!next.has(name)) await this.stop(name, true);
		for (const s of servers) {
			const prev = this.states.get(s.name);
			const changed = prev && JSON.stringify(prev.config) !== JSON.stringify(s.config);
			if (prev && changed && prev.status === 'running') await this.stop(s.name);
			if (!prev || changed) {
				this.states.set(s.name, { name: s.name, scope: s.scope, config: s.config, status: 'stopped', tools: [], resources: [], stderr: prev?.stderr ?? [], calls: 0, failures: 0 });
			}
		}
		this.opts.onChange();
	}

	list(): McpServerState[] {
		return [...this.states.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): McpServerState | undefined {
		return this.states.get(name);
	}

	/** Start the servers an agent's tool selectors refer to ("mcp:*" or "mcp:<name>"). */
	async ensureForSelectors(selectors: string[]): Promise<string[]> {
		const wanted = new Set<string>();
		for (const s of selectors) {
			if (s === '*' || s === 'mcp:*') for (const st of this.states.values()) wanted.add(st.name);
			else if (s.startsWith('mcp:')) wanted.add(s.slice(4));
		}
		const targets = [...wanted].map(n => this.states.get(n)).filter((s): s is McpServerState => !!s && s.config.enabled !== false && s.status !== 'running');
		const ws = targets.filter(t => t.scope === 'workspace').map(t => t.name);
		if (ws.length && !(await this.opts.trustWorkspace(ws))) {
			for (const n of ws) this.setError(n, 'workspace MCP server not trusted');
		}
		const errors: string[] = [];
		await Promise.all(targets.filter(t => t.scope === 'user' || this.states.get(t.name)?.status !== 'error').map(async t => {
			try {
				await this.start(t.name);
			} catch (e) {
				errors.push(`${t.name}: ${(e as Error).message}`);
			}
		}));
		return errors;
	}

	async start(name: string): Promise<void> {
		const st = this.states.get(name);
		if (!st) throw new Error(`Unknown MCP server "${name}"`);
		if (st.status === 'running') return;
		const inflight = this.starting.get(name);
		if (inflight) return inflight;
		const p = this.doStart(st).finally(() => this.starting.delete(name));
		this.starting.set(name, p);
		return p;
	}

	private async doStart(st: McpServerState): Promise<void> {
		st.status = 'starting';
		st.error = undefined;
		this.opts.onChange();
		const cfg = st.config;
		const client = new Client(this.opts.clientInfo, { capabilities: {} });
		try {
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = await this.opts.resolveValue(v);
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = await this.opts.resolveValue(v);
			let transport;
			const type = cfg.type ?? (cfg.url ? 'http' : 'stdio');
			if (type === 'stdio') {
				if (!cfg.command) throw new Error('stdio server needs "command"');
				const stdio = new StdioClientTransport({
					command: cfg.command,
					args: cfg.args ?? [],
					env: { ...(process.env as Record<string, string>), ...env },
					cwd: cfg.cwd,
					stderr: 'pipe',
				});
				stdio.stderr?.on('data', (b: Buffer) => {
					for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) st.stderr.push(line);
					if (st.stderr.length > 200) st.stderr.splice(0, st.stderr.length - 200);
				});
				transport = stdio;
			} else if (type === 'sse') {
				transport = new SSEClientTransport(new URL(cfg.url!), { requestInit: { headers } });
			} else {
				transport = new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers } });
			}
			client.onerror = err => this.opts.log('warn', `MCP ${st.name}: ${err.message}`);
			client.onclose = () => {
				if (this.clients.get(st.name) === client) {
					this.clients.delete(st.name);
					this.unregister(st.name);
					if (st.status === 'running') this.setError(st.name, 'server exited unexpectedly' + (st.stderr.length ? `: ${st.stderr.slice(-3).join(' | ')}` : ''));
				}
			};
			await withTimeout(client.connect(transport), 30_000, 'connection timed out after 30s');
			this.clients.set(st.name, client);
			const caps = client.getServerCapabilities();
			const tools = caps?.tools ? (await withTimeout(client.listTools(), 20_000, 'tools/list timed out')).tools : [];
			let resources: McpServerState['resources'] = [];
			if (caps?.resources) {
				try {
					resources = (await withTimeout(client.listResources(), 10_000, 'resources/list timed out')).resources.map(r => ({ uri: r.uri, name: r.name, mimeType: r.mimeType }));
				} catch (e) {
					this.opts.log('warn', `MCP ${st.name}: resources/list failed: ${(e as Error).message}`);
				}
			}
			this.unregister(st.name);
			const disposers: (() => void)[] = [];
			st.tools = [];
			for (const t of tools) {
				const registeredAs = toolNameFor(st.name, t.name);
				const tool: Tool = {
					name: registeredAs,
					toolset: `mcp:${st.name}`,
					category: 'mcp',
					source: 'mcp',
					readOnly: t.annotations?.readOnlyHint === true,
					description: `[MCP ${st.name}] ${t.description ?? t.name}`.slice(0, 1024),
					inputSchema: (t.inputSchema as Tool['inputSchema']) ?? { type: 'object', properties: {} },
					describe: input => `${st.name}.${t.name}(${truncateMiddle(JSON.stringify(input), 40).text})`,
					run: (input, ctx) => this.callTool(st.name, t.name, input, ctx.signal),
				};
				disposers.push(this.opts.registry.register(tool));
				st.tools.push({ name: t.name, description: t.description, registeredAs });
			}
			this.disposers.set(st.name, disposers);
			st.resources = resources;
			st.status = 'running';
			st.startedAt = Date.now();
			this.opts.log('info', `MCP ${st.name}: connected (${st.tools.length} tools, ${resources.length} resources)`);
		} catch (e) {
			try {
				await client.close();
			} catch {
				/* already closed */
			}
			this.clients.delete(st.name);
			const msg = (e as Error)?.message ?? String(e);
			this.setError(st.name, msg + (st.stderr.length ? ` (stderr: ${st.stderr.slice(-3).join(' | ')})` : ''));
			throw new Error(msg);
		} finally {
			this.opts.onChange();
		}
	}

	async callTool(server: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		const st = this.states.get(server);
		const client = this.clients.get(server);
		if (!st || !client) return { content: `MCP server "${server}" is not running`, isError: true };
		st.calls++;
		try {
			const res = await client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: (st.config.timeout ?? 120) * 1000 });
			const texts: string[] = [];
			const images: ImagePart[] = [];
			for (const c of (res.content as any[]) ?? []) {
				if (c.type === 'text') texts.push(c.text);
				else if (c.type === 'image') images.push({ type: 'image', mediaType: c.mimeType, data: c.data });
				else if (c.type === 'resource') texts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`);
				else if (c.type === 'resource_link') texts.push(`[resource ${c.uri}]`);
				else texts.push(JSON.stringify(c));
			}
			if (!texts.length && res.structuredContent) texts.push(JSON.stringify(res.structuredContent, null, 2));
			if (res.isError) st.failures++;
			return { content: truncateMiddle(texts.join('\n') || '(no content)', 12_000).text, isError: !!res.isError, images: images.length ? images : undefined };
		} catch (e) {
			st.failures++;
			return { content: `MCP ${server}.${tool} failed: ${(e as Error).message}`, isError: true };
		}
	}

	async readResource(server: string, uri: string): Promise<string> {
		const client = this.clients.get(server);
		if (!client) throw new Error(`MCP server "${server}" is not running`);
		const res = await client.readResource({ uri });
		return res.contents.map((c: any) => c.text ?? `[binary ${c.mimeType ?? ''}]`).join('\n');
	}

	async stop(name: string, remove = false): Promise<void> {
		const client = this.clients.get(name);
		this.clients.delete(name);
		this.unregister(name);
		const st = this.states.get(name);
		if (st) {
			st.status = 'stopped';
			st.tools = [];
			st.resources = [];
		}
		if (client) {
			try {
				await client.close();
			} catch (e) {
				this.opts.log('warn', `MCP ${name}: close failed: ${(e as Error).message}`);
			}
		}
		if (remove) this.states.delete(name);
		this.opts.onChange();
	}

	async restart(name: string): Promise<void> {
		await this.stop(name);
		await this.start(name);
	}

	/** Start (if needed), list tools, and stop again if it was not running before. */
	async test(name: string): Promise<{ ok: boolean; tools: string[]; error?: string }> {
		const wasRunning = this.states.get(name)?.status === 'running';
		try {
			await this.start(name);
			const tools = this.states.get(name)?.tools.map(t => t.name) ?? [];
			if (!wasRunning) await this.stop(name);
			return { ok: true, tools };
		} catch (e) {
			return { ok: false, tools: [], error: (e as Error).message };
		}
	}

	async disposeAll(): Promise<void> {
		await Promise.all([...this.clients.keys()].map(n => this.stop(n)));
	}

	private unregister(name: string): void {
		for (const d of this.disposers.get(name) ?? []) d();
		this.disposers.delete(name);
	}

	private setError(name: string, error: string): void {
		const st = this.states.get(name);
		if (!st) return;
		st.status = 'error';
		st.error = error;
		st.tools = [];
		this.opts.log('error', `MCP ${name}: ${error}`);
		this.opts.onChange();
	}
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(msg)), ms);
		p.then(v => {
			clearTimeout(t);
			resolve(v);
		}, e => {
			clearTimeout(t);
			reject(e);
		});
	});
}
