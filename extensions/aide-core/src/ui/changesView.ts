import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangeTracker } from '../changes/tracker';
import type { Services } from '../services';

/** Baseline (pre-AI) content of files under review: aide-original:/abs/path */
class OriginalDocs implements vscode.TextDocumentContentProvider {
	static readonly scheme = 'aide-original';
	private emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;
	constructor(private readonly changes: ChangeTracker) {}
	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.changes.getPending(uri.fsPath)?.original ?? '';
	}
	refresh(file: string): void {
		this.emitter.fire(vscode.Uri.file(file).with({ scheme: OriginalDocs.scheme }));
	}
}

type Node = { kind: 'group'; label: 'Added' | 'Modified' | 'Deleted'; files: string[] } | { kind: 'file'; path: string; change: string; added: number; removed: number };

export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.CodeLensProvider {
	private emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private lensEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.lensEmitter.event;
	private originals: OriginalDocs;
	private view: vscode.TreeView<Node> | undefined;

	constructor(private readonly s: Services) {
		this.originals = new OriginalDocs(s.changes);
	}

	register(ctx: vscode.ExtensionContext): void {
		this.view = vscode.window.createTreeView('aide.changes', { treeDataProvider: this, showCollapseAll: false });
		ctx.subscriptions.push(
			this.view,
			vscode.workspace.registerTextDocumentContentProvider(OriginalDocs.scheme, this.originals),
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
			new vscode.Disposable(this.s.changes.onDidChange(() => this.refresh())),
			vscode.workspace.onDidSaveTextDocument(() => this.lensEmitter.fire()),
			vscode.commands.registerCommand('aide.changes.openDiff', (n?: Node | string) => this.openDiff(typeof n === 'string' ? n : n?.kind === 'file' ? n.path : undefined)),
			vscode.commands.registerCommand('aide.changes.acceptFile', (n?: Node | string) => this.withFile(n, f => this.s.changes.acceptFile(f))),
			vscode.commands.registerCommand('aide.changes.rejectFile', (n?: Node | string) => this.withFile(n, async f => {
				const ok = await vscode.window.showWarningMessage(`Revert AI changes to ${vscode.workspace.asRelativePath(f)}?`, { modal: true }, 'Revert');
				if (ok) {
					await this.saveIfDirty(f);
					this.s.changes.rejectFile(f);
				}
			})),
			vscode.commands.registerCommand('aide.changes.acceptHunk', (f: string, i: number) => this.s.changes.acceptHunk(f, i)),
			vscode.commands.registerCommand('aide.changes.rejectHunk', async (f: string, i: number) => {
				await this.saveIfDirty(f);
				this.s.changes.rejectHunk(f, i);
			}),
			vscode.commands.registerCommand('aide.changes.acceptAll', () => this.s.changes.acceptAll()),
			vscode.commands.registerCommand('aide.changes.rejectAll', async () => {
				const n = this.s.changes.pendingChanges().length;
				if (!n) return;
				const ok = await vscode.window.showWarningMessage(`Revert all AI changes in ${n} file(s)?`, { modal: true }, 'Revert all');
				if (ok) this.s.changes.rejectAll();
			}),
		);
		this.refresh();
	}

	private async saveIfDirty(file: string): Promise<void> {
		const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === file.toLowerCase());
		if (doc?.isDirty) await doc.save();
	}

	private async withFile(n: Node | string | undefined, fn: (f: string) => unknown): Promise<void> {
		const f = typeof n === 'string' ? n : n?.kind === 'file' ? n.path : vscode.window.activeTextEditor?.document.uri.fsPath;
		if (f) await fn(f);
	}

	refresh(): void {
		const pending = this.s.changes.pendingChanges();
		if (this.view) {
			this.view.badge = pending.length ? { value: pending.length, tooltip: `${pending.length} AI-changed file(s) to review` } : undefined;
			this.view.message = pending.length ? undefined : 'No AI changes awaiting review.';
		}
		void vscode.commands.executeCommand('setContext', 'aide.hasPendingChanges', pending.length > 0);
		for (const p of pending) this.originals.refresh(p.path);
		this.emitter.fire(undefined);
		this.lensEmitter.fire();
	}

	getChildren(n?: Node): Node[] {
		const pending = this.s.changes.pendingChanges();
		if (!n) {
			const groups: Node[] = [];
			for (const [label, kind] of [['Added', 'added'], ['Modified', 'modified'], ['Deleted', 'deleted']] as const) {
				const files = pending.filter(p => p.kind === kind).map(p => p.path);
				if (files.length) groups.push({ kind: 'group', label, files });
			}
			return groups;
		}
		if (n.kind === 'group') {
			return pending.filter(p => n.files.includes(p.path)).map(p => ({ kind: 'file', path: p.path, change: p.kind, added: p.added, removed: p.removed }));
		}
		return [];
	}

	getTreeItem(n: Node): vscode.TreeItem {
		if (n.kind === 'group') {
			const it = new vscode.TreeItem(`${n.label} (${n.files.length})`, vscode.TreeItemCollapsibleState.Expanded);
			it.contextValue = 'group';
			return it;
		}
		const it = new vscode.TreeItem(path.basename(n.path), vscode.TreeItemCollapsibleState.None);
		it.resourceUri = vscode.Uri.file(n.path);
		it.description = `${vscode.workspace.asRelativePath(path.dirname(n.path))}  +${n.added} -${n.removed}`;
		it.contextValue = 'aideChange';
		it.tooltip = `${n.change}: ${n.path}`;
		it.command = { command: 'aide.changes.openDiff', title: 'Open diff', arguments: [n.path] };
		return it;
	}

	async openDiff(file?: string): Promise<void> {
		const f = file ?? this.s.changes.pendingChanges()[0]?.path;
		if (!f) {
			void vscode.window.showInformationMessage('No AI changes to review.');
			return;
		}
		const p = this.s.changes.getPending(f);
		const left = vscode.Uri.file(f).with({ scheme: OriginalDocs.scheme });
		const right = vscode.Uri.file(f);
		if (p && p.original !== null && !fs.existsSync(f)) {
			// deleted file: show original only
			await vscode.window.showTextDocument(left);
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(f)} (AI changes)`);
	}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.s.changes.getPending(doc.uri.fsPath)) return [];
		const lenses: vscode.CodeLens[] = [];
		for (const h of this.s.changes.hunks(doc.uri.fsPath)) {
			const line = Math.min(h.newStart, Math.max(0, doc.lineCount - 1));
			const range = new vscode.Range(line, 0, line, 0);
			const desc = `AI change: +${h.newLines.length} -${h.oldLines.length}`;
			lenses.push(
				new vscode.CodeLens(range, { title: `$(check) Accept`, tooltip: desc, command: 'aide.changes.acceptHunk', arguments: [doc.uri.fsPath, h.index] }),
				new vscode.CodeLens(range, { title: `$(discard) Reject`, tooltip: desc, command: 'aide.changes.rejectHunk', arguments: [doc.uri.fsPath, h.index] }),
				new vscode.CodeLens(range, { title: desc, command: 'aide.changes.openDiff', arguments: [doc.uri.fsPath] }),
			);
		}
		return lenses;
	}
}
