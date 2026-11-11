import * as fs from 'fs';
import * as path from 'path';
import { buildRepoMap, listRepoFiles, loadIgnoreMatcher, type RepoFile } from '../ai/context/repoMap';

/** Instruction files AIDE reads, in priority order (AIDE-native first, then common formats). */
const INSTRUCTION_FILES = ['.aide/instructions.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', '.windsurfrules'];

/**
 * Transparent, user-editable project knowledge:
 *   .aide/instructions.md   - rules for AI in this project
 *   .aide/rules/*.md        - additional rule files
 *   .aide/memory.md         - facts agents record (editable)
 *   .aide/context/*.md      - generated context (project map)
 *   .aide/agents/           - custom agents
 *   .aide/workflows/        - workflows
 *   .aide/mcp.json          - workspace MCP servers
 */
export class ProjectContext {
	private files: RepoFile[] | undefined;
	private filesAt = 0;
	private mapCache = new Map<number, string>();

	constructor(readonly root: string) {}

	dir(...parts: string[]): string {
		return path.join(this.root, '.aide', ...parts);
	}

	instructions(): { source: string; content: string }[] {
		const out: { source: string; content: string }[] = [];
		for (const rel of INSTRUCTION_FILES) {
			const abs = path.join(this.root, rel);
			try {
				const c = fs.readFileSync(abs, 'utf8').trim();
				if (c) out.push({ source: rel, content: c });
			} catch {
				/* not present */
			}
		}
		try {
			for (const f of fs.readdirSync(this.dir('rules')).filter(f => f.endsWith('.md')).sort()) {
				const c = fs.readFileSync(this.dir('rules', f), 'utf8').trim();
				if (c) out.push({ source: `.aide/rules/${f}`, content: c });
			}
		} catch {
			/* no rules dir */
		}
		return out;
	}

	memory(): string | undefined {
		try {
			return fs.readFileSync(this.dir('memory.md'), 'utf8').trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/** Best guess at the command that verifies changes (tests), used by agents. */
	verifyCommand(): string | undefined {
		const has = (f: string) => fs.existsSync(path.join(this.root, f));
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
			const scripts = pkg.scripts ?? {};
			const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
			if (scripts.test && !/no test specified/.test(scripts.test)) return `${pm} ${pm === 'npm' ? 'test' : 'test'}`;
			if (scripts.build) return `${pm} run build`;
			if (scripts.typecheck) return `${pm} run typecheck`;
		} catch {
			/* not a node project */
		}
		if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg') || fs.existsSync(path.join(this.root, 'tests'))) {
			if (has('pyproject.toml') || has('pytest.ini') || has('tests')) return 'python -m pytest -q';
		}
		if (has('Cargo.toml')) return 'cargo test';
		if (has('go.mod')) return 'go test ./...';
		try {
			if (fs.readdirSync(this.root).some(f => f.endsWith('.sln') || f.endsWith('.csproj'))) return 'dotnet test';
		} catch {
			/* unreadable root */
		}
		if (has('default.project.json')) return 'rojo build -o build.rbxlx';
		return undefined;
	}

	async repoFiles(): Promise<RepoFile[]> {
		if (this.files && Date.now() - this.filesAt < 30_000) return this.files;
		this.files = await listRepoFiles(this.root, await loadIgnoreMatcher(this.root));
		this.filesAt = Date.now();
		this.mapCache.clear();
		return this.files;
	}

	async repoMap(budget: number): Promise<string> {
		const files = await this.repoFiles();
		const hit = this.mapCache.get(budget);
		if (hit) return hit;
		const map = await buildRepoMap(this.root, files, budget);
		this.mapCache.set(budget, map);
		return map;
	}

	/** Called by file watchers: next request re-scans (incremental enough for typical repos). */
	invalidate(): void {
		this.files = undefined;
		this.mapCache.clear();
	}

	ensureScaffold(): void {
		fs.mkdirSync(this.dir(), { recursive: true });
		const ins = this.dir('instructions.md');
		if (!fs.existsSync(ins)) {
			fs.writeFileSync(ins, `# Project instructions for AI

These instructions are sent to every AIDE agent working in this project. Keep them short.

- Coding conventions:
- How to build:
- How to test:
- Never modify:
`);
		}
		const mem = this.dir('memory.md');
		if (!fs.existsSync(mem)) fs.writeFileSync(mem, '# Project memory\n\nFacts AIDE agents should remember about this project. Edit freely.\n');
	}
}
