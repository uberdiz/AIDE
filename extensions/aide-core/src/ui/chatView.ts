import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContextStrategy } from '../ai/context/engine';
import type { ChatController } from '../chat/controller';
import type { Attachment } from '../chat/conversations';
import * as config from '../core/config';
import type { Services } from '../services';
import { showPreviewDiff } from '../services';
import { runnerFor, spawnCommand } from '../tools/builtin';
import { webviewHtml } from './webviewHtml';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'aide.chat';
	private view: vscode.WebviewView | undefined;
	private previewTimer: NodeJS.Timeout | undefined;
	private term: AbortController | undefined;

	constructor(private readonly s: Services, private readonly chat: ChatController) {}

	get resolved(): boolean {
		return !!this.view;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.s.context.extensionUri, 'media');
		const dist = vscode.Uri.joinPath(this.s.context.extensionUri, 'dist');
		view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
		const logo = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'AIDE_Logo.png')).toString();
		view.webview.html = webviewHtml(view.webview, this.s.context.extensionUri, 'chat', 'AIDE Chat', { logo });
		const sub = this.chat.attach(msg => void view.webview.postMessage(msg));
		view.onDidDispose(() => {
			sub.dispose();
			this.term?.abort();
			this.view = undefined;
		});
		view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
			this.s.log.error('Chat view message failed', e);
			void view.webview.postMessage({ type: 'error', message: (e as Error).message });
		}));
	}

	reveal(): void {
		void vscode.commands.executeCommand('aide.chat.focus');
	}

	private postLater(msg: Record<string, unknown>): void {
		this.reveal();
		setTimeout(() => void this.view?.webview.postMessage(msg), this.view ? 50 : 700);
	}

	/** Put text into the composer (e.g. "Add selection to chat"). */
	insertIntoComposer(text: string, send = false): void {
		this.postLater({ type: 'insert', text, send });
	}

	/** Add a text block (terminal output, logs) to the composer as a compact attachment. */
	attach(a: Attachment): void {
		this.postLater({ type: 'attach', attachment: a });
	}

	private post(msg: Record<string, unknown>): void {
		void this.view?.webview.postMessage(msg);
	}

	private async onMessage(m: any): Promise<void> {
		switch (m.type) {
			case 'ready':
				this.chat.pushState();
				break;
			case 'send':
				await this.chat.send({ text: m.text, model: m.model || undefined, strategy: m.strategy, exclude: m.exclude, images: m.images, attachments: sanitizeAttachments(m.attachments) });
				break;
			case 'cancel':
				this.chat.cancel();
				break;
			case 'newChat':
				this.chat.newConversation();
				break;
			case 'open':
				this.chat.open(m.id);
				break;
			case 'delete':
				this.chat.delete(m.id);
				break;
			case 'search':
				this.post({ type: 'searchResults', results: this.s.conversations.search(m.query ?? '', this.s.root).slice(0, 100) });
				break;
			case 'select':
				await this.chat.setSelection({ agentMode: m.agentMode, model: m.model, strategy: m.strategy });
				break;
			case 'setAutoProviders':
				await config.update('routing.autoProviders', Array.isArray(m.providers) ? m.providers.map(String) : []);
				break;
			case 'revert':
				this.chat.revertTo(Number(m.index), !!m.restoreFiles);
				break;
			case 'edit':
				await this.chat.editMessage(Number(m.index), String(m.text ?? ''), !!m.restoreFiles);
				break;
			case 'regenerate':
				await this.chat.regenerate(Number(m.index));
				break;
			case 'branch':
				this.chat.branch(Number(m.index));
				break;
			case 'copyTurn':
				await this.chat.copyTurn(Number(m.index));
				this.post({ type: 'toast', text: 'Copied.' });
				break;
			case 'copyChat':
				await this.chat.copyChat();
				break;
			case 'openLog':
				await this.chat.openLog();
				break;
			case 'approval':
				this.chat.answerApproval(m.id, { allow: m.allow, scope: m.scope });
				break;
			case 'approvalDiff':
				await this.chat.showApprovalDiff(m.id);
				break;
			case 'preview':
				if (this.previewTimer) clearTimeout(this.previewTimer);
				this.previewTimer = setTimeout(async () => {
					const b = await this.chat.previewContext(m.text ?? '', (m.strategy as ContextStrategy) ?? this.chat.selectedStrategy, m.exclude ?? [], sanitizeAttachments(m.attachments));
					this.post({ type: 'contextPreview', items: b.items.map(i => ({ key: i.key, label: i.label, kind: i.kind, tokens: i.tokens, reason: i.reason, truncated: i.truncated, deduped: i.deduped })), dropped: b.dropped, total: b.totalTokens, budget: b.budget, intent: b.intent });
				}, 300);
				break;
			case 'mentionQuery':
				this.post({ type: 'mentionResults', items: await this.mentionItems(String(m.query ?? '')) });
				break;
			case 'fileSuggest':
				this.post({ type: 'fileSuggestions', items: await this.fileSuggestions(String(m.query ?? '')) });
				break;
			case 'pastePath': {
				const rel = await this.workspaceRel(String(m.text ?? ''));
				this.post({ type: 'insert', text: rel ? `${fileRef(rel)} ` : String(m.text ?? '') });
				break;
			}
			case 'insertCode':
				await this.insertCode(m.code);
				break;
			case 'applyCode':
				await this.applyCode(m.code, m.lang);
				break;
			case 'copy':
				await vscode.env.clipboard.writeText(m.text);
				this.post({ type: 'toast', text: 'Copied.' });
				break;
			case 'openFile':
				await this.openFile(m.path, m.line);
				break;
			case 'restoreCheckpoint':
				await vscode.commands.executeCommand('aide.checkpoints.restore', m.id);
				break;
			case 'implementPlan':
				if (typeof m.planFile === 'string') await this.chat.implementPlan(m.planFile);
				break;
			case 'reviewChanges':
				await vscode.commands.executeCommand('aide.changes.focus');
				break;
			case 'inspect':
				await vscode.commands.executeCommand('aide.inspector.open', m.requestId);
				break;
			case 'command':
				if (typeof m.command === 'string' && m.command.startsWith('aide.')) await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
				break;
			case 'termRun':
				await this.runTerminal(String(m.command ?? ''));
				break;
			case 'termKill':
				this.term?.abort();
				break;
			case 'runFileInChat': {
				const rel = String(m.path ?? '');
				const runner = runnerFor(rel);
				if (runner) this.post({ type: 'termStart', command: `${runner} ${/\s/.test(rel) ? `"${rel}"` : rel}` });
				break;
			}
			case 'dropUris': {
				const refs: string[] = [];
				for (const u of String(m.uris ?? '').split(/\r?\n/).filter(Boolean)) {
					try {
						const uri = vscode.Uri.parse(u.trim());
						const root = this.s.root;
						const rel = root ? path.relative(root, uri.fsPath).replace(/\\/g, '/') : uri.fsPath;
						const isDir = fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory();
						refs.push(isDir ? `@folder:${/\s/.test(rel) ? `"${rel}"` : rel}` : fileRef(rel));
					} catch {
						/* ignore bad uri */
					}
				}
				if (refs.length) this.post({ type: 'insert', text: refs.join(' ') + ' ' });
				break;
			}
		}
	}

	/**
	 * The chat terminal: commands the user types run in the workspace (PowerShell
	 * on Windows) with output streamed into the chat. Output is also captured for @terminal.
	 */
	private async runTerminal(command: string): Promise<void> {
		if (!command.trim()) return;
		this.term?.abort();
		const ac = new AbortController();
		this.term = ac;
		const cwd = this.s.root ?? os.homedir();
		const item = { terminal: 'AIDE Chat', command, cwd, output: '', ts: Date.now(), exitCode: undefined as number | undefined };
		this.s.capture.push(item);
		const r = await spawnCommand(command, { cwd, timeoutMs: 30 * 60_000, signal: ac.signal, onData: text => this.post({ type: 'termData', text }) });
		item.output = r.output;
		item.exitCode = r.exitCode ?? undefined;
		if (this.term === ac) this.term = undefined;
		this.post({ type: 'termEnd', exitCode: r.exitCode, killed: r.killed || r.timedOut });
	}

	private async workspaceRel(p: string): Promise<string | undefined> {
		const root = this.s.root;
		if (!root) return undefined;
		const abs = path.isAbsolute(p) ? p : path.join(root, p);
		const rel = path.relative(root, abs);
		if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
		return fs.existsSync(abs) ? rel.replace(/\\/g, '/') : undefined;
	}

	/** While typing a file name or path, offer to link the matching workspace file(s). */
	private async fileSuggestions(query: string): Promise<{ label: string; insert: string; detail?: string }[]> {
		if (!this.s.project) return [];
		const direct = await this.workspaceRel(query);
		if (direct) return [{ label: path.basename(direct), insert: fileRef(direct), detail: direct }];
		const q = query.replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '');
		const files = await this.s.project.repoFiles();
		return files
			.map(f => ({ f: f.rel, score: f.rel.toLowerCase() === q ? 200 : f.rel.toLowerCase().endsWith('/' + q) ? 150 : fuzzy(f.rel.toLowerCase(), q) }))
			.filter(x => x.score >= 60)
			.sort((a, b) => b.score - a.score || a.f.length - b.f.length)
			.slice(0, 6)
			.map(x => ({ label: path.basename(x.f), insert: fileRef(x.f), detail: x.f }));
	}

	private async mentionItems(query: string): Promise<{ label: string; insert: string; detail?: string; kind: string }[]> {
		const q = query.toLowerCase();
		if (q.startsWith('output:') || q === 'output') {
			const name = q.replace(/^output:?/, '');
			return this.s.outputs.list().filter(o => o.name.toLowerCase().includes(name)).slice(0, 30).map(o => ({ label: o.name, insert: `@output:${/\s/.test(o.name) ? `"${o.name}"` : o.name}`, detail: 'Output log', kind: 'output' }));
		}
		const statics = [
			{ label: 'selection', insert: '@selection', detail: 'Current editor selection', kind: 'special' },
			{ label: 'terminal', insert: '@terminal', detail: 'Recent terminal output', kind: 'special' },
			{ label: 'output', insert: '@output:', detail: 'An Output panel log (Git, Python, tasks...)', kind: 'special' },
			{ label: 'errors', insert: '@errors', detail: 'Problems panel', kind: 'special' },
			{ label: 'git', insert: '@git', detail: 'Uncommitted changes', kind: 'special' },
			{ label: 'workspace', insert: '@workspace', detail: 'Repository map', kind: 'special' },
			{ label: 'memory', insert: '@memory', detail: 'Project and personal memory', kind: 'special' },
		].filter(s => s.label.startsWith(q));
		const out = [...statics];
		if (this.s.project) {
			const files = await this.s.project.repoFiles();
			const scored = files
				.map(f => ({ f: f.rel, score: fuzzy(f.rel.toLowerCase(), q) }))
				.filter(x => x.score > 0)
				.sort((a, b) => b.score - a.score || a.f.length - b.f.length)
				.slice(0, 25);
			for (const s of scored) out.push({ label: path.basename(s.f), insert: fileRef(s.f), detail: s.f, kind: 'file' });
			const dirs = [...new Set(files.map(f => f.rel.split('/').slice(0, -1).join('/')).filter(Boolean))].filter(d => d.toLowerCase().includes(q)).slice(0, 6);
			for (const d of dirs) out.push({ label: d + '/', insert: `@folder:${/\s/.test(d) ? `"${d}"` : d}`, detail: 'folder', kind: 'folder' });
		}
		if (q.length >= 2) {
			const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query)) ?? [];
			for (const s of syms.slice(0, 10)) out.push({ label: s.name, insert: `@symbol:${s.name}`, detail: `${vscode.SymbolKind[s.kind]} · ${vscode.workspace.asRelativePath(s.location.uri)}`, kind: 'symbol' });
		}
		return out.slice(0, 40);
	}

	private async insertCode(code: string): Promise<void> {
		const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
		if (!ed) {
			void vscode.window.showInformationMessage('Open an editor to insert code.');
			return;
		}
		await ed.edit(b => b.replace(ed.selection, code));
	}

	/** Apply a code block to the active editor: replaces the selection, else the whole file, after showing a diff. */
	private async applyCode(code: string, lang?: string): Promise<void> {
		const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
		if (!ed) {
			void vscode.window.showInformationMessage('Open the target file in an editor, then click Apply again.');
			return;
		}
		const doc = ed.document;
		const before = doc.getText();
		const range = ed.selection.isEmpty ? new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)) : ed.selection;
		const after = before.slice(0, doc.offsetAt(range.start)) + code + before.slice(doc.offsetAt(range.end));
		await showPreviewDiff(`Apply to ${path.basename(doc.fileName)}`, doc.fileName, before, after);
		const pick = await vscode.window.showInformationMessage(
			`Apply the code block to ${ed.selection.isEmpty ? 'the whole file' : 'the selection'} in ${path.basename(doc.fileName)}?${lang ? ` (${lang})` : ''}`,
			'Apply',
			'Cancel',
		);
		if (pick !== 'Apply') return;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, range, code);
		await vscode.workspace.applyEdit(edit);
		await vscode.window.showTextDocument(doc);
	}

	private async openFile(p: string, line?: number): Promise<void> {
		const root = this.s.root;
		const abs = path.isAbsolute(p) ? p : root ? path.join(root, p) : p;
		if (!fs.existsSync(abs)) return;
		await this.s.ide.openFile?.(abs, line);
	}
}

function fileRef(rel: string): string {
	return `@file:${/\s/.test(rel) ? `"${rel}"` : rel}`;
}

function sanitizeAttachments(v: unknown): Attachment[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter(a => a && typeof a.text === 'string' && typeof a.label === 'string')
		.slice(0, 10)
		.map(a => ({ kind: a.kind === 'terminal' || a.kind === 'output' ? a.kind : 'text', label: String(a.label).slice(0, 80), text: String(a.text).slice(0, 200_000) }));
}

/** Subsequence fuzzy score; favors matches in the basename and contiguous runs. */
export function fuzzy(text: string, q: string): number {
	if (!q) return 1;
	const base = text.slice(text.lastIndexOf('/') + 1);
	if (base.startsWith(q)) return 100;
	if (base.includes(q)) return 80;
	if (text.includes(q)) return 60;
	let ti = 0;
	let score = 0;
	let run = 0;
	for (const ch of q) {
		const idx = text.indexOf(ch, ti);
		if (idx < 0) return 0;
		run = idx === ti ? run + 1 : 0;
		score += 1 + run;
		ti = idx + 1;
	}
	return Math.min(50, score);
}
