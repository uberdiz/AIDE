import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { readMcpConfig, writeMcpConfig, type McpConfigFile } from '../mcp/manager';
import { AIDE_HOME, type Services } from '../services';

/** Strip // and /* comments plus trailing commas from JSONC (settings.json, keybindings.json). */
export function parseJsonc(text: string): any {
	let out = '';
	let inStr = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			out += c;
			if (c === '\\') out += text[++i] ?? '';
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i++;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1') || '{}');
}

const SECRETISH = /(key|token|secret|password|passwd|auth|credential)/i;

/** Redact literal secrets in MCP env/headers unless they use ${secret:...}/${env:...} placeholders. */
export function redactMcp(cfg: McpConfigFile): { config: McpConfigFile; redacted: number } {
	let redacted = 0;
	const out: McpConfigFile = { servers: {} };
	for (const [name, s] of Object.entries(cfg.servers)) {
		const clean = JSON.parse(JSON.stringify(s));
		for (const field of ['env', 'headers'] as const) {
			for (const [k, v] of Object.entries<string>(clean[field] ?? {})) {
				if (typeof v === 'string' && !/^\$\{(secret|env):/.test(v) && (SECRETISH.test(k) || v.length > 24)) {
					clean[field][k] = '<redacted>';
					redacted++;
				}
			}
		}
		out.servers[name] = clean;
	}
	return { config: out, redacted };
}

interface AideProfile {
	format: 'aide-profile';
	version: 1;
	exportedAt: string;
	settings?: Record<string, unknown>;
	keybindings?: unknown[];
	extensions?: string[];
	agents?: Record<string, string>;
	workflows?: Record<string, string>;
	mcp?: McpConfigFile;
}

function userDir(ctx: vscode.ExtensionContext): string {
	// globalStorage is <User>/globalStorage/<extension-id>
	return path.resolve(ctx.globalStorageUri.fsPath, '..', '..');
}

function readDir(dir: string, re: RegExp): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const f of fs.readdirSync(dir).filter(x => re.test(x))) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
	} catch {
		/* none */
	}
	return out;
}

export function registerProfile(ctx: vscode.ExtensionContext, s: Services): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand('aide.profile.export', async () => {
			const parts = await vscode.window.showQuickPick(
				[
					{ label: 'Settings (includes theme, fonts, AI providers, routing, limits)', id: 'settings', picked: true },
					{ label: 'Keybindings', id: 'keybindings', picked: true },
					{ label: 'Installed extensions (list)', id: 'extensions', picked: true },
					{ label: 'Custom agents (~/.aide/agents)', id: 'agents', picked: true },
					{ label: 'Workflows (~/.aide/workflows)', id: 'workflows', picked: true },
					{ label: 'MCP servers (~/.aide/mcp.json, secrets redacted)', id: 'mcp', picked: true },
				],
				{ canPickMany: true, placeHolder: 'What to include (API keys are never exported)' },
			);
			if (!parts?.length) return;
			const ids = new Set(parts.map(p => p.id));
			const profile: AideProfile = { format: 'aide-profile', version: 1, exportedAt: new Date().toISOString() };
			const u = userDir(ctx);
			if (ids.has('settings')) {
				try {
					profile.settings = parseJsonc(fs.readFileSync(path.join(u, 'settings.json'), 'utf8'));
				} catch {
					profile.settings = {};
				}
			}
			if (ids.has('keybindings')) {
				try {
					profile.keybindings = parseJsonc(fs.readFileSync(path.join(u, 'keybindings.json'), 'utf8'));
				} catch {
					profile.keybindings = [];
				}
			}
			if (ids.has('extensions')) profile.extensions = vscode.extensions.all.filter(e => !e.packageJSON?.isBuiltin && !e.id.startsWith('vscode.') && e.id !== 'aide.aide-core').map(e => e.id);
			if (ids.has('agents')) profile.agents = readDir(path.join(AIDE_HOME, 'agents'), /\.(md|ya?ml)$/i);
			if (ids.has('workflows')) profile.workflows = readDir(path.join(AIDE_HOME, 'workflows'), /\.ya?ml$/i);
			let redacted = 0;
			if (ids.has('mcp')) {
				const r = redactMcp(readMcpConfig(path.join(AIDE_HOME, 'mcp.json')).config);
				profile.mcp = r.config;
				redacted = r.redacted;
			}
			const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), 'aide-profile.json')), filters: { 'AIDE profile': ['json'] } });
			if (!target) return;
			fs.writeFileSync(target.fsPath, JSON.stringify(profile, null, 2));
			void vscode.window.showInformationMessage(`AIDE profile exported${redacted ? ` (${redacted} MCP secret value(s) redacted)` : ''}.`);
		}),
		vscode.commands.registerCommand('aide.profile.import', async () => {
			const src = await vscode.window.showOpenDialog({ filters: { 'AIDE profile': ['json'] }, canSelectMany: false });
			if (!src?.[0]) return;
			const profile = JSON.parse(fs.readFileSync(src[0].fsPath, 'utf8')) as AideProfile;
			if (profile.format !== 'aide-profile') throw new Error('Not an AIDE profile file.');
			const ok = await vscode.window.showWarningMessage('Import this AIDE profile? Settings are merged over yours; keybindings, agents, workflows and MCP servers with the same names are replaced.', { modal: true }, 'Import');
			if (!ok) return;
			const u = userDir(ctx);
			if (profile.settings) {
				let current: Record<string, unknown> = {};
				try {
					current = parseJsonc(fs.readFileSync(path.join(u, 'settings.json'), 'utf8'));
				} catch {
					/* new file */
				}
				fs.writeFileSync(path.join(u, 'settings.json'), JSON.stringify({ ...current, ...profile.settings }, null, '\t'));
			}
			if (profile.keybindings) fs.writeFileSync(path.join(u, 'keybindings.json'), JSON.stringify(profile.keybindings, null, '\t'));
			for (const [dir, files] of [['agents', profile.agents], ['workflows', profile.workflows]] as const) {
				if (!files) continue;
				fs.mkdirSync(path.join(AIDE_HOME, dir), { recursive: true });
				for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(AIDE_HOME, dir, path.basename(f)), content);
			}
			if (profile.mcp) {
				const file = path.join(AIDE_HOME, 'mcp.json');
				const cur = readMcpConfig(file).config;
				writeMcpConfig(file, { servers: { ...cur.servers, ...profile.mcp.servers } });
			}
			s.reloadAgents();
			await s.reloadMcp();
			const missing = (profile.extensions ?? []).filter(id => !vscode.extensions.getExtension(id));
			if (missing.length) {
				const inst = await vscode.window.showInformationMessage(`Profile imported. ${missing.length} extension(s) from the profile are not installed.`, 'Install from marketplace', 'Skip');
				if (inst === 'Install from marketplace') for (const id of missing) await vscode.commands.executeCommand('workbench.extensions.installExtension', id).then(undefined, e => s.log.warn(`Could not install ${id}: ${e}`));
			} else void vscode.window.showInformationMessage('Profile imported.');
			const redacted = JSON.stringify(profile.mcp ?? {}).includes('<redacted>');
			if (redacted) void vscode.window.showWarningMessage('Some MCP server secrets were redacted in the profile. Re-enter them (use ${secret:name} placeholders with "AIDE: Store Secret").');
		}),
	);
}
