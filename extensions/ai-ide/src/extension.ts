/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AgentOrchestrator } from './agents/orchestrator';
import { PlanningDocumentProvider } from './planning/document-provider';
import { ChangeManager } from './execution/change-manager';
import { AIChatPanel } from './ui/chat-panel';
import { SessionManager } from './state/session-manager';
import { AgentGroupManager } from './agents/group-manager';
import { SelectionContextProvider } from './ui/selection-context';
import { FileTimelineProvider } from './ui/file-timeline';
import { MentionProvider } from './ui/mention-provider';
import { AISettingsPanel } from './ui/settings-panel';
import { AgentGroupPanel } from './ui/agent-group-panel';
import { TaskTreeProvider } from './ui/task-view';

export function activate(context: vscode.ExtensionContext) {
	console.log('AI IDE extension is now active');

	// Initialize core managers
	const agentGroupManager = new AgentGroupManager(context);
	const sessionManager = new SessionManager(context);

	// Initialize components
	const taskProvider = new TaskTreeProvider(context);
	const planningProvider = new PlanningDocumentProvider(context);
	const fileTimeline = new FileTimelineProvider(context);
	const orchestrator = new AgentOrchestrator(context, agentGroupManager, taskProvider, planningProvider);
	const changeManager = new ChangeManager(context, orchestrator);
	const chatPanel = new AIChatPanel(context, orchestrator, changeManager, agentGroupManager);
	const selectionContext = new SelectionContextProvider(context, chatPanel);

	const updateWorkspace = () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (folder) {
			// Don't save if it's the IDE root (contains product.json and START_HERE.md)
			const isIdeRoot =
				vscode.workspace.asRelativePath('product.json') === 'product.json' &&
				vscode.workspace.asRelativePath('START_HERE.md') === 'START_HERE.md';

			if (!isIdeRoot) {
				context.globalState.update('lastWorkspaceFolder', folder);
			}
		}
	};

	updateWorkspace();
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(updateWorkspace));

	// Handle .md file formatting on creation
	context.subscriptions.push(vscode.workspace.onDidCreateFiles(async (e) => {
		for (const file of e.files) {
			if (file.path.endsWith('.md')) {
				const doc = await vscode.workspace.openTextDocument(file);
				await vscode.window.showTextDocument(doc, { preview: false });
				// Format the document
				await vscode.commands.executeCommand('editor.action.formatDocument');
				// Show preview
				await vscode.commands.executeCommand('markdown.showPreview', file);
			}
		}
	}));

	// Restore session
	sessionManager.restoreSession().catch(console.error);

	// Register Commands IMMEDIATELY to avoid "Command not found" errors
	context.subscriptions.push(
		vscode.commands.registerCommand('ai-ide.groupsUpdated', async () => {
			if (orchestrator) { await orchestrator.reloadActiveGroup(); }
			if (chatPanel) { chatPanel.syncState(); }
		}),

		vscode.commands.registerCommand('ai-ide.createPlan', async () => {
			const input = await vscode.window.showInputBox({
				prompt: 'Describe what you want to build',
				placeHolder: 'e.g., Create a REST API with authentication'
			});
			if (input && orchestrator) {
				await orchestrator.generatePlan(input);
			}
		}),

		vscode.commands.registerCommand('ai-ide.applyChanges', async () => {
			if (changeManager) { await changeManager.applyPendingChanges(); }
		}),

		vscode.commands.registerCommand('ai-ide.ingestPatches', async (response: string) => {
			if (!changeManager || !response) { return; }
			const patches = await changeManager.parsePatchesFromResponse(response);
			for (const p of patches) { changeManager.addPendingChange(p); }
		}),

		vscode.commands.registerCommand('ai-ide.applyChangesForce', async () => {
			if (changeManager) { await changeManager.applyPendingChangesForce(); }
		}),

		vscode.commands.registerCommand('ai-ide.openChat', () => {
			if (chatPanel) { chatPanel.focus(); }
		}),

		vscode.commands.registerCommand('ai-ide.openChatPanel', () => {
			if (chatPanel) { chatPanel.show(); }
		}),

		vscode.commands.registerCommand('ai-ide.manageAgentGroups', () => {
			vscode.commands.executeCommand('ai-agent-manager-gui.focus');
		}),

		vscode.commands.registerCommand('ai-ide.switchAgentGroup', async () => {
			if (!agentGroupManager || !chatPanel) { return; }
			const groups = agentGroupManager.getGroups();
			const items = groups.map((g: any) => ({ label: g.name, description: g.name }));
			const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select agent group' });
			if (selected) {
				await agentGroupManager.setActiveGroup(selected.label);
				chatPanel.syncState();
			}
		}),

		vscode.commands.registerCommand('ai-ide.addSelectionToChat', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			if (selectionContext) { await selectionContext.addCurrentSelectionToChat(uri, uris); }
		}),

		vscode.commands.registerCommand('ai-ide.toggleExecutionMode', async () => {
			const currentMode = context.workspaceState.get<string>('executionMode', 'plan');
			const newMode = currentMode === 'plan' ? 'quick' : 'plan';
			await context.workspaceState.update('executionMode', newMode);
			vscode.window.showInformationMessage(`Execution mode: ${newMode}`);
			if (chatPanel) { chatPanel.syncState(); }
		}),

		vscode.commands.registerCommand('ai-ide.editTask', async (node: any) => {
			if (!taskProvider || !node) { return; }
			const newLabel = await vscode.window.showInputBox({
				prompt: 'Edit task name or add comment',
				value: node.label
			});
			if (newLabel) {
				await taskProvider.updateTask(node.taskId, { label: newLabel });
			}
		}),

		vscode.commands.registerCommand('ai-ide.addTask', async () => {
			if (taskProvider) {
				const label = await vscode.window.showInputBox({ prompt: 'Task name' });
				if (label) { await taskProvider.addTask(label); }
			}
		}),

		vscode.commands.registerCommand('ai-ide.clearTasks', async () => {
			if (taskProvider) { await taskProvider.clearTasks(); }
		}),

		vscode.commands.registerCommand('ai-ide.removeTask', async (node: any) => {
			if (taskProvider && node && node.taskId) {
				await taskProvider.removeTask(node.taskId);
			}
		}),

		vscode.commands.registerCommand('ai-ide.optimizeSystemPrompt', async (prompt: string) => {
			if (orchestrator) {
				const agent = orchestrator.findAgentByName('Coder') || orchestrator.findAgentByName('Planner') || orchestrator.findAgentByName('Architect');
				if (agent) {
					return await agent.execute(prompt);
				}
			}
			return null;
		}),

		// Register document providers
		vscode.workspace.registerTextDocumentContentProvider('ai-plan', planningProvider),
		vscode.workspace.registerTextDocumentContentProvider('ai-next-steps', {
			provideTextDocumentContent: (uri: vscode.Uri) => {
				return changeManager.getNextStepsContent(uri);
			}
		}),

		// Register Webview Views
		vscode.window.registerWebviewViewProvider('ai-chat', chatPanel, {
			webviewOptions: { retainContextWhenHidden: true }
		}),

		// Override built-in chat open/focus commands so the default Chat is inaccessible
		vscode.commands.registerCommand('workbench.action.chat.open', async (opts?: any) => {
			if (chatPanel) { chatPanel.focus(); }
		}),
		vscode.commands.registerCommand('workbench.action.chat.focus', async () => {
			if (chatPanel) { chatPanel.focus(); }
		}),

		vscode.window.registerWebviewViewProvider('ai-agent-manager-gui', new AgentGroupPanel(context.extensionUri, agentGroupManager)),
		vscode.window.registerWebviewViewProvider('ai-settings-gui', new AISettingsPanel(context.extensionUri, context, agentGroupManager)),

		// Register tree views
		vscode.window.registerTreeDataProvider('ai-file-timeline', fileTimeline),
		vscode.window.registerTreeDataProvider('ai-tasks', taskProvider)
	);

	// Register a broad set of chat-related command overrides to block access to built-in chat
	const chatCommandsToOverride = [
		'workbench.action.chat.open', 'workbench.action.chat.focus', 'workbench.action.chat.openInSidebar',
		'workbench.action.chat.openInEditor', 'workbench.action.chat.openInNewWindow', 'workbench.action.chat.newChat',
		'workbench.action.chat.openSessionInEditorGroup', 'workbench.action.chat.openSessionInNewEditorGroup',
		'workbench.action.chat.openSessionInNewWindow', 'workbench.action.chat.triggerSetup',
		'workbench.action.chat.triggerSetupAnonymousWithoutDialog', 'workbench.action.chat.upgradePlan',
		'workbench.action.chat.manageOverages', 'workbench.action.chat.focusInput', 'workbench.action.chat.history',
		'workbench.action.chat.cancel', 'workbench.action.chat.submit', 'workbench.action.chat.sendToNewChat',
		'workbench.action.chat.runInTerminal', 'workbench.action.chat.attachContext', 'workbench.action.chat.attachFile',
		'workbench.action.chat.attachSelection', 'workbench.action.chat.copyAll', 'workbench.action.chat.copyItem',
		'workbench.action.chat.export', 'workbench.action.chat.import', 'workbench.action.chat.openModelPicker',
		'workbench.action.chat.openModePicker', 'workbench.action.chat.toggle', 'workbench.action.chat.openStorageFolder',
		'workbench.action.chat.openSessionWithPrompt', 'workbench.action.chat.openNewSessionEditor',
		'workbench.action.chat.openNewSessionSidebar', 'workbench.action.chat.openSessionWithPrompt',
		'workbench.action.chat.pickAgentSession', 'workbench.action.chat.manage', 'workbench.action.chat.generateInstructions'
	];

	for (const cmd of chatCommandsToOverride) {
		try {
			context.subscriptions.push(vscode.commands.registerCommand(cmd, async (..._args: any[]) => {
				if (chatPanel) { chatPanel.focus(); }
			}));
		} catch (err) {
			console.error(`Failed to override command ${cmd}:`, err);
		}
	}

	// Activate selection context provider
	selectionContext.activate();

	// Ensure the custom chat opens immediately on activation
	try {
		chatPanel.focus();
	} catch (e) {
		console.error('Failed to auto-focus AIDE chat:', e);
	}

	// Async initialization for heavy tasks
	(async () => {
		try {
			await agentGroupManager.loadOnStartup();
			await orchestrator.reloadActiveGroup();
			await sessionManager.restoreSession();

			// Restore workspace if needed
			const lastWorkspace = context.globalState.get<string>('lastWorkspaceFolder');
			if ((!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) && lastWorkspace) {
				try {
					const uri = vscode.Uri.file(lastWorkspace);
					await vscode.workspace.fs.stat(uri);
					await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
					return;
				} catch {
					console.log('Last workspace folder no longer exists');
				}
			}

			// Auto-open chat
			if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				const config = vscode.workspace.getConfiguration('ai-ide');
				if (config.get('autoOpenChat', true)) {
					setTimeout(() => chatPanel.focus(), 500);
				}
			}

			console.log('AI IDE initialization complete');
		} catch (err) {
			console.error('Startup initialization failed:', err);
		}
	})();

	// Register completion provider for mentions
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			{ scheme: 'file' },
			new MentionProvider(context),
			'#'
		)
	);

	// Save session on deactivation
	context.subscriptions.push({
		dispose: () => {
			sessionManager.saveSession().catch(err => console.error('Failed to save session:', err));
		}
	});
}

export function deactivate() {
	console.log('AI IDE extension is now deactivated');
}
