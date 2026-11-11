import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatController } from '../chat/controller';
import type { Services } from '../services';
import { createZip } from './zip';

export const AIDE_API_DOC = `# AIDE extension API (v1)

AIDE extensions are standard VS Code-compatible extensions (package.json manifest +
a CommonJS entry file). Anything the VS Code extension API offers works: commands,
views, webviews, status bar items, themes, keybindings, languages, debuggers.

In addition, AIDE exposes an API for its AI platform:

\`\`\`js
const vscode = require('vscode');
function activate(context) {
  const aide = vscode.extensions.getExtension('aide.aide-core')?.exports;
  if (!aide) return; // running outside AIDE
}
\`\`\`

Declare the dependency in package.json: \`"extensionDependencies": ["aide.aide-core"]\`.

## aide.registerTool(tool) -> Disposable
Adds a tool agents can call.
\`\`\`js
aide.registerTool({
  name: 'docker_ps',                      // [a-zA-Z0-9_-], unique
  description: 'List running containers', // tells the model when to use it
  toolset: 'docker',                      // agents select tools by toolset
  category: 'command',                    // permission: read|write|delete|command|network|git|github|external|mcp
  readOnly: true,
  inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
  describe: input => 'List containers',   // shown in approvals / chat
  async run(input, ctx) {                 // ctx: { root, signal, runId, agentId }
    return { content: 'text result', isError: false };
  },
});
\`\`\`

## aide.registerAgent(agent) -> Disposable
\`\`\`js
aide.registerAgent({
  id: 'docker-helper', name: 'Docker Helper', description: '...',
  task: 'coding',                  // routing task
  tools: ['docker', 'filesystem', 'terminal'],
  instructions: 'You manage Docker for this project...',
});
\`\`\`

## aide.chat({ task, system, prompt | messages, model, maxTokens }) -> { text, model, inputTokens, outputTokens, cost }
Calls a model through AIDE's router (limits, fallback and usage tracking apply).

## aide.runAgent({ agentId, prompt }) -> { status, text }
Runs an agent visibly in the AIDE chat (with the normal approval prompts).

## aide.buildContext(prompt, strategy) -> { items, totalTokens }
The context AIDE would attach for a prompt (strategy: minimal | balanced | deep | maximum).

## aide.registerWorkflow({ name, description, steps }) -> Disposable
Steps: { run: 'npm test' } | { command: 'workbench.action.files.saveAll' } | { agent: 'reviewer', prompt: '...' }
| { ai: 'commit-message' | 'pr-description' } | { confirm: 'Message' } | { git: 'commit' | 'push' } | { github: 'create-pr' }.

## aide.registerConnector(connector) / aide.registerProvider(provider) / aide.registerProviderKind(kind, factory)
See the AIDE source (src/connectors/connectors.ts, src/ai/types.ts) for the interfaces.

## aide.models() / aide.onDidRecordRequest(listener)
`;

interface Template {
	id: string;
	label: string;
	description: string;
	files: (name: string, id: string) => Record<string, string>;
	contributes: (name: string, id: string) => Record<string, unknown>;
}

const header = (name: string) => `// ${name} - an AIDE extension. Edit freely; run it with "AIDE: Run Extension in Development Host".\nconst vscode = require('vscode');\n`;

