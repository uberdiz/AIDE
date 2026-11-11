import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { toMarkdown, type Conversation } from './conversations';

/**
 * Human-readable chat logs: one Markdown transcript per conversation (with
 * tool calls and results) plus a live "AIDE Chat" output channel.
 */
export class ChatLog implements vscode.Disposable {
	private readonly channel = vscode.window.createOutputChannel('AIDE Chat');

	constructor(readonly dir: string, private readonly enabled: () => boolean) {}

	fileFor(c: Conversation): string {
		return path.join(this.dir, `${new Date(c.created).toISOString().slice(0, 10)}_${c.id}.md`);
	}

	write(c: Conversation): void {
		if (!this.enabled()) return;
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			fs.writeFileSync(this.fileFor(c), toMarkdown(c, { tools: true }));
		} catch {
			/* logging must never break the chat */
		}
	}

	delete(c: Conversation): void {
		fs.rmSync(this.fileFor(c), { force: true });
	}

	line(text: string): void {
		this.channel.appendLine(`[${new Date().toLocaleTimeString()}] ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
	}

	show(): void {
		this.channel.show(true);
	}

	dispose(): void {
		this.channel.dispose();
	}
}
