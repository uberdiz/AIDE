import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_TEMPLATE, type AgentDefinition } from '../agents/definitions';
import type { Checkpoint } from '../changes/tracker';
import { readMcpConfig, writeMcpConfig, type McpScope, type McpServerState } from '../mcp/manager';
import { AIDE_HOME, type Services } from '../services';

// ------------------------------------------------------------------ checkpoints

export class CheckpointsView implements vscode.TreeDataProvider<Checkpoint | { file: string; cp: Checkpoint }> {
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly s: Services) {}

	register(ctx: vscode.ExtensionContext): void {
		ctx.subscriptions.push(
			vscode.window.createTreeView('aide.checkpoints', { treeDataProvider: this }),
			new vscode.Disposable(this.s.changes.onDidChange(() => this.emitter.fire())),
			vscode.commands.registerCommand('aide.checkpoints.restore', async (arg?: Checkpoint | string) => {
				const id = typeof arg === 'string' ? arg : arg?.id ?? (await this.pick());
				if (!id) return;
				const cp = this.s.changes.listCheckpoints().find(c => c.id === id);
				if (!cp) return void vscode.window.showWarningMessage('That checkpoint no longer exists (it may have been restored already).');
				const newer = this.s.changes.listCheckpoints().filter(c => c.ts > cp.ts).length;
				const ok = await vscode.window.showWarningMessage(
					`Restore checkpoint "${cp.label}"?`,
					{ modal: true, detail: `Files changed by AI since ${new Date(cp.ts).toLocaleString()} will be restored${newer ? ` (including ${newer} newer checkpoint(s))` : ''}. Files the AI created will be deleted.` },
					'Restore',
				);
				if (!ok) return;
				// Save open editors first so on-disk state is what gets restored over.
				for (const d of vscode.workspace.textDocuments) if (d.isDirty && d.uri.scheme === 'file') await d.save();
				const r = this.s.changes.restore(id);
				void vscode.window.showInformationMessage(`Restored ${r.restored.length} file(s), removed ${r.deleted.length} created file(s).`);
			}),
			vscode.commands.registerCommand('aide.checkpoints.delete', (cp: Checkpoint) => cp && this.s.changes.deleteCheckpoint(cp.id)),
		);
	}

	private async pick(): Promise<string | undefined> {
		const items = this.s.changes.listCheckpoints().map(c => ({ label: c.label, description: `${new Date(c.ts).toLocaleString()} · ${c.files.length} file(s)`, id: c.id }));
		if (!items.length) {
			void vscode.window.showInformationMessage('No checkpoints yet. AIDE creates one automatically before an agent changes files.');
			return undefined;
		}
		return (await vscode.window.showQuickPick(items, { placeHolder: 'Restore which checkpoint?' }))?.id;
	}

	getChildren(el?: Checkpoint | { file: string; cp: Checkpoint }) {
		if (!el) return this.s.changes.listCheckpoints();
		if ('id' in el) return el.files.map(f => ({ file: f.path, cp: el }));
		return [];
	}

	getTreeItem(el: Checkpoint | { file: string; cp: Checkpoint }): vscode.TreeItem {
		if ('id' in el) {
			const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
			it.description = `${timeAgo(el.ts)} · ${el.files.length} file(s)`;
			it.iconPath = new vscode.ThemeIcon('history');
			it.contextValue = 'aideCheckpoint';
			it.tooltip = new Date(el.ts).toLocaleString();
			return it;
		}
		const it = new vscode.TreeItem(path.basename(el.file));
		it.description = vscode.workspace.asRelativePath(path.dirname(el.file));
		it.resourceUri = vscode.Uri.file(el.file);
		return it;
	}
}

// ------------------------------------------------------------------ MCP

type McpNode = { kind: 'server'; st: McpServerState } | { kind: 'tool'; server: string; name: string; description?: string } | { kind: 'error'; text: string };

