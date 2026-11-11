import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
	ts: number;
	level: Level;
	msg: string;
	source?: string;
	data?: unknown;
}

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Structured logger: writes to a LogOutputChannel (visible in Output > AIDE),
 * a rotating JSONL file, and an in-memory ring buffer for the diagnostics panel.
 */
export class Logger implements vscode.Disposable {
	private readonly channel: vscode.LogOutputChannel;
	private readonly ring: LogRecord[] = [];
	private stream: fs.WriteStream | undefined;
	readonly file: string;
	private listeners = new Set<(r: LogRecord) => void>();

	constructor(readonly dir: string) {
		this.channel = vscode.window.createOutputChannel('AIDE', { log: true });
		fs.mkdirSync(dir, { recursive: true });
		this.file = path.join(dir, 'aide.log.jsonl');
		try {
			if (fs.existsSync(this.file) && fs.statSync(this.file).size > 5 * 1024 * 1024) {
				fs.renameSync(this.file, path.join(dir, 'aide.log.1.jsonl'));
			}
		} catch {
			/* rotation is best effort */
		}
		this.stream = fs.createWriteStream(this.file, { flags: 'a' });
		this.stream.on('error', () => (this.stream = undefined));
	}

	log(level: Level, msg: string, data?: unknown, source?: string): void {
		const rec: LogRecord = { ts: Date.now(), level, msg, source, data };
		this.ring.push(rec);
		if (this.ring.length > 2000) this.ring.splice(0, this.ring.length - 2000);
		const line = source ? `[${source}] ${msg}` : msg;
		const extra = data === undefined ? '' : ` ${safeJson(data)}`;
		switch (level) {
			case 'debug': this.channel.debug(line + extra); break;
			case 'info': this.channel.info(line + extra); break;
			case 'warn': this.channel.warn(line + extra); break;
			case 'error': this.channel.error(line + extra); break;
		}
		this.stream?.write(JSON.stringify({ ...rec, data: data === undefined ? undefined : safeData(data) }) + '\n');
		for (const l of this.listeners) l(rec);
	}

	debug(msg: string, data?: unknown, source?: string) { this.log('debug', msg, data, source); }
	info(msg: string, data?: unknown, source?: string) { this.log('info', msg, data, source); }
	warn(msg: string, data?: unknown, source?: string) { this.log('warn', msg, data, source); }
	error(msg: string, data?: unknown, source?: string) { this.log('error', msg, data, source); }

	/** Scoped logger for a subsystem. */
	scope(source: string) {
		return (level: Level, msg: string, data?: unknown) => this.log(level, msg, data, source);
	}

	records(min: Level = 'debug'): LogRecord[] {
		return this.ring.filter(r => ORDER[r.level] >= ORDER[min]);
	}

	onRecord(fn: (r: LogRecord) => void): vscode.Disposable {
		this.listeners.add(fn);
		return new vscode.Disposable(() => this.listeners.delete(fn));
	}

	show(): void {
		this.channel.show(true);
	}

	asText(min: Level = 'debug'): string {
		return this.records(min).map(r => `${new Date(r.ts).toISOString()} ${r.level.toUpperCase().padEnd(5)} ${r.source ? `[${r.source}] ` : ''}${r.msg}${r.data !== undefined ? ' ' + safeJson(r.data) : ''}`).join('\n');
	}

	clear(): void {
		this.ring.length = 0;
		this.stream?.end();
		try {
			fs.writeFileSync(this.file, '');
		} catch {
			/* ignore */
		}
		this.stream = fs.createWriteStream(this.file, { flags: 'a' });
		this.channel.clear();
	}

	dispose(): void {
		this.stream?.end();
		this.channel.dispose();
	}
}

function safeJson(v: unknown): string {
	try {
		const s = JSON.stringify(v);
		return s && s.length > 2000 ? s.slice(0, 2000) + '...' : s ?? '';
	} catch {
		return String(v);
	}
}

function safeData(v: unknown): unknown {
	if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
	return v;
}
