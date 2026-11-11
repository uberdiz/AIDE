import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GitHubClient } from '../github/github';
import type { Services } from '../services';

export interface ConnectorItem {
	id: string;
	name: string;
	kind: 'folder' | 'file';
	mimeType?: string;
	size?: number;
	modified?: string;
	url?: string;
}

export interface ConnectorContent {
	name: string;
	mimeType?: string;
	/** text when the item is textual (or exportable as text) */
	text?: string;
	data?: Buffer;
}

/**
 * Connector API: external storage/services AIDE can browse, import from and
 * (with the "external" permission) use as AI context via @doc:<connector>:<id>.
 */
export interface Connector {
	readonly id: string;
	readonly name: string;
	readonly icon: string;
	isConnected(): Promise<boolean>;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	list(parentId?: string): Promise<ConnectorItem[]>;
	read(id: string): Promise<ConnectorContent>;
	search?(query: string): Promise<ConnectorItem[]>;
	upload?(parentId: string | undefined, name: string, data: Buffer): Promise<ConnectorItem>;
}

export class ConnectorRegistry {
	private items = new Map<string, Connector>();
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	register(c: Connector): vscode.Disposable {
		this.items.set(c.id, c);
		this.emitter.fire();
		return new vscode.Disposable(() => {
			this.items.delete(c.id);
			this.emitter.fire();
		});
	}

	get(id: string): Connector | undefined {
		return this.items.get(id);
	}

	all(): Connector[] {
		return [...this.items.values()];
	}

	changed(): void {
		this.emitter.fire();
	}
}

// ------------------------------------------------------------------ GitHub

export class GitHubConnector implements Connector {
	readonly id = 'github';
	readonly name = 'GitHub';
	readonly icon = 'github';

	constructor(private readonly gh: GitHubClient) {}

	isConnected() {
		return this.gh.signedIn();
	}
	async connect() {
		await this.gh.getToken(true);
	}
	disconnect() {
		return this.gh.signOut();
	}

	/** ids: "" (repos) | "owner/repo" | "owner/repo:path/in/repo" */
	async list(parentId?: string): Promise<ConnectorItem[]> {
		if (!parentId) {
			const repos = await this.gh.request<any[]>('GET', '/user/repos?per_page=100&sort=updated');
			return repos.map(r => ({ id: r.full_name, name: r.full_name, kind: 'folder', url: r.html_url, modified: r.updated_at }));
		}
		const [repo, p = ''] = parentId.split(':');
		const items = await this.gh.request<any[]>('GET', `/repos/${repo}/contents/${encodePath(p)}`);
		return items
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
			.map(i => ({ id: `${repo}:${i.path}`, name: i.name, kind: i.type === 'dir' ? 'folder' : 'file', size: i.size, url: i.html_url }));
	}

	async read(id: string): Promise<ConnectorContent> {
		const [repo, p] = id.split(':');
		const text = await this.gh.request<string>('GET', `/repos/${repo}/contents/${encodePath(p)}`, undefined, 'application/vnd.github.raw');
		return { name: path.basename(p), text };
	}

	async search(query: string): Promise<ConnectorItem[]> {
		const r = await this.gh.request('GET', `/search/repositories?q=${encodeURIComponent(query)}+user:@me&per_page=30`);
		return (r.items ?? []).map((x: any) => ({ id: x.full_name, name: x.full_name, kind: 'folder' as const, url: x.html_url }));
	}
}

function encodePath(p: string): string {
	return p.split('/').map(encodeURIComponent).join('/');
}

// ------------------------------------------------------------------ Google Drive

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const EXPORTS: Record<string, [string, string]> = {
	'application/vnd.google-apps.document': ['text/markdown', '.md'],
	'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'],
	'application/vnd.google-apps.presentation': ['text/plain', '.txt'],
	'application/vnd.google-apps.drawing': ['image/svg+xml', '.svg'],
};

/**
 * Google Drive via OAuth 2.0 for desktop apps (loopback redirect + PKCE).
 * Requires the user's own OAuth client (aide.connectors.googleDrive.clientId /
 * client secret stored with "Connectors: Configure Google Drive"), because AIDE
 * does not ship shared credentials. Read-only scope.
 */
export class GoogleDriveConnector implements Connector {
	readonly id = 'gdrive';
	readonly name = 'Google Drive';
	readonly icon = 'cloud';
	private access: { token: string; expires: number } | undefined;

	constructor(private readonly s: Services) {}