export class McpView implements vscode.TreeDataProvider<McpNode> {
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly s: Services) {}

	register(ctx: vscode.ExtensionContext): void {
		const view = vscode.window.createTreeView('aide.mcp', { treeDataProvider: this });
		const withServer = (fn: (name: string) => Promise<unknown>) => async (n?: McpNode) => {
			const name = n?.kind === 'server' ? n.st.name : await this.pickServer();
			if (!name) return;
			try {
				await fn(name);
			} catch (e) {
				void vscode.window.showErrorMessage(`MCP ${name}: ${(e as Error).message}`);
			}
		};
		ctx.subscriptions.push(
			view,
			this.s.onDidChangeMcp(() => {
				this.emitter.fire();
				const running = this.s.mcp.list().filter(x => x.status === 'running').length;
				view.description = `${running}/${this.s.mcp.list().length} running`;
			}),
			vscode.commands.registerCommand('aide.mcp.add', () => this.addServer()),
			vscode.commands.registerCommand('aide.mcp.start', withServer(n => this.s.mcp.start(n))),
			vscode.commands.registerCommand('aide.mcp.stop', withServer(n => this.s.mcp.stop(n))),
			vscode.commands.registerCommand('aide.mcp.restart', withServer(n => this.s.mcp.restart(n))),
			vscode.commands.registerCommand('aide.mcp.test', withServer(async n => {
				const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing MCP server ${n}...` }, () => this.s.mcp.test(n));
				if (r.ok) void vscode.window.showInformationMessage(`MCP ${n}: OK - ${r.tools.length} tool(s): ${r.tools.slice(0, 12).join(', ')}${r.tools.length > 12 ? '...' : ''}`);
				else void vscode.window.showErrorMessage(`MCP ${n} failed: ${r.error}`);
			})),
			vscode.commands.registerCommand('aide.mcp.toggle', withServer(async n => {
				const st = this.s.mcp.get(n)!;
				await this.editConfig(st.scope, cfg => {
					cfg.servers[n].enabled = st.config.enabled === false;
				});
			})),
			vscode.commands.registerCommand('aide.mcp.remove', withServer(async n => {
				const st = this.s.mcp.get(n)!;
				const ok = await vscode.window.showWarningMessage(`Remove MCP server "${n}" from ${st.scope} configuration?`, { modal: true }, 'Remove');
				if (ok) await this.editConfig(st.scope, cfg => void delete cfg.servers[n]);
			})),
			vscode.commands.registerCommand('aide.mcp.openConfig', async (scope?: McpScope) => {
				const sc = scope ?? ((await vscode.window.showQuickPick(['user', 'workspace'], { placeHolder: 'Which MCP configuration?' })) as McpScope | undefined);
				if (!sc) return;
				const file = this.s.mcpConfigFile(sc);
				if (!file) return void vscode.window.showWarningMessage('Open a folder to use workspace MCP configuration.');
				if (!fs.existsSync(file)) writeMcpConfig(file, { servers: {} });
				await vscode.window.showTextDocument(vscode.Uri.file(file));
			}),
			vscode.commands.registerCommand('aide.mcp.showLogs', withServer(async n => {
				const st = this.s.mcp.get(n)!;
				const doc = await vscode.workspace.openTextDocument({ content: `MCP server ${n} (${st.status})\n${st.error ? `Error: ${st.error}\n` : ''}\n--- stderr (last ${st.stderr.length} lines) ---\n${st.stderr.join('\n')}`, language: 'log' });
				await vscode.window.showTextDocument(doc, { preview: true });
			})),
		);
	}

	private async pickServer(): Promise<string | undefined> {
		const items = this.s.mcp.list().map(s => ({ label: s.name, description: `${s.status} · ${s.scope}` }));
		return (await vscode.window.showQuickPick(items, { placeHolder: 'MCP server' }))?.label;
	}

	async editConfig(scope: McpScope, mutate: (cfg: { servers: Record<string, any> }) => void): Promise<void> {
		const file = this.s.mcpConfigFile(scope);
		if (!file) throw new Error('Open a folder to use workspace MCP configuration.');
		const { config, error } = readMcpConfig(file);
		if (error) throw new Error(`Fix ${file} first: ${error}`);
		mutate(config);
		writeMcpConfig(file, config);
		await this.s.reloadMcp();
	}

	async addServer(): Promise<void> {
		const type = await vscode.window.showQuickPick([
			{ label: 'Local command (stdio)', description: 'e.g. npx -y @modelcontextprotocol/server-filesystem', value: 'stdio' },
			{ label: 'Remote (Streamable HTTP)', description: 'https://example.com/mcp', value: 'http' },
			{ label: 'Remote (legacy SSE)', value: 'sse' },
		], { placeHolder: 'Add MCP server' });
		if (!type) return;
		const name = await vscode.window.showInputBox({ prompt: 'Server name (letters, digits, -, _)', validateInput: v => (/^[\w-]{1,40}$/.test(v) ? undefined : 'Use letters, digits, - or _') });
		if (!name) return;
		const server: Record<string, unknown> = {};
		if (type.value === 'stdio') {
			const cmdline = await vscode.window.showInputBox({ prompt: 'Command line', placeHolder: 'npx -y @modelcontextprotocol/server-memory' });
			if (!cmdline) return;
			const parts = splitArgs(cmdline);
			server.command = parts[0];
			server.args = parts.slice(1);
			const env = await vscode.window.showInputBox({ prompt: 'Environment variables (optional): KEY=value, comma separated. Use ${secret:name} for secrets stored in AIDE.', placeHolder: 'GITHUB_TOKEN=${secret:github}' });
			if (env) server.env = Object.fromEntries(env.split(',').map(kv => kv.split('=')).filter(p => p[0]?.trim()).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
		} else {
			const url = await vscode.window.showInputBox({ prompt: 'Server URL', validateInput: v => (/^https?:\/\//.test(v) ? undefined : 'Must start with http(s)://') });
			if (!url) return;
			server.url = url;
			server.type = type.value;
		}
		const scope = (await vscode.window.showQuickPick([{ label: 'user', description: '~/.aide/mcp.json - all projects' }, { label: 'workspace', description: '.aide/mcp.json - this project (shareable)' }], { placeHolder: 'Save to' }))?.label as McpScope | undefined;
		if (!scope) return;
		try {
			await this.editConfig(scope, cfg => (cfg.servers[name] = server));
			const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${name}...` }, () => this.s.mcp.test(name));
			if (r.ok) void vscode.window.showInformationMessage(`MCP server "${name}" added: ${r.tools.length} tool(s). Assign it to agents with the tool selector "mcp:${name}" (Coder and custom agents), or "mcp:*".`);
			else void vscode.window.showWarningMessage(`MCP server "${name}" was saved but failed to start: ${r.error}`, 'Edit config').then(p => p && vscode.commands.executeCommand('aide.mcp.openConfig', scope));
		} catch (e) {
			void vscode.window.showErrorMessage((e as Error).message);
		}
	}

	getChildren(n?: McpNode): McpNode[] {
		if (!n) {
			const nodes: McpNode[] = this.s.mcp.list().map(st => ({ kind: 'server', st }));
			for (const e of this.s.mcpErrors) nodes.push({ kind: 'error', text: e });
			return nodes;
		}
		if (n.kind === 'server') return n.st.tools.map(t => ({ kind: 'tool', server: n.st.name, name: t.name, description: t.description }));
		return [];
	}

	getTreeItem(n: McpNode): vscode.TreeItem {
		if (n.kind === 'error') {
			const it = new vscode.TreeItem(n.text);
			it.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
			return it;
		}
		if (n.kind === 'tool') {
			const it = new vscode.TreeItem(n.name);
			it.description = n.description?.split('\n')[0];
			it.tooltip = n.description;
			it.iconPath = new vscode.ThemeIcon('tools');
			return it;
		}
		const st = n.st;
		const it = new vscode.TreeItem(st.name, st.tools.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		const disabled = st.config.enabled === false;
		it.description = `${disabled ? 'disabled' : st.status}${st.status === 'running' ? ` · ${st.tools.length} tools` : ''} · ${st.scope}`;
		it.tooltip = new vscode.MarkdownString(`**${st.name}** (${st.scope})\n\n${st.config.command ? `\`${[st.config.command, ...(st.config.args ?? [])].join(' ')}\`` : st.config.url ?? ''}${st.error ? `\n\n**Error:** ${st.error}` : ''}\n\nCalls: ${st.calls} · failures: ${st.failures}`);
		const icons: Record<string, [string, string?]> = { running: ['pass-filled', 'testing.iconPassed'], starting: ['loading~spin'], error: ['error', 'errorForeground'], stopped: ['circle-large-outline'] };
		const [ic, color] = disabled ? ['circle-slash'] : icons[st.status];
		it.iconPath = new vscode.ThemeIcon(ic, color ? new vscode.ThemeColor(color) : undefined);
		it.contextValue = `aideMcp.${st.status}`;
		return it;
	}
}

function splitArgs(s: string): string[] {
	const out: string[] = [];
	for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

// ------------------------------------------------------------------ agents

export class AgentsView implements vscode.TreeDataProvider<AgentDefinition | string> {
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly s: Services) {}

	register(ctx: vscode.ExtensionContext, startAgent: (agentId: string) => void): void {
		ctx.subscriptions.push(
			vscode.window.createTreeView('aide.agents', { treeDataProvider: this }),
			this.s.onDidChangeAgents(() => this.emitter.fire()),
			vscode.commands.registerCommand('aide.agents.new', () => this.newAgent()),
			vscode.commands.registerCommand('aide.agents.open', (a: AgentDefinition) => a?.file && vscode.window.showTextDocument(vscode.Uri.file(a.file))),
			vscode.commands.registerCommand('aide.agents.use', (a: AgentDefinition) => a && startAgent(a.id)),
			vscode.commands.registerCommand('aide.agents.reload', () => this.s.reloadAgents()),
		);
	}

	async newAgent(): Promise<void> {
		const name = await vscode.window.showInputBox({ prompt: 'Agent name', placeHolder: 'Roblox Developer' });
		if (!name) return;
		const scope = await vscode.window.showQuickPick([{ label: 'Workspace', description: '.aide/agents/ (share with the project)', value: 'ws' }, { label: 'User', description: '~/.aide/agents/ (all projects)', value: 'user' }], { placeHolder: 'Where should the agent live?' });
		if (!scope) return;
		const dir = scope.value === 'ws' ? this.s.project?.dir('agents') : path.join(AIDE_HOME, 'agents');
		if (!dir) return void vscode.window.showWarningMessage('Open a folder first, or create a user agent.');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`);
		if (!fs.existsSync(file)) fs.writeFileSync(file, AGENT_TEMPLATE.replace('name: My Agent', `name: ${name}`));
		await vscode.window.showTextDocument(vscode.Uri.file(file));
		this.s.reloadAgents();
	}

	getChildren(el?: AgentDefinition | string): (AgentDefinition | string)[] {
		if (!el) {
			const groups = ['Built-in', 'Custom', 'Extensions'];
			const agents = this.s.agents();
			const out: string[] = groups.filter(g => agents.some(a => groupOf(a) === g));
			if (this.s.agentErrors.length) out.push('Errors');
			return out;
		}
		if (typeof el === 'string') {
			if (el === 'Errors') return this.s.agentErrors.map(e => `! ${e}`);
			return this.s.agents().filter(a => groupOf(a) === el);
		}
		return [];
	}

	getTreeItem(el: AgentDefinition | string): vscode.TreeItem {
		if (typeof el === 'string') {
			if (el.startsWith('! ')) {
				const it = new vscode.TreeItem(el.slice(2));
				it.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
				return it;
			}
			return new vscode.TreeItem(el, vscode.TreeItemCollapsibleState.Expanded);
		}
		const it = new vscode.TreeItem(el.name);
		it.description = el.model ?? el.task;
		it.tooltip = new vscode.MarkdownString(`**${el.name}** - ${el.description}\n\nTools: \`${el.tools.join(', ')}\`${el.file ? `\n\n${el.file}` : ''}`);
		it.iconPath = new vscode.ThemeIcon(el.icon ?? 'hubot');
		it.contextValue = el.file ? 'aideAgent.file' : 'aideAgent';
		it.command = { command: 'aide.agents.use', title: 'Use agent', arguments: [el] };
		return it;
	}
}

function groupOf(a: AgentDefinition): string {
	return a.source === 'builtin' ? 'Built-in' : a.source === 'extension' ? 'Extensions' : 'Custom';
}

export function timeAgo(ts: number): string {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return new Date(ts).toLocaleDateString();
}
