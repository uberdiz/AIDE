import { ClaudeCodeProvider } from './ai/providers/claudeCode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiClient, type LimitDecision, type RequestRecord } from './ai/client';
import { formatModelRef, ProviderRegistry, type ModelRef } from './ai/providers/registry';
import { describePick, pickForRole, roleForTask, type PickableModel } from './ai/modelPicker';
import { Router } from './ai/router';
import type { ModelInfo, ProviderKind } from './ai/types';
import { UsageStore } from './ai/usage';
import { BUILTIN_AGENTS, loadAgentsFrom, type AgentDefinition } from './agents/definitions';
import { PermissionService, type PermissionAnswer, type PermissionRequest } from './agents/permissions';
import { AgentRunner } from './agents/runtime';
import { ChangeTracker } from './changes/tracker';
import { ConversationStore } from './chat/conversations';
import * as config from './core/config';
import { Logger } from './core/logger';
import { McpManager, readMcpConfig, type McpScope, type McpServerConfig } from './mcp/manager';
import { ProjectContext } from './project/projectContext';
import { BUILTIN_TOOLS } from './tools/builtin';
import { ToolRegistry } from './tools/registry';
import type { IdeServices } from './tools/types';
import { ToolStats } from './ui/dataPanels';
import { OutputLogs } from './vscode/contextSources';
import { createIdeServices, TerminalCapture } from './vscode/ideServices';

/** User-level AIDE config (agents, mcp.json, workflows, templates). Overridable for tests. */
export const AIDE_HOME = process.env.AIDE_HOME || path.join(os.homedir(), '.aide');

const ENV_KEYS: Partial<Record<ProviderKind, string[]>> = {
	anthropic: ['ANTHROPIC_API_KEY'],
	openai: ['OPENAI_API_KEY'],
	gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

export type ApprovalPresenter = (req: PermissionRequest) => Promise<PermissionAnswer>;

/** Asks the user to approve agent actions: inline in the chat when visible, otherwise a modal. */
export class ApprovalService {
	presenter: ApprovalPresenter | undefined;
	async ask(req: PermissionRequest): Promise<PermissionAnswer> {
		if (this.presenter) return this.presenter(req);
		return modalApproval(req);
	}
}

export async function modalApproval(req: PermissionRequest): Promise<PermissionAnswer> {
	for (;;) {
		const detail = [
			req.dangerous ? `WARNING: ${req.dangerous}. This approval is not remembered.` : '',
			req.preview?.detail ?? '',
			`Agent: ${req.agentId}   Category: ${req.category}   Tool: ${req.toolName}`,
		].filter(Boolean).join('\n\n');
		const hasDiff = req.preview?.before !== undefined && req.preview?.after !== undefined;
		const options = req.dangerous ? ['Allow once'] : ['Allow once', 'Allow for session', 'Allow for workspace', 'Always allow'];
		if (hasDiff) options.push('Show diff');
		const pick = await vscode.window.showWarningMessage(`AIDE: ${req.summary}`, { modal: true, detail }, ...options);
		if (pick === 'Show diff' && req.preview) {
			await showPreviewDiff(req.preview.title, req.preview.path ?? 'file', req.preview.before ?? '', req.preview.after ?? '');
			continue;
		}
		switch (pick) {
			case 'Allow once': return { allow: true, scope: 'once' };
			case 'Allow for session': return { allow: true, scope: 'session' };
			case 'Allow for workspace': return { allow: true, scope: 'workspace' };
			case 'Always allow': return { allow: true, scope: 'always' };
			default: return { allow: false, scope: 'once' };
		}
	}
}

/** In-memory documents for previews (aide-preview: scheme). */
export class PreviewDocs implements vscode.TextDocumentContentProvider {
	static readonly scheme = 'aide-preview';
	private docs = new Map<string, string>();
	private emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;
	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.docs.get(uri.toString()) ?? '';
	}
	set(name: string, content: string): vscode.Uri {
		const uri = vscode.Uri.from({ scheme: PreviewDocs.scheme, path: '/' + name.replace(/\\/g, '/').replace(/^\/+/, ''), query: String(Date.now()) });
		this.docs.set(uri.toString(), content);
		if (this.docs.size > 200) this.docs.delete(this.docs.keys().next().value!);
		this.emitter.fire(uri);
		return uri;
	}
}
export const previewDocs = new PreviewDocs();

