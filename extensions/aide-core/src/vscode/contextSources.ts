import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContextSources } from '../ai/context/engine';
import { isBinaryPath, isSecretPath } from '../ai/context/ignore';
import { git, grep, htmlToText } from '../tools/builtin';
import type { IdeServices } from '../tools/types';
import type { ProjectContext } from '../project/projectContext';
import { formatDiagnostics, type TerminalCapture } from './ideServices';

export interface ContextSourceDeps {
	root: string | undefined;
	project: ProjectContext | undefined;
	capture: TerminalCapture;
	ide: IdeServices;
	fetchDoc?: (ref: string) => Promise<{ label: string; content: string } | undefined>;
	allowNetwork: (url: string) => Promise<boolean>;
	/** ~/.aide/memory.md: facts about the user that apply to every project */
	userMemory?: () => string | undefined;
	outputs?: OutputLogs;
}

/**
 * Output panel channels are persisted as log files under the window's log
 * folder; reading them is the only way an extension can see another
 * extension's (or a task's) output.
 */
export class OutputLogs {
	constructor(private readonly windowLogDir: string) {}

	list(): { name: string; file: string; mtime: number }[] {
		const out: { name: string; file: string; mtime: number }[] = [];
		const walk = (dir: string, depth: number) => {
			let entries: fs.Dirent[] = [];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const p = path.join(dir, e.name);
				if (e.isDirectory() && depth < 3) walk(p, depth + 1);
				else if (e.isFile() && e.name.endsWith('.log')) {
					try {
						const st = fs.statSync(p);
						if (st.size > 0) out.push({ name: e.name.replace(/^\d+-/, '').replace(/\.log$/, ''), file: p, mtime: st.mtimeMs });
					} catch {
						/* vanished */
					}
				}
			}
		};
		walk(this.windowLogDir, 0);
		const byName = new Map<string, { name: string; file: string; mtime: number }>();
		for (const o of out.sort((a, b) => b.mtime - a.mtime)) if (!byName.has(o.name.toLowerCase())) byName.set(o.name.toLowerCase(), o);
		return [...byName.values()];
	}

	async read(name: string): Promise<{ label: string; content: string } | undefined> {
		const all = this.list();
		const q = name.toLowerCase();
		const hit = q ? all.find(o => o.name.toLowerCase() === q) ?? all.find(o => o.name.toLowerCase().includes(q)) : all[0];
		if (!hit) return undefined;
		const text = await fs.promises.readFile(hit.file, 'utf8');
		return { label: `Output: ${hit.name}`, content: text.split('\n').slice(-200).join('\n') };
	}
}