	private clientId(): string | undefined {
		return vscode.workspace.getConfiguration('aide').get<string>('connectors.googleDrive.clientId') || undefined;
	}

	async isConnected(): Promise<boolean> {
		return !!(await this.s.getSecret('gdrive.refresh'));
	}

	async configure(): Promise<boolean> {
		const id = await vscode.window.showInputBox({ prompt: 'Google OAuth client ID (type "Desktop app", from console.cloud.google.com > APIs & Services > Credentials; enable the Drive API)', value: this.clientId() ?? '', ignoreFocusOut: true });
		if (!id) return false;
		const secret = await vscode.window.showInputBox({ prompt: 'OAuth client secret (stored in the OS keychain)', password: true, ignoreFocusOut: true });
		if (!secret) return false;
		await vscode.workspace.getConfiguration('aide').update('connectors.googleDrive.clientId', id.trim(), vscode.ConfigurationTarget.Global);
		await this.s.setSecret('gdrive.clientSecret', secret.trim());
		return true;
	}

	async connect(): Promise<void> {
		if (!this.clientId() || !(await this.s.getSecret('gdrive.clientSecret'))) {
			if (!(await this.configure())) return;
		}
		const clientId = this.clientId()!;
		const clientSecret = (await this.s.getSecret('gdrive.clientSecret'))!;
		const verifier = crypto.randomBytes(48).toString('base64url');
		const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
		const state = crypto.randomBytes(16).toString('hex');
		const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
			const server = http.createServer((req, res) => {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				const err = url.searchParams.get('error');
				const c = url.searchParams.get('code');
				res.writeHead(200, { 'content-type': 'text/html' });
				res.end(`<html><body style="font-family:sans-serif"><h3>${c && url.searchParams.get('state') === state ? 'AIDE is connected to Google Drive. You can close this tab.' : 'Authorization failed.'}</h3></body></html>`);
				server.close();
				if (err) reject(new Error(`Google authorization failed: ${err}`));
				else if (!c || url.searchParams.get('state') !== state) reject(new Error('Invalid OAuth response'));
				else resolve({ code: c, redirectUri });
			});
			let redirectUri = '';
			server.listen(0, '127.0.0.1', () => {
				const port = (server.address() as { port: number }).port;
				redirectUri = `http://127.0.0.1:${port}`;
				const auth = `${GOOGLE_AUTH}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.readonly', code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state })}`;
				void vscode.env.openExternal(vscode.Uri.parse(auth));
			});
			setTimeout(() => {
				server.close();
				reject(new Error('Timed out waiting for Google authorization (5 minutes).'));
			}, 5 * 60_000);
		});
		const res = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
		const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
		if (!res.ok || !tok.refresh_token) throw new Error(`Google token exchange failed: ${tok.error_description ?? res.status}`);
		await this.s.setSecret('gdrive.refresh', tok.refresh_token);
		this.access = { token: tok.access_token!, expires: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 };
	}

	async disconnect(): Promise<void> {
		this.access = undefined;
		await this.s.setSecret('gdrive.refresh', undefined);
	}

	private async token(): Promise<string> {
		if (this.access && this.access.expires > Date.now()) return this.access.token;
		const refresh = await this.s.getSecret('gdrive.refresh');
		const secret = await this.s.getSecret('gdrive.clientSecret');
		if (!refresh || !secret || !this.clientId()) throw new Error('Google Drive is not connected.');
		const res = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId()!, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
		const tok = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
		if (!res.ok || !tok.access_token) throw new Error(`Google token refresh failed: ${tok.error_description ?? res.status}. Reconnect Google Drive.`);
		this.access = { token: tok.access_token, expires: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 };
		return tok.access_token;
	}

	private async api(url: string): Promise<Response> {
		const res = await fetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
		if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
		return res;
	}

	private toItem(f: any): ConnectorItem {
		return { id: f.id, name: f.name, kind: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file', mimeType: f.mimeType, size: f.size ? Number(f.size) : undefined, modified: f.modifiedTime, url: f.webViewLink };
	}

	async list(parentId?: string): Promise<ConnectorItem[]> {
		const q = `'${parentId ?? 'root'}' in parents and trashed = false`;
		const res = await this.api(`${DRIVE}/files?${new URLSearchParams({ q, pageSize: '200', orderBy: 'folder,name', fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)' })}`);
		return ((await res.json()) as { files: any[] }).files.map(f => this.toItem(f));
	}

	async search(query: string): Promise<ConnectorItem[]> {
		const q = `(name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}') and trashed = false`;
		const res = await this.api(`${DRIVE}/files?${new URLSearchParams({ q, pageSize: '50', fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)' })}`);
		return ((await res.json()) as { files: any[] }).files.map(f => this.toItem(f));
	}

	async read(id: string): Promise<ConnectorContent> {
		const meta = (await (await this.api(`${DRIVE}/files/${id}?fields=id,name,mimeType,size`)).json()) as { name: string; mimeType: string; size?: string };
		const exp = EXPORTS[meta.mimeType];
		if (exp) {
			const res = await this.api(`${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(exp[0])}`);
			const name = meta.name.endsWith(exp[1]) ? meta.name : meta.name + exp[1];
			return { name, mimeType: exp[0], text: await res.text() };
		}
		if (meta.size && Number(meta.size) > 50 * 1024 * 1024) throw new Error('File is larger than 50 MB; download it from Drive directly.');
		const buf = Buffer.from(await (await this.api(`${DRIVE}/files/${id}?alt=media`)).arrayBuffer());
		const textual = /^text\/|json|xml|javascript|yaml|csv|markdown/.test(meta.mimeType) || !buf.subarray(0, 8000).includes(0);
		return { name: meta.name, mimeType: meta.mimeType, text: textual ? buf.toString('utf8') : undefined, data: buf };
	}
}