const TEMPLATES: Template[] = [
	{
		id: 'command',
		label: 'Command',
		description: 'A command in the Command Palette',
		contributes: (name, id) => ({ commands: [{ command: `${id}.hello`, title: `${name}: Hello` }] }),
		files: (name, id) => ({
			'extension.js': `${header(name)}
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('${id}.hello', () => {
    vscode.window.showInformationMessage('Hello from ${name}!');
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
`,
		}),
	},
	{
		id: 'panel',
		label: 'Panel (webview)',
		description: 'A custom editor-area panel with HTML UI',
		contributes: (name, id) => ({ commands: [{ command: `${id}.open`, title: `${name}: Open Panel` }] }),
		files: (name, id) => ({
			'extension.js': `${header(name)}
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('${id}.open', () => {
    const panel = vscode.window.createWebviewPanel('${id}', '${name}', vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = \`<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground)">
      <h2>${name}</h2><p id="t">Loading...</p>
      <button onclick="acquireVsCodeApi().postMessage({ type: 'refresh' })">Refresh</button>
      <script>window.addEventListener('message', e => document.getElementById('t').textContent = e.data.text);</script>
    </body></html>\`;
    const update = () => panel.webview.postMessage({ text: 'Updated at ' + new Date().toLocaleTimeString() });
    panel.webview.onDidReceiveMessage(m => m.type === 'refresh' && update());
    update();
  }));
}
module.exports = { activate, deactivate() {} };
`,
		}),
	},
	{
		id: 'sidebar',
		label: 'Sidebar view (tree)',
		description: 'A tree view in the Explorer sidebar',
		contributes: (name, id) => ({ views: { explorer: [{ id: `${id}.view`, name }] }, commands: [{ command: `${id}.refresh`, title: 'Refresh', icon: '$(refresh)' }], menus: { 'view/title': [{ command: `${id}.refresh`, when: `view == ${id}.view`, group: 'navigation' }] } }),
		files: (name, id) => ({
			'extension.js': `${header(name)}
class Provider {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeTreeData = this._e.event; }
  refresh() { this._e.fire(); }
  getTreeItem(el) { return new vscode.TreeItem(el.label); }
  getChildren() { return [{ label: 'Item one' }, { label: 'Item two' }, { label: new Date().toLocaleTimeString() }]; }
}
function activate(context) {
  const p = new Provider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('${id}.view', p), vscode.commands.registerCommand('${id}.refresh', () => p.refresh()));
}
module.exports = { activate, deactivate() {} };
`,
		}),
	},
	{
		id: 'statusbar',
		label: 'Status bar item',
		description: 'A live status bar widget',
		contributes: () => ({}),
		files: name => ({
			'extension.js': `${header(name)}
function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  const update = () => { item.text = '$(clock) ' + new Date().toLocaleTimeString(); };
  update();
  item.show();
  const t = setInterval(update, 1000);
  context.subscriptions.push(item, { dispose: () => clearInterval(t) });
}
module.exports = { activate, deactivate() {} };
`,
		}),
	},
	{
		id: 'ai-tool',
		label: 'AI tool',
		description: 'A tool AIDE agents can call',
		contributes: () => ({}),
		files: (name, id) => ({
			'extension.js': `${header(name)}
function activate(context) {
  const aide = vscode.extensions.getExtension('aide.aide-core')?.exports;
  if (!aide) { vscode.window.showWarningMessage('${name} needs AIDE.'); return; }
  context.subscriptions.push(aide.registerTool({
    name: '${id.replace(/[^a-zA-Z0-9_]/g, '_')}_word_count',
    description: 'Count words in a workspace file',
    toolset: '${id}',
    category: 'read',
    readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: i => 'Count words in ' + i.path,
    async run(input, ctx) {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(ctx.root), String(input.path));
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      return { content: String(text.split(/\\s+/).filter(Boolean).length) };
    },
  }));
  // Give an agent access with tools: ['${id}'] (or register one below).
  context.subscriptions.push(aide.registerAgent({ id: '${id}-agent', name: '${name} Agent', task: 'chat', tools: ['${id}', 'filesystem', 'search'], instructions: 'You help with word counts. Use the word count tool.' }));
}
module.exports = { activate, deactivate() {} };
`,
		}),
	},
	{
		id: 'agent',
		label: 'AI agent',
		description: 'A custom agent with its own instructions and tools',
		contributes: () => ({}),
		files: (name, id) => ({
			'extension.js': `${header(name)}
function activate(context) {
  const aide = vscode.extensions.getExtension('aide.aide-core')?.exports;
  if (!aide) return;
  context.subscriptions.push(aide.registerAgent({
    id: '${id}',
    name: '${name}',
    description: 'Describe what this agent does',
    task: 'coding',
    tools: ['filesystem', 'search', 'terminal', 'ide'],
    instructions: 'You are a specialist in ... Explain how the agent should work here.',
  }));
}
module.exports = { activate, deactivate() {} };
`,
		}),
	},
	{
		id: 'theme',
		label: 'Color theme',
		description: 'A color theme',
		contributes: name => ({ themes: [{ label: name, uiTheme: 'vs-dark', path: './theme.json' }] }),
		files: name => ({
			'extension.js': `${header(name)}\nmodule.exports = { activate() {}, deactivate() {} };\n`,
			'theme.json': JSON.stringify({ name, type: 'dark', colors: { 'editor.background': '#1b1d23', 'activityBar.background': '#15171c', 'sideBar.background': '#17191e', 'statusBar.background': '#3d5afe', focusBorder: '#3d5afe' }, tokenColors: [{ scope: ['keyword', 'storage'], settings: { foreground: '#82aaff' } }, { scope: ['string'], settings: { foreground: '#c3e88d' } }, { scope: ['comment'], settings: { foreground: '#676e95', fontStyle: 'italic' } }] }, null, 2),
		}),
	},
	{
		id: 'mcp',
		label: 'MCP server (Node)',
		description: 'A Model Context Protocol server; register it under AIDE > MCP',
		contributes: () => ({}),
		files: (name, id) => ({
			'extension.js': `${header(name)}\n// This folder also contains server.mjs, a standalone MCP server.\n// Add it to AIDE: "MCP: Add Server" -> command: node, args: <this folder>/server.mjs\nmodule.exports = { activate() {}, deactivate() {} };\n`,
			'server.mjs': `// Minimal MCP server over stdio (JSON-RPC). Run: node server.mjs
import readline from 'node:readline';
const tools = [{ name: 'hello', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }];
const rl = readline.createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: '${id}', version: '0.1.0' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Hello, ' + msg.params.arguments.name + '!' }] } });
  else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
`,
		}),
	},
];

