import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatController } from './chat/controller';
import { ConnectorRegistry, ConnectorsView, GitHubConnector, GoogleDriveConnector } from './connectors/connectors';
import * as config from './core/config';
import { registerProfile } from './core/profile';
import { createApi, type AideApi } from './extensions/api';
import { ExtensionBuilder } from './extensions/builder';
import { registerAiGit } from './git/aiGit';
import { GitHubClient, githubTools, GitHubView } from './github/github';
import { InlineAi } from './inline/inlineAi';
import { registerTemplates } from './project/templates';
import { AIDE_HOME, previewDocs, PreviewDocs, Services } from './services';
import { debugTools } from './tools/debugTools';
import { ideTools } from './tools/ideTools';
import { registerDevTools } from './tools/devtools';
import { ChangesView } from './ui/changesView';
import { ChatViewProvider } from './ui/chatView';
import { InspectorPanel, UsagePanel } from './ui/dataPanels';
import { SettingsPanel } from './ui/settingsPanel';
import { registerStatusBar } from './ui/statusBar';
import { AgentsView, CheckpointsView, McpView } from './ui/treeViews';
import { registerLayouts } from './ui/workbench';
import { LanguageSupport } from './vscode/languageSupport';
import { registerAutomations, Workflows } from './workflows/workflows';

let services: Services | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<AideApi> {
	const started = Date.now();
	const s = new Services(ctx);
	services = s;
	ctx.subscriptions.push(s, vscode.workspace.registerTextDocumentContentProvider(PreviewDocs.scheme, previewDocs));

	// Chat
	const chat = new ChatController(s);
	const chatView = new ChatViewProvider(s, chat);
	ctx.subscriptions.push(chat, vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }));
	const sendToChat = (agentId: string, prompt: string) => {
		void chat.setSelection({ agentId }).then(() => chatView.insertIntoComposer(prompt, true));
	};

	// Tools that need IDE services
	for (const t of [...debugTools(), ...ideTools()]) s.tools.register(t);
	const gh = new GitHubClient(s);
	for (const t of githubTools(gh)) s.tools.register(t);

	// Connectors (+ @doc: resolution, gated by the "external" permission)
	const connectors = new ConnectorRegistry();
	ctx.subscriptions.push(connectors.register(new GitHubConnector(gh)), connectors.register(new GoogleDriveConnector(s)));
	chat.setDocResolver(async ref => {
		const i = ref.indexOf(':');
		const c = connectors.get(ref.slice(0, i));
		if (!c) return undefined;
		const ok = await s.permissions.check({ category: 'external', toolName: `connector_${c.id}`, agentId: 'context', summary: `Read ${c.name} document ${ref.slice(i + 1)} into AI context` });
		if (!ok.allowed) return undefined;
		const content = await c.read(ref.slice(i + 1));
		return { label: `${c.name}: ${content.name}`, content: content.text ?? `[binary ${content.mimeType ?? ''} - not included]` };
	});

	// Views
	new ChangesView(s).register(ctx);
	new CheckpointsView(s).register(ctx);
	new McpView(s).register(ctx);
	new AgentsView(s).register(ctx, agentId => {
		// "/<agent>" in the composer pins the agent for that message; Auto stays on afterwards.
		chatView.insertIntoComposer(`/${agentId} `);
	});
	const ghView = new GitHubView(s, gh, sendToChat);
	ghView.register(ctx);
	new ConnectorsView(s, connectors, text => chatView.insertIntoComposer(text)).register(ctx);

	// Editor AI, Git, workflows, extensions, workbench
	new InlineAi(s, chat, (text, send) => chatView.insertIntoComposer(text, send)).register(ctx);
	registerAiGit(ctx, s, sendToChat);
	const workflows = new Workflows(s, chat, async () => vscode.commands.executeCommand('aide.github.createPR'));
	ctx.subscriptions.push(workflows);
	registerAutomations(ctx, s, workflows, chat);
	const builder = new ExtensionBuilder(s, chat);
	builder.register(ctx);
	registerLayouts(ctx);
	registerProfile(ctx, s);
	registerTemplates(ctx);
	registerDevTools(ctx);
	new LanguageSupport(ctx).register();
	registerStatusBar(ctx, s, chat);
	registerCommands(ctx, s, chat, chatView, workflows);

	// Background: discover models without blocking startup.
	setTimeout(() => void s.refreshModels(), 1500);
	// The secondary side bar can be restored before the chat view is instantiated, which leaves it
	// blank; reveal the chat once (then hand focus back to the editor) so the default layout is complete.
	setTimeout(async () => {
		if (chatView.resolved || !config.get<boolean>('chat.openOnStartup', true)) return;
		await vscode.commands.executeCommand('aide.chat.focus');
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	}, 2500);
	s.log.info(`AIDE activated in ${Date.now() - started}ms (workspace: ${s.root ?? 'none'})`);
	void maybeWelcome(ctx, s);
	const api = createApi(s, chat, connectors, workflows);
	// Integration tests reach internals; never exposed in normal runs.
	if (process.env.AIDE_TEST === '1') Object.assign(api, { _internals: { services: s, chat, workflows, connectors, builder } });
	return api;
}