// ------------------------------------------------------------------ view

type CNode = { kind: 'connector'; c: Connector; connected: boolean } | { kind: 'item'; c: Connector; item: ConnectorItem } | { kind: 'msg'; text: string };

export class ConnectorsView implements vscode.TreeDataProvider<CNode> {
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly s: Services, private readonly reg: ConnectorRegistry, private readonly addToChat: (text: string) => void) {}

	register(ctx: vscode.ExtensionContext): void {
		const safe = (fn: (n: any) => Promise<unknown>) => async (n: any) => {
			try {
				await fn(n);
			} catch (e) {
				void vscode.window.showErrorMessage((e as Error).message);
			}
		};
		ctx.subscriptions.push(
			vscode.window.createTreeView('aide.connectors', { treeDataProvider: this }),
			this.reg.onDidChange(() => this.emitter.fire()),
			vscode.commands.registerCommand('aide.connectors.connect', safe(async (n?: CNode) => {
				const c = n?.kind === 'connector' ? n.c : await this.pick();
				if (!c) return;
				await c.connect();
				this.emitter.fire();
			})),
			vscode.commands.registerCommand('aide.connectors.disconnect', safe(async (n: CNode) => {
				if (n?.kind !== 'connector') return;
				await n.c.disconnect();
				this.emitter.fire();
			})),
			vscode.commands.registerCommand('aide.connectors.configureDrive', safe(async () => {
				const d = this.reg.get('gdrive') as GoogleDriveConnector | undefined;
				if (d && (await d.configure())) void vscode.window.showInformationMessage('Google Drive client configured. Use "Connect" to sign in.');
			})),
			vscode.commands.registerCommand('aide.connectors.preview', safe(async (n: CNode) => {
				if (n?.kind !== 'item' || n.item.kind !== 'file') return;
				const content = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading ${n.item.name}...` }, () => n.c.read(n.item.id));
				if (content.text === undefined) return void vscode.window.showInformationMessage(`${content.name} is binary (${content.mimeType ?? 'unknown type'}); import it to use it.`);
				const doc = await vscode.workspace.openTextDocument({ content: content.text, language: guessLanguage(content.name) });
				await vscode.window.showTextDocument(doc, { preview: true });
			})),
			vscode.commands.registerCommand('aide.connectors.import', safe(async (n: CNode) => {
				if (n?.kind !== 'item') return;
				const root = this.s.root;
				if (!root) throw new Error('Open a folder to import into.');
				const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, n.item.name)), title: 'Import into workspace' });
				if (!target) return;
				if (n.item.kind === 'folder') {
					const count = await this.importFolder(n.c, n.item.id, target.fsPath);
					void vscode.window.showInformationMessage(`Imported ${count} file(s) into ${vscode.workspace.asRelativePath(target)}.`);
				} else {
					const content = await n.c.read(n.item.id);
					const finalPath = path.extname(target.fsPath) ? target.fsPath : target.fsPath + path.extname(content.name);
					fs.mkdirSync(path.dirname(finalPath), { recursive: true });
					fs.writeFileSync(finalPath, content.data ?? content.text ?? '');
					await vscode.window.showTextDocument(vscode.Uri.file(finalPath));
				}
			})),
			vscode.commands.registerCommand('aide.connectors.addToChat', (n: CNode) => {
				if (n?.kind === 'item' && n.item.kind === 'file') this.addToChat(`@doc:${n.c.id}:${n.item.id} `);
			}),
			vscode.commands.registerCommand('aide.connectors.search', safe(async () => {
				const c = await this.pick(true);
				if (!c?.search) return;
				const q = await vscode.window.showInputBox({ prompt: `Search ${c.name}` });
				if (!q) return;
				const results = await c.search(q);
				const pick = await vscode.window.showQuickPick(results.map(r => ({ label: r.name, description: r.kind, item: r })), { placeHolder: `${results.length} result(s)` });
				if (!pick) return;
				const act = await vscode.window.showQuickPick(['Preview', 'Import into workspace', 'Add to chat'], { placeHolder: pick.label });
				const node: CNode = { kind: 'item', c, item: pick.item };
				if (act === 'Preview') await vscode.commands.executeCommand('aide.connectors.preview', node);
				if (act === 'Import into workspace') await vscode.commands.executeCommand('aide.connectors.import', node);
				if (act === 'Add to chat') await vscode.commands.executeCommand('aide.connectors.addToChat', node);
			})),
		);
	}

	private async importFolder(c: Connector, id: string, dest: string, depth = 0): Promise<number> {
		if (depth > 8) return 0;
		fs.mkdirSync(dest, { recursive: true });
		let n = 0;
		for (const it of await c.list(id)) {
			if (it.kind === 'folder') n += await this.importFolder(c, it.id, path.join(dest, safeName(it.name)), depth + 1);
			else {
				const content = await c.read(it.id);
				fs.writeFileSync(path.join(dest, safeName(content.name)), content.data ?? content.text ?? '');
				n++;
			}
		}
		return n;
	}

	private async pick(searchable = false): Promise<Connector | undefined> {
		const list = this.reg.all().filter(c => !searchable || c.search);
		return (await vscode.window.showQuickPick(list.map(c => ({ label: c.name, c })), { placeHolder: 'Connector' }))?.c;
	}

	getTreeItem(n: CNode): vscode.TreeItem {
		if (n.kind === 'msg') return new vscode.TreeItem(n.text);
		if (n.kind === 'connector') {
			const it = new vscode.TreeItem(n.c.name, n.connected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
			it.iconPath = new vscode.ThemeIcon(n.c.icon);
			it.description = n.connected ? 'connected' : 'not connected';
			it.contextValue = n.connected ? 'aideConnector.connected' : 'aideConnector';
			if (!n.connected) it.command = { command: 'aide.connectors.connect', title: 'Connect', arguments: [n] };
			return it;
		}
		const it = new vscode.TreeItem(n.item.name, n.item.kind === 'folder' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		it.iconPath = n.item.kind === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
		it.resourceUri = vscode.Uri.parse(`aide-connector:/${n.item.name}`);
		it.description = n.item.size !== undefined ? `${Math.ceil(n.item.size / 1024)} KB` : undefined;
		it.contextValue = `aideConnectorItem.${n.item.kind}`;
		if (n.item.kind === 'file') it.command = { command: 'aide.connectors.preview', title: 'Preview', arguments: [n] };
		return it;
	}

	async getChildren(n?: CNode): Promise<CNode[]> {
		try {
			if (!n) return Promise.all(this.reg.all().map(async c => ({ kind: 'connector' as const, c, connected: await c.isConnected() })));
			if (n.kind === 'connector') return (await n.c.list()).map(item => ({ kind: 'item', c: n.c, item }));
			if (n.kind === 'item' && n.item.kind === 'folder') return (await n.c.list(n.item.id)).map(item => ({ kind: 'item', c: n.c, item }));
			return [];
		} catch (e) {
			return [{ kind: 'msg', text: `Error: ${(e as Error).message}` }];
		}
	}
}

function safeName(n: string): string {
	return n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function guessLanguage(name: string): string | undefined {
	const ext = path.extname(name).slice(1).toLowerCase();
	return ({ md: 'markdown', csv: 'csv', json: 'json', ts: 'typescript', js: 'javascript', py: 'python', txt: 'plaintext', yml: 'yaml', yaml: 'yaml', html: 'html', svg: 'xml', xml: 'xml' } as Record<string, string>)[ext];
}
