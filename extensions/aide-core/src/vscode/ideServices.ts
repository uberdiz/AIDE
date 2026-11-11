import * as path from 'path';
import * as vscode from 'vscode';
import { stripAnsi } from '../ai/context/compress';
import { spawnCommand } from '../tools/builtin';
import type { IdeServices } from '../tools/types';

export interface CapturedExecution {
	terminal: string;
	command: string;
	cwd?: string;
	output: string;
	exitCode?: number;
	ts: number;
}

/**
 * Captures output of commands run in integrated terminals (via shell
 * integration) and of commands run by agents, for @terminal context and
 * error intelligence.
 */
export class TerminalCapture implements vscode.Disposable {
	private items: CapturedExecution[] = [];
	private disposables: vscode.Disposable[] = [];
	private readonly failEmitter = new vscode.EventEmitter<CapturedExecution>();
	readonly onDidFail = this.failEmitter.event;

	constructor() {
		this.disposables.push(
			vscode.window.onDidStartTerminalShellExecution(async e => {
				const item: CapturedExecution = { terminal: e.terminal.name, command: e.execution.commandLine.value, cwd: e.execution.cwd?.fsPath, output: '', ts: Date.now() };
				this.push(item);
				try {
					for await (const chunk of e.execution.read()) {
						if (item.output.length < 1_000_000) item.output += chunk;
					}
				} catch {
					/* terminal closed mid-stream */
				}
			}),
			vscode.window.onDidEndTerminalShellExecution(e => {
				const item = [...this.items].reverse().find(i => i.command === e.execution.commandLine.value && i.exitCode === undefined);
				if (item) {
					item.exitCode = e.exitCode;
					item.output = stripAnsi(item.output);
					if (e.exitCode !== undefined && e.exitCode !== 0) this.failEmitter.fire(item);
				}
			}),
		);
	}

	push(item: CapturedExecution): void {
		this.items.push(item);
		if (this.items.length > 20) this.items.shift();
	}

	recent(n = 3): CapturedExecution[] {
		return this.items.slice(-n);
	}

	last(): CapturedExecution | undefined {
		return this.items[this.items.length - 1];
	}

	/** Text of the last few executions, or the active terminal buffer as a fallback. */
	async text(): Promise<string | undefined> {
		const recent = this.recent(3);
		if (recent.length) {
			return recent.map(i => `$ ${i.command}${i.cwd ? `   (cwd: ${i.cwd})` : ''}\n${stripAnsi(i.output).trimEnd()}${i.exitCode !== undefined ? `\n[exit code ${i.exitCode}]` : ''}`).join('\n\n');
		}
		if (!vscode.window.activeTerminal) return undefined;
		// No shell integration: copy the visible buffer through the clipboard, then restore it.
		const saved = await vscode.env.clipboard.readText();
		try {
			await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
			await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
			await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
			const text = await vscode.env.clipboard.readText();
			return text && text !== saved ? text : undefined;
		} finally {
			await vscode.env.clipboard.writeText(saved);
		}
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.failEmitter.dispose();
	}
}

/** Pseudoterminal that mirrors agent-run commands so the user sees exactly what ran. */
class AgentTerminal {
	private terminal: vscode.Terminal | undefined;
	private writeEmitter = new vscode.EventEmitter<string>();
	private opened = false;
	private pending: string[] = [];

	private ensure(): void {
		if (this.terminal && vscode.window.terminals.includes(this.terminal)) return;
		this.opened = false;
		this.writeEmitter = new vscode.EventEmitter<string>();
		const pty: vscode.Pseudoterminal = {
			onDidWrite: this.writeEmitter.event,
			open: () => {
				this.opened = true;
				for (const p of this.pending) this.writeEmitter.fire(p);
				this.pending = [];
			},
			close: () => {
				this.terminal = undefined;
				this.opened = false;
			},
		};
		this.terminal = vscode.window.createTerminal({ name: 'AIDE Agent', pty, iconPath: new vscode.ThemeIcon('hubot') });
	}

	write(text: string): void {
		this.ensure();
		const t = text.replace(/\r?\n/g, '\r\n');
		if (this.opened) this.writeEmitter.fire(t);
		else this.pending.push(t);
	}

	show(): void {
		this.ensure();
		this.terminal?.show(true);
	}
}

export function createIdeServices(capture: TerminalCapture, getRoot: () => string | undefined): IdeServices {
	const agentTerminal = new AgentTerminal();
	return {
		async diagnostics(pathFilter?: string) {
			return formatDiagnostics(getRoot(), pathFilter);
		},
		async runCommand(command, opts) {
			const reveal = vscode.workspace.getConfiguration('aide').get<boolean>('agents.revealTerminal', true);
			if (reveal) agentTerminal.show();
			agentTerminal.write(`\x1b[1;36m$ ${command}\x1b[0m  \x1b[90m(${opts.cwd})\x1b[0m\n`);
			const item: CapturedExecution = { terminal: 'AIDE Agent', command, cwd: opts.cwd, output: '', ts: Date.now() };
			capture.push(item);
			const r = await spawnCommand(command, {
				...opts,
				onData: s => {
					agentTerminal.write(s);
					opts.onData?.(s);
				},
			});
			item.output = r.output;
			item.exitCode = r.exitCode ?? undefined;
			const status = r.timedOut ? 'timed out' : r.killed ? 'cancelled' : `exit ${r.exitCode}`;
			agentTerminal.write(`\x1b[${r.exitCode === 0 ? '32' : '31'}m[${status}]\x1b[0m\n\n`);
			return r;
		},
		ripgrepPath() {
			const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
			return path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe);
		},
		async openFile(absPath, line) {
			const doc = await vscode.workspace.openTextDocument(absPath);
			const ed = await vscode.window.showTextDocument(doc, { preview: false });
			if (line) ed.revealRange(new vscode.Range(line - 1, 0, line - 1, 0), vscode.TextEditorRevealType.InCenter);
		},
		fileChanged(absPath) {
			// Open editors on this file reload automatically when not dirty; nothing else needed.
			void absPath;
		},
	};
}

export function formatDiagnostics(root: string | undefined, pathFilter?: string, activeOnly?: vscode.Uri): string {
	const lines: string[] = [];
	const sev = ['error', 'warning', 'info', 'hint'];
	for (const [uri, diags] of vscode.languages.getDiagnostics()) {
		if (activeOnly && uri.toString() !== activeOnly.toString()) continue;
		const rel = root ? path.relative(root, uri.fsPath).replace(/\\/g, '/') : uri.fsPath;
		if (rel.startsWith('..')) continue;
		if (pathFilter && rel !== pathFilter) continue;
		for (const d of diags) {
			if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
			lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev[d.severity]}${d.source ? ` [${d.source}${d.code ? ` ${typeof d.code === 'object' ? d.code.value : d.code}` : ''}]` : ''}: ${d.message}`);
			if (lines.length >= 200) return lines.join('\n') + '\n...';
		}
	}
	return lines.join('\n');
}
