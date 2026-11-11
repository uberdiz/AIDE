import { execFile } from 'child_process';
import * as vscode from 'vscode';

/** Small, dependency-free developer utilities. */
export function registerDevTools(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand('aide.dev.formatJson', () => transformJson(t => JSON.stringify(JSON.parse(t), null, 2))),
		vscode.commands.registerCommand('aide.dev.minifyJson', () => transformJson(t => JSON.stringify(JSON.parse(t)))),
		vscode.commands.registerCommand('aide.dev.regexTester', () => regexTester()),
		vscode.commands.registerCommand('aide.dev.ports', () => ports()),
		vscode.commands.registerCommand('aide.dev.env', async () => {
			const secret = /(key|token|secret|password|pwd|auth)/i;
			const items = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ label: k, description: secret.test(k) ? '••••••' : (v ?? '').slice(0, 200) }));
			const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Environment variables of the IDE process (secret-looking values hidden)', matchOnDescription: true });
			if (pick && !secret.test(pick.label)) await vscode.env.clipboard.writeText(process.env[pick.label] ?? '');
		}),
	);
}

async function transformJson(fn: (t: string) => string): Promise<void> {
	const ed = vscode.window.activeTextEditor;
	if (!ed) return;
	const range = ed.selection.isEmpty ? new vscode.Range(ed.document.positionAt(0), ed.document.positionAt(ed.document.getText().length)) : ed.selection;
	try {
		const out = fn(ed.document.getText(range));
		await ed.edit(b => b.replace(range, out));
	} catch (e) {
		void vscode.window.showErrorMessage(`Invalid JSON: ${(e as Error).message}`);
	}
}

function regexTester(): void {
	const panel = vscode.window.createWebviewPanel('aide.regex', 'Regex Tester', vscode.ViewColumn.Beside, { enableScripts: true });
	const nonce = Math.random().toString(36).slice(2);
	panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px}
input,textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);font-family:var(--vscode-editor-font-family);padding:4px}
mark{background:var(--vscode-editor-findMatchHighlightBackground);color:inherit} pre{white-space:pre-wrap;font-family:var(--vscode-editor-font-family)} .err{color:var(--vscode-errorForeground)} .row{display:flex;gap:6px}</style></head>
<body><h3>Regex tester</h3><div class="row"><input id="re" placeholder="pattern, e.g. (\\w+)@(\\w+)\\.com"><input id="fl" value="g" style="width:80px" placeholder="flags"></div>
<p><textarea id="tx" rows="8" placeholder="test text">alice@example.com, bob@test.com</textarea></p><div id="err" class="err"></div><pre id="out"></pre><pre id="groups"></pre>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function run(){$('err').textContent='';let re;try{re=new RegExp($('re').value,$('fl').value.includes('g')?$('fl').value:$('fl').value+'g')}catch(e){$('err').textContent=e.message;return}
const t=$('tx').value;let html='',last=0,groups=[];if(!$('re').value){$('out').innerHTML=esc(t);$('groups').textContent='';return}
for(const m of t.matchAll(re)){if(m[0]==='')continue;html+=esc(t.slice(last,m.index))+'<mark>'+esc(m[0])+'</mark>';last=m.index+m[0].length;groups.push(m.slice(1).length?m[0]+'  ->  '+m.slice(1).map((g,i)=>'$'+(i+1)+'='+g).join('  '):m[0])}
$('out').innerHTML=html+esc(t.slice(last));$('groups').textContent=groups.length+' match(es)\\n'+groups.join('\\n')}
['re','fl','tx'].forEach(id=>$(id).addEventListener('input',run));run();</script></body></html>`;
}

async function ports(): Promise<void> {
	const isWin = process.platform === 'win32';
	const out = await new Promise<string>(resolve => execFile(isWin ? 'netstat' : 'lsof', isWin ? ['-ano', '-p', 'TCP'] : ['-iTCP', '-sTCP:LISTEN', '-n', '-P'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? '')));
	const rows: { port: string; pid: string; addr: string }[] = [];
	for (const line of out.split('\n')) {
		if (isWin) {
			const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
			if (m) rows.push({ addr: m[1], port: m[2], pid: m[3] });
		} else {
			const parts = line.trim().split(/\s+/);
			const m = /:(\d+)$/.exec(parts[8] ?? '');
			if (m && parts[1]) rows.push({ addr: parts[8], port: m[1], pid: parts[1] });
		}
	}
	const uniq = [...new Map(rows.map(r => [`${r.port}:${r.pid}`, r])).values()].sort((a, b) => Number(a.port) - Number(b.port));
	const pick = await vscode.window.showQuickPick(uniq.map(r => ({ label: `:${r.port}`, description: `pid ${r.pid}`, detail: r.addr, r })), { placeHolder: `${uniq.length} listening TCP ports` });
	if (!pick) return;
	const act = await vscode.window.showQuickPick(['Open in browser', 'Kill process'], { placeHolder: `Port ${pick.r.port} (pid ${pick.r.pid})` });
	if (act === 'Open in browser') await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${pick.r.port}`));
	if (act === 'Kill process') {
		const ok = await vscode.window.showWarningMessage(`Kill process ${pick.r.pid} listening on port ${pick.r.port}?`, { modal: true }, 'Kill');
		if (!ok) return;
		try {
			process.kill(Number(pick.r.pid));
			void vscode.window.showInformationMessage(`Killed ${pick.r.pid}.`);
		} catch (e) {
			void vscode.window.showErrorMessage(`Could not kill ${pick.r.pid}: ${(e as Error).message}`);
		}
	}
}
