/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/orchestrator';

export interface FileChange {
	path: string;
	oldContent: string;
	newContent: string;
	searchContent?: string;
	replaceContent?: string;
	range?: vscode.Range;
	timestamp?: number;
}

export class ChangeManager {
	private pendingChanges: FileChange[] = [];
	private nextStepsContent: Map<string, string> = new Map();
	private undoHistory: Array<{
		id: string;
		messageIndex?: number;
		timestamp: number;
		changes: Array<{ path: string; oldContent: string; newContent: string; isNew: boolean }>;
	}> = [];
	private backupDir: string;
	private diffDecorationType: vscode.TextEditorDecorationType;
	private diagnosticCollection: vscode.DiagnosticCollection;

	constructor(
		private context: vscode.ExtensionContext,
		private orchestrator: AgentOrchestrator
	) {
		this.backupDir = path.join(this.context.globalStorageUri.fsPath, 'backups');
		this.ensureBackupDir();

		this.diffDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(74, 158, 74, 0.2)', // Light green
			isWholeLine: true,
			border: '1px solid rgba(74, 158, 74, 0.4)',
			overviewRulerColor: 'rgba(74, 158, 74, 0.8)',
		});

		this.diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-ide-executor');
	}

	public clearDiagnostics(): void {
		try {
			this.diagnosticCollection.clear();
		} catch (e) {
			console.error('Failed to clear diagnostics:', e);
		}
	}

	private async ensureBackupDir() {
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.backupDir));
		} catch (e) { }
	}

	private async saveBackup(filePath: string, content: string): Promise<string> {
		const fileName = path.basename(filePath);
		const backupName = `${Date.now()}_${fileName}`;
		const backupPath = path.join(this.backupDir, backupName);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(backupPath), Buffer.from(content));
		return backupPath;
	}

	/**
	 * Adjust replacement indentation to match the target location.
	 * If the replacement contains multiple lines, normalize its minimal indent
	 * and prefix lines with the base indent of the target line so pasted code
	 * aligns properly with surrounding code.
	 */
	private adjustReplacementIndentation(original: string, index: number, replacement: string): string {
		if (!replacement) { return replacement; }
		// Find start of the line where index sits
		let lineStart = original.lastIndexOf('\n', Math.max(0, index - 1));
		lineStart = lineStart === -1 ? 0 : lineStart + 1;
		const linePrefix = original.slice(lineStart, index);
		const baseIndentMatch = linePrefix.match(/^[ \t]*/);
		const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';

		const lines = replacement.split('\n');
		if (lines.length <= 1) {
			return replacement;
		}

		// Compute minimal indent among non-empty lines except the first
		let minIndent: number | null = null;
		for (let i = 1; i < lines.length; i++) {
			const l = lines[i];
			if (l.trim().length === 0) { continue; }
			const m = l.match(/^[ \t]*/);
			const indentLen = m ? m[0].length : 0;
			if (minIndent === null || indentLen < minIndent) { minIndent = indentLen; }
		}
		if (minIndent === null) { minIndent = 0; }

		// Remove minIndent from subsequent lines and prefix baseIndent
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].length >= minIndent) {
				lines[i] = lines[i].slice(minIndent);
			}
			if (lines[i].trim().length > 0) {
				lines[i] = baseIndent + lines[i];
			}
		}

		return lines.join('\n');
	}

	private async showDiffPreview(change: FileChange): Promise<void> {
		const docOriginal = await vscode.workspace.openTextDocument({ content: change.oldContent });
		const docModified = await vscode.workspace.openTextDocument({ content: change.newContent });
		await vscode.commands.executeCommand('vscode.diff', docOriginal.uri, docModified.uri, `Diff: ${path.basename(change.path)}`);
	}

	async applyChanges(changes: FileChange[]): Promise<void> {
		if (changes.length === 0) {
			return;
		}

		for (const change of changes) {
			await this.showDiffPreview(change);
		}

		const approved = await vscode.window.showInformationMessage(
			`Apply ${changes.length} change(s)?`,
			{ modal: false },
			'Apply All', 'Cancel'
		);

		if (approved !== 'Apply All') {
			return;
		}

		const historyEntry = {
			id: Math.random().toString(36).substring(7),
			timestamp: Date.now(),
			changes: [] as Array<{ path: string; oldContent: string; newContent: string; isNew: boolean }>
		};

		const edit = new vscode.WorkspaceEdit();
		for (const change of changes) {
			const absolutePath = path.isAbsolute(change.path) ? change.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', change.path);
			const uri = vscode.Uri.file(absolutePath);

			let isNew = false;
			let currentContent = '';
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				currentContent = doc.getText();
			} catch {
				isNew = true;
				edit.createFile(uri, { ignoreIfExists: true });
			}

			// Save backup before modification
			await this.saveBackup(absolutePath, currentContent);
			historyEntry.changes.push({ path: absolutePath, oldContent: currentContent, newContent: change.newContent, isNew });

			if (change.searchContent) {
				const doc = await vscode.workspace.openTextDocument(uri);
				const content = doc.getText();
				const index = content.indexOf(change.searchContent);
				if (index !== -1) {
					const range = new vscode.Range(doc.positionAt(index), doc.positionAt(index + change.searchContent.length));
					const adjusted = this.adjustReplacementIndentation(content, index, change.newContent);
					edit.replace(uri, range, adjusted);
				}
			} else {
				if (isNew) {
					edit.insert(uri, new vscode.Position(0, 0), change.newContent);
				} else {
					const doc = await vscode.workspace.openTextDocument(uri);
					const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
					edit.replace(uri, fullRange, change.newContent);
				}
			}
		}

		const success = await vscode.workspace.applyEdit(edit);
		if (success) {
			await vscode.workspace.saveAll();
			this.undoHistory.push(historyEntry);
			vscode.window.showInformationMessage(`Successfully applied ${changes.length} changes.`, 'Undo').then(selection => {
				if (selection === 'Undo') { this.undoLastChange(); }
			});
		}
	}

	async undoLastChange(): Promise<void> {
		const entry = this.undoHistory.pop();
		if (entry) {
			await this.revertEntry(entry);
		}
		await this.clearDecorations();
	}

	public async revertChanges(messageIndex?: number): Promise<void> {
		if (typeof messageIndex === 'number') {
			// Revert all entries associated with this message index or later.
			// Also include entries that lack a messageIndex (treat them as tied to recent actions).
			const entriesToRevert = this.undoHistory.filter(e => (e.messageIndex === undefined) || (e.messageIndex !== undefined && e.messageIndex >= messageIndex));
			// Keep only entries that are strictly before the cutoff and have a defined messageIndex
			this.undoHistory = this.undoHistory.filter(e => e.messageIndex !== undefined && e.messageIndex < messageIndex);

			// Revert in reverse order to restore previous state
			for (let i = entriesToRevert.length - 1; i >= 0; i--) {
				await this.revertEntry(entriesToRevert[i]);
			}
		} else {
			await this.undoLastChange();
		}
		await this.clearDecorations();
	}

	private async revertEntry(entry: any): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		for (const change of entry.changes) {
			const uri = vscode.Uri.file(change.path);
			if (change.isNew) {
				edit.deleteFile(uri, { ignoreIfNotExists: true });
			} else {
				const doc = await vscode.workspace.openTextDocument(uri);
				const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
				edit.replace(uri, fullRange, change.oldContent);
			}
		}
		const success = await vscode.workspace.applyEdit(edit);
		if (success) {
			await vscode.workspace.saveAll();
			vscode.window.showInformationMessage('Changes reverted successfully.');
		}
	}

	async applyPendingChanges(messageIndex?: number): Promise<boolean> {
		if (this.pendingChanges.length === 0) {
			vscode.window.showInformationMessage('No pending changes');
			return true;
		}

		const historyEntry = {
			id: Math.random().toString(36).substring(7),
			messageIndex,
			timestamp: Date.now(),
			changes: [] as Array<{ path: string; oldContent: string; newContent: string; isNew: boolean }>
		};

		const edit = new vscode.WorkspaceEdit();
		for (const change of this.pendingChanges) {
			const absolutePath = path.isAbsolute(change.path) ? change.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', change.path);
			const uri = vscode.Uri.file(absolutePath);

			let oldContent = '';
			let isNew = false;
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				oldContent = doc.getText();

				if (change.searchContent && change.replaceContent) {
					// Normalize line endings for comparison
					const normalizedOld = oldContent.replace(/\r/g, '');
					const normalizedSearch = change.searchContent.replace(/\r/g, '');
					let index = normalizedOld.indexOf(normalizedSearch);

					// If direct match fails, try a more resilient whitespace-insensitive match
					if (index === -1) {
						// Stage 1: Collapse horizontal whitespace (spaces/tabs)
						const cleanSearchH = normalizedSearch.replace(/[ \t]+/g, ' ').trim();
						const cleanOldH = normalizedOld.replace(/[ \t]+/g, ' ');
						const cleanIndexH = cleanOldH.indexOf(cleanSearchH);

						if (cleanIndexH !== -1) {
							// Map cleanIndexH back to actual index
							let currentCleanPos = 0;
							let currentNormPos = 0;
							while (currentCleanPos < cleanIndexH && currentNormPos < normalizedOld.length) {
								if (normalizedOld[currentNormPos] === ' ' || normalizedOld[currentNormPos] === '\t') {
									while (currentNormPos < normalizedOld.length && (normalizedOld[currentNormPos] === ' ' || normalizedOld[currentNormPos] === '\t')) {
										currentNormPos++;
									}
									currentCleanPos++;
								} else {
									currentCleanPos++;
									currentNormPos++;
								}
							}
							index = currentNormPos;
						} else {
							// Stage 2: Collapse ALL whitespace (including newlines)
							const cleanSearchA = normalizedSearch.replace(/\s+/g, '');
							const cleanOldA = normalizedOld.replace(/\s+/g, '');
							const cleanIndexA = cleanOldA.indexOf(cleanSearchA);

							if (cleanIndexA !== -1) {
								let currentCleanPos = 0;
								let currentNormPos = 0;

								while (currentCleanPos < cleanIndexA && currentNormPos < normalizedOld.length) {
									if (/\s/.test(normalizedOld[currentNormPos])) {
										currentNormPos++;
									} else {
										currentCleanPos++;
										currentNormPos++;
									}
								}
								// Align index to the actual start of the first non-whitespace character
								index = currentNormPos;
							} else {
								// Stage 3: Partial/Fuzzy match (try to find the best line-based match)
								const searchLines = normalizedSearch.split('\n').map(l => l.trim()).filter(l => l.length > 5);
								if (searchLines.length > 0) {
									// Try to find a unique line that matches the first or most distinctive line
									for (const line of searchLines) {
										const lineIndex = normalizedOld.indexOf(line);
										if (lineIndex !== -1 && normalizedOld.indexOf(line, lineIndex + 1) === -1) {
											index = lineIndex;
											break;
										}
									}

									// Stage 4: Token-based similarity match (if unique line match fails)
									if (index === -1) {
										const searchTokens = normalizedSearch.toLowerCase().split(/[^a-z0-9]/).filter(t => t.length > 3);
										if (searchTokens.length > 2) {
											const lines = normalizedOld.split('\n');
											let bestLineIdx = -1;
											let maxScore = 0;

											for (let i = 0; i < lines.length; i++) {
												const line = lines[i].toLowerCase();
												let score = 0;
												for (const token of searchTokens) {
													if (line.includes(token)) score++;
												}

												if (score > maxScore) {
													maxScore = score;
													bestLineIdx = i;
												} else if (score === maxScore && score > 0) {
													// Tie-break: if scores are equal, we can't be sure unless it's a very high score
													// or we just skip to avoid wrong replacements
												}
											}

											// Only use the match if it's "good enough" (e.g., matches > 60% of tokens)
											if (maxScore > searchTokens.length * 0.6) {
												// Calculate the character index of this line
												let charIdx = 0;
												for (let i = 0; i < bestLineIdx; i++) {
													charIdx += lines[i].length + 1; // +1 for newline
												}
												index = charIdx;
											}
										}
									}
								}
							}
						}
					}

					if (index !== -1) {
						// Map normalized index back to actual index
						let actualStart = 0;
						let normPos = 0;
						while (normPos < index && actualStart < oldContent.length) {
							if (oldContent[actualStart] !== '\r') {
								normPos++;
							}
							actualStart++;
						}

						let actualEnd = actualStart;

						let normEndPos = index;
						let currentCleanEndPos = 0;

						// Find end accurately for fuzzy match
						const cleanSearchA = normalizedSearch.replace(/\s+/g, '');

						// If we found a match via Stage 4 (token similarity), we should replace
						// until the end of the line or until a matching block end.
						// For now, let's at least ensure we don't crash and find a reasonable end.
						if (cleanSearchA.length > 0) {
							while (currentCleanEndPos < cleanSearchA.length && normEndPos < normalizedOld.length) {
								if (/\s/.test(normalizedOld[normEndPos])) {
									normEndPos++;
								} else {
									currentCleanEndPos++;
									normEndPos++;
								}
							}
						} else {
							// If search was empty or Stage 4 found just a line start,
							// replace just that line.
							const lines = normalizedOld.split('\n');
							// We need to find which line 'index' is in
							let charCount = 0;
							for (const line of lines) {
								if (charCount <= index && index < charCount + line.length + 1) {
									normEndPos = charCount + line.length;
									break;
								}
								charCount += line.length + 1;
							}
						}

						let normPosEnd = 0;
						let tempActualEnd = 0;
						while (normPosEnd < normEndPos && tempActualEnd < oldContent.length) {
							if (oldContent[tempActualEnd] !== '\r') normPosEnd++;
							tempActualEnd++;
						}
						actualEnd = tempActualEnd;

						const range = new vscode.Range(doc.positionAt(actualStart), doc.positionAt(actualEnd));
						const adjusted = this.adjustReplacementIndentation(oldContent, actualStart, change.replaceContent || change.newContent);
						edit.replace(uri, range, adjusted);
					} else {
						console.error(`Search content not found in ${change.path}. Skipping targeted replacement.`);
						continue; // Don't proceed with this change
					}
				} else if (change.newContent) {
					const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
					edit.replace(uri, fullRange, change.newContent);
				}
			} catch {
				isNew = true;
				edit.createFile(uri, { ignoreIfExists: true });
				edit.insert(uri, new vscode.Position(0, 0), change.newContent);
			}
			historyEntry.changes.push({ path: absolutePath, oldContent, newContent: change.newContent, isNew });
		}

		const success = await vscode.workspace.applyEdit(edit);
		if (success) {
			await vscode.workspace.saveAll();
			this.undoHistory.push(historyEntry);
			this.pendingChanges = [];
			await this.clearDecorations();
			vscode.window.showInformationMessage('Changes applied and files saved.');
		}
		return success;
	}

	/**
	 * Force apply pending changes without showing previews or confirmation.
	 */
	public async applyPendingChangesForce(messageIndex?: number): Promise<boolean> {
		if (this.pendingChanges.length === 0) { return true; }

		const historyEntry = {
			id: Math.random().toString(36).substring(7),
			messageIndex,
			timestamp: Date.now(),
			changes: [] as Array<{ path: string; oldContent: string; newContent: string; isNew: boolean }>
		};

		const edit = new vscode.WorkspaceEdit();
		for (const change of this.pendingChanges) {
			const absolutePath = path.isAbsolute(change.path) ? change.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', change.path);
			const uri = vscode.Uri.file(absolutePath);

			let oldContent = '';
			let isNew = false;
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				oldContent = doc.getText();

				if (change.searchContent && change.replaceContent) {
					const normalizedOld = oldContent.replace(/\r/g, '');
					const normalizedSearch = change.searchContent.replace(/\r/g, '');
					let index = normalizedOld.indexOf(normalizedSearch);
					if (index !== -1) {
						const range = new vscode.Range(doc.positionAt(index), doc.positionAt(index + change.searchContent.length));
						const adjusted = this.adjustReplacementIndentation(normalizedOld, index, change.replaceContent || change.newContent);
						edit.replace(uri, range, adjusted);
					} else {
						const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
						edit.replace(uri, fullRange, change.newContent);
					}
				} else if (change.newContent) {
					const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
					edit.replace(uri, fullRange, change.newContent);
				}
			} catch {
				isNew = true;
				edit.createFile(uri, { ignoreIfExists: true });
				edit.insert(uri, new vscode.Position(0, 0), change.newContent);
			}

			historyEntry.changes.push({ path: absolutePath, oldContent, newContent: change.newContent, isNew });
		}

		const success = await vscode.workspace.applyEdit(edit);
		if (success) {
			await vscode.workspace.saveAll();
			this.undoHistory.push(historyEntry);
			this.pendingChanges = [];
			await this.clearDecorations();
		}
		return success;
	}

	public clearPendingChanges(): void {
		this.pendingChanges = [];
	}

	public getPendingChanges(): FileChange[] {
		return this.pendingChanges;
	}

	public addPendingChange(change: FileChange): void {
		if (this.pendingChanges.some(c => c.path === change.path)) {
			return;
		}
		this.pendingChanges.push(change);
	}

	public async clearDecorations(): Promise<void> {
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.diffDecorationType, []);
		}
	}

	public async executeAndAnalyze(command: string): Promise<{ success: boolean; output: string; error?: string }> {
		const outputChannel = vscode.window.createOutputChannel('AIDE Executor');
		outputChannel.show();

		return new Promise((resolve) => {
			let output = '';
			let error = '';

			const cp = require('child_process');
			const shell = vscode.env.shell;

			outputChannel.appendLine(`$ ${command}`);

			const child = cp.spawn(shell, [shell.includes('powershell') ? '-Command' : '-c', command], {
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				env: process.env
			});

			child.stdout.on('data', (data: Buffer) => {
				const chunk = data.toString();
				output += chunk;
				outputChannel.append(chunk);
			});

			child.stderr.on('data', (data: Buffer) => {
				const chunk = data.toString();
				error += chunk;
				outputChannel.append(chunk);
			});

			child.on('close', async (code: number) => {
				if (code === 0) {
					// Clear any previous diagnostics on success
					this.diagnosticCollection.clear();
					resolve({ success: true, output });
				} else {
					// Parse and publish diagnostics so user sees errors in editors
					try {
						this.publishDiagnosticsFromOutput(error || output);
					} catch (diagErr) {
						console.error('Failed to publish diagnostics:', diagErr);
					}

					// Analyze error text for suggested fixes
					const analysis = await this.analyzeError(error || output);
					resolve({ success: false, output, error: analysis });
				}
			});
		});
	}

	private publishDiagnosticsFromOutput(output: string): void {
		if (!output) { return; }
		const diagMap = new Map<string, vscode.Diagnostic[]>();

		// Python traceback: File "path", line N
		for (const m of output.matchAll(/File "([^"]+)", line (\d+)(?:, in .*?)?/g)) {
			const file = m[1];
			const line = parseInt(m[2], 10) - 1;
			const msg = extractLineMessage(output, m.index || 0) || 'Python error';
			addDiag(file, line, 0, msg);
		}

		// Node/JS stack: at ... (path:line:col) or at path:line:col
		for (const m of output.matchAll(/at .*?\(?([\/.A-Za-z0-9_:\\-]+):(\d+):(\d+)\)?/g)) {
			const file = m[1];
			const line = parseInt(m[2], 10) - 1;
			const col = parseInt(m[3], 10) - 1;
			const msg = 'Runtime error';
			addDiag(file, line, col, msg);
		}

		// Generic colon-style: path:line:col: message
		for (const m of output.matchAll(/([\/.A-Za-z0-9_:\\-]+):(\d+):(\d+):\s*(.+)/g)) {
			const file = m[1];
			const line = parseInt(m[2], 10) - 1;
			const col = parseInt(m[3], 10) - 1;
			const msg = m[4];
			addDiag(file, line, col, msg);
		}

		// Apply diagnostics to collection
		for (const [filePath, diags] of diagMap) {
			try {
				const uri = vscode.Uri.file(path.isAbsolute(filePath) ? filePath : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', filePath));
				this.diagnosticCollection.set(uri, diags);
			} catch (e) {
				console.error('Failed to set diagnostics for', filePath, e);
			}
		}

		function addDiag(file: string, line: number, col: number, message: string) {
			try {
				const uriKey = file;
				const diag = new vscode.Diagnostic(new vscode.Range(new vscode.Position(Math.max(0, line), Math.max(0, col)), new vscode.Position(Math.max(0, line), Math.max(0, col + 1))), message, vscode.DiagnosticSeverity.Error);
				const arr = diagMap.get(uriKey) || [];
				arr.push(diag);
				diagMap.set(uriKey, arr);
			} catch (e) { console.error('addDiag error', e); }
		}

		function extractLineMessage(text: string, idx: number): string | undefined {
			if (typeof idx !== 'number' || idx < 0) { return undefined; }
			// Take next non-empty line after the match index as message (common in Python)
			const rest = text.slice(idx);
			const lines = rest.split('\n');
			for (let i = 1; i < Math.min(lines.length, 6); i++) {
				const l = lines[i].trim();
				if (l.length > 0) { return l; }
			}
			return undefined;
		}
	}

	private async analyzeError(errorText: string): Promise<string> {
		if (!errorText) {
			return 'Unknown error occurred.';
		}

		// Basic classification
		if (errorText.includes('SyntaxError') || errorText.includes('expected')) {
			return `Syntax Error detected: ${errorText.split('\n')[0]}`;
		}
		if (errorText.includes('ModuleNotFoundError') || errorText.includes('cannot find module')) {
			return `Dependency Error: Missing module. Try installing dependencies.`;
		}
		if (errorText.includes('ReferenceError')) {
			return `Runtime Error: Reference not found.`;
		}

		// Use agent to analyze if it's complex
		try {
			// Find all file/line matches in the traceback
			const allMatches = Array.from(errorText.matchAll(/(?:File|at)\s+"?([^"\n,]+)"?,\s+line\s+(\d+)/gi));
			let contextPrompt = '';

			// We want the most relevant match, which is usually the last one that is a local file
			let bestMatch = null;
			for (let i = allMatches.length - 1; i >= 0; i--) {
				const match = allMatches[i];
				const filePath = match[1];
				// Simple heuristic: ignore files in Python lib or standard libraries
				if (!filePath.includes('Python') && !filePath.includes('site-packages') && !filePath.includes('node_modules')) {
					bestMatch = match;
					break;
				}
			}

			if (bestMatch) {
				const filePath = bestMatch[1];
				const lineNum = parseInt(bestMatch[2]);
				try {
					const uri = vscode.Uri.file(filePath);
					const doc = await vscode.workspace.openTextDocument(uri);
					const startLine = Math.max(0, lineNum - 10);
					const endLine = Math.min(doc.lineCount - 1, lineNum + 10);
					const contextLines = [];
					for (let i = startLine; i <= endLine; i++) {
						contextLines.push(doc.lineAt(i).text);
					}
					contextPrompt = `\n\nRelevant code from ${path.basename(filePath)} around line ${lineNum}:\n\`\`\`python\n${contextLines.join('\n')}\n\`\`\``;
				} catch (e) {
					console.error('Failed to read context file:', e);
				}
			}

			const analysis = await this.orchestrator.executeTask(
				`The code failed with the following error. Analyze the error and provide a fix using the [FILE: path] and SEARCH/REPLACE format.
IMPORTANT: You MUST provide the fix in the following format:
[FILE: path/to/file]
<<<<<<< SEARCH
old code (exactly as it appears in the file)
=======
new code
>>>>>>> REPLACE

${contextPrompt}

Error Output:
${errorText.substring(0, 1000)}`
			);

			// Extract patches from analysis and add to pending changes
			const patches = await this.parsePatchesFromResponse(analysis);
			for (const patch of patches) {
				this.addPendingChange(patch);
			}

			return analysis;
		} catch {
			return `Execution failed with error: ${errorText.substring(0, 200)}...`;
		}
	}

	public async applyDiffsToFiles(changes: FileChange[], messageIndex?: number): Promise<FileChange[]> {
		const historyEntry = {
			id: Math.random().toString(36).substring(7),
			messageIndex,
			timestamp: Date.now(),
			changes: [] as Array<{ path: string; oldContent: string; newContent: string; isNew: boolean }>
		};

		const enrichedChanges: FileChange[] = [];

		for (const change of changes) {
			const absolutePath = path.isAbsolute(change.path) ? change.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', change.path);
			const uri = vscode.Uri.file(absolutePath);

			try {
				let document: vscode.TextDocument;
				let currentContent = '';
				let isNew = false;

				try {
					document = await vscode.workspace.openTextDocument(uri);
					currentContent = document.getText();
				} catch {
					isNew = true;
					// Create empty file if it doesn't exist so we can show it
					const edit = new vscode.WorkspaceEdit();
					edit.createFile(uri, { ignoreIfExists: true });
					await vscode.workspace.applyEdit(edit);
					document = await vscode.workspace.openTextDocument(uri);
					currentContent = '';
				}

				const editor = await vscode.window.showTextDocument(document, { preview: false });

				const edit = new vscode.WorkspaceEdit();
				let appliedRange: vscode.Range | undefined;

				// Save history before change
				historyEntry.changes.push({ path: absolutePath, oldContent: currentContent, newContent: change.newContent, isNew });

				if (change.searchContent && change.replaceContent) {
					const text = currentContent;
					// Normalize line endings for search
					const normalizedText = text.replace(/\r/g, '');
					const normalizedSearch = change.searchContent.replace(/\r/g, '');
					let index = normalizedText.indexOf(normalizedSearch);

					// If direct match fails, try a more resilient whitespace-insensitive match
					if (index === -1) {
						// Stage 1: Collapse horizontal whitespace (spaces/tabs)
						const cleanSearchH = normalizedSearch.replace(/[ \t]+/g, ' ').trim();
						const cleanTextH = normalizedText.replace(/[ \t]+/g, ' ');
						const cleanIndexH = cleanTextH.indexOf(cleanSearchH);

						if (cleanIndexH !== -1) {
							// Map cleanIndexH back to actual index
							let currentCleanPos = 0;
							let currentNormPos = 0;
							while (currentCleanPos < cleanIndexH && currentNormPos < normalizedText.length) {
								if (normalizedText[currentNormPos] === ' ' || normalizedText[currentNormPos] === '\t') {
									while (currentNormPos < normalizedText.length && (normalizedText[currentNormPos] === ' ' || normalizedText[currentNormPos] === '\t')) {
										currentNormPos++;
									}
									currentCleanPos++;
								} else {
									currentCleanPos++;
									currentNormPos++;
								}
							}
							index = currentNormPos;
						} else {
							// Stage 2: Collapse ALL whitespace (including newlines)
							const cleanSearchA = normalizedSearch.replace(/\s+/g, '');
							const cleanTextA = normalizedText.replace(/\s+/g, '');
							const cleanIndexA = cleanTextA.indexOf(cleanSearchA);

							if (cleanIndexA !== -1) {
								let currentCleanPos = 0;
								let currentNormPos = 0;

								while (currentCleanPos < cleanIndexA && currentNormPos < normalizedText.length) {
									if (/\s/.test(normalizedText[currentNormPos])) {
										currentNormPos++;
									} else {
										currentCleanPos++;
										currentNormPos++;
									}
								}
								// Align index to the actual start of the first non-whitespace character
								index = currentNormPos;
							} else {
								// Stage 3: Partial/Fuzzy match (try to find the best line-based match)
								const searchLines = normalizedSearch.split('\n').map(l => l.trim()).filter(l => l.length > 5);
								if (searchLines.length > 0) {
									for (const line of searchLines) {
										const lineIndex = normalizedText.indexOf(line);
										if (lineIndex !== -1 && normalizedText.indexOf(line, lineIndex + 1) === -1) {
											index = lineIndex;
											break;
										}
									}

									// Stage 4: Token-based similarity match (if unique line match fails)
									if (index === -1) {
										const searchTokens = normalizedSearch.toLowerCase().split(/[^a-z0-9]/).filter(t => t.length > 3);
										if (searchTokens.length > 2) {
											const lines = normalizedText.split('\n');
											let bestLineIdx = -1;
											let maxScore = 0;

											for (let i = 0; i < lines.length; i++) {
												const line = lines[i].toLowerCase();
												let score = 0;
												for (const token of searchTokens) {
													if (line.includes(token)) score++;
												}

												if (score > maxScore) {
													maxScore = score;
													bestLineIdx = i;
												}
											}

											if (maxScore > searchTokens.length * 0.6) {
												let charIdx = 0;
												for (let i = 0; i < bestLineIdx; i++) {
													charIdx += lines[i].length + 1;
												}
												index = charIdx;
											}
										}
									}
								}
							}
						}
					}

					if (index !== -1) {
						// Map normalized index back to actual index
						let actualStart = 0;
						let normPos = 0;
						while (normPos < index && actualStart < text.length) {
							if (text[actualStart] !== '\r') { normPos++; }
							actualStart++;
						}

						let actualEnd = actualStart;

						let normEndPos = index;
						let currentCleanEndPos = 0;

						// Find end accurately for fuzzy match
						const cleanSearchA = normalizedSearch.replace(/\s+/g, '');

						if (cleanSearchA.length > 0) {
							while (currentCleanEndPos < cleanSearchA.length && normEndPos < normalizedText.length) {
								if (/\s/.test(normalizedText[normEndPos])) {
									normEndPos++;
								} else {
									currentCleanEndPos++;
									normEndPos++;
								}
							}
						} else {
							const lines = normalizedText.split('\n');
							let charCount = 0;
							for (const line of lines) {
								if (charCount <= index && index < charCount + line.length + 1) {
									normEndPos = charCount + line.length;
									break;
								}
								charCount += line.length + 1;
							}
						}

						let normPosEnd = 0;
						let tempActualEnd = 0;
						while (normPosEnd < normEndPos && tempActualEnd < text.length) {
							if (text[tempActualEnd] !== '\r') normPosEnd++;
							tempActualEnd++;
						}
						actualEnd = tempActualEnd;

						appliedRange = new vscode.Range(
							document.positionAt(actualStart),
							document.positionAt(actualEnd)
						);
						const adjusted = this.adjustReplacementIndentation(text, actualStart, change.replaceContent || change.newContent);
						edit.replace(uri, appliedRange, adjusted);
					} else {
						console.error(`Search content not found in ${change.path}. Skipping targeted replacement.`);
						continue;
					}
				} else if (change.newContent) {
					// Full file or simple insertion
					const fullRange = new vscode.Range(
						new vscode.Position(0, 0),
						document.lineAt(document.lineCount > 0 ? document.lineCount - 1 : 0).range.end
					);
					appliedRange = fullRange;
					edit.replace(uri, fullRange, change.newContent);
				}

				const success = await vscode.workspace.applyEdit(edit);
				if (success) {
					// Force a brief pause to allow VS Code to update the document state
					await new Promise(r => setTimeout(r, 100));

					// Highlight the changed area
					const docAfter = await vscode.workspace.openTextDocument(uri);
					const editorAfter = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());

					if (editorAfter && appliedRange) {
						const startPos = appliedRange.start;
						const contentLen = (change.replaceContent || change.newContent || "").length;
						const endPos = docAfter.positionAt(docAfter.offsetAt(startPos) + contentLen);
						const newRange = new vscode.Range(startPos, endPos);

						editorAfter.setDecorations(this.diffDecorationType, [newRange]);
						editorAfter.revealRange(newRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
					}

					// Add enriched change for UI
					enrichedChanges.push({
						...change,
						oldContent: currentContent
					});
				}
			} catch (err) {
				console.error(`Error applying diff to ${change.path}:`, err);
			}
		}
		this.undoHistory.push(historyEntry);
		return enrichedChanges;
	}

	public async parsePatchesFromResponse(response: string): Promise<FileChange[]> {
		const patches: FileChange[] = [];

		// 1. Find file paths and their associated SEARCH/REPLACE blocks
		const fileSectionRegex = /(?:###\s+)?(?:\[FILE:\s*|File:\s*|Proposed fix for\s+|Patch for\s+)\s*([a-zA-Z]:\\[^\]\n]+|[\/\w\-.\\ ]+)/gi;
		const sections: { path: string, content: string }[] = [];
		let match;
		let lastIndex = -1;
		let lastPath = '';

		while ((match = fileSectionRegex.exec(response)) !== null) {
			if (lastPath && lastIndex !== -1) {
				sections.push({
					path: lastPath,
					content: response.substring(lastIndex, match.index)
				});
			}
			lastPath = match[1];
			lastIndex = match.index + match[0].length;
		}

		// If no file sections found but there are SEARCH/REPLACE blocks,
		// they might be for the "active" file if we're in a specific context.
		// For now, let's at least capture the last section.
		if (lastPath && lastIndex !== -1) {
			sections.push({
				path: lastPath,
				content: response.substring(lastIndex)
			});
		}

		// Fallback: If no explicit file sections were found, but there are patches,
		// try to find any path-like strings that appear right before a patch.
		if (sections.length === 0) {
			const searchReplaceRegex = /<<<<<<<\s*SEARCH/g;
			if (searchReplaceRegex.test(response)) {
				// Try to find any path in the response
				const pathRegex = /([a-zA-Z0-9_\-\./\\]+\.(?:py|js|ts|go|cpp|h|java|cs|rb|php|html|css|json|yml|yaml|md))/gi;
				const pathMatch = pathRegex.exec(response);
				if (pathMatch) {
					sections.push({
						path: pathMatch[1],
						content: response
					});
				}
			}
		}

		// 2. Process each section for patches or full content
		for (const section of sections) {
			const absolutePath = path.isAbsolute(section.path) ? section.path : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', section.path);

			// Reset regex for each section
			const searchReplaceRegex = /<<<<<<<\s*SEARCH\s*(?:\r?\n)?([\s\S]*?)\r?\n=======\s*(?:\r?\n)?([\s\S]*?)\r?\n>>>>>>>\s*REPLACE/g;
			let patchFound = false;
			let patchMatch;

			while ((patchMatch = searchReplaceRegex.exec(section.content)) !== null) {
				const searchContent = patchMatch[1].replace(/\r/g, '');
				const replaceContent = patchMatch[2].replace(/\r/g, '');

				if (searchContent.trim() || replaceContent.trim()) {
					patches.push({
						path: absolutePath,
						oldContent: '',
						newContent: '',
						searchContent,
						replaceContent
					});
					patchFound = true;
				}
			}

			// If no patches found, look for a code block as full file replacement
			if (!patchFound) {
				const codeBlockRegex = /```[a-zA-Z0-9]*\r?\n([\s\S]*?)\n```/g;
				let codeMatch;
				while ((codeMatch = codeBlockRegex.exec(section.content)) !== null) {
					const blockContent = codeMatch[1];

					// If the code block contains SEARCH/REPLACE markers, it's a failed patch parsing, not a full file
					if (blockContent.includes('<<<<<<< SEARCH') && blockContent.includes('>>>>>>> REPLACE')) {
						// Try to extract patches from within this block
						const subSearchReplaceRegex = /<<<<<<<\s*SEARCH\s*(?:\r?\n)?([\s\S]*?)\r?\n=======\s*(?:\r?\n)?([\s\S]*?)\r?\n>>>>>>>\s*REPLACE/g;
						let subMatch;
						while ((subMatch = subSearchReplaceRegex.exec(blockContent)) !== null) {
							patches.push({
								path: absolutePath,
								oldContent: '',
								newContent: '',
								searchContent: subMatch[1].replace(/\r/g, ''),
								replaceContent: subMatch[2].replace(/\r/g, '')
							});
							patchFound = true;
						}
						continue;
					}

					patches.push({
						path: absolutePath,
						oldContent: '',
						newContent: blockContent,
						searchContent: '',
						replaceContent: ''
					});
					patchFound = true;
				}
			}
		}

		return patches;
	}



	private async showNextSteps(changes: FileChange[]): Promise<void> {
		const content = this.generateNextSteps(changes);
		const uri = vscode.Uri.parse(`ai-next-steps:/next-steps-${Date.now()}.md`);
		this.nextStepsContent.set(uri.toString(), content);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
	}

	private generateNextSteps(changes: FileChange[]): string {
		let content = '# Implementation Summary\n\n';
		content += '## Files Modified\n\n';
		for (const change of changes) {
			content += `- \`${change.path}\`\n`;
		}
		content += '\n## Next Steps\n';
		content += '1. Review the changes for any logic errors.\n';
		content += '2. Run your tests to ensure no regressions.\n';
		content += '3. Commit the changes if you are satisfied.\n';
		return content;
	}

	getNextStepsContent(uri: vscode.Uri): string {
		return this.nextStepsContent.get(uri.toString()) || 'No summary available';
	}
}