function registerCommands(ctx: vscode.ExtensionContext, s: Services, chat: ChatController, chatView: ChatViewProvider, workflows: Workflows): void {
	const reg = (id: string, fn: (...a: any[]) => unknown) =>
		ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a: any[]) => {
			try {
				return await fn(...a);
			} catch (e) {
				s.log.error(`Command ${id} failed`, e);
				void vscode.window.showErrorMessage(`AIDE: ${(e as Error).message}`);
			}
		}));

	reg('aide.chat.new', () => {
		chat.newConversation();
		chatView.reveal();
	});
	reg('aide.chat.open', () => chatView.reveal());
	reg('aide.chat.addSelection', () => {
		const ed = vscode.window.activeTextEditor;
		if (!ed) return;
		const rel = vscode.workspace.asRelativePath(ed.document.uri);
		chatView.insertIntoComposer(ed.selection.isEmpty ? `@file:${/\s/.test(rel) ? `"${rel}"` : rel} ` : '@selection ');
	});
	reg('aide.chat.addTerminalSelection', async () => {
		// The terminal API has no selection getter: copy through the clipboard, then restore it.
		const saved = await vscode.env.clipboard.readText();
		await vscode.env.clipboard.writeText('');
		await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
		let text = await vscode.env.clipboard.readText();
		await vscode.env.clipboard.writeText(saved);
		let label = 'Terminal selection';
		if (!text.trim()) {
			const last = s.capture.last();
			if (!last) return void vscode.window.showInformationMessage('Select text in the terminal first (or run a command).');
			text = `$ ${last.command}\n${last.output.trimEnd()}${last.exitCode !== undefined ? `\n[exit code ${last.exitCode}]` : ''}`;
			label = 'Last command output';
		}
		if (/error|exception|traceback|failed/i.test(text)) label = 'Error output';
		chatView.attach({ kind: 'terminal', label, text: text.replace(/\r\n/g, '\n') });
	});
	reg('aide.chat.openLog', () => chat.openLog());
	reg('aide.chat.openLogsFolder', () => {
		fs.mkdirSync(chat.log.dir, { recursive: true });
		return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(chat.log.dir));
	});
	reg('aide.memory.openUser', async () => {
		const file = path.join(AIDE_HOME, 'memory.md');
		if (!fs.existsSync(file)) fs.writeFileSync(file, '# Personal memory\n\nFacts AIDE should remember in every project (your preferences, tools, conventions). Edit freely.\n');
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	});
	reg('aide.chat.addFile', (uri?: vscode.Uri) => {
		const u = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!u) return;
		const rel = vscode.workspace.asRelativePath(u);
		const isDir = fs.existsSync(u.fsPath) && fs.statSync(u.fsPath).isDirectory();
		chatView.insertIntoComposer(`@${isDir ? 'folder' : 'file'}:${/\s/.test(rel) ? `"${rel}"` : rel} `);
	});
	reg('aide.chat.ask', async () => {
		const q = await vscode.window.showInputBox({ prompt: 'Ask AIDE', placeHolder: 'Question about your code (use @file:..., @selection, @errors...)' });
		if (q) chatView.insertIntoComposer(q, true);
	});
	reg('aide.chat.cancel', () => chat.cancel());
	reg('aide.agent.stopAll', () => {
		const n = s.cancelAll();
		void vscode.window.setStatusBarMessage(n ? `AIDE: stopped ${n} AI operation(s)` : 'AIDE: nothing running', 3000);
	});
	reg('aide.agent.run', async () => {
		const pick = await vscode.window.showQuickPick(s.agents().map(a => ({ label: a.name, description: a.source, detail: a.description, id: a.id })), { placeHolder: 'Run which agent?' });
		if (!pick) return;
		const prompt = await vscode.window.showInputBox({ prompt: `Task for ${pick.label}` });
		if (!prompt) return;
		await chat.setSelection({ agentId: pick.id });
		chatView.insertIntoComposer(prompt, true);
	});
	reg('aide.agent.select', async () => {
		const items = [{ label: '$(sparkle) Auto', detail: 'Choose the agent for each message from what it asks (recommended)', id: 'auto' }, ...s.agents().map(a => ({ label: a.name, detail: a.description, id: a.id }))];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: `Agent for every chat message (now: ${chat.agentMode})` });
		if (pick) await chat.setSelection({ agentMode: pick.id });
	});
	reg('aide.model.select', async () => {
		if (!s.allModelRefs().length) await s.refreshModels();
		const items = [{ label: '$(sparkle) Auto (a model per task)', ref: '' }, ...s.allModelRefs().map(m => ({ label: `${m.local ? '$(vm) ' : '$(cloud) '}${m.ref}`, description: m.info.contextWindow ? `${Math.round(m.info.contextWindow / 1000)}k ctx` : '', detail: (m.info.capabilities ?? []).join(', '), ref: m.ref }))];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Model for AIDE chat (routing still falls back on errors)', matchOnDetail: true });
		if (pick) await chat.setSelection({ model: pick.ref || null });
		void vscode.commands.executeCommand('aide.internal.refreshStatus');
	});
	reg('aide.model.refresh', () => s.refreshModels());
	reg('aide.settings.open', (tab?: string) => SettingsPanel.show(s, typeof tab === 'string' ? tab : undefined));
	reg('aide.settings.openJson', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:aide.aide-core'));
	reg('aide.usage.open', () => UsagePanel.show(s, s.toolStats));
	reg('aide.inspector.open', (id?: string) => InspectorPanel.show(s, typeof id === 'string' ? id : undefined));
	reg('aide.secret.store', async () => {
		const name = await vscode.window.showInputBox({ prompt: 'Secret name (use it in MCP config as ${secret:name})', validateInput: v => (/^[\w.-]+$/.test(v) ? undefined : 'letters, digits, . - _') });
		if (!name) return;
		const value = await vscode.window.showInputBox({ prompt: `Value for ${name} (stored in the OS keychain)`, password: true });
		if (value === undefined) return;
		await s.setSecret(name, value || undefined);
		void vscode.window.showInformationMessage(value ? `Stored secret "${name}".` : `Deleted secret "${name}".`);
	});

	// logs
	reg('aide.logs.show', () => s.log.show());
	reg('aide.logs.copy', async () => {
		await vscode.env.clipboard.writeText(s.log.asText());
		void vscode.window.showInformationMessage('AIDE logs copied to the clipboard.');
	});
	reg('aide.logs.export', async () => {
		const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(s.log.dir, `aide-log-${Date.now()}.txt`)), filters: { Text: ['txt'] } });
		if (target) fs.writeFileSync(target.fsPath, s.log.asText());
	});
	reg('aide.logs.openFolder', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.log.file)));
	reg('aide.logs.clear', () => s.log.clear());

	// project context
	reg('aide.project.init', async () => {
		if (!s.project) return void vscode.window.showWarningMessage('Open a folder first.');
		s.project.ensureScaffold();
		await vscode.window.showTextDocument(vscode.Uri.file(s.project.dir('instructions.md')));
	});
	reg('aide.project.openInstructions', async () => {
		if (!s.project) return void vscode.window.showWarningMessage('Open a folder first.');
		s.project.ensureScaffold();
		await vscode.window.showTextDocument(vscode.Uri.file(s.project.dir('instructions.md')));
	});
	reg('aide.project.openMemory', async () => {
		if (!s.project) return void vscode.window.showWarningMessage('Open a folder first.');
		s.project.ensureScaffold();
		await vscode.window.showTextDocument(vscode.Uri.file(s.project.dir('memory.md')));
	});
	reg('aide.project.analyze', async () => {
		if (!s.project) return void vscode.window.showWarningMessage('Open a folder first.');
		s.project.ensureScaffold();
		await chat.setSelection({ agentId: 'docs' });
		chatView.reveal();
		await chat.send({
			agentId: 'docs',
			newConversation: true,
			strategy: 'balanced',
			text: `Onboard me to this repository. Investigate it (read key files, configs, entry points, tests) and write .aide/context/project-map.md containing:
## Overview (what it is)
## Architecture (components and how they interact)
## How to build, run and test (exact commands)
## Important files and directories
## Development workflow and conventions
Then add 3-8 durable facts (build/test commands, conventions, gotchas) to project memory with update_project_memory. Finish with a short summary. @workspace`,
		});
	});

	// workflows
	reg('aide.workflows.run', (name?: string) => workflows.pickAndRun(typeof name === 'string' ? name : undefined));
	reg('aide.workflows.new', () => workflows.newWorkflow());
	reg('aide.welcome', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'aide.aide-core#aide.welcome', false));
}

async function maybeWelcome(ctx: vscode.ExtensionContext, s: Services): Promise<void> {
	if (ctx.globalState.get<boolean>('aide.welcomed')) return;
	await ctx.globalState.update('aide.welcomed', true);
	if (config.get<boolean>('welcome.show', true)) {
		await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'aide.aide-core#aide.welcome', false).then(undefined, e => s.log.warn(`walkthrough: ${e}`));
	}
}

export async function deactivate(): Promise<void> {
	if (!services) return;
	services.cancelAll();
	services.saveUsage();
	await services.mcp.disposeAll();
}
