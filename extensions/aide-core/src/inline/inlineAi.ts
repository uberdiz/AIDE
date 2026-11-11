import * as path from 'path';
import * as vscode from 'vscode';
import { CancelledError } from '../ai/client';
import { messageText } from '../ai/types';
import type { ChatController } from '../chat/controller';
import * as config from '../core/config';
import { showPreviewDiff, type Services } from '../services';
import { leadingWs, reindent } from './reindent';

const EDIT_SYSTEM = `You are a precise code-editing engine inside an IDE.
Return ONLY the code that replaces the selected region - no explanations, no Markdown fences, no surrounding code that was not selected.
Keep the original indentation style and line endings. Preserve behavior unless the instruction says otherwise.`;

export interface EditAction {
	id: string;
	label: string;
	icon: string;
	instruction?: string;
	/** send to chat instead of editing in place */
	chat?: { agent: string; prompt: string };
	ask?: string;
}

export const ACTIONS: EditAction[] = [
	{ id: 'explain', label: 'Explain', icon: 'comment-discussion', chat: { agent: 'chat', prompt: 'Explain what this code does, step by step, and point out anything surprising. @selection' } },
	{ id: 'refactor', label: 'Refactor', icon: 'wand', instruction: 'Refactor this code for readability and maintainability without changing behavior.' },
	{ id: 'fix', label: 'Fix bugs', icon: 'wrench', instruction: 'Find and fix bugs in this code. Keep changes minimal.' },
	{ id: 'docs', label: 'Add documentation', icon: 'book', instruction: 'Add idiomatic documentation comments (docstrings/JSDoc) for the functions, classes and non-obvious logic. Do not change code.' },
	{ id: 'comments', label: 'Add comments', icon: 'comment', instruction: 'Add brief comments explaining non-obvious logic. Do not change code.' },
	{ id: 'optimize', label: 'Optimize', icon: 'rocket', instruction: 'Optimize this code for performance while keeping behavior identical. Only change what materially helps.' },
	{ id: 'types', label: 'Add types', icon: 'symbol-interface', instruction: 'Add precise type annotations/type definitions appropriate for this language. Do not change runtime behavior.' },
	{ id: 'translate', label: 'Translate to another language...', icon: 'arrow-swap', ask: 'Translate to which language?' },
	{ id: 'tests', label: 'Generate tests', icon: 'beaker', chat: { agent: 'tester', prompt: 'Write tests for this code using the project\'s test framework, run them, and fix failures. @selection' } },
	{ id: 'custom', label: 'Edit with instruction...', icon: 'edit', ask: 'How should the selected code change?' },
];