export function createContextSources(d: ContextSourceDeps): ContextSources {
	const root = d.root;
	const rel = (uri: vscode.Uri) => (root ? path.relative(root, uri.fsPath).replace(/\\/g, '/') : uri.fsPath);
	const inRoot = (p: string) => {
		if (!root) return undefined;
		const abs = path.resolve(root, p);
		const r = path.relative(root, abs);
		return r.startsWith('..') || path.isAbsolute(r) ? undefined : abs;
	};
	return {
		async readFile(p) {
			const abs = inRoot(p);
			if (!abs || isSecretPath(p) || isBinaryPath(p)) return undefined;
			// Prefer the editor buffer (includes unsaved edits).
			const open = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && path.resolve(doc.uri.fsPath) === abs);
			if (open) return open.getText();
			try {
				const st = await fs.promises.stat(abs);
				if (!st.isFile() || st.size > 2_000_000) return undefined;
				return await fs.promises.readFile(abs, 'utf8');
			} catch {
				return undefined;
			}
		},
		async listFolder(p) {
			if (!d.project) return [];
			const prefix = p.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/?$/, '/');
			const files = await d.project.repoFiles();
			return files.filter(f => prefix === '/' || f.rel.startsWith(prefix)).map(f => f.rel).slice(0, 400);
		},
		async selection() {
			const ed = vscode.window.activeTextEditor;
			if (!ed || ed.selection.isEmpty) return undefined;
			return { file: rel(ed.document.uri), startLine: ed.selection.start.line + 1, text: ed.document.getText(ed.selection) };
		},
		async activeFile() {
			const ed = vscode.window.activeTextEditor;
			if (!ed || ed.document.uri.scheme !== 'file' || isSecretPath(ed.document.uri.fsPath)) return undefined;
			return { file: rel(ed.document.uri), content: ed.document.getText(), cursorLine: ed.selection.active.line + 1 };
		},
		async openFiles() {
			const out: string[] = [];
			for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
				const input = t.input as { uri?: vscode.Uri } | undefined;
				if (input?.uri?.scheme === 'file') out.push(rel(input.uri));
			}
			return [...new Set(out)].filter(f => !f.startsWith('..'));
		},
		async terminal() {
			return d.capture.text();
		},
		async diagnostics(scope) {
			const active = vscode.window.activeTextEditor?.document.uri;
			if (scope === 'active' && !active) return '';
			return formatDiagnostics(root, undefined, scope === 'active' ? active : undefined);
		},
		async gitDiff() {
			if (!root) return undefined;
			const diff = await git(root, ['diff', 'HEAD', '--no-color', '--stat', '--patch']);
			if (diff.code !== 0) return undefined;
			const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
			const u = untracked.stdout.trim();
			const text = diff.stdout.trim() + (u ? `\n\nUntracked files:\n${u}` : '');
			return text || undefined;
		},
		async search(terms, maxFiles) {
			if (!root) return [];
			const scores = new Map<string, { score: number; lines: number[] }>();
			for (const [i, term] of terms.entries()) {
				const hits = await grep({ root, ide: d.ide, signal: new AbortController().signal }, term, { max: 60 });
				for (const h of hits) {
					const m = /^(.+?):(\d+):/.exec(h);
					if (!m) continue;
					const file = m[1];
					if (isSecretPath(file)) continue;
					const cur = scores.get(file) ?? { score: 0, lines: [] };
					cur.score += terms.length - i + (path.basename(file).toLowerCase().includes(term.toLowerCase()) ? 3 : 0);
					if (cur.lines.length < 6) cur.lines.push(Number(m[2]));
					scores.set(file, cur);
				}
			}
			return [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, maxFiles).map(([file, v]) => ({ file, lines: v.lines }));
		},
		async symbol(name) {
			const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name)) ?? [];
			const leaf = name.split('.').pop()!;
			return syms
				.filter(s => s.name === leaf || s.name === name)
				.slice(0, 5)
				.map(s => ({ file: rel(s.location.uri), line: s.location.range.start.line + 1 }))
				.filter(s => !s.file.startsWith('..'));
		},
		async repoMap(budget) {
			return d.project ? d.project.repoMap(budget) : '(no folder open)';
		},
		async instructions() {
			return d.project?.instructions() ?? [];
		},
		async memory() {
			const project = d.project?.memory();
			const user = d.userMemory?.();
			if (!project && !user) return undefined;
			return [project ? `Project memory (.aide/memory.md):\n${project}` : '', user ? `Personal memory (applies to every project):\n${user}` : ''].filter(Boolean).join('\n\n');
		},
		async resolveFileRef(ref) {
			if (!root) return undefined;
			const norm = ref.replace(/\\/g, '/');
			const direct = path.isAbsolute(ref) ? ref : path.join(root, norm);
			const r = path.relative(root, path.resolve(direct)).replace(/\\/g, '/');
			if (!r.startsWith('..') && !path.isAbsolute(r)) {
				try {
					if (fs.statSync(path.join(root, r)).isFile()) return r;
				} catch {
					/* not a direct path; try by name */
				}
			}
			if (path.isAbsolute(ref) || !d.project) return undefined;
			const files = await d.project.repoFiles();
			const lower = norm.toLowerCase();
			const hits = files.filter(f => f.rel.toLowerCase() === lower || f.rel.toLowerCase().endsWith('/' + lower));
			return hits.length === 1 ? hits[0].rel : hits.sort((a, b) => a.rel.length - b.rel.length)[0]?.rel;
		},
		async output(name) {
			return d.outputs?.read(name);
		},
		fetchDoc: d.fetchDoc,
		async fetchUrl(url) {
			if (!(await d.allowNetwork(url))) return undefined;
			try {
				const res = await fetch(url, { headers: { 'user-agent': 'AIDE/2.0' } });
				const t = await res.text();
				return /html/i.test(res.headers.get('content-type') ?? '') ? htmlToText(t) : t;
			} catch {
				return undefined;
			}
		},
	};
}
