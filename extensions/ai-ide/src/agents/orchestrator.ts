/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AgentGroupManager } from './group-manager';
import { BaseAgent } from './base-agent';
import { ProjectAnalyzer } from '../services/project-analyzer';
import { DependencyAnalyzer } from '../services/dependency-analyzer';

import { TaskTreeProvider } from '../ui/task-view';
import { PlanningDocumentProvider } from '../planning/document-provider';

export interface AgentMessage {
	from: string;
	to: string;
	content: string;
	timestamp: Date;
	context?: any;
}

export class AgentOrchestrator {
	private agents: Map<string, BaseAgent> = new Map();
	private messageHistory: AgentMessage[] = [];
	private projectAnalyzer: ProjectAnalyzer;
	private dependencyAnalyzer: DependencyAnalyzer;
	private activeTasks: Set<string> = new Set();
	private _onStatusUpdate: vscode.EventEmitter<{ working: boolean; text?: string; taskId?: string }> = new vscode.EventEmitter();
	public readonly onStatusUpdate = this._onStatusUpdate.event;

	private _onMessage: vscode.EventEmitter<{ role: 'user' | 'assistant' | 'error'; content: string; images?: string[]; taskId?: string }> = new vscode.EventEmitter();
	public readonly onMessage = this._onMessage.event;

	constructor(
		private context: vscode.ExtensionContext,
		private groupManager: AgentGroupManager,
		private taskProvider?: TaskTreeProvider,
		private planningProvider?: PlanningDocumentProvider
	) {
		this.projectAnalyzer = new ProjectAnalyzer();
		this.dependencyAnalyzer = new DependencyAnalyzer();
	}

	public async loadGroup(groupName: string): Promise<void> {
		const group = this.groupManager.getGroups().find((g: any) => g.name === groupName);
		if (!group) { return; }

		this.agents.clear();
		for (const agentConfig of group.agents) {
			const agent = new BaseAgent(this.context, agentConfig, this);
			this.agents.set(agentConfig.name, agent);
		}
	}

	public async reloadActiveGroup(): Promise<void> {
		const active = this.groupManager.getActiveGroup();
		if (active) {
			await this.loadGroup(active.name);
		}
	}

	public async executeTask(task: string, images?: string[], taskId?: string): Promise<string> {
		const id = taskId || Math.random().toString(36).substring(7);
		this.activeTasks.add(id);
		this._onStatusUpdate.fire({ working: true, text: 'Orchestrating task...', taskId: id });

		try {
			this.recordMessage('user', 'orchestrator', task);

			const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
			const projectContext = workspaceUri ? await this.projectAnalyzer.analyze(workspaceUri) : {};
			const relevantFiles = await this.detectRelevantFiles(task);
			const dependencies = await this.dependencyAnalyzer.analyzeDependencies();
			const repoMap = workspaceUri ? await this.projectAnalyzer.getRepositoryMap(workspaceUri) : "";
			const context = { projectContext, relevantFiles, dependencies, repoMap };

			// If images are present, route to image_agent or describing logic FIRST
			let enhancedTask = task;

			// If user asked explicitly to fix errors, run automated fix workflow
			if (/fix\s+errors?/i.test(task) || /fix\s+the\s+build/i.test(task)) {
				const res = await this.fixErrorsUntilClean();
				return res;
			}
			if (images && images.length > 0) {
				const visualContext = await this.routeToImageAgent(task, images, projectContext);
				enhancedTask = `[Visual Context: ${visualContext}]\n\n${task}`;
			}

			const isSimple = this.isSimpleTask(enhancedTask);
			if (isSimple) {
				const coder = this.findAgentByRole('coder') || Array.from(this.agents.values())[0];
				if (coder) {
					const finalRequest = this.getCoderRequest(enhancedTask);
					return await coder.execute(finalRequest, context, this.getMessageHistory(), (update: string) => {
						this._onStatusUpdate.fire({ working: true, text: `Coder: ${update}`, taskId: id });
					});
				}
			}

			const roleLabel = this.selectAgentForTask(enhancedTask);
			const agent = this.findAgentByRole(roleLabel) || Array.from(this.agents.values())[0];

			if (!agent) { throw new Error('No agents available in current group.'); }

			const finalTask = (roleLabel === 'coder' || roleLabel === 'fixer' || roleLabel === 'designer')
				? this.getCoderRequest(enhancedTask)
				: enhancedTask;

			const response = await agent.execute(finalTask, context, this.getMessageHistory(), (update: string) => {
				this._onStatusUpdate.fire({ working: true, text: `${agent.config.name}: ${update}`, taskId: id });
			});

			this.recordMessage(agent.config.name, 'user', response);
			return response;
		} finally {
			this.activeTasks.delete(id);
			this._onStatusUpdate.fire({ working: this.activeTasks.size > 0, taskId: id });
		}
	}