export class ExtensionBuilder {
	constructor(private readonly s: Services, private readonly chat: ChatController) {}

	register(ctx: vscode.ExtensionContext): void {
		const safe = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
			try {
				await fn(...a);
			} catch (e) {
				void vscode.window.showErrorMessage(`AIDE: ${(e as Error).message}`);
			}
		};
		ctx.subscriptions.push(
			vscode.commands.registerCommand('aide.extensions.new', safe(() => this.create())),
			vscode.commands.registerCommand('aide.extensions.buildWithAi', safe(() => this.buildWithAi())),
			vscode.commands.registerCommand('aide.extensions.run', safe((dir?: string) => this.run(dir))),
			vscode.commands.registerCommand('aide.extensions.install', safe((dir?: string) => this.install(dir))),
			vscode.commands.registerCommand('aide.extensions.package', safe(async (dir?: string) => {
				const d = dir ?? (await this.pickFolder());
				if (!d) return;
				const vsix = this.packageVsix(d);
				void vscode.window.showInformationMessage(`Packaged ${path.basename(vsix)}`, 'Reveal').then(p => p && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(vsix)));
			})),
			vscode.commands.registerCommand('aide.extensions.uninstall', safe(() => this.uninstall())),
			vscode.commands.registerCommand('aide.extensions.openApiDocs', async () => {
				const doc = await vscode.workspace.openTextDocument({ content: AIDE_API_DOC, language: 'markdown' });
				await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
			}),
		);
	}

	private get home(): string {
		return vscode.workspace.getConfiguration('aide').get<string>('extensions.folder') || path.join(os.homedir(), 'aide-extensions');
	}

	/** Write an extension scaffold; returns its folder. */
	scaffold(name: string, templateId: string, dir?: string): string {
		const t = TEMPLATES.find(x => x.id === templateId) ?? TEMPLATES[0];
		const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-extension';
		const folder = dir ?? path.join(this.home, id);
		if (fs.existsSync(path.join(folder, 'package.json'))) throw new Error(`${folder} already contains an extension.`);
		fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
		const pkg = {
			name: id,
			displayName: name,
			description: t.description,
			version: '0.0.1',
			publisher: 'local',
			engines: { vscode: '^1.90.0' },
			categories: ['Other'],
			keywords: ['aide-extension'],
			activationEvents: ['onStartupFinished'],
			main: './extension.js',
			extensionDependencies: ['aide.aide-core'],
			contributes: t.contributes(name, id),
		};
		fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
		for (const [f, content] of Object.entries(t.files(name, id))) fs.writeFileSync(path.join(folder, f), content);
		fs.writeFileSync(path.join(folder, 'AIDE_API.md'), AIDE_API_DOC);
		fs.writeFileSync(path.join(folder, 'README.md'), `# ${name}\n\n${t.description}. Generated by AIDE.\n\n- Run: **AIDE: Run Extension in Development Host**\n- Install: **AIDE: Install Extension from Folder**\n- API: see AIDE_API.md\n`);
		fs.writeFileSync(path.join(folder, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Run Extension', type: 'extensionHost', request: 'launch', args: ['--extensionDevelopmentPath=${workspaceFolder}'] }] }, null, 2));
		void this.s.context.globalState.update('aide.lastExtensionFolder', folder);
		return folder;
	}

	private async create(): Promise<void> {
		const t = await vscode.window.showQuickPick(TEMPLATES.map(x => ({ label: x.label, description: x.description, id: x.id })), { placeHolder: 'New AIDE extension - choose a type' });
		if (!t) return;
		const name = await vscode.window.showInputBox({ prompt: 'Extension name', placeHolder: 'Docker Manager' });
		if (!name) return;
		const folder = this.scaffold(name, t.id);
		const next = await vscode.window.showInformationMessage(`Created ${name} in ${folder}`, 'Run it', 'Open folder', 'Add to workspace');
		if (next === 'Run it') await this.run(folder);
		if (next === 'Open folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
		if (next === 'Add to workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(folder) });
		await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'extension.js')));
	}

	/** "Create an AIDE extension that adds a Docker management panel." */
	private async buildWithAi(): Promise<void> {
		const what = await vscode.window.showInputBox({ prompt: 'Describe the extension to build', placeHolder: 'A Docker management panel that lists containers and can start/stop them', ignoreFocusOut: true });
		if (!what) return;
		const name = await vscode.window.showInputBox({ prompt: 'Extension name', value: what.split(/\s+/).slice(0, 3).map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ') });
		if (!name) return;
		const folder = this.scaffold(name, 'command');
		await vscode.commands.executeCommand('aide.chat.focus');
		const result = await this.chat.send({
			agentId: 'extension-builder',
			newConversation: true,
			root: folder,
			strategy: 'minimal',
			text: `Build an AIDE extension in this folder (${folder}): ${what}

The folder already has a scaffold (package.json, extension.js, AIDE_API.md). Steps:
1. Read package.json, extension.js and AIDE_API.md.
2. Design it briefly (what commands/views/tools it adds), then implement it in extension.js (CommonJS, no build step, no npm dependencies unless essential) and update package.json contributes.
3. Verify: run \`node --check extension.js\` and fix any errors; validate package.json with \`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"\`.
4. Explain the architecture in README.md and summarize how to run it.`,
		});
		if (result?.status === 'completed') {
			const next = await vscode.window.showInformationMessage(`Extension "${name}" is ready in ${folder}.`, 'Run in Development Host', 'Install', 'Open folder');
			if (next === 'Run in Development Host') await this.run(folder);
			if (next === 'Install') await this.install(folder);
			if (next === 'Open folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
		}
	}

	private async pickFolder(): Promise<string | undefined> {
		const last = this.s.context.globalState.get<string>('aide.lastExtensionFolder');
		const ws = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).filter(f => fs.existsSync(path.join(f, 'package.json'))) ?? [];
		const candidates = [...new Set([...(last ? [last] : []), ...ws])];
		if (fs.existsSync(this.home)) for (const d of fs.readdirSync(this.home)) if (fs.existsSync(path.join(this.home, d, 'package.json'))) candidates.push(path.join(this.home, d));
		const items = [...new Set(candidates)].map(c => ({ label: path.basename(c), description: c, dir: c }));
		items.push({ label: '$(folder) Browse...', description: '', dir: '' });
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Extension folder' });
		if (!pick) return undefined;
		if (pick.dir) return pick.dir;
		const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select extension folder' });
		return uri?.[0]?.fsPath;
	}

	async run(dir?: string): Promise<void> {
		const d = dir ?? (await this.pickFolder());
		if (!d) return;
		if (!fs.existsSync(path.join(d, 'package.json'))) throw new Error(`${d} has no package.json`);
		const ok = await vscode.debug.startDebugging(undefined, { type: 'extensionHost', request: 'launch', name: `Run ${path.basename(d)}`, args: [`--extensionDevelopmentPath=${d}`] });
		if (!ok) throw new Error('Could not start the Extension Development Host.');
	}

	packageVsix(dir: string): string {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		for (const k of ['name', 'version', 'publisher', 'engines']) if (!pkg[k]) throw new Error(`package.json is missing "${k}"`);
		const files: { name: string; data: Buffer }[] = [];
		const walk = (rel: string) => {
			for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
				const r = rel ? `${rel}/${e.name}` : e.name;
				if (['.git', 'node_modules', '.vscode'].includes(e.name) && !(e.name === 'node_modules' && pkg.dependencies && Object.keys(pkg.dependencies).length)) continue;
				if (e.name.endsWith('.vsix')) continue;
				if (e.isDirectory()) walk(r);
				else files.push({ name: `extension/${r}`, data: fs.readFileSync(path.join(dir, r)) });
			}
		};
		walk('');
		const esc = (s: string) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
		const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName ?? pkg.name)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description ?? '')}</Description>
    <Tags>${esc((pkg.keywords ?? []).join(','))}</Tags>
    <Categories>${esc((pkg.categories ?? ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${esc((pkg.extensionDependencies ?? []).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`;
		const exts = new Set(files.map(f => path.extname(f.name).toLowerCase()).filter(Boolean));
		exts.add('.vsixmanifest');
		exts.add('.json');
		const types = `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...exts].map(e => `<Default Extension="${esc(e)}" ContentType="${e === '.json' ? 'application/json' : e === '.vsixmanifest' ? 'text/xml' : 'application/octet-stream'}"/>`).join('')}</Types>`;
		const out = path.join(dir, `${pkg.name}-${pkg.version}.vsix`);
		fs.writeFileSync(out, createZip([{ name: '[Content_Types].xml', data: Buffer.from(types) }, { name: 'extension.vsixmanifest', data: Buffer.from(manifest) }, ...files]));
		return out;
	}

	async install(dir?: string): Promise<void> {
		const d = dir ?? (await this.pickFolder());
		if (!d) return;
		const vsix = this.packageVsix(d);
		await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
		const pick = await vscode.window.showInformationMessage(`Installed ${path.basename(d)}. Reload to activate it.`, 'Reload window');
		if (pick) await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}

	private async uninstall(): Promise<void> {
		const local = vscode.extensions.all.filter(e => !e.id.startsWith('vscode.') && e.id !== 'aide.aide-core' && e.packageJSON?.isBuiltin !== true && !e.extensionUri.fsPath.includes(`${path.sep}resources${path.sep}app${path.sep}extensions`));
		const pick = await vscode.window.showQuickPick(local.map(e => ({ label: e.packageJSON.displayName ?? e.id, description: e.id, id: e.id })), { placeHolder: 'Uninstall which extension?' });
		if (!pick) return;
		await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', pick.id);
		const r = await vscode.window.showInformationMessage(`Uninstalled ${pick.id}.`, 'Reload window');
		if (r) await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}
