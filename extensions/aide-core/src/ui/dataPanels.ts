import * as vscode from 'vscode';
import type { RequestRecord } from '../ai/client';
import { estimateMessageTokens } from '../ai/tokens';
import type { Services } from '../services';
import { webviewHtml } from './webviewHtml';

/** Tool call statistics for the diagnostics panel. */
export class ToolStats {
	readonly byTool = new Map<string, { calls: number; errors: number; totalMs: number }>();
	record(name: string, isError: boolean, ms: number): void {
		const s = this.byTool.get(name) ?? { calls: 0, errors: 0, totalMs: 0 };
		s.calls++;
		if (isError) s.errors++;
		s.totalMs += ms;
		this.byTool.set(name, s);
	}
}

abstract class DataPanel {
	protected panel: vscode.WebviewPanel;
	protected disposables: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;

	constructor(protected readonly s: Services, viewType: string, title: string, bundle: string, initial?: unknown) {
		this.panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [vscode.Uri.joinPath(s.context.extensionUri, 'media'), vscode.Uri.joinPath(s.context.extensionUri, 'dist')] });
		this.panel.webview.html = webviewHtml(this.panel.webview, s.context.extensionUri, bundle, title, initial);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.s.log.error(`${title} panel`, e)), null, this.disposables);
	}

	protected refreshSoon(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.panel.webview.postMessage({ type: 'data', ...this.data() });
		}, 400);
	}

	protected abstract data(): Record<string, unknown>;

	protected async onMessage(m: any): Promise<void> {
		if (m.type === 'ready') void this.panel.webview.postMessage({ type: 'data', ...this.data() });
		else if (m.type === 'command' && typeof m.command === 'string' && m.command.startsWith('aide.')) await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
	}

	reveal(): void {
		this.panel.reveal();
	}

	protected dispose(): void {
		for (const d of this.disposables) d.dispose();
	}
}

export class UsagePanel extends DataPanel {
	static current: UsagePanel | undefined;

	static show(s: Services, stats: ToolStats): void {
		if (UsagePanel.current) return UsagePanel.current.reveal();
		UsagePanel.current = new UsagePanel(s, stats);
	}

	private constructor(s: Services, private readonly stats: ToolStats) {
		super(s, 'aide.usage', 'AIDE Usage & Diagnostics', 'usage');
		this.disposables.push(s.onDidChangeUsage(() => this.refreshSoon()), s.onDidRecordRequest(() => this.refreshSoon()), s.log.onRecord(r => r.level !== 'debug' && this.refreshSoon()));
	}

	protected data(): Record<string, unknown> {
		const u = this.s.usage;
		return {
			today: u.totals('day'),
			month: u.totals('month'),
			all: u.totals('all'),
			limits: u.limits,
			daily: u.daily(30),
			byProvider: u.breakdown('month', 'providerId'),
			byModel: u.breakdown('month', 'model'),
			byProject: u.breakdown('month', 'project'),
			recent: u.recentEntries().slice(-60).reverse(),
			requests: {
				total: this.s.requests.length,
				errors: this.s.requests.filter(r => r.status === 'error').length,
				cancelled: this.s.requests.filter(r => r.status === 'cancelled').length,
			},
			tools: [...this.stats.byTool.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.calls - a.calls),
			mcp: this.s.mcp.list().map(m => ({ name: m.name, status: m.status, calls: m.calls, failures: m.failures, error: m.error })),
			logs: this.s.log.records('warn').slice(-150).reverse().map(r => ({ ts: r.ts, level: r.level, msg: r.msg, source: r.source })),
			logFile: this.s.log.file,
		};
	}

	protected override dispose(): void {
		UsagePanel.current = undefined;
		super.dispose();
	}
}

export class InspectorPanel extends DataPanel {
	static current: InspectorPanel | undefined;

	static show(s: Services, requestId?: string): void {
		if (InspectorPanel.current) {
			InspectorPanel.current.reveal();
			if (requestId) void InspectorPanel.current.panel.webview.postMessage({ type: 'select', id: requestId });
			return;
		}
		InspectorPanel.current = new InspectorPanel(s, requestId);
	}

	private constructor(s: Services, requestId?: string) {
		super(s, 'aide.inspector', 'AIDE Context Inspector', 'inspector', { selected: requestId });
		this.disposables.push(s.onDidRecordRequest(() => this.refreshSoon()));
	}

	protected data(): Record<string, unknown> {
		return { requests: [...this.s.requests].reverse().map(r => serialize(r)) };
	}

	protected override dispose(): void {
		InspectorPanel.current = undefined;
		super.dispose();
	}
}

function serialize(r: RequestRecord): Record<string, unknown> {
	return {
		...r,
		modelInfo: r.modelInfo,
		messages: r.messages.map(m => {
			const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : `[image ${p.mediaType}]`)).join('\n');
			return {
				role: m.role,
				toolName: m.toolName,
				isError: m.isError,
				tokens: estimateMessageTokens(m),
				text: text.length > 60_000 ? text.slice(0, 60_000) + `\n... [${text.length - 60_000} more characters]` : text,
				toolCalls: m.toolCalls?.map(c => ({ name: c.name, input: JSON.stringify(c.input).slice(0, 4000) })),
			};
		}),
	};
}