	public async generatePlan(request: string, images?: string[]): Promise<{ type: 'plan' | 'implementation'; content: string }> {
		this._onStatusUpdate.fire({ working: true, text: 'Analyzing task scale...' });
		try {
			this.recordMessage('user', 'orchestrator', request);

			const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
			const projectContext = workspaceUri ? await this.projectAnalyzer.analyze(workspaceUri) : {};
			const relevantFiles = await this.detectRelevantFiles(request);
			const dependencies = await this.dependencyAnalyzer.analyzeDependencies();
			const repoMap = workspaceUri ? await this.projectAnalyzer.getRepositoryMap(workspaceUri) : "";
			const context = { projectContext, relevantFiles, dependencies, repoMap };

			let enhancedRequest = request;
			if (images && images.length > 0) {
				const visualDescription = await this.routeToImageAgent("Analyze this UI/Diagram for planning.", images, projectContext);
				enhancedRequest = `Visual Context: ${visualDescription}\n\nPlan for: ${request}`;
			}

			// 1. Determine Scale: If simple, skip estimation and go to implementation
			if (this.isSimpleTask(enhancedRequest)) {
				console.log(`Task detected as simple, bypassing planning.`);
				return await this.executeDirectImplementation(enhancedRequest, context);
			}

			const planner = this.agents.get('Planner') || this.findAgentByRole('planner') || this.findAgentByRole('architect') || Array.from(this.agents.values())[0];
			if (!planner) { throw new Error('No planner agent available.'); }

			const scalePrompt = `Analyze the following request and estimate how many files need to be created or modified.
Response format: JUST THE NUMBER.
Request: ${enhancedRequest}`;

			const scaleResponse = await planner.execute(scalePrompt, context, this.getMessageHistory());
			const fileCount = parseInt(scaleResponse.trim()) || 1;

			console.log(`Task scale analysis: ${fileCount} files estimated.`);

			// 2. Logic: Direct Implementation (Coder)
			// We skip the planner's scale analysis if it's a simple task or if we want to prioritize Coder.
			// Even for multi-file tasks, we now route to Coder if we want to "reduce wait times" by avoiding the planner.
			// If fileCount >= 3 and mode is 'plan', we might still want a plan, but the user said "No agents but the Coder agent should code".
			// This means we should ensure that ONLY the coder handles the implementation.

			if (fileCount <= 2 || true) { // Force direct implementation for now to satisfy "No agents but Coder should code" and reduce wait
				return await this.executeDirectImplementation(enhancedRequest, context);
			} else {
				// 3+ files: Generate a plan WITHOUT code.
				this._onStatusUpdate.fire({ working: true, text: 'Generating multi-file plan...' });
				const planningRequest = `STRICT PLANNING REQUEST:
Create a detailed implementation plan in Markdown for a multi-file task (${fileCount} files estimated).
1. Use a structured task list with checkboxes [ ].
2. Briefly explain the architectural approach.
3. List all files that will be modified.
4. IMPORTANT: DO NOT include any code blocks, implementation details, or scripts in this plan. Focus ONLY on the steps and architecture.
5. Output ONLY the plan.

Request: ${enhancedRequest}`;

				return await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "AI IDE: Architecting implementation plan...",
					cancellable: true
				}, async (progress) => {
					const plan = await planner.execute(planningRequest, context, this.getMessageHistory(), (update: string) => {
						progress.report({ message: update });
						this._onStatusUpdate.fire({ working: true, text: `Planner: ${update}` });
					});

					this.recordMessage(planner.config.name, 'user', plan);

					// Populate Task View
					if (this.taskProvider) {
						await this.taskProvider.clearTasks();
						const taskMatches = plan.match(/^\s*[-*]\s*\[\s*\]\s+(.+)$/gm);
						if (taskMatches) {
							for (const m of taskMatches) {
								const label = m.replace(/^\s*[-*]\s*\[\s*\]\s+/, '').trim();
								await this.taskProvider.addTask(label, "Extracted from plan");
							}
						}
					}

					// Open planning document via provider
					if (this.planningProvider) {
						await this.planningProvider.createPlan(plan);
						vscode.window.showInformationMessage("Plan generated. Please review and edit plan.md, then click 'Start Coding' to execute.", "OK");
					}

					return { type: 'plan', content: plan };
				});
			}
		} finally {
			this._onStatusUpdate.fire({ working: false });
		}
	}

	private getCoderRequest(task: string): string {
		return `STRICT IMPLEMENTATION REQUEST:
1. Provide ONLY the code implementation with MINIMAL but helpful comments.
2. For existing files, use SEARCH/REPLACE patches.
3. For new files, use the full file format.
4. Output ONLY the file blocks. No conversational text, no explanations, no "Here is the code".
5. If you need to run a command, use [COMMAND: command].

For each change, use this format EXACTLY:
[FILE: path]
\`\`\`
<<<<<<< SEARCH
old code here
=======
new code here
>>>>>>> REPLACE
\`\`\`

OR for new files:
[FILE: path]
\`\`\`
full code here
\`\`\`

Request: ${task}`;
	}

	private async routeToImageAgent(task: string, images: string[], context: any): Promise<string> {
		this._onStatusUpdate.fire({ working: true, text: 'Image Agent analyzing...' });
		try {
			let visionAgent = this.agents.get('Image_Agent');
			if (!visionAgent) {
				visionAgent = this.findAgentByRole('vision') || this.findAgentByRole('image');
			}

			if (!visionAgent) {
				const msg = "NO VISION AGENT FOUND: Please add an agent with 'vision' or 'image' roles (e.g., GPT-4o, Claude 3.5 Sonnet) to analyze screenshots or diagrams.";
				vscode.window.showErrorMessage(msg, 'Open Settings').then(selection => {
					if (selection === 'Open Settings') {
						vscode.commands.executeCommand('ai-ide.openSettings');
					}
				});
				throw new Error(msg);
			}

			// Refined, concise image agent prompt to minimize output tokens
			// Request compact JSON with very short fields and an explicit overall length limit.
			const intentPrompt = `IMAGE ANALYSIS TASK: Compact Technical Summary (short, precise)
User's Goal: ${task}
Context: Analyzing ${images.length} technical images/screenshots.

OUTPUT FORMAT (MANDATORY): Return a compact JSON object with these keys only: ` +
				`{"summary":"", "elements":[], "issues":[], "recommendation":""}` +
				` where values are short strings or arrays of short strings.

CONSTRAINTS:
- Keep the entire response under 150 words (very concise).
- Keep each string value under ~30 words.
- Use short phrases, not full sentences where possible.
- No additional text, headers, examples, or explanations — ONLY the JSON object.

Instructions for Analysis (brief):
1. Visual Fidelity: report key colors (hex or very short name) only if relevant.
2. Layout: single-line descriptor (e.g., "two-column grid, centered header").
3. Elements: list visible UI components as short tokens (button, input, label).
4. Platform: one-word guess if confident (Windows/macOS/Web) else omit.
5. Focus on details that impact the user's goal: ${task}.

Output ONLY the compact JSON object described above.`;

			const result = await visionAgent.execute(intentPrompt, context);

			// Post-process the vision agent output to ensure brevity in history and downstream use.
			let conciseSummary = '';
			try {
				const parsed = JSON.parse(result);
				// Prefer `summary` field, otherwise build short combined summary
				if (parsed && typeof parsed === 'object') {
					if (parsed.summary && typeof parsed.summary === 'string') {
						conciseSummary = parsed.summary;
					} else {
						const parts: string[] = [];
						if (Array.isArray(parsed.elements) && parsed.elements.length) {
							parts.push((parsed.elements as string[]).slice(0, 6).join(', '));
						}
						if (Array.isArray(parsed.issues) && parsed.issues.length) {
							parts.push((parsed.issues as string[]).slice(0, 4).join(', '));
						}
						if (parsed.recommendation) { parts.push(String(parsed.recommendation)); }
						conciseSummary = parts.join(' | ');
					}
				} else {
					conciseSummary = String(result).slice(0, 400);
				}
			} catch (e) {
				// Not JSON — fallback to truncation
				conciseSummary = String(result).slice(0, 400);
			}

			// Trim to a safe length
			const maxLen = 600;
			if (conciseSummary.length > maxLen) { conciseSummary = conciseSummary.slice(0, maxLen) + '...'; }

			// Do NOT append the image summary to the visible chat history or fire a chat message
			// Keep the concise summary local for downstream agents only (returned below).

			// Return the concise summary so downstream agents see a short visual context
			return conciseSummary;
		} finally {
			this._onStatusUpdate.fire({ working: false });
		}
	}

	/**
	 * Attempt to fix workspace diagnostics by iteratively requesting patches from the coder
	 * and applying them until diagnostics are cleared or max attempts reached.
	 */
	public async fixErrorsUntilClean(maxAttempts: number = 6): Promise<string> {
		this._onStatusUpdate.fire({ working: true, text: 'Attempting to fix workspace errors...' });
		try {
			const coder = this.findAgentByRole('coder') || Array.from(this.agents.values())[0];
			if (!coder) { throw new Error('No coder agent available to fix errors.'); }

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				this._onStatusUpdate.fire({ working: true, text: `Fix attempt ${attempt}/${maxAttempts}...` });

				// Collect diagnostics
				const allDiagnostics = vscode.languages.getDiagnostics();
				const diagEntries: Array<{ path: string; messages: string[] }> = [];
				for (const [uri, diags] of allDiagnostics) {
					if (!diags || diags.length === 0) { continue; }
					const rel = vscode.workspace.asRelativePath(uri);
					const messages = diags.slice(0, 10).map(d => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`);
					diagEntries.push({ path: rel, messages });
				}

				if (diagEntries.length === 0) {
					return 'No diagnostics found — workspace is clean.';
				}

				// Build a concise fix request for the coder
				let diagSummary = '';
				for (const e of diagEntries) {
					diagSummary += `File: ${e.path}\n`;
					for (const m of e.messages) { diagSummary += `- ${m}\n`; }
					diagSummary += '\n';
				}

				const fixPrompt = `Fix the following diagnostics. For each file, provide fixes using the exact SEARCH/REPLACE format and [FILE: path] block as required by the extension.
${diagSummary}
IMPORTANT: Output ONLY one or more [FILE: path] blocks with either SEARCH/REPLACE or full new file contents. Do NOT include extra commentary.`;

				const coderRequest = this.getCoderRequest(fixPrompt);
				const response = await coder.execute(coderRequest, undefined, this.getMessageHistory(), (u: string) => {
					this._onStatusUpdate.fire({ working: true, text: `Coder: ${u}` });
				});

				// Send the response to the ChangeManager by command that ingests patches and force-applies them
				await vscode.commands.executeCommand('ai-ide.ingestPatches', response);
				await vscode.commands.executeCommand('ai-ide.applyChangesForce');

				// Give the editor/diagnostic providers a moment to re-evaluate
				await new Promise(r => setTimeout(r, 1500));

				// Optionally trigger a build task to regenerate diagnostics
				try {
					await vscode.commands.executeCommand('workbench.action.tasks.runTask', 'VS Code - Build');
				} catch (e) {
					// Ignore if task couldn't be started
				}

				// Wait and re-evaluate diagnostics
				await new Promise(r => setTimeout(r, 3000));
			}

			return 'Reached maximum fix attempts. Please review remaining diagnostics.';
		} finally {
			this._onStatusUpdate.fire({ working: false });
		}
	}

	private async detectRelevantFiles(request: string): Promise<string[]> {
		const relevantFiles: string[] = [];
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) { return []; }

		// Extract file mentions from request
		const filePattern = /(?:file|in|modify|update|edit)\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)/gi;
		let match;
		while ((match = filePattern.exec(request)) !== null) {
			relevantFiles.push(match[1]);
		}

		// Include currently open files
		for (const editor of vscode.window.visibleTextEditors) {
			relevantFiles.push(vscode.workspace.asRelativePath(editor.document.uri));
		}

		return Array.from(new Set(relevantFiles)).slice(0, 10);
	}

	public isSimpleTask(task: string): boolean {
		const lower = task.toLowerCase();
		const codingKeywords = [
			'code', 'implement', 'write', 'create', 'add', 'fix', 'modify', 'update',
			'refactor', 'delete', 'remove', 'script', 'function', 'class', 'method'
		];
		const simpleKeywords = [
			'comment', 'typo', 'rename', 'log', 'console.log', 'print',
			'change text', 'update version', 'small fix', 'refactor this line'
		];

		// If it's a direct coding request and not too long, consider it simple enough for direct execution
		const isCodingRequest = codingKeywords.some(k => lower.includes(k));
		const isShort = task.length < 500;
		const matchesSimple = simpleKeywords.some(k => lower.includes(k));

		return (matchesSimple && isShort) || (isCodingRequest && task.length < 150);
	}

	private async executeDirectImplementation(request: string, context: any): Promise<{ type: 'implementation'; content: string }> {
		this._onStatusUpdate.fire({ working: true, text: 'Executing direct implementation...' });
		const coder = this.findAgentByRole('coder') || Array.from(this.agents.values())[0];
		if (!coder) { throw new Error('No coder agent available.'); }

		const coderRequest = this.getCoderRequest(request);
		const implementation = await coder.execute(coderRequest, context, this.getMessageHistory(), (update: string) => {
			this._onStatusUpdate.fire({ working: true, text: `Coder: ${update}` });
		});
		this.recordMessage(coder.config.name, 'user', implementation);
		return { type: 'implementation', content: implementation };
	}

	private selectAgentForTask(task: string): string {
		const lower = task.toLowerCase();

		// 1. Text/Summary/Planning/Review -> Planner
		// Only use planner if explicitly asked for meta-tasks, NOT for implementation
		const planningKeywords = ['plan', 'summarize', 'explain', 'analyze', 'review', 'describe', 'architect', 'how to', 'what is', 'tell me about'];
		const implementationKeywords = ['code', 'implement', 'write', 'create', 'add', 'fix', 'modify', 'update', 'refactor', 'script'];

		// If it contains implementation keywords, prioritize Coder
		if (implementationKeywords.some(k => lower.includes(k))) {
			return 'coder';
		}

		if (planningKeywords.some(k => lower.includes(k))) {
			return 'planner';
		}

		// 2. Testing -> Tester
		if (lower.includes('test') || lower.includes('spec')) { return 'tester'; }

		// 3. UI/UX -> Designer
		if (lower.includes('ui') || lower.includes('css') || lower.includes('style')) { return 'designer'; }

		// 4. Default to Coder
		return 'coder';
	}

	public getAgentByName(name: string): BaseAgent | undefined {
		return this.agents.get(name);
	}

	public stop(): void {
		for (const agent of this.agents.values()) {
			agent.cancel();
		}
		this._onStatusUpdate.fire({ working: false, text: 'Processing stopped by user.' });
	}

	public findAgentByName(name: string): BaseAgent | undefined {
		return this.agents.get(name) || this.agents.get(name.toLowerCase());
	}

	public async undoLastStep(): Promise<void> {
		this.messageHistory.pop(); // Remove assistant message
		this.messageHistory.pop(); // Remove user message
	}

	private findAgentByRole(role: string): BaseAgent | undefined {
		for (const agent of this.agents.values()) {
			if (agent.config.role.toLowerCase().includes(role.toLowerCase()) ||
				agent.config.name.toLowerCase().includes(role.toLowerCase())) {
				return agent;
			}
		}
		return undefined;
	}

	private recordMessage(from: string, to: string, content: string): void {
		this.messageHistory.push({ from, to, content, timestamp: new Date() });
		if (this.messageHistory.length > 200) { this.messageHistory.shift(); }
	}

	getMessageHistory(): AgentMessage[] { return this.messageHistory; }
}
