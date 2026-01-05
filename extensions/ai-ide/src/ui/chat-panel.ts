/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Buffer } from 'buffer';

import { AgentOrchestrator } from '../agents/orchestrator';
import { ChangeManager } from '../execution/change-manager';
import { AgentGroupManager } from '../agents/group-manager';
import { BaseAgent } from '../agents/base-agent';

type ChatRole = 'user' | 'assistant' | 'error';

interface ChatMessage {
	role: ChatRole;
	content: string;
	images?: string[];
}

interface WebviewMessage {
	type: string;
	[key: string]: unknown;
}

export class AIChatPanel implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private messages: ChatMessage[] = [];

	private isProcessing = false;
	private messageQueue: Array<{ text: string; images: string[] }> = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly orchestrator: AgentOrchestrator,
		private readonly changeManager: ChangeManager,
		private readonly groupManager: AgentGroupManager
	) {
		this.loadHistory();
		this.orchestrator.onStatusUpdate(update => {
			this.setWorking(update.working, update.text);
		});
		this.orchestrator.onMessage(msg => {
			this.addMessage(msg.role, msg.content, msg.images);
		});
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri]
		};

		webviewView.webview.html = this.getHtmlContent(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((data: WebviewMessage) => {
			void this.handleMessage(data);
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.syncState();
			}
		});

		this.syncState();
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready': {
					setTimeout(() => {
						this.syncState();
					}, 100);
					break;
				}

				case 'optimizeSystemPrompt': {
					// Use any available agent to optimize a system prompt
					const agent = this.orchestrator.findAgentByName('Coder') ||
						this.orchestrator.findAgentByName('Planner') ||
						(this.orchestrator as any).getAgentByName(Array.from((this.orchestrator as any).agents.keys())[0] as string);

					if (agent && typeof message.prompt === 'string') {
						const result = await (agent as BaseAgent).execute(message.prompt);
						this.postMessage({ type: 'optimizedPrompt', prompt: result, agentId: message.agentId as string });
					}
					break;
				}

				case 'sendMessage': {
					await this.handleUserMessage(
						String(message.text ?? ''),
						(message.images as string[]) ?? []
					);
					break;
				}

				case 'changeGroup': {
					if (typeof message.group === 'string') {
						await this.groupManager.setActiveGroup(message.group);
						await this.orchestrator.reloadActiveGroup();
						this.syncState();
					}
					break;
				}

				case 'changeMode': {
					await this.context.workspaceState.update(
						'executionMode',
						String(message.mode ?? 'plan')
					);
					this.syncState();
					break;
				}

				case 'saveUnsentPrompt': {
					if (typeof message.text === 'string') {
						await this.context.workspaceState.update('unsentPrompt', message.text);
					}
					break;
				}

				case 'optimizeQuery': {
					if (typeof message.text === 'string') {
						await this.handleOptimizeQuery(message.text);
					}
					break;
				}

				case 'stop': {
					this.orchestrator.stop();
					break;
				}

				case 'attachContext': {
					await this.handleAttachContext();
					break;
				}

				case 'openFile': {
					if (typeof message.path === 'string') {
						const absolutePath = path.isAbsolute(message.path) ? message.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', message.path);
						const uri = vscode.Uri.file(absolutePath);
						vscode.window.showTextDocument(uri);
					}
					break;
				}

				case 'applySinglePatch': {
					if (typeof message.path === 'string') {
						const pathStr = message.path as string;
						const patches = this.changeManager.getPendingChanges().filter(p => p.path === pathStr || p.path.endsWith(pathStr));
						if (patches.length > 0) {
							await this.changeManager.applyChanges(patches);
							this.syncState();
						}
					}
					break;
				}

				case 'runFile': {
					if (typeof message.path === 'string') {
						const ext = message.path.split('.').pop();
						let cmd = '';
						if (ext === 'py') { cmd = `python "${message.path}"`; }
						else if (ext === 'js') { cmd = `node "${message.path}"`; }
						else if (ext === 'ts') { cmd = `ts-node "${message.path}"`; }
						else { cmd = message.path; }

						this.changeManager.executeAndAnalyze(cmd);
					}
					break;
				}

				case 'deleteFile': {
					if (typeof message.path === 'string') {
						const absolutePath = path.isAbsolute(message.path) ? message.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', message.path);
						const uri = vscode.Uri.file(absolutePath);
						const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${message.path}?`, { modal: true }, 'Delete');
						if (confirm === 'Delete') {
							await vscode.workspace.fs.delete(uri);
							this.syncState();
						}
					}
					break;
				}

				case 'rejectChanges':
					await this.changeManager.undoLastChange();
					this.changeManager.clearPendingChanges();
					await this.changeManager.clearDecorations();
					this.syncState();
					break;
				case 'feedback':
					// Feedback logic can be added here (e.g. logging to state)
					vscode.window.showInformationMessage(`Feedback received: ${message.value}`);
					break;
				case 'undo': {
					if (this.messages.length === 0) { break; }

					const targetIndex = typeof message.index === 'number' ? message.index : -1;
					console.log(`Undo requested. Target index: ${targetIndex}, current count: ${this.messages.length}`);

					// Identify the user message we are reverting to/removing
					let targetUserMessage: ChatMessage | undefined;
					if (targetIndex !== -1) {
						targetUserMessage = this.messages[targetIndex];
						// Remove messages from the end until we've removed the target user message
						while (this.messages.length > targetIndex) {
							this.messages.pop();
						}
					} else {
						// Default: Remove messages until we've removed exactly one user message
						let removedUser = false;
						while (this.messages.length > 0 && !removedUser) {
							const msg = this.messages.pop();
							if (msg?.role === 'user') {
								removedUser = true;
								targetUserMessage = msg;
							}
						}
					}

					// Sync with orchestrator (removes the last interaction from its history)
					await this.orchestrator.undoLastStep();

					// Revert script changes
					await this.changeManager.revertChanges(targetIndex);
					this.changeManager.clearPendingChanges();

					// Restore the user prompt and context
					if (targetUserMessage) {
						this.postMessage({
							type: 'restoreInput',
							text: targetUserMessage.content,
							images: targetUserMessage.images || []
						});
					}

					this.saveHistory();
					this.syncState();
					break;
				}

				case 'applyChanges': {
					const index = typeof message.index === 'number' ? message.index : undefined;
					await this.changeManager.applyPendingChanges(index);
					this.syncState();
					break;
				}

				case 'startCoding': {
					await this.handleStartCoding();
					break;
				}

				case 'runCommand': {
					const cmd = String(message.command ?? '');

					if (!cmd) {
						break;
					}

					const terminal =
						vscode.window.activeTerminal ??
						vscode.window.createTerminal('AI IDE');

					terminal.show();
					terminal.sendText(cmd);
					break;
				}

				case 'executeAndAnalyze': {
					if (this.isProcessing) {
						this.addMessage('assistant', '_System is busy. Please wait for the current task to finish..._');
						break;
					}
					const cmd = String(message.command ?? '');
					if (!cmd) { break; }

					// Ask for permission first
					const selection = await vscode.window.showInformationMessage(
						`The AI wants to run: ${cmd}\nAllow this command?`,
						{ modal: true },
						'Allow', 'Cancel'
					);

					if (selection !== 'Allow') {
						this.addMessage('assistant', 'Command execution cancelled by user.');
						break;
					}

					void this.handleExecuteAndAnalyze(cmd);
					break;
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Chat Error: ${msg}`);
			this.addMessage('error', `System Error: ${msg}`);
		}
	}

	private async handleExecuteAndAnalyze(cmd: string): Promise<void> {
		this.isProcessing = true;
		this.setWorking(true, `Executing: ${cmd}...`);
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) { throw new Error('No workspace folder open.'); }

			// Show the command in an integrated terminal for user visibility
			const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'AI IDE Runner' });
			terminal.show(true);
			terminal.sendText(cmd, true);

			// Retry loop: run, analyze, apply fixes, re-run until success or attempts exhausted
			let attempt = 0;
			const maxAttempts = 6;
			let lastResult: { success: boolean; output: string; error?: string } | undefined;
			while (attempt < maxAttempts) {
				attempt++;
				this.setWorking(true, `Executing: ${cmd} (attempt ${attempt}/${maxAttempts})...`);
				lastResult = await this.changeManager.executeAndAnalyze(cmd);

				// Display captured output in chat for quick review
				let display = lastResult.output || '';
				if (lastResult.error && lastResult.error.length > 0) {
					display += `\n\nANALYSIS:\n${lastResult.error}`;
				}
				if (!display) { display = 'Command executed with no output.'; }

				this.addMessage('assistant', `Command output (attempt ${attempt}):\n\`\`\`\n${display}\n\`\`\``);

				if (lastResult.success) {
					// Success: clear diagnostics and stop
					this.changeManager.clearDiagnostics();
					this.addMessage('assistant', `✅ Run succeeded on attempt ${attempt}.`);
					break;
				}

				// Not successful: see if there are pending fixes
				let pending = this.changeManager.getPendingChanges();
				if (pending.length === 0) {
					// No fixes available, cannot proceed
					this.addMessage('error', `No suggested fixes found after attempt ${attempt}. Stopping.`);
					break;
				}

				// Show and apply fixes
				for (const patch of pending) {
					if (patch.searchContent && patch.replaceContent) {
						this.addMessage('assistant', `Proposed fix for \`${patch.path}\`:\n\n\`\`\`\n<<<<<<< SEARCH\n${patch.searchContent}\n=======\n${patch.replaceContent}\n>>>>>>> REPLACE\n\`\`\``);
					}
				}

				const enrichedPatches = await this.changeManager.applyDiffsToFiles(pending);
				// Clear pending changes now that applied
				this.changeManager.clearPendingChanges();
				this.postMessage({ type: 'enableApplyButton', patches: enrichedPatches });

				// Small pause to let editors update
				await new Promise(r => setTimeout(r, 1000));
			}

			this.syncState();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.addMessage('error', `Execution Error: ${msg}`);
		} finally {
			this.isProcessing = false;
			this.setWorking(false);
			const next = this.messageQueue.shift();
			if (next) { setTimeout(() => this.processNextInQueue(next.text, next.images), 100); }
		}
	}

	private async handleUserMessage(
		text: string,
		images: string[] = []
	): Promise<void> {
		const userIndex = this.addMessage('user', text, images);

		if (this.isProcessing) {
			this.messageQueue.push({ text, images });
			this.addMessage('assistant', '_Message queued. I will process it as soon as I finish the current task..._');
			return;
		}

		// Handle automated "run and fix" request
		if (text.toLowerCase().includes('make sure it runs with no errors')) {
			await this.handleAutomatedRunFixLoop(userIndex);
			return;
		}

		await this.processNextInQueue(text, images, userIndex);
	}

	private async detectRunCommand(): Promise<string> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		// 1. Prioritize active editor if it's a known script
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			const activeFile = activeEditor.document.uri.fsPath;
			const ext = path.extname(activeFile);
			if (ext === '.py') {
				return `python "${activeFile}"`;
			}
			if (ext === '.js' || (ext === '.ts' && !activeFile.includes('node_modules'))) {
				return `node "${activeFile}"`;
			}
		}

		if (!workspaceRoot) {
			return 'npm start';
		}

		try {
			// Ask the AI to detect the run command based on project files
			const files = fs.readdirSync(workspaceRoot);
			const prompt = `Based on these files in the project root, what is the most likely command to run this project? Return ONLY the command string (e.g. "npm start", "python main.py", "go run .").\nFiles: ${files.join(', ')}`;

			const detectedCmd = await this.orchestrator.executeTask(prompt);
			if (detectedCmd && detectedCmd.length < 50 && !detectedCmd.includes('\n')) {
				// Clean up command: remove backticks, leading symbols like >, $, or #
				return detectedCmd.trim()
					.replace(/^`+|`+$/g, '')
					.replace(/^[>$#]\s*/, '')
					.trim();
			}
		} catch (err) {
			console.error('Failed to detect run command with AI:', err);
		}

		// Fallback heuristic
		if (fs.existsSync(path.join(workspaceRoot, 'package.json'))) {
			const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
			if (pkg.scripts && pkg.scripts.start) {
				return 'npm start';
			}
			if (pkg.scripts && pkg.scripts.dev) {
				return 'npm run dev';
			}
		}
		if (fs.existsSync(path.join(workspaceRoot, 'main.py'))) {
			return 'python main.py';
		}
		if (fs.existsSync(path.join(workspaceRoot, 'app.py'))) {
			return 'python app.py';
		}
		if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
			return 'go run .';
		}
		if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) {
			return 'cargo run';
		}

		return 'npm start';
	}

	private async handleAutomatedRunFixLoop(userIndex?: number): Promise<void> {
		this.isProcessing = true;
		this.setWorking(true, 'Running automated diagnostic loop...');

		const loopLogs: string[] = [];
		const totalFixes: string[] = [];
		const iterationCheckpoints: string[] = [];

		try {
			this.addMessage('assistant', 'Starting automated "Run & Fix" loop...');

			// Detect run command with AI assistance
			const runCmd = await this.detectRunCommand();
			loopLogs.push(`Detected run command: \`${runCmd}\``);

			let loopCount = 0;
			const maxLoops = 3;
			let success = false;

			while (loopCount < maxLoops && !success) {
				loopCount++;
				loopLogs.push(`**Iteration ${loopCount}**: Running \`${runCmd}\`...`);

				const result = await this.changeManager.executeAndAnalyze(runCmd);

				if (result.success) {
					loopLogs.push('✅ Project ran successfully.');
					success = true;
				} else {
					// Clean up the error display - if it starts with "Analyze this..." or similar, just show a summary
					let displayError = result.error || 'Unknown error';
					if (displayError.length > 200) {
						displayError = displayError.substring(0, 200) + '...';
					}
					loopLogs.push(`❌ Error detected: ${displayError}`);

					const pending = this.changeManager.getPendingChanges();
					if (pending.length > 0) {
						loopLogs.push(`Found ${pending.length} suggested fix(es). Applying...`);

						// Show the patches in the chat so the user can see them
						for (const patch of pending) {
							if (patch.searchContent && patch.replaceContent) {
								this.addMessage('assistant', `Proposed fix for \`${patch.path}\`:\n\n\`\`\`python\n<<<<<<< SEARCH\n${patch.searchContent}\n=======\n${patch.replaceContent}\n>>>>>>> REPLACE\n\`\`\``);
							}
						}

						pending.forEach(p => totalFixes.push(p.path));

						const applySuccess = await this.changeManager.applyPendingChanges(userIndex);
						if (!applySuccess) {
							loopLogs.push('Failed to apply suggested fixes. Aborting.');
							break;
						}
						// Track that we made a change this iteration
						iterationCheckpoints.push(totalFixes[totalFixes.length - 1]);
					} else {
						// If no fixes were found, try one more time explicitly asking for a fix
						loopLogs.push('No immediate fix found. Requesting deeper AI analysis...');
						const deepAnalysis = await this.orchestrator.executeTask(`The command \`${runCmd}\` failed with this error:\n\n${result.output}\n\nPlease provide a fix for this.`);
						const patches = await this.changeManager.parsePatchesFromResponse(deepAnalysis);

						if (patches.length > 0) {
							for (const patch of patches) {
								this.changeManager.addPendingChange(patch);
								totalFixes.push(patch.path);

								// Show deep fixes in chat too
								if (patch.searchContent && patch.replaceContent) {
									this.addMessage('assistant', `Deep fix for \`${patch.path}\`:\n\n\`\`\`python\n<<<<<<< SEARCH\n${patch.searchContent}\n=======\n${patch.replaceContent}\n>>>>>>> REPLACE\n\`\`\``);
								}
							}
							loopLogs.push(`Found ${patches.length} deep fix(es). Applying...`);
							const applySuccess = await this.changeManager.applyPendingChanges(userIndex);
							if (!applySuccess) {
								loopLogs.push('Failed to apply deep fixes. Aborting.');
								break;
							}
							iterationCheckpoints.push(totalFixes[totalFixes.length - 1]);
						} else {
							loopLogs.push('AI could not find a fix for this error. Aborting.');
							break;
						}
					}
				}
			}

			// Final Summary Message
			if (success) {
				let summary = `### ✅ Run & Fix Successful\n\nResolved errors after ${loopCount} iteration(s).`;
				if (totalFixes.length > 0) {
					const uniqueFiles = [...new Set(totalFixes)];
					summary += `\n\n**Fixed files:**\n` + uniqueFiles.map(f => `- \`${f}\``).join('\n');
				}
				this.addMessage('assistant', summary);
			} else {
				// Revert all changes made during this loop if it failed
				if (iterationCheckpoints.length > 0) {
					loopLogs.push(`\n**Reverting ${iterationCheckpoints.length} failed iteration(s) to restore original state...**`);
					for (let i = 0; i < iterationCheckpoints.length; i++) {
						await this.changeManager.undoLastChange();
					}
				}

				const summary = `### ❌ Run & Fix Failed\n\nCould not resolve errors after ${loopCount} iteration(s). Original state restored.\n\n**Log Trace:**\n\n` + loopLogs.join('\n');
				this.addMessage('error', summary);
			}

		} catch (err) {
			this.addMessage('error', `Automated loop failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.isProcessing = false;
			this.setWorking(false);
			const next = this.messageQueue.shift();
			if (next) { setTimeout(() => this.processNextInQueue(next.text, next.images), 100); }
		}
	}

	private async processNextInQueue(text: string, images: string[], userIndex?: number): Promise<void> {
		this.isProcessing = true;
		try {
			await this.processTask(text, images, userIndex);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.addMessage('error', `AI Error: ${msg}`);
		} finally {
			this.isProcessing = false;
			const next = this.messageQueue.shift();
			if (next) {
				// Small delay to allow UI to settle
				setTimeout(() => this.processNextInQueue(next.text, next.images), 100);
			}
		}
	}

	private async processTask(text: string, images: string[] = [], userIndex?: number): Promise<void> {
		try {
			const mode =
				this.context.workspaceState.get<string>('executionMode') ?? 'plan';

			let response: string;
			let type: 'plan' | 'implementation' | 'direct' = 'direct';

			if (images.length > 0) {
				response = await this.orchestrator.executeTask(text, images);
			} else if (mode === 'plan') {
				const planResult = await this.orchestrator.generatePlan(text);
				response = planResult.content;
				type = planResult.type;
			} else {
				response = await this.orchestrator.executeTask(text);
			}

			// If the orchestrator returned an empty response, surface that to the user
			if (!response || response.trim().length === 0) {
				// Try one automatic retry and log debug output if still empty
				const debugChannel = vscode.window.createOutputChannel('AI IDE Agent Debug');
				debugChannel.show(true);
				debugChannel.appendLine(`Request produced empty response. Request:\n${text}\n\nAttempting one retry...`);
				const retry = await this.orchestrator.executeTask(text, images);
				if (retry && retry.trim().length > 0) {
					response = retry;
					debugChannel.appendLine('Retry returned non-empty response.');
				} else {
					debugChannel.appendLine('Retry also returned empty. Attempting direct Coder agent for patches...');
					// Try direct coder agent for implementation patches (use public lookup APIs)
					const coder = this.orchestrator.getAgentByName('Coder') || this.orchestrator.findAgentByName('Coder');
					if (coder) {
						const coderPrompt = `STRICT IMPLEMENTATION REQUEST:\n1. Provide ONLY the code implementation with MINIMAL comments.\n2. For existing files, use SEARCH/REPLACE patches.\n3. For new files, return full file blocks.\n4. Output ONLY [FILE: path] blocks and SEARCH/REPLACE patches.\n\nRequest: ${text}`;
						try {
							const coderResp = await (coder as any).execute(coderPrompt, undefined, this.orchestrator.getMessageHistory());
							debugChannel.appendLine('Coder agent response length: ' + String((coderResp || '').length));
							const patches = await this.changeManager.parsePatchesFromResponse(coderResp);
							if (patches.length > 0) {
								for (const p of patches) { this.changeManager.addPendingChange(p); }
								this.addMessage('assistant', 'Coder provided patches. Applying fixes and running tests...');
								const enriched = await this.changeManager.applyDiffsToFiles(patches);
								this.postMessage({ type: 'enableApplyButton', patches: enriched });
								// Automatically run the project to validate fixes
								try {
									const autoCmd = await this.detectRunCommand();
									await this.handleExecuteAndAnalyze(autoCmd);
								} catch (e) {
									console.error('Auto-run after coder patches failed:', e);
								}
								response = 'Applied coder patches and ran project; see results above.';
							} else {
								debugChannel.appendLine('Coder returned no parsable patches. Message history:');
								for (const m of this.orchestrator.getMessageHistory()) { debugChannel.appendLine(`[${m.from} -> ${m.to}] ${m.content}`); }
								response = 'No response from agents after retry and coder fallback. See "AI IDE Agent Debug" output for details.';
								this.addMessage('assistant', response);
								this.syncState();
								return;
							}
						} catch (err) {
							debugChannel.appendLine('Coder agent execution failed: ' + String(err));
							response = 'Fallback to coder agent failed. See "AI IDE Agent Debug" output for details.';
							this.addMessage('assistant', response);
							this.syncState();
							return;
						}
					} else {
						debugChannel.appendLine('No coder agent available. Message history:');
						for (const m of this.orchestrator.getMessageHistory()) { debugChannel.appendLine(`[${m.from} -> ${m.to}] ${m.content}`); }
						response = 'No response from agents and no coder agent available. See "AI IDE Agent Debug" output for details.';
						this.addMessage('assistant', response);
						this.syncState();
						return;
					}
				}
			}

			const patches =
				await this.changeManager.parsePatchesFromResponse(response);

			for (const patch of patches) {
				this.changeManager.addPendingChange(patch);
			}

			this.addMessage('assistant', response);

			if (type === 'plan') {
				this.postMessage({ type: 'showProceedButton' });
			} else {
				this.postMessage({ type: 'hideProceedButton' });
			}

			if (patches.length > 0) {
				// Apply diffs immediately to files with highlighting
				const enrichedPatches = await this.changeManager.applyDiffsToFiles(patches);
				this.postMessage({ type: 'enableApplyButton', patches: enrichedPatches });

				// Automatically run and analyze the project/script after coding changes
				try {
					const autoCmd = await this.detectRunCommand();
					this.addMessage('assistant', `Auto-running after code changes: \`${autoCmd}\``);
					await this.handleExecuteAndAnalyze(autoCmd);
				} catch (err) {
					console.error('Auto run failed:', err);
				}
			} else if (type !== 'plan') {
				this.postMessage({ type: 'disableApplyButton' });
			}

			this.syncState();
			this.postMessage({ type: 'playSound', sound: 'complete' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.addMessage('error', `AI Error: ${msg}`);
		}
	}

	private async handleStartCoding(): Promise<void> {
		let planContent = '';

		// Try to find an open plan.md
		const planDoc = vscode.workspace.textDocuments.find(d =>
			d.uri.scheme === 'ai-plan' || d.fileName.endsWith('plan.md')
		);

		if (planDoc) {
			planContent = planDoc.getText();
		} else {
			// Fallback to last assistant message
			planContent = [...this.messages]
				.reverse()
				.find(m => m.role === 'assistant')?.content ?? '';
		}

		if (!planContent) {
			vscode.window.showWarningMessage("No plan found to implement. Please generate a plan first.");
			return;
		}

		this.addMessage('user', 'Proceed with implementation.');

		this.processTask(`Implement based on this plan:\n${planContent}`).catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			this.addMessage('error', `AI Error: ${msg}`);
		});
	}

	private async handleApplyChanges(): Promise<void> {
		const pending = this.changeManager.getPendingChanges();
		if (pending.length === 0) {
			vscode.window.showInformationMessage('No pending changes to apply.');
			return;
		}

		const success = await this.changeManager.applyPendingChanges();
		if (success) {
			this.addMessage('assistant', 'All changes applied successfully.');
			this.postMessage({ type: 'disableApplyButton' });
		} else {
			this.addMessage('error', 'Failed to apply some changes. Check the logs.');
		}
	}

	private async handleAttachContext(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			openLabel: 'Add Context'
		});

		if (!uris) {
			return;
		}

		for (const uri of uris) {
			const stat = await vscode.workspace.fs.stat(uri);

			if (stat.type !== vscode.FileType.File) {
				continue;
			}

			const ext = uri.path.split('.').pop()?.toLowerCase() ?? '';

			if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
				const content = await vscode.workspace.fs.readFile(uri);
				const b64 = Buffer.from(content).toString('base64');

				this.postMessage({
					type: 'addImage',
					data: `data:image/${ext};base64,${b64}`
				});
			} else {
				const doc = await vscode.workspace.openTextDocument(uri);

				this.postMessage({
					type: 'appendInput',
					text: `\n\n[File: ${vscode.workspace.asRelativePath(
						uri
					)}]\n\`\`\`\n${doc.getText()}\n\`\`\`\n`
				});
			}
		}
	}

	private async handleOptimizeQuery(text: string): Promise<void> {
		this.setWorking(true, 'Optimizing query...');
		try {
			const activeGroup = this.groupManager.getActiveGroup();
			if (!activeGroup || activeGroup.agents.length === 0) {
				throw new Error('No agents available to optimize query.');
			}

			// Pick the first agent that isn't the planner, or just the first one
			const optimizer = activeGroup.agents.find(a => a.role !== 'planner') || activeGroup.agents[0];
			const agent = this.orchestrator.findAgentByName(optimizer.name);

			if (!agent) {
				throw new Error(`Agent ${optimizer.name} not found.`);
			}

			const prompt = `You are a prompt engineering expert. Optimize the following user request to be clear, detailed, and actionable for an AI software planner.
IMPORTANT: Keep the optimized request concise and short (maximum 2-3 sentences). Focus only on the core technical requirements.

User Request: ${text}

Optimized Request:`;

			const optimized = await agent.execute(prompt);
			this.postMessage({ type: 'restoreInput', text: optimized, images: [] });
			await this.context.workspaceState.update('unsentPrompt', optimized);
		} catch (error: any) {
			vscode.window.showErrorMessage(`Optimization failed: ${error.message}`);
		} finally {
			this.setWorking(false);
		}
	}

	public setWorking(working: boolean, text?: string): void {
		this.postMessage({ type: 'setWorking', working, text });
	}

	public syncState(): void {
		if (!this.view) {
			return;
		}

		const groups = this.groupManager
			.getGroups()
			.map(g => g.name)
			.filter((n): n is string => Boolean(n));

		const activeGroup = this.groupManager.getActiveGroup();
		const mode =
			this.context.workspaceState.get<string>('executionMode') ?? 'plan';
		const unsentPrompt = this.context.workspaceState.get<string>('unsentPrompt', '');

		this.postMessage({
			type: 'syncState',
			state: {
				messages: this.messages,
				groups,
				activeGroup: activeGroup?.name ?? '',
				agents: activeGroup?.agents ?? [],
				mode,
				unsentPrompt,
				hasPendingChanges:
					this.changeManager.getPendingChanges().length > 0,
				pendingPatches: this.changeManager.getPendingChanges()
			}
		});
	}

	private postMessage(msg: unknown): void {
		if (this.view) {
			this.view.webview.postMessage(msg);
		}
	}

	private addMessage(
		role: ChatRole,
		content: string,
		images?: string[]
	): number {
		this.messages.push({ role, content, images });
		const index = this.messages.length - 1;
		this.saveHistory();
		this.postMessage({
			type: 'addMessage',
			message: { role, content, images }
		});
		return index;
	}

	private getStorageKey(): string {
		return 'ai-ide.chat.history.v2';
	}

	private loadHistory(): void {
		this.messages =
			this.context.workspaceState.get<ChatMessage[]>(
				this.getStorageKey(),
				[]
			);
	}

	private saveHistory(): void {
		this.context.workspaceState.update(
			this.getStorageKey(),
			this.messages.slice(-50)
		);
	}

	public show(): void {
		void vscode.commands.executeCommand('ai-chat.focus');
	}

	public focus(): void {
		this.show();
	}

	public appendToInput(text: string): void {
		this.postMessage({ type: 'appendInput', text });
	}

	public resetChat(): void {
		this.messages = [];
		this.saveHistory();
		this.syncState();
	}

	private getHtmlContent(webview: vscode.Webview): string {
		const markedUri = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
		const hljsUri = "https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js";
		const hljsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'highlight.js', 'styles', 'atom-one-dark.min.css'));
		const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'AIDE_Logo.png'));

		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui', 'chat.html');
		let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

		// Replace placeholders
		html = html.replace(/\$\{webview\.cspSource\}/g, webview.cspSource);
		html = html.replace(/\$\{hljsCssUri\}/g, hljsCssUri.toString());
		html = html.replace(/\$\{markedUri\}/g, markedUri);
		html = html.replace(/\$\{hljsUri\}/g, hljsUri);
		html = html.replace(/\$\{logoUri\}/g, logoUri.toString());

		return html;
	}
}