export async function showPreviewDiff(title: string, filePath: string, before: string, after: string): Promise<void> {
	const name = path.basename(filePath);
	const left = previewDocs.set(`before/${name}`, before);
	const right = previewDocs.set(`after/${name}`, after);
	await vscode.commands.executeCommand('vscode.diff', left, right, `${title} (proposed)`, { preview: true });
}

export interface RunHandle {
	id: string;
	agentId: string;
	conversationId?: string;
	controller: AbortController;
	started: number;
	label: string;
}

/** Wires every AIDE subsystem together. One instance per window. */
export class Services implements vscode.Disposable {
	readonly log: Logger;
	readonly providers: ProviderRegistry;
	readonly router: Router;
	readonly usage: UsageStore;
	readonly client: AiClient;
	readonly tools = new ToolRegistry();
	readonly approvals = new ApprovalService();
	readonly permissions: PermissionService;
	readonly changes: ChangeTracker;
	readonly runner: AgentRunner;
	readonly mcp: McpManager;
	readonly conversations: ConversationStore;
	readonly capture = new TerminalCapture();
	readonly outputs: OutputLogs;
	readonly toolStats = new ToolStats();
	readonly ide: IdeServices;
	project: ProjectContext | undefined;

	readonly requests: RequestRecord[] = [];
	readonly runs = new Map<string, RunHandle>();
	private extensionAgents = new Map<string, AgentDefinition>();
	private customAgents: AgentDefinition[] = [];
	agentErrors: string[] = [];
	mcpErrors: string[] = [];

	private readonly emitters = {
		requests: new vscode.EventEmitter<RequestRecord>(),
		usage: new vscode.EventEmitter<void>(),
		agents: new vscode.EventEmitter<void>(),
		mcp: new vscode.EventEmitter<void>(),
		runs: new vscode.EventEmitter<void>(),
		models: new vscode.EventEmitter<void>(),
	};
	readonly onDidRecordRequest = this.emitters.requests.event;
	readonly onDidChangeUsage = this.emitters.usage.event;
	readonly onDidChangeAgents = this.emitters.agents.event;
	readonly onDidChangeMcp = this.emitters.mcp.event;
	readonly onDidChangeRuns = this.emitters.runs.event;
	readonly onDidChangeModels = this.emitters.models.event;

	private disposables: vscode.Disposable[] = [];
	private usageSaveTimer: NodeJS.Timeout | undefined;
	private readonly storage: string;

