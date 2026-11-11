import * as fs from 'fs';
import * as path from 'path';
import { estimateTokens } from '../tokens';
import { outlineFile } from './compress';
import { autoContextAllowed, IgnoreMatcher } from './ignore';

export interface RepoFile {
	rel: string; // forward slashes
	size: number;
	mtime: number;
}

/** Walk a workspace honoring ignore rules. Bounded so huge repos stay cheap. */
export async function listRepoFiles(root: string, matcher: IgnoreMatcher, maxFiles = 6000): Promise<RepoFile[]> {
	const out: RepoFile[] = [];
	const queue: string[] = [''];
	while (queue.length && out.length < maxFiles) {
		const relDir = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			const rel = relDir ? `${relDir}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!matcher.ignores(rel, true)) queue.push(rel);
			} else if (e.isFile() && !matcher.ignores(rel)) {
				try {
					const st = await fs.promises.stat(path.join(root, rel));
					out.push({ rel, size: st.size, mtime: st.mtimeMs });
				} catch {
					/* vanished between readdir and stat */
				}
				if (out.length >= maxFiles) break;
			}
		}
	}
	return out;
}

export async function loadIgnoreMatcher(root: string, extraPatterns: string[] = []): Promise<IgnoreMatcher> {
	const m = new IgnoreMatcher();
	for (const f of ['.gitignore', '.aideignore']) {
		try {
			m.add(await fs.promises.readFile(path.join(root, f), 'utf8'));
		} catch {
			/* optional */
		}
	}
	if (extraPatterns.length) m.add(extraPatterns.join('\n'));
	return m;
}

const KEY_FILES = /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|[\w.-]+\.csproj|[\w.-]+\.sln|CMakeLists\.txt|Makefile|Dockerfile|docker-compose\.ya?ml|tsconfig\.json|vite\.config\.\w+|default\.project\.json|README\.md|AGENTS\.md|CLAUDE\.md)$/i;
const ENTRY_FILES = /(^|\/)(main|index|app|server|extension|cli|__main__|lib|mod|program|init)\.(ts|tsx|js|mjs|py|rs|go|cs|java|kt|lua|luau|cpp|c)$/i;

/**
 * Compact repository map: directory tree with file counts plus outlines of the
 * most informative files. Deterministic and cheap, meant to replace dumping files.
 */
export async function buildRepoMap(root: string, files: RepoFile[], budgetTokens = 2500): Promise<string> {
	const allowed = files.filter(f => autoContextAllowed(f.rel, new IgnoreMatcher([])));
	const byDir = new Map<string, RepoFile[]>();
	for (const f of allowed) {
		const d = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '.';
		if (!byDir.has(d)) byDir.set(d, []);
		byDir.get(d)!.push(f);
	}
	const treeLines: string[] = [`Repository: ${path.basename(root)} (${allowed.length} files)`];
	for (const d of [...byDir.keys()].sort()) {
		const fs_ = byDir.get(d)!;
		const depth = d === '.' ? 0 : d.split('/').length;
		const indent = '  '.repeat(depth);
		if (fs_.length > 12) {
			const exts = new Map<string, number>();
			for (const f of fs_) {
				const e = path.extname(f.rel) || '(none)';
				exts.set(e, (exts.get(e) ?? 0) + 1);
			}
			const summary = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => `${n}×${e}`).join(', ');
			treeLines.push(`${indent}${d}/ [${fs_.length} files: ${summary}]`);
			const notable = fs_.filter(f => KEY_FILES.test(f.rel) || ENTRY_FILES.test(f.rel)).slice(0, 6);
			for (const f of notable) treeLines.push(`${indent}  ${path.basename(f.rel)}`);
		} else {
			treeLines.push(`${indent}${d === '.' ? './' : d + '/'}  ${fs_.map(f => path.basename(f.rel)).join('  ')}`);
		}
	}
	let map = treeLines.join('\n');
	const treeBudget = Math.floor(budgetTokens * 0.55);
	if (estimateTokens(map) > treeBudget) {
		// Keep shallow levels only.
		map = treeLines.filter(l => l.search(/\S/) <= 4).join('\n');
		if (estimateTokens(map) > treeBudget) map = map.slice(0, treeBudget * 3.5) + '\n...';
	}

	let remaining = budgetTokens - estimateTokens(map);
	const important = allowed
		.filter(f => (KEY_FILES.test(f.rel) || ENTRY_FILES.test(f.rel)) && f.size < 400_000)
		.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)
		.slice(0, 12);
	const outlines: string[] = [];
	for (const f of important) {
		if (remaining < 150) break;
		try {
			const content = await fs.promises.readFile(path.join(root, f.rel), 'utf8');
			const body = /\.(json|toml|txt|ya?ml|gradle|kts|xml|csproj)$|Makefile|Dockerfile/i.test(f.rel)
				? content.slice(0, 1200)
				: outlineFile(content, Math.min(400, remaining));
			const block = `--- ${f.rel}\n${body}`;
			const t = estimateTokens(block);
			if (t > remaining) continue;
			outlines.push(block);
			remaining -= t;
		} catch {
			/* unreadable file: skip */
		}
	}
	return outlines.length ? `${map}\n\nKey files:\n${outlines.join('\n')}` : map;
}
