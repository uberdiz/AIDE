import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import * as config from '../core/config';
import { runHint, runnerFor } from '../tools/builtin';
import { isExtensionInstalled, LANGUAGE_EXTENSIONS } from '../tools/ideTools';

/**
 * Makes new files runnable: offers the language extension a file needs (e.g.
 * Python), adds a Run button for scripts, and detects a missing interpreter.
 */
export class LanguageSupport implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];
	private askedThisSession = new Set<string>();

	constructor(private readonly ctx: vscode.ExtensionContext) {}

	register(): void {
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(ed => this.onEditor(ed)),
			vscode.extensions.onDidChange(() => this.onEditor(vscode.window.activeTextEditor)),
			vscode.commands.registerCommand('aide.run.file', (uri?: vscode.Uri) => this.runFile(uri)),
			vscode.commands.registerCommand('aide.language.installSupport', () => this.installFor(vscode.window.activeTextEditor?.document.uri, true)),
			vscode.commands.registerCommand('aide.python.install', () => this.installPython()),
		);
		this.ctx.subscriptions.push(this);
		this.onEditor(vscode.window.activeTextEditor);
	}

	private onEditor(ed: vscode.TextEditor | undefined): void {
		const file = ed?.document.uri.scheme === 'file' ? ed.document.uri.fsPath : undefined;
		const ext = file ? path.extname(file).toLowerCase() : '';
		void vscode.commands.executeCommand('setContext', 'aide.canRunFile', !!file && !!runHint(file));
		// The Python extension brings its own Run button; do not show two.
		void vscode.commands.executeCommand('setContext', 'aide.langRunButton', ext === '.py' && isExtensionInstalled('ms-python.python'));
		if (file) void this.installFor(ed!.document.uri, false);
	}

	/** Offer the extension that adds run/debug/IntelliSense for this file type (once per type). */
	private async installFor(uri: vscode.Uri | undefined, explicit: boolean): Promise<void> {
		if (!uri) return;
		const ext = path.extname(uri.fsPath).toLowerCase();
		const rec = LANGUAGE_EXTENSIONS[ext];
		if (!rec) {
			if (explicit) void vscode.window.showInformationMessage(`AIDE has no recommended extension for "${ext || path.basename(uri.fsPath)}" files. Search the Extensions view (Ctrl+Shift+X).`);
			return;
		}
		if (isExtensionInstalled(rec.id)) {
			if (explicit) void vscode.window.showInformationMessage(`${rec.name} support (${rec.id}) is already installed.`);
			return;
		}
		if (!explicit) {
			const dismissed = this.ctx.globalState.get<string[]>('aide.language.dismissed', []);
			if (!config.get<boolean>('languageSupport.recommend', true) || dismissed.includes(rec.id) || this.askedThisSession.has(rec.id)) return;
			this.askedThisSession.add(rec.id);
		}
		const pick = await vscode.window.showInformationMessage(`${rec.name} files need the ${rec.name} extension to run, debug and get IntelliSense. Install ${rec.id} from Open VSX?`, 'Install', ...(explicit ? [] : ['Not now', "Don't ask again"]));
		if (pick === "Don't ask again") {
			await this.ctx.globalState.update('aide.language.dismissed', [...this.ctx.globalState.get<string[]>('aide.language.dismissed', []), rec.id]);
			return;
		}
		if (pick !== 'Install') return;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${rec.id}...` }, async () => {
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', rec.id);
				void vscode.window.showInformationMessage(`${rec.name} support installed.`);
			} catch (e) {
				void vscode.window.showErrorMessage(`Could not install ${rec.id}: ${(e as Error).message}`);
			}
		});
	}

	/** Run the current script in a terminal (python/node/...). */
	private async runFile(uri?: vscode.Uri): Promise<void> {
		const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
		if (!doc || doc.uri.scheme !== 'file') return void vscode.window.showInformationMessage('Open a script file to run it.');
		if (doc.isDirty) await doc.save();
		const file = doc.uri.fsPath;
		const runner = runnerFor(file);
		if (!runner) {
			if (!path.extname(file)) void vscode.window.showWarningMessage(`"${path.basename(file)}" has no file extension, so AIDE cannot tell how to run it. Rename it (e.g. to ${path.basename(file)}.py).`);
			else void vscode.window.showInformationMessage(`AIDE does not know how to run ${path.extname(file)} files. Use a task or the language extension's Run button.`);
			return;
		}
		if (/\.pyw?$/i.test(file) && !(await pythonAvailable())) {
			const pick = await vscode.window.showWarningMessage('Python is not installed (the "python" command only opens the Microsoft Store).', 'Install Python', 'Cancel');
			if (pick === 'Install Python') await this.installPython();
			return;
		}
		const cwd = path.dirname(file);
		const term = vscode.window.terminals.find(t => t.name === 'AIDE Run' && t.exitStatus === undefined) ?? vscode.window.createTerminal({ name: 'AIDE Run', cwd, iconPath: new vscode.ThemeIcon('play') });
		term.show();
		// Shell integration captures the output, so it shows up in @terminal and "Fix with AI".
		term.sendText(`cd "${cwd}"`, true);
		term.sendText(`${runner} "${file}"`, true);
	}

	private async installPython(): Promise<void> {
		if (process.platform !== 'win32') return void vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
		const pick = await vscode.window.showInformationMessage('Install Python 3.12 with winget (Windows Package Manager)? It opens in a terminal so you can follow the progress.', { modal: true }, 'Install', 'Open python.org');
		if (pick === 'Open python.org') return void vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
		if (pick !== 'Install') return;
		const term = vscode.window.createTerminal({ name: 'Install Python', iconPath: new vscode.ThemeIcon('cloud-download') });
		term.show();
		term.sendText('winget install -e --id Python.Python.3.12 --accept-package-agreements', true);
		void vscode.window.showInformationMessage('After the installation finishes, restart AIDE so the new PATH is picked up.');
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
	}
}

/** True when a real Python interpreter answers (not the Microsoft Store alias). */
export function pythonAvailable(): Promise<boolean> {
	return new Promise(resolve => {
		execFile(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
			resolve(!err && /Python \d/.test(`${stdout}${stderr}`));
		});
	});
}