export class InlineAi implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];
	private inlineEnabled = config.get<boolean>('inlineCompletion.enabled', true);
	private statusItem: vscode.StatusBarItem;
	private failItem: vscode.StatusBarItem;
	private failTimer: NodeJS.Timeout | undefined;

	constructor(private readonly s: Services, private readonly chat: ChatController, private readonly revealChat: (text: string, send: boolean) => void) {
		this.statusItem = vscode.window.createStatusBarItem('aide.inline', vscode.StatusBarAlignment.Right, 99);
		this.statusItem.command = 'aide.inline.toggleCompletions';
		this.failItem = vscode.window.createStatusBarItem('aide.lastFailure', vscode.StatusBarAlignment.Left, 50);
		this.failItem.command = 'aide.errors.fixLastCommand';
		this.updateStatus();
	}

	register(ctx: vscode.ExtensionContext): void {
		this.disposables.push(
			this.statusItem,
			this.failItem,
			vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, { provideInlineCompletionItems: (d, p, c, t) => this.complete(d, p, c, t) }),
			vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, { provideCodeActions: (d, r, c) => this.codeActions(d, r, c) }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] }),
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, { provideCodeLenses: d => this.codeLenses(d), onDidChangeCodeLenses: this.lensChanged.event }),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('aide.inlineCompletion') || e.affectsConfiguration('aide.routing')) {
					this.inlineEnabled = config.get<boolean>('inlineCompletion.enabled', true);
					this.updateStatus();
				}
				if (e.affectsConfiguration('aide.codeLens')) this.lensChanged.fire();
			}),
			vscode.commands.registerCommand('aide.inline.toggleCompletions', async () => {
				if (!this.autocompleteRoute().length) {
					const pick = await vscode.window.showInformationMessage('Inline completions need an "autocomplete" routing rule (a fast model, ideally local).', 'Configure routing');
					if (pick) await vscode.commands.executeCommand('aide.settings.open', 'routing');
					return;
				}
				await config.update('inlineCompletion.enabled', !this.inlineEnabled);
			}),
			vscode.commands.registerCommand('aide.inline.actions', () => this.pickAction()),
			vscode.commands.registerCommand('aide.inline.run', (id: string, uri?: vscode.Uri, range?: vscode.Range, extra?: string) => this.runAction(id, uri, range, extra)),
			vscode.commands.registerCommand('aide.inline.edit', () => this.runAction('custom')),
			vscode.commands.registerCommand('aide.inline.explain', () => this.runAction('explain')),
			vscode.commands.registerCommand('aide.inline.generate', () => this.generate('code')),
			vscode.commands.registerCommand('aide.inline.generateRegex', () => this.generate('regex')),
			vscode.commands.registerCommand('aide.inline.generateSql', () => this.generate('sql')),
			vscode.commands.registerCommand('aide.errors.fixAtCursor', () => this.fixAtCursor()),
			vscode.commands.registerCommand('aide.errors.explain', (uri: vscode.Uri, diag: vscode.Diagnostic) => this.explainDiagnostic(uri, diag)),
			vscode.commands.registerCommand('aide.errors.fix', (uri: vscode.Uri, diag: vscode.Diagnostic) => this.fixDiagnostic(uri, diag)),
			vscode.commands.registerCommand('aide.errors.fixLastCommand', () => this.fixLastCommand()),
			vscode.tasks.onDidEndTaskProcess(e => this.onTaskEnd(e)),
			this.s.capture.onDidFail(item => this.onCommandFailed(item.command, item.exitCode)),
		);
		ctx.subscriptions.push(this);
	}

	private lensChanged = new vscode.EventEmitter<void>();

	private autocompleteRoute(): string[] {
		const r = config.routingConfig().rules.autocomplete;
		return (Array.isArray(r) ? r : r ? [r] : []).filter(Boolean);
	}

	private updateStatus(): void {
		const route = this.autocompleteRoute();
		if (!route.length) {
			this.statusItem.text = '$(sparkle) AI';
			this.statusItem.tooltip = 'AIDE inline completions: no "autocomplete" route configured. Click to set one up.';
		} else {
			this.statusItem.text = this.inlineEnabled ? '$(sparkle) AI' : '$(circle-slash) AI';
			this.statusItem.tooltip = `AIDE inline completions ${this.inlineEnabled ? 'on' : 'off'} (${route[0]}). Click to toggle.`;
		}
		this.statusItem.show();
	}

	// ------------------------------------------------------------ inline completion

	private async complete(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
		if (!this.inlineEnabled || !this.autocompleteRoute().length || doc.uri.scheme !== 'file') return undefined;
		if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
			await new Promise(r => setTimeout(r, config.get<number>('inlineCompletion.debounceMs', 350)));
			if (token.isCancellationRequested) return undefined;
		}
		const text = doc.getText();
		const offset = doc.offsetAt(pos);
		const prefix = text.slice(Math.max(0, offset - 3000), offset);
		const suffix = text.slice(offset, offset + 1000);
		const line = doc.lineAt(pos.line).text;
		if (line.slice(pos.character).trim().length > 0 && !/^[)\]}'";,]*$/.test(line.slice(pos.character).trim())) return undefined;
		const ac = new AbortController();
		const sub = token.onCancellationRequested(() => ac.abort());
		try {
			const r = await this.s.client.run({
				task: 'autocomplete',
				source: 'autocomplete',
				strictRoute: true,
				signal: ac.signal,
				request: {
					system: 'You are a code completion engine. Output only the text to insert at <CURSOR>: no explanation, no Markdown fences, no repetition of the prefix. Complete the current statement or a few lines at most.',
					messages: [{ role: 'user', content: `File: ${vscode.workspace.asRelativePath(doc.uri)} (${doc.languageId})\n\n${prefix}<CURSOR>${suffix}` }],
					maxTokens: config.get<number>('inlineCompletion.maxTokens', 96),
					temperature: 0.1,
				},
			});
			let out = stripFences(messageText(r.message)).replace(/<CURSOR>/g, '');
			if (!out.trim()) return undefined;
			// Avoid duplicating the text that already follows the cursor.
			const following = suffix.split('\n')[0];
			if (following.trim() && out.endsWith(following.trim())) out = out.slice(0, out.length - following.trim().length);
			const maxLines = config.get<number>('inlineCompletion.maxLines', 8);
			out = out.split('\n').slice(0, maxLines).join('\n');
			return [new vscode.InlineCompletionItem(out, new vscode.Range(pos, pos))];
		} catch (e) {
			if (!(e instanceof CancelledError)) this.s.log.debug(`inline completion failed: ${(e as Error).message}`);
			return undefined;
		} finally {
			sub.dispose();
		}
	}

	// ------------------------------------------------------------ actions

	private async pickAction(): Promise<void> {
		const ed = vscode.window.activeTextEditor;
		if (!ed) return;
		const items = ACTIONS.map(a => ({ label: `$(${a.icon}) ${a.label}`, id: a.id }));
		items.push({ label: '$(add) Generate code here...', id: 'gen' }, { label: '$(regex) Generate regex...', id: 'regex' }, { label: '$(database) Generate SQL...', id: 'sql' }, { label: '$(comment-discussion) Add selection to chat', id: 'addToChat' });
		const pick = await vscode.window.showQuickPick(items, { placeHolder: ed.selection.isEmpty ? 'AI actions (no selection: acts on the current line/block)' : 'AI actions for the selection' });
		if (!pick) return;
		if (pick.id === 'gen') return this.generate('code');
		if (pick.id === 'regex') return this.generate('regex');
		if (pick.id === 'sql') return this.generate('sql');
		if (pick.id === 'addToChat') return void vscode.commands.executeCommand('aide.chat.addSelection');
		await this.runAction(pick.id);
	}

	async runAction(id: string, uri?: vscode.Uri, range?: vscode.Range, extra?: string): Promise<void> {
		const action = ACTIONS.find(a => a.id === id);
		if (!action) return;
		let ed = vscode.window.activeTextEditor;
		if (uri) ed = await vscode.window.showTextDocument(uri);
		if (!ed) return void vscode.window.showInformationMessage('Open a file first.');
		if (range) ed.selection = new vscode.Selection(range.start, range.end);
		if (ed.selection.isEmpty) {
			const block = await this.enclosingBlock(ed.document, ed.selection.active);
			ed.selection = new vscode.Selection(block.start, block.end);
		}
		if (action.chat) {
			this.revealChat(`${action.chat.prompt}${extra ? ` ${extra}` : ''}`, true);
			await this.chat.setSelection({ agentId: action.chat.agent });
			return;
		}
		let instruction = action.instruction;
		if (action.ask) {
			const answer = await vscode.window.showInputBox({ prompt: action.ask, placeHolder: action.id === 'translate' ? 'e.g. TypeScript, Python, Rust' : 'e.g. use async/await and handle errors' });
			if (!answer) return;
			instruction = action.id === 'translate' ? `Translate this code to ${answer}, idiomatically.` : answer;
		}
		await this.editRegion(ed, ed.selection, instruction!, action.label);
	}

	/** Innermost function/class symbol around the cursor, else the current line. */
	private async enclosingBlock(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Range> {
		const syms = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
		let best: vscode.DocumentSymbol | undefined;
		const walk = (list: vscode.DocumentSymbol[]) => {
			for (const s of list) {
				if (!s.range.contains(pos)) continue;
				if ([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class, vscode.SymbolKind.Constructor].includes(s.kind)) best = s;
				walk(s.children ?? []);
			}
		};
		walk(syms);
		return best?.range ?? doc.lineAt(pos.line).range;
	}

	private async editRegion(ed: vscode.TextEditor, sel: vscode.Range, instruction: string, label: string): Promise<void> {
		const doc = ed.document;
		// Whole lines only: partial first lines are where indentation gets lost.
		const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
		const range = new vscode.Range(sel.start.line, 0, endLine, doc.lineAt(endLine).text.length);
		const selected = doc.getText(range);
		const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, range.start.line - 40), 0), range.start));
		const after = doc.getText(new vscode.Range(range.end, new vscode.Position(Math.min(doc.lineCount - 1, range.end.line + 20), 0)));
		const rel = vscode.workspace.asRelativePath(doc.uri);
		const version = doc.version;
		let model: string | undefined;
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `AIDE: ${label}...`, cancellable: true }, async (_p, token) => {
			const ac = new AbortController();
			token.onCancellationRequested(() => ac.abort());
			try {
				const r = await this.s.client.run({
					task: 'simple_edits',
					source: `inline:${label}`,
					signal: ac.signal,
					request: {
						system: EDIT_SYSTEM,
						messages: [{ role: 'user', content: `Instruction: ${instruction}\nLanguage: ${doc.languageId}\nFile: ${rel}\n\nCode before the selection (context only, do not repeat):\n\`\`\`\n${before}\n\`\`\`\n\nCode after the selection (context only, do not repeat):\n\`\`\`\n${after}\n\`\`\`\n\nSelected lines to rewrite (return all ${range.end.line - range.start.line + 1} of them with the change applied, keeping the indentation exactly; the first line starts with ${leadingWs(selected).length} spaces/tabs):\n\`\`\`\n${selected}\n\`\`\`` }],
						temperature: 0.2,
					},
				});
				model = `${r.ref.providerId}/${r.ref.modelId}`;
				return reindent(selected, stripFences(messageText(r.message)));
			} catch (e) {
				if (e instanceof CancelledError) return undefined;
				void vscode.window.showErrorMessage(`AIDE: ${(e as Error).message}`);
				return undefined;
			}
		});
		if (result === undefined) return;
		if (doc.version !== version) return void vscode.window.showWarningMessage('The file changed while AIDE was working; the edit was not applied.');
		const full = doc.getText();
		const proposed = full.slice(0, doc.offsetAt(range.start)) + result + full.slice(doc.offsetAt(range.end));
		await showPreviewDiff(label, doc.fileName, full, proposed);
		const pick = await vscode.window.showInformationMessage(`${label}: apply the proposed change to ${path.basename(doc.fileName)}?`, 'Apply', 'Discard');
		const applied = pick === 'Apply' && doc.version === version;
		this.chat.recordInline({ title: `${label}: ${path.basename(doc.fileName)}`, prompt: `${instruction}\n\nLines ${range.start.line + 1}-${range.end.line + 1}`, file: rel, language: doc.languageId, result, outcome: applied ? 'Applied to the file.' : pick === 'Apply' ? 'Not applied: the file changed meanwhile.' : 'Discarded.', model });
		if (pick !== 'Apply') return;
		if (doc.version !== version) return void vscode.window.showWarningMessage('The file changed; the edit was not applied.');
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, range, result);
		await vscode.workspace.applyEdit(edit);
		await vscode.window.showTextDocument(doc);
	}

	private async generate(kind: 'code' | 'regex' | 'sql'): Promise<void> {
		const ed = vscode.window.activeTextEditor;
		if (!ed) return void vscode.window.showInformationMessage('Open a file first.');
		const what = await vscode.window.showInputBox({ prompt: kind === 'regex' ? 'Describe what the regular expression should match' : kind === 'sql' ? 'Describe the SQL query (mention tables/columns)' : 'Describe the code to generate at the cursor' });
		if (!what) return;
		const doc = ed.document;
		const around = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, ed.selection.active.line - 30), 0), ed.selection.active));
		const instruction = kind === 'regex'
			? `Write a ${doc.languageId} regular expression literal that matches: ${what}. Output only the regex expression usable at the cursor.`
			: kind === 'sql' ? `Write a SQL query: ${what}. Output only SQL.` : `Generate ${doc.languageId} code: ${what}. Output only the code to insert at the cursor.`;
		let model: string | undefined;
		const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AIDE: generating...', cancellable: true }, async (_p, token) => {
			const ac = new AbortController();
			token.onCancellationRequested(() => ac.abort());
			try {
				const r = await this.s.client.run({ task: kind === 'code' ? 'coding' : 'simple_edits', source: `generate:${kind}`, signal: ac.signal, request: { system: EDIT_SYSTEM, messages: [{ role: 'user', content: `${instruction}\n\nCode before the cursor (context):\n\`\`\`\n${around}\n\`\`\`` }] } });
				model = `${r.ref.providerId}/${r.ref.modelId}`;
				return stripFences(messageText(r.message));
			} catch (e) {
				if (!(e instanceof CancelledError)) void vscode.window.showErrorMessage(`AIDE: ${(e as Error).message}`);
				return undefined;
			}
		});
		if (!out) return;
		// Continuation lines follow the indentation of the line the cursor is on.
		const indent = leadingWs(doc.lineAt(ed.selection.active.line).text);
		const code = out.split('\n').map((l, i) => (i === 0 || !l.trim() ? l : indent + l)).join('\n');
		const pick = await vscode.window.showInformationMessage(`Insert generated ${kind}?`, { modal: true, detail: out.length > 1500 ? out.slice(0, 1500) + '\n...' : out }, 'Insert', 'Copy', 'Open in Chat');
		const rel = vscode.workspace.asRelativePath(doc.uri);
		const convId = this.chat.recordInline({ title: `Generate: ${what}`, prompt: what, file: `${rel}:${ed.selection.active.line + 1}`, language: kind === 'sql' ? 'sql' : doc.languageId, result: out, outcome: pick === 'Insert' ? `Inserted into ${rel}.` : pick === 'Copy' ? 'Copied to the clipboard.' : 'Not inserted.', model });
		if (pick === 'Insert') await ed.edit(b => b.replace(ed.selection, code));
		else if (pick === 'Copy') await vscode.env.clipboard.writeText(out);
		else if (pick === 'Open in Chat') {
			this.chat.open(convId);
			void vscode.commands.executeCommand('aide.chat.focus');
		}
	}

	// ------------------------------------------------------------ error intelligence

	private codeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
		const out: vscode.CodeAction[] = [];
		if (config.get<boolean>('errorIntel.enabled', true)) {
			for (const d of ctx.diagnostics.filter(x => x.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 2)) {
				const fix = new vscode.CodeAction(`AI: Fix "${truncate(d.message, 50)}"`, vscode.CodeActionKind.QuickFix);
				fix.command = { command: 'aide.errors.fix', title: 'Fix with AI', arguments: [doc.uri, d] };
				fix.diagnostics = [d];
				const explain = new vscode.CodeAction('AI: Explain this problem', vscode.CodeActionKind.QuickFix);
				explain.command = { command: 'aide.errors.explain', title: 'Explain with AI', arguments: [doc.uri, d] };
				out.push(fix, explain);
			}
		}
		if (!range.isEmpty) {
			const a = new vscode.CodeAction('AI: Edit selection...', vscode.CodeActionKind.RefactorRewrite);
			a.command = { command: 'aide.inline.edit', title: 'Edit with AI' };
			out.push(a);
		}
		return out;
	}

	private diagText(uri: vscode.Uri, d: vscode.Diagnostic): string {
		return `${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.source ? `[${d.source}${d.code ? ' ' + (typeof d.code === 'object' ? d.code.value : d.code) : ''}] ` : ''}${d.message}`;
	}

	private explainDiagnostic(uri: vscode.Uri, d: vscode.Diagnostic): void {
		const rel = vscode.workspace.asRelativePath(uri);
		this.revealChat(`Explain this problem and how to fix it:\n${this.diagText(uri, d)}\n@file:${/\s/.test(rel) ? `"${rel}"` : rel}`, true);
	}

	private async fixDiagnostic(uri: vscode.Uri, d: vscode.Diagnostic): Promise<void> {
		const ed = await vscode.window.showTextDocument(uri);
		const doc = ed.document;
		const block = await this.enclosingBlock(doc, d.range.start);
		// Small window around the problem: rewriting a whole function to fix one line is how the rest of a file gets damaged.
		const last = Math.min(doc.lineCount - 1, d.range.end.line + 6);
		const window = new vscode.Range(Math.max(0, d.range.start.line - 6), 0, last, doc.lineAt(last).text.length);
		const range = block.contains(d.range) && block.end.line - block.start.line <= 30 ? block : window;
		await this.editRegion(ed, range, `Fix this problem: ${this.diagText(uri, d)}. Change only the line(s) causing it; return every other line unchanged.`, 'Fix problem');
	}

	private async fixAtCursor(): Promise<void> {
		const ed = vscode.window.activeTextEditor;
		if (!ed) return;
		const diags = vscode.languages.getDiagnostics(ed.document.uri).filter(d => d.severity <= vscode.DiagnosticSeverity.Warning);
		const at = diags.find(d => d.range.contains(ed.selection.active)) ?? diags.sort((a, b) => Math.abs(a.range.start.line - ed.selection.active.line) - Math.abs(b.range.start.line - ed.selection.active.line))[0];
		if (!at) return void vscode.window.showInformationMessage('No problems in this file.');
		await this.fixDiagnostic(ed.document.uri, at);
	}

	private async onTaskEnd(e: vscode.TaskProcessEndEvent): Promise<void> {
		if (!e.exitCode || !config.get<boolean>('errorIntel.enabled', true)) return;
		const task = e.execution.task;
		const exec = task.execution;
		const cmd = exec instanceof vscode.ShellExecution ? (exec.commandLine ?? [exec.command, ...(exec.args ?? [])].filter(a => a !== undefined).map(a => (typeof a === 'string' ? a : a!.value)).join(' ')) : exec instanceof vscode.ProcessExecution ? [exec.process, ...exec.args].join(' ') : task.name;
		const pick = await vscode.window.showErrorMessage(`Task "${task.name}" failed (exit code ${e.exitCode}).`, 'Fix with AI', 'Explain with AI');
		if (pick === 'Fix with AI') {
			await this.chat.setSelection({ agentId: 'debugger' });
			this.revealChat(`The task "${task.name}" failed with exit code ${e.exitCode}. Reproduce it by running \`${cmd}\`, find the root cause, fix it, and re-run to confirm.`, true);
		} else if (pick === 'Explain with AI') {
			await this.chat.setSelection({ agentId: 'chat' });
			this.revealChat(`The task "${task.name}" (\`${cmd}\`) failed with exit code ${e.exitCode}. Explain the failure. @terminal @errors`, true);
		}
	}

	private onCommandFailed(command: string, exitCode?: number): void {
		if (!config.get<boolean>('errorIntel.enabled', true)) return;
		this.failItem.text = `$(error) \`${truncate(command, 30)}\` failed - Fix with AI`;
		this.failItem.tooltip = `Exit code ${exitCode}. Click to explain or fix with AI.`;
		this.failItem.show();
		if (this.failTimer) clearTimeout(this.failTimer);
		this.failTimer = setTimeout(() => this.failItem.hide(), 60_000);
	}

	private async fixLastCommand(): Promise<void> {
		this.failItem.hide();
		const last = this.s.capture.recent(10).reverse().find(i => i.exitCode && i.exitCode !== 0);
		if (!last) return void vscode.window.showInformationMessage('No failed terminal command captured.');
		const pick = await vscode.window.showQuickPick([{ label: '$(wrench) Fix with AI', id: 'fix' }, { label: '$(comment-discussion) Explain with AI', id: 'explain' }], { placeHolder: `\`${last.command}\` exited with ${last.exitCode}` });
		if (!pick) return;
		await this.chat.setSelection({ agentId: pick.id === 'fix' ? 'debugger' : 'chat' });
		this.revealChat(pick.id === 'fix' ? `\`${last.command}\` failed with exit code ${last.exitCode}. Find the root cause, fix it, and re-run the command to confirm. @terminal` : `Explain why \`${last.command}\` failed. @terminal`, true);
	}

	// ------------------------------------------------------------ AI code lens

	private async codeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		if (!config.get<boolean>('codeLens.enabled', false)) return [];
		const syms = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
		const lenses: vscode.CodeLens[] = [];
		const walk = (list: vscode.DocumentSymbol[]) => {
			for (const s of list) {
				if ([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class].includes(s.kind) && s.range.end.line - s.range.start.line >= 3) {
					const r = new vscode.Range(s.range.start, s.range.start);
					lenses.push(
						new vscode.CodeLens(r, { title: '$(sparkle) Explain', command: 'aide.inline.run', arguments: ['explain', doc.uri, s.range] }),
						new vscode.CodeLens(r, { title: 'Tests', command: 'aide.inline.run', arguments: ['tests', doc.uri, s.range] }),
						new vscode.CodeLens(r, { title: 'Docs', command: 'aide.inline.run', arguments: ['docs', doc.uri, s.range] }),
					);
				}
				if (s.kind === vscode.SymbolKind.Class) walk(s.children ?? []);
			}
		};
		walk(syms);
		return lenses.slice(0, 300);
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
	}
}

export function stripFences(s: string): string {
	const m = /^\s*```[\w+#.-]*[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(s);
	return (m ? m[1] : s).replace(/^\n+/, '').replace(/\s+$/, s.endsWith('\n') ? '\n' : '');
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
