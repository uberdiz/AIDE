/* Integration tests: run inside the real AIDE application via @vscode/test-electron. */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

type T = { name: string; fn: () => Promise<void>; needsAi?: boolean };
const tests: T[] = [];
const test = (name: string, fn: () => Promise<void>, needsAi = false) => tests.push({ name, fn, needsAi });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<V>(fn: () => V | Promise<V>, timeoutMs = 15000, what = 'condition'): Promise<NonNullable<V>> {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v as NonNullable<V>;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const MODEL = process.env.AIDE_TEST_MODEL ?? 'ollama/llama3.1:latest';
let api: any;
let S: any; // services
let chat: any;
let ws: string;

async function aiAvailable(): Promise<boolean> {
	try {
		const r = await fetch('http://localhost:11434/api/tags');
		const j = (await r.json()) as { models: { name: string }[] };
		return j.models.some(m => `ollama/${m.name}` === MODEL);
	} catch {
		return false;
	}
}

async function configure(key: string, value: unknown) {
	await vscode.workspace.getConfiguration('aide').update(key, value, vscode.ConfigurationTarget.Global);
}

// ------------------------------------------------------------------ phase 1

function phase1() {
	test('extension activates and exposes the API', async () => {
		const ext = vscode.extensions.getExtension('aide.aide-core')!;
		assert.ok(ext, 'aide-core installed');
		api = await ext.activate();
		assert.strictEqual(api.version, '1.0.0');
		assert.ok(api._internals, 'test internals exposed');
		S = api._internals.services;
		chat = api._internals.chat;
	});

	test('every contributed command is registered', async () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(vscode.extensions.getExtension('aide.aide-core')!.extensionPath, 'package.json'), 'utf8'));
		const all = new Set(await vscode.commands.getCommands(true));
		const missing = pkg.contributes.commands.map((c: any) => c.command).filter((c: string) => !all.has(c));
		assert.deepStrictEqual(missing, []);
		assert.ok(all.has('aide.chat.focus'), 'chat view focus command');
	});

	test('workspace: create, edit, save, rename, search, delete files', async () => {
		const a = vscode.Uri.file(path.join(ws, 'src', 'alpha.ts'));
		await vscode.workspace.fs.writeFile(a, Buffer.from('export const alpha = 1;\n'));
		const doc = await vscode.workspace.openTextDocument(a);
		const ed = await vscode.window.showTextDocument(doc);
		await ed.edit(b => b.insert(new vscode.Position(1, 0), 'export const beta = 2;\n'));
		assert.ok(await doc.save());
		assert.ok(fs.readFileSync(a.fsPath, 'utf8').includes('beta = 2'));
		const b = vscode.Uri.file(path.join(ws, 'src', 'renamed.ts'));
		const we = new vscode.WorkspaceEdit();
		we.renameFile(a, b);
		assert.ok(await vscode.workspace.applyEdit(we));
		assert.ok(fs.existsSync(b.fsPath) && !fs.existsSync(a.fsPath));
		const found = await vscode.workspace.findFiles('src/**/*.ts');
		assert.ok(found.some(f => f.fsPath === b.fsPath));
		const search = await S.tools.get('search_text').run({ query: 'beta = 2' }, { root: ws, ide: S.ide, signal: new AbortController().signal });
		assert.ok(search.content.includes('renamed.ts'), search.content);
		await vscode.workspace.fs.delete(b);
		assert.ok(!fs.existsSync(b.fsPath));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('editor: split editor groups and multiple tabs', async () => {
		const f1 = path.join(ws, 'one.txt');
		const f2 = path.join(ws, 'two.txt');
		fs.writeFileSync(f1, '1');
		fs.writeFileSync(f2, '2');
		await vscode.window.showTextDocument(vscode.Uri.file(f1), { viewColumn: vscode.ViewColumn.One });
		await vscode.window.showTextDocument(vscode.Uri.file(f2), { viewColumn: vscode.ViewColumn.Two });
		assert.ok(vscode.window.tabGroups.all.length >= 2);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('terminal: create, run command, multiple terminals, kill', async () => {
		const t1 = vscode.window.createTerminal({ name: 'test-1', cwd: ws });
		const t2 = vscode.window.createTerminal({ name: 'test-2', cwd: ws });
		t1.show();
		const marker = path.join(ws, 'term-marker.txt');
		t1.sendText(process.platform === 'win32' ? `Set-Content -Path "${marker}" -Value terminal-ok` : `echo terminal-ok > "${marker}"`);
		await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('terminal-ok'), 30000, 'terminal command output');
		assert.ok(vscode.window.terminals.filter(t => t.name.startsWith('test-')).length === 2);
		const closed = new Promise<void>(r => vscode.window.onDidCloseTerminal(t => t === t2 && r()));
		t2.dispose();
		await closed;
		t1.dispose();
	});

	test('agent command runner: output, exit codes, cancellation (kills process)', async () => {
		const ok = await S.ide.runCommand('echo agent-run-ok', { cwd: ws, timeoutMs: 30000, signal: new AbortController().signal });
		assert.ok(ok.output.includes('agent-run-ok'));
		assert.strictEqual(ok.exitCode, 0);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1000);
		const killed = await S.ide.runCommand(process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60', { cwd: ws, timeoutMs: 60000, signal: ac.signal });
		assert.ok(killed.killed);
		assert.ok(S.capture.recent(5).some((c: any) => c.command === 'echo agent-run-ok'), '@terminal capture includes agent command');
	});

	test('git: init, status, diff, commit, branch, checkout, push, pull (built-in Git + CLI)', async () => {
		git(ws, 'init', '-b', 'main');
		git(ws, 'config', 'user.email', 'aide@test.local');
		git(ws, 'config', 'user.name', 'AIDE Test');
		fs.writeFileSync(path.join(ws, 'README.md'), '# test\n');
		const gitExt = vscode.extensions.getExtension('vscode.git')!;
		const gapi = (await gitExt.activate()).getAPI(1);
		const repo = (await gapi.openRepository(vscode.Uri.file(ws))) ?? (await until(() => gapi.repositories.find((r: any) => r.rootUri.fsPath.toLowerCase() === ws.toLowerCase()), 20000, 'git repository'));
		await repo.status();
		assert.ok(repo.state.untrackedChanges.length + repo.state.workingTreeChanges.length > 0, 'status shows the new file');
		await repo.add([path.join(ws, 'README.md')]);
		await repo.commit('initial commit');
		assert.strictEqual(git(ws, 'log', '--pretty=%s').trim(), 'initial commit');
		fs.appendFileSync(path.join(ws, 'README.md'), 'more\n');
		const diff = await repo.diffWithHEAD(path.join(ws, 'README.md'));
		assert.ok(diff.includes('+more'));
		await repo.createBranch('feature/x', true);
		assert.strictEqual(git(ws, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/x');
		await repo.add([path.join(ws, 'README.md')]);
		await repo.commit('feature change');
		await repo.checkout('main');
		assert.strictEqual(git(ws, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
		// remote round trip
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-remote-'));
		git(bare, 'init', '--bare', '-b', 'main');
		await repo.addRemote('origin', bare);
		await repo.push('origin', 'main', true);
		const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-clone-'));
		git(other, 'clone', bare, '.');
		git(other, 'config', 'user.email', 'o@test.local');
		git(other, 'config', 'user.name', 'Other');
		fs.writeFileSync(path.join(other, 'from-remote.txt'), 'hi');
		git(other, 'add', '.');
		git(other, 'commit', '-m', 'remote change');
		git(other, 'push');
		await repo.pull();
		assert.ok(fs.existsSync(path.join(ws, 'from-remote.txt')), 'pull brought the remote change');
		// AI git tool (read-only) sees the repo
		const st = await S.tools.get('git_status').run({}, { root: ws, ide: S.ide, signal: new AbortController().signal });
		assert.ok(st.content.includes('main'), st.content);
	});

	test('AI: configure provider and discover models', async () => {
		await configure('providers', [{ id: 'ollama', kind: 'ollama', label: 'Ollama', local: true }, { id: 'broken', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' }]);
		await configure('routing.default', [MODEL]);
		await configure('routing.autoFallback', false);
		await sleep(300);
		await S.refreshModels();
		const refs = S.allModelRefs().map((m: any) => m.ref);
		assert.ok(refs.includes(MODEL), `models: ${refs.join(', ')}`);
		assert.ok(S.modelErrors.get('broken'), 'broken provider reports an error instead of crashing');
	}, true);

	test('AI: chat through the router with streaming and usage accounting', async () => {
		const before = S.usage.totals('day').requests;
		const deltas: string[] = [];
		const r = await S.client.run({ task: 'chat', source: 'test', signal: new AbortController().signal, request: { messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }], maxTokens: 20, temperature: 0 }, onEvent: (e: any) => e.type === 'text' && deltas.push(e.text) });
		const text = typeof r.message.content === 'string' ? r.message.content : '';
		assert.ok(/pong/i.test(text), text);
		assert.ok(deltas.length >= 1, 'streamed deltas');
		assert.ok(S.usage.totals('day').requests > before);
		assert.ok(r.usage.exact && r.usage.inputTokens > 0);
		const api2 = await api.chat({ prompt: 'Say "ok".', maxTokens: 10 });
		assert.ok(api2.text.length > 0 && api2.model === MODEL);
	}, true);

	test('AI: provider fallback when the first model fails', async () => {
		await configure('routing.default', ['broken/some-model', MODEL]);
		await sleep(300);
		const r = await S.client.run({ task: 'chat', source: 'test', signal: new AbortController().signal, request: { messages: [{ role: 'user', content: 'Say hi' }], maxTokens: 10 } });
		assert.strictEqual(`${r.ref.providerId}/${r.ref.modelId}`, MODEL);
		assert.ok(r.record.attempts.some((a: any) => a.ref === 'broken/some-model' && a.error), JSON.stringify(r.record.attempts));
		await configure('routing.default', [MODEL]);
	}, true);

	test('AI: clear error when no model can serve a task', async () => {
		await configure('routing.rules', { review: ['nope/model'] });
		await sleep(300);
		await assert.rejects(() => S.client.run({ task: 'review', source: 'test', strictRoute: true, signal: new AbortController().signal, request: { messages: [{ role: 'user', content: 'x' }] } }), /No model available/);
		await configure('routing.rules', {});
	}, true);

	test('AI: usage limits block, warn, and are enforced before sending', async () => {
		await configure('limits.perRequestTokens', 5);
		await configure('limits.onLimit', 'stop');
		await sleep(300);
		await assert.rejects(() => api.chat({ prompt: 'This prompt is longer than five tokens for sure.' }), /Usage limit/);
		await configure('limits.perRequestTokens', null);
		await configure('providers', [{ id: 'ollama', kind: 'ollama', local: true }, { id: 'broken', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' }]);
		await configure('limits.providers', { ollama: { daily: { tokens: 1 } } });
		await sleep(300);
		const check = S.usage.check('ollama', 100, 0, true);
		assert.strictEqual(check.status, 'exceeded');
		await configure('limits.providers', {});
		await configure('limits.onLimit', 'ask');
	}, true);

	test('AI: file context via @file mention reaches the model', async () => {
		fs.writeFileSync(path.join(ws, 'notes.txt'), 'Project codename: ZEBRA-42\nRelease: autumn\n');
		await configure('permissions.write', 'allow');
		await configure('permissions.command', 'allow');
		const r = await chat.send({ agentId: 'chat', strategy: 'minimal', newConversation: true, text: 'According to @file:notes.txt , what is the project codename? Reply with only the codename.' });
		assert.strictEqual(r.status, 'completed');
		assert.ok(/ZEBRA-42/i.test(r.text), r.text);
		// Context is attached to the first request of the run; later steps carry tool results.
		const withCtx = S.requests.slice(-6).filter((x: any) => x.context?.length);
		assert.ok(withCtx.some((x: any) => x.context.some((c: any) => c.label === 'notes.txt')), 'inspector recorded the context item');
	}, true);

	test('AI: coding agent uses tools to create a file, with checkpoint and review', async () => {
		let r;
		for (let attempt = 0; attempt < 3; attempt++) {
			r = await chat.send({ agentId: 'coder', strategy: 'minimal', newConversation: true, text: 'Use the write_file tool to create a file named hello_aide.txt whose content is exactly: hello from aide' });
			if (fs.existsSync(path.join(ws, 'hello_aide.txt'))) break;
		}
		assert.ok(fs.existsSync(path.join(ws, 'hello_aide.txt')), `agent did not create the file: ${JSON.stringify(r)}`);
		assert.ok(fs.readFileSync(path.join(ws, 'hello_aide.txt'), 'utf8').includes('hello from aide'));
		const pending = S.changes.pendingChanges().map((p: any) => path.basename(p.path));
		assert.ok(pending.includes('hello_aide.txt'), pending.join(','));
		const cps = S.changes.listCheckpoints();
		assert.ok(cps.length > 0);
		const conv = chat.conversation();
		assert.ok(conv.turns.some((t: any) => (t.parts ?? []).some((p: any) => p.type === 'tool' && p.name === 'write_file')));
		// restore the checkpoint -> created file removed
		S.changes.restore(cps.find((c: any) => c.files.some((f: any) => f.path.endsWith('hello_aide.txt'))).id);
		assert.ok(!fs.existsSync(path.join(ws, 'hello_aide.txt')));
	}, true);

	test('AI: cancellation stops a running agent promptly', async () => {
		// Cancel only once text is actually streaming, so the model cannot finish first.
		let streaming!: () => void;
		const firstDelta = new Promise<void>(r => (streaming = r));
		const sub = chat.attach((m: any) => m.type === 'delta' && streaming());
		const p = chat.send({ agentId: 'chat', strategy: 'minimal', newConversation: true, text: 'Count from 1 to 3000, writing each number on its own line. Do not stop early.' });
		await Promise.race([firstDelta, sleep(60_000)]);
		await sleep(300);
		const t0 = Date.now();
		chat.cancel();
		const r = await p;
		sub.dispose();
		assert.strictEqual(r.status, 'cancelled');
		assert.ok(Date.now() - t0 < 5000, 'cancel took too long');
		assert.strictEqual(S.runs.size, 0, 'no orphaned runs');
	}, true);

	test('context engine: strategies, ignore rules and budgets', async () => {
		fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
		fs.writeFileSync(path.join(ws, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
		fs.writeFileSync(path.join(ws, '.env'), 'SECRET_KEY=abc');
		const minimal = await api.buildContext('explain', 'minimal');
		const deep = await api.buildContext('explain the README', 'deep');
		assert.ok(deep.totalTokens >= minimal.totalTokens);
		const all = JSON.stringify(deep.items);
		assert.ok(!all.includes('module.exports = 1'), 'node_modules excluded');
		assert.ok(!all.includes('SECRET_KEY'), 'secrets excluded');
	});

	test('MCP: add, start, list tools, invoke, stop, handle failure', async () => {
		const fixture = path.join(vscode.extensions.getExtension('aide.aide-core')!.extensionPath, 'test', 'fixtures', 'echo-mcp-server.mjs');
		const home = process.env.AIDE_HOME!;
		fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ servers: { echo: { command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: '1' } }, broken: { command: 'no-such-binary-aide' } } }));
		await S.reloadMcp();
		assert.deepStrictEqual(S.mcp.list().map((m: any) => m.name), ['broken', 'echo']);
		await S.mcp.start('echo');
		const tool = S.tools.get('mcp__echo__add');
		assert.ok(tool, 'mcp tool registered');
		const res = await tool.run({ a: 20, b: 22 }, { signal: new AbortController().signal });
		assert.strictEqual(res.content, '42');
		await assert.rejects(() => S.mcp.start('broken'));
		assert.strictEqual(S.mcp.get('broken').status, 'error');
		assert.strictEqual(S.mcp.get('echo').status, 'running', 'healthy server unaffected');
		await S.mcp.stop('echo');
		assert.ok(!S.tools.get('mcp__echo__add'));
	});

	test('extensions: scaffold, package VSIX, install, uninstall', async () => {
		const builder = api._internals.builder;
		const dir = path.join(os.tmpdir(), `aide-ext-${Date.now()}`);
		builder.scaffold('Test Widget', 'command', dir);
		execFileSync(process.execPath, ['--check', path.join(dir, 'extension.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
		const vsix = builder.packageVsix(dir);
		assert.ok(fs.statSync(vsix).size > 500);
		await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
		const extDir = process.env.AIDE_TEST_EXT_DIR!;
		await until(() => fs.readdirSync(extDir).some(d => d.startsWith('local.test-widget')), 20000, 'installed extension folder');
		await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', 'local.test-widget');
	});

	test('extensions: a crashing extension does not break AIDE', async () => {
		const broken = vscode.extensions.getExtension('aide-test.broken-ext');
		assert.ok(broken, 'fixture loaded');
		await assert.rejects(async () => broken!.activate());
		assert.ok(vscode.extensions.getExtension('aide.aide-core')!.isActive);
		assert.ok((await vscode.commands.getCommands(true)).includes('aide.chat.new'));
	});

	test('extension API: register tool and agent', async () => {
		const d1 = api.registerTool({ name: 'ext_test_tool', description: 'test', inputSchema: { type: 'object', properties: {} }, run: async () => ({ content: 'ext-ok' }) });
		const d2 = api.registerAgent({ id: 'ext-agent', name: 'Ext Agent', instructions: 'x', tools: ['ext:external'] });
		assert.ok(S.tools.get('ext_test_tool'));
		assert.ok(S.agents().some((a: any) => a.id === 'ext-agent'));
		d1.dispose();
		d2.dispose();
		assert.ok(!S.tools.get('ext_test_tool'));
	});

	test('custom agents from .aide/agents are loaded', async () => {
		fs.mkdirSync(path.join(ws, '.aide', 'agents'), { recursive: true });
		fs.writeFileSync(path.join(ws, '.aide', 'agents', 'roblox.md'), '---\nname: Roblox Developer\ntools: [filesystem, terminal]\n---\nYou are a Roblox specialist.');
		S.reloadAgents();
		assert.ok(S.agents().some((a: any) => a.id === 'roblox-developer'));
	});

	test('UI: views open, layouts apply, theme changes', async () => {
		await vscode.commands.executeCommand('aide.chat.focus');
		await vscode.commands.executeCommand('workbench.view.extension.aide');
		await vscode.commands.executeCommand('aide.layout.apply', 'Focus');
		assert.strictEqual(vscode.workspace.getConfiguration().get('workbench.activityBar.location'), 'hidden');
		await vscode.commands.executeCommand('aide.layout.apply', 'Coding');
		assert.strictEqual(vscode.workspace.getConfiguration().get('workbench.activityBar.location'), 'default');
		await vscode.workspace.getConfiguration().update('workbench.colorTheme', 'AIDE Light', vscode.ConfigurationTarget.Global);
		await until(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light, 10000, 'light theme');
		await vscode.commands.executeCommand('aide.usage.open');
		await vscode.commands.executeCommand('aide.inspector.open');
		await vscode.commands.executeCommand('aide.settings.open');
		await sleep(1500);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('persist marker for restart check', async () => {
		await configure('agents.default', 'coder');
		fs.writeFileSync(path.join(process.env.AIDE_TEST_STATE!, 'phase1.json'), JSON.stringify({ conversations: S.conversations.list().length, usage: S.usage.totals('all').requests }));
		S.saveUsage();
	});
}

// ------------------------------------------------------------------ phase 2 (after restart)

function phase2() {
	test('after restart: settings, theme, conversations and usage persisted', async () => {
		api = await vscode.extensions.getExtension('aide.aide-core')!.activate();
		S = api._internals.services;
		const p1 = JSON.parse(fs.readFileSync(path.join(process.env.AIDE_TEST_STATE!, 'phase1.json'), 'utf8'));
		assert.strictEqual(vscode.workspace.getConfiguration('aide').get('agents.default'), 'coder');
		assert.strictEqual(vscode.window.activeColorTheme.kind, vscode.ColorThemeKind.Light);
		assert.strictEqual(S.conversations.list().length, p1.conversations);
		assert.strictEqual(S.usage.totals('all').requests, p1.usage);
	});
}

export async function run(): Promise<void> {
	ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
	if (process.env.AIDE_TEST_PHASE === '2') phase2();
	else phase1();
	const ai = await aiAvailable();
	const results: { name: string; status: string; ms: number; error?: string }[] = [];
	for (const t of tests) {
		if (t.needsAi && !ai) {
			results.push({ name: t.name, status: 'SKIP', ms: 0, error: `Ollama model ${MODEL} not available` });
			console.log(`SKIP  ${t.name}`);
			continue;
		}
		const t0 = Date.now();
		try {
			await Promise.race([t.fn(), sleep(240_000).then(() => { throw new Error('test timeout (240s)'); })]);
			results.push({ name: t.name, status: 'PASS', ms: Date.now() - t0 });
			console.log(`PASS  ${t.name} (${Date.now() - t0}ms)`);
		} catch (e) {
			results.push({ name: t.name, status: 'FAIL', ms: Date.now() - t0, error: (e as Error)?.stack ?? String(e) });
			console.log(`FAIL  ${t.name}\n      ${(e as Error)?.message}`);
		}
	}
	fs.writeFileSync(path.join(process.env.AIDE_TEST_STATE!, `results-phase${process.env.AIDE_TEST_PHASE ?? '1'}.json`), JSON.stringify(results, null, 2));
	const failed = results.filter(r => r.status === 'FAIL');
	if (failed.length) throw new Error(`${failed.length} integration test(s) failed`);
}