	constructor(readonly context: vscode.ExtensionContext) {
		this.storage = context.globalStorageUri.fsPath;
		fs.mkdirSync(this.storage, { recursive: true });
		fs.mkdirSync(AIDE_HOME, { recursive: true });
		this.log = new Logger(path.join(this.storage, 'logs'));
		// logUri = <logs>/<session>/window1/exthost/<extension>; output channels are logged under window1.
		this.outputs = new OutputLogs(path.dirname(path.dirname(context.logUri.fsPath)));
		const root = this.root;
		this.project = root ? new ProjectContext(root) : undefined;

		this.providers = new ProviderRegistry(id => this.getApiKey(id));
		// Claude Code works in the open folder, like the person would in a terminal there.
		this.providers.registerKind('claude-code', c => new ClaudeCodeProvider(c, () => this.root));
		this.providers.setConfigs(config.providersConfig());
		this.router = new Router(config.routingConfig(), {
			providerExists: id => !!this.providers.getConfig(id),
			isLocal: id => this.providers.isLocal(id),
			modelInfo: ref => this.providers.modelInfo(ref),
			knownModels: () => this.knownChatModels(),
			autoPick: task => this.autoPick(task),
		});

		this.usage = new UsageStore(config.limitsConfig());
		try {
			this.usage.load(JSON.parse(fs.readFileSync(path.join(this.storage, 'usage.json'), 'utf8')));
		} catch {
			/* no usage yet */
		}

		const logScope = this.log.scope('ai');
		this.client = new AiClient(this.providers, this.router, this.usage, {
			project: () => (this.root ? path.basename(this.root) : '(no folder)'),
			askLimit: (check, ref) => this.askLimit(check.messages, ref),
			warn: msgs => void vscode.window.showWarningMessage(`AIDE usage: ${msgs.join(' | ')}`, 'Open Usage').then(p => p && vscode.commands.executeCommand('aide.usage.open')),
			onRecord: r => {
				const i = this.requests.findIndex(x => x.id === r.id);
				if (i >= 0) this.requests[i] = { ...r };
				else this.requests.push({ ...r });
				if (this.requests.length > 150) this.requests.shift();
				this.emitters.requests.fire(r);
			},
			onUsageChanged: () => this.scheduleUsageSave(),
			log: (l, m, d) => logScope(l, m, d),
			defaultMaxTokens: () => config.get<number>('ai.maxOutputTokens', 16_000),
		});

		for (const t of BUILTIN_TOOLS) this.tools.register(t);

		this.permissions = new PermissionService(
			() => config.permissionPolicy(),
			{
				read: scope => (scope === 'workspace' ? context.workspaceState : context.globalState).get<Record<string, 'allow' | 'deny'>>(`aide.grants.${scope}`, {}),
				write: (scope, grants) => void (scope === 'workspace' ? context.workspaceState : context.globalState).update(`aide.grants.${scope}`, grants),
			},
			req => this.approvals.ask(req),
		);

		const wsKey = root ? Buffer.from(root.toLowerCase()).toString('base64url').slice(-40) : 'no-folder';
		this.changes = new ChangeTracker(path.join(this.storage, 'checkpoints', wsKey));
		this.ide = createIdeServices(this.capture, () => this.root);
		this.runner = new AgentRunner(this.client, this.tools, this.permissions, this.changes, this.ide, this.log.scope('agent'), (n, e, ms) => this.toolStats.record(n, e, ms));
		this.conversations = new ConversationStore(path.join(this.storage, 'conversations'));

		this.mcp = new McpManager({
			registry: this.tools,
			resolveValue: v => this.resolvePlaceholders(v),
			log: this.log.scope('mcp'),
			onChange: () => this.emitters.mcp.fire(),
			clientInfo: { name: 'AIDE', version: '2.0.0' },
			trustWorkspace: names => this.trustWorkspaceMcp(names),
		});

		this.disposables.push(
			this.log,
			this.capture,
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('aide.providers')) {
					this.providers.setConfigs(config.providersConfig());
					this.emitters.models.fire();
					void this.refreshModels();
				}
				if (e.affectsConfiguration('aide.routing')) {
					this.router.setConfig(config.routingConfig());
					this.emitters.models.fire();
				}
				if (e.affectsConfiguration('aide.limits')) this.usage.limits = config.limitsConfig();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				const r = this.root;
				this.project = r ? new ProjectContext(r) : undefined;
				this.reloadAgents();
				void this.reloadMcp();
			}),
		);
		this.watchConfigFiles();
		this.reloadAgents();
		void this.reloadMcp();
	}

	get root(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// ------------------------------------------------------------ secrets

	private secretKey(providerId: string): string {
		return `aide.apiKey.${providerId}`;
	}

	async getApiKey(providerId: string): Promise<string | undefined> {
		const stored = await this.context.secrets.get(this.secretKey(providerId));
		if (stored) return stored;
		const kind = this.providers?.getConfig(providerId)?.kind;
		for (const env of (kind && ENV_KEYS[kind]) ?? []) if (process.env[env]) return process.env[env];
		if (providerId === 'openrouter' && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
		return undefined;
	}

	async hasStoredKey(providerId: string): Promise<boolean> {
		return !!(await this.context.secrets.get(this.secretKey(providerId)));
	}

	async setApiKey(providerId: string, key: string | undefined): Promise<void> {
		if (key) await this.context.secrets.store(this.secretKey(providerId), key.trim());
		else await this.context.secrets.delete(this.secretKey(providerId));
		this.providers.reset(providerId);
		this.emitters.models.fire();
	}

	async getSecret(name: string): Promise<string | undefined> {
		return this.context.secrets.get(`aide.secret.${name}`);
	}

	async setSecret(name: string, value: string | undefined): Promise<void> {
		if (value) await this.context.secrets.store(`aide.secret.${name}`, value);
		else await this.context.secrets.delete(`aide.secret.${name}`);
	}

	/** ${secret:name} -> SecretStorage, ${env:NAME} -> process env, ${workspaceFolder} -> root. */
	async resolvePlaceholders(v: string): Promise<string> {
		let out = v.replace(/\$\{env:([\w]+)\}/g, (_, n) => process.env[n] ?? '').replace(/\$\{workspaceFolder\}/g, this.root ?? '');
		for (const m of [...out.matchAll(/\$\{secret:([\w.-]+)\}/g)]) out = out.replace(m[0], (await this.getSecret(m[1])) ?? '');
		return out;
	}

	// ------------------------------------------------------------ models

	private knownChatModels(): ModelRef[] {
		const refs: { ref: ModelRef; score: number }[] = [];
		const allowed = new Set(this.autoProviders());
		for (const p of this.providers.list().filter(x => allowed.has(x.id))) {
			const models = this.cachedModels(p.id);
			for (const m of models) {
				const caps = m.capabilities ?? [];
				if (caps.includes('embeddings') && !caps.includes('chat')) continue;
				const size = Number(/\((\d+(?:\.\d+)?)B\)/i.exec(m.label ?? '')?.[1] ?? 0);
				const score = (caps.includes('tools') ? 1000 : 0) + (this.providers.isLocal(p.id) ? 0 : 500) + size;
				refs.push({ ref: { providerId: p.id, modelId: m.id }, score });
			}
		}
		return refs.sort((a, b) => b.score - a.score).map(r => r.ref);
	}

	private modelLists = new Map<string, ModelInfo[]>();
	modelErrors = new Map<string, string>();

	cachedModels(providerId: string): ModelInfo[] {
		return this.modelLists.get(providerId) ?? [];
	}

	/** Refresh model lists from all providers (in the background; failures are recorded, not thrown). */
	async refreshModels(): Promise<void> {
		await Promise.all(this.providers.list().map(async p => {
			try {
				const models = await this.providers.models(p.id, { refresh: true, signal: AbortSignal.timeout(8000) });
				this.modelLists.set(p.id, models);
				this.modelErrors.delete(p.id);
			} catch (e) {
				this.modelErrors.set(p.id, (e as Error).message);
				this.log.warn(`Could not list models for ${p.id}: ${(e as Error).message}`);
			}
		}));
		this.emitters.models.fire();
	}

	allModelRefs(): { ref: string; info: ModelInfo; provider: string; providerId: string; local: boolean }[] {
		const out: { ref: string; info: ModelInfo; provider: string; providerId: string; local: boolean }[] = [];
		for (const p of this.providers.list()) for (const m of this.cachedModels(p.id)) out.push({ ref: formatModelRef({ providerId: p.id, modelId: m.id }), info: m, provider: p.label ?? p.id, providerId: p.id, local: this.providers.isLocal(p.id) });
		return out;
	}

	/** Providers Auto may use (setting aide.routing.autoProviders; empty = all enabled providers). */
	autoProviders(): string[] {
		const chosen = config.get<string[]>('routing.autoProviders', []).filter(id => this.providers.getConfig(id));
		return chosen.length ? chosen : this.providers.list().map(p => p.id);
	}

	/** Models Auto can choose from, in the picker's format. */
	autoCandidates(): PickableModel[] {
		const allowed = new Set(this.autoProviders());
		return this.allModelRefs()
			.filter(m => allowed.has(m.providerId))
			.map(m => ({ ref: m.ref, providerId: m.providerId, id: m.info.id, label: m.info.label, local: m.local || !!m.info.local, caps: m.info.capabilities ?? [], contextWindow: m.info.contextWindow }));
	}

	autoPick(task: string): { refs: string[]; reason: string } {
		const role = roleForTask(task);
		const picks = pickForRole(role, this.autoCandidates());
		return { refs: picks.map(p => p.ref), reason: picks[0] ? describePick(role, picks[0]) : 'no suitable model' };
	}

	/** Models are discovered in the background; make sure a list exists before routing a chat. */
	async ensureModels(timeoutMs = 4000): Promise<void> {
		if (this.providers.list().every(p => this.modelLists.has(p.id) || this.modelErrors.has(p.id))) return;
		await Promise.race([this.refreshModels(), new Promise(r => setTimeout(r, timeoutMs))]);
	}

	// ------------------------------------------------------------ usage

	private scheduleUsageSave(): void {
		this.emitters.usage.fire();
		if (this.usageSaveTimer) return;
		this.usageSaveTimer = setTimeout(() => {
			this.usageSaveTimer = undefined;
			this.saveUsage();
		}, 1500);
	}

	saveUsage(): void {
		try {
			const f = path.join(this.storage, 'usage.json');
			fs.writeFileSync(f + '.tmp', JSON.stringify(this.usage.toJSON()));
			fs.renameSync(f + '.tmp', f);
		} catch (e) {
			this.log.error('Failed to save usage', e);
		}
	}

	private async askLimit(messages: string[], ref: string): Promise<LimitDecision> {
		const pick = await vscode.window.showWarningMessage(`AIDE usage limit reached for ${ref}`, { modal: true, detail: messages.join('\n') + '\n\nChoose how to continue.' }, 'Continue anyway', 'Use another model', 'Reduce context');
		return pick === 'Continue anyway' ? 'proceed' : pick === 'Use another model' ? 'skip' : pick === 'Reduce context' ? 'reduce' : 'stop';
	}

	// ------------------------------------------------------------ agents

	agents(): AgentDefinition[] {
		const byId = new Map<string, AgentDefinition>();
		for (const a of [...BUILTIN_AGENTS, ...this.extensionAgents.values(), ...this.customAgents]) byId.set(a.id, a);
		return [...byId.values()];
	}

	agent(id: string): AgentDefinition {
		return this.agents().find(a => a.id === id) ?? BUILTIN_AGENTS[0];
	}

	registerAgent(a: AgentDefinition): vscode.Disposable {
		this.extensionAgents.set(a.id, { ...a, source: 'extension' });
		this.emitters.agents.fire();
		return new vscode.Disposable(() => {
			this.extensionAgents.delete(a.id);
			this.emitters.agents.fire();
		});
	}

	reloadAgents(): void {
		const user = loadAgentsFrom(path.join(AIDE_HOME, 'agents'), 'user');
		const ws = this.project ? loadAgentsFrom(this.project.dir('agents'), 'workspace') : { agents: [], errors: [] };
		this.customAgents = [...user.agents, ...ws.agents];
		this.agentErrors = [...user.errors, ...ws.errors];
		for (const e of this.agentErrors) this.log.warn(`Agent file error: ${e}`);
		this.emitters.agents.fire();
	}

	// ------------------------------------------------------------ MCP

	mcpConfigFile(scope: McpScope): string | undefined {
		return scope === 'user' ? path.join(AIDE_HOME, 'mcp.json') : this.project ? this.project.dir('mcp.json') : undefined;
	}

	async reloadMcp(): Promise<void> {
		const servers: { name: string; scope: McpScope; config: McpServerConfig }[] = [];
		this.mcpErrors = [];
		for (const scope of ['user', 'workspace'] as McpScope[]) {
			const file = this.mcpConfigFile(scope);
			if (!file) continue;
			const { config: c, error } = readMcpConfig(file);
			if (error) this.mcpErrors.push(error);
			for (const [name, cfg] of Object.entries(c.servers)) servers.push({ name, scope, config: cfg });
		}
		await this.mcp.configure(servers);
		if (config.get<string>('mcp.autoStart', 'onDemand') === 'startup') {
			const errs = await this.mcp.ensureForSelectors(['mcp:*']);
			for (const e of errs) this.log.warn(`MCP start failed: ${e}`);
		}
	}

	private async trustWorkspaceMcp(names: string[]): Promise<boolean> {
		const key = `aide.mcp.trusted:${names.sort().join(',')}`;
		if (this.context.workspaceState.get<boolean>(key)) return true;
		if (!vscode.workspace.isTrusted) return false;
		const pick = await vscode.window.showWarningMessage(
			`This workspace defines MCP servers (${names.join(', ')}) in .aide/mcp.json. They run local commands. Start them?`,
			{ modal: true },
			'Trust and start',
		);
		if (pick) await this.context.workspaceState.update(key, true);
		return !!pick;
	}

	private watchConfigFiles(): void {
		const home = vscode.Uri.file(AIDE_HOME);
		const w1 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(home, '{mcp.json,agents/**}'));
		const w2 = vscode.workspace.createFileSystemWatcher('**/.aide/{mcp.json,agents/**}');
		for (const w of [w1, w2]) {
			const handler = (uri: vscode.Uri) => {
				if (uri.fsPath.endsWith('mcp.json')) void this.reloadMcp();
				else this.reloadAgents();
			};
			w.onDidChange(handler);
			w.onDidCreate(handler);
			w.onDidDelete(handler);
			this.disposables.push(w);
		}
		const files = vscode.workspace.createFileSystemWatcher('**/*');
		const inval = () => this.project?.invalidate();
		files.onDidCreate(inval);
		files.onDidDelete(inval);
		this.disposables.push(files);
	}

	// ------------------------------------------------------------ runs

	startRun(agentId: string, label: string, conversationId?: string): RunHandle {
		const h: RunHandle = { id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, agentId, conversationId, controller: new AbortController(), started: Date.now(), label };
		this.runs.set(h.id, h);
		this.emitters.runs.fire();
		return h;
	}

	endRun(id: string): void {
		this.runs.delete(id);
		this.emitters.runs.fire();
	}

	cancelAll(): number {
		const n = this.runs.size;
		for (const r of this.runs.values()) r.controller.abort();
		return n;
	}

	dispose(): void {
		this.cancelAll();
		this.saveUsage();
		void this.mcp.disposeAll();
		for (const e of Object.values(this.emitters)) e.dispose();
		for (const d of this.disposables) d.dispose();
	}
}
