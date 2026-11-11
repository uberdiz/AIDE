import { estimateTokens } from '../tokens';
import { excerpt, hashText, outlineFile, truncateMiddle } from './compress';
import { extractFileRefs, extractSearchTerms, parseMentions, type Mention } from './mentions';

export type ContextStrategy = 'minimal' | 'balanced' | 'deep' | 'maximum';

export interface ContextItem {
	key: string;
	kind: 'instructions' | 'memory' | 'file' | 'folder' | 'selection' | 'terminal' | 'diagnostics' | 'git' | 'repomap' | 'search' | 'symbol' | 'doc' | 'url' | 'note';
	label: string;
	content: string;
	tokens: number;
	reason: string;
	priority: number;
	truncated?: boolean;
	hash: string;
	/** true when replaced by a back-reference because identical content was already sent */
	deduped?: boolean;
}

export interface ContextBundle {
	items: ContextItem[];
	dropped: { label: string; reason: string; tokens: number }[];
	totalTokens: number;
	budget: number;
	strategy: ContextStrategy;
	mentions: Mention[];
}

/** Everything the engine can pull from the IDE. Implemented by the extension layer. */
export interface ContextSources {
	readFile(rel: string): Promise<string | undefined>;
	listFolder(rel: string): Promise<string[]>;
	selection(): Promise<{ file: string; startLine: number; text: string } | undefined>;
	activeFile(): Promise<{ file: string; content: string; cursorLine: number } | undefined>;
	openFiles(): Promise<string[]>;
	terminal(): Promise<string | undefined>;
	diagnostics(scope: 'active' | 'all'): Promise<string>;
	gitDiff(): Promise<string | undefined>;
	search(terms: string[], maxFiles: number): Promise<{ file: string; lines: number[] }[]>;
	symbol(name: string): Promise<{ file: string; line: number }[]>;
	repoMap(budgetTokens: number): Promise<string>;
	instructions(): Promise<{ source: string; content: string }[]>;
	memory(): Promise<string | undefined>;
	fetchDoc?(ref: string): Promise<{ label: string; content: string } | undefined>;
	fetchUrl?(url: string): Promise<string | undefined>;
	/** Resolve a file named in plain text (absolute path, relative path or unique file name) to a workspace-relative path. */
	resolveFileRef?(ref: string): Promise<string | undefined>;
	/** Recent output of an Output channel / log, for @output:<name>. */
	output?(name: string): Promise<{ label: string; content: string } | undefined>;
}

interface StrategyProfile {
	defaultBudget: number;
	activeFile: boolean;
	diagnostics: 'none' | 'active' | 'all';
	searchFiles: number;
	fullFiles: number;
	perFileTokens: number;
	repoMap: number;
	openFiles: boolean;
	gitDiff: boolean;
}

export const STRATEGIES: Record<ContextStrategy, StrategyProfile> = {
	minimal: { defaultBudget: 4_000, activeFile: false, diagnostics: 'none', searchFiles: 0, fullFiles: 0, perFileTokens: 3_000, repoMap: 0, openFiles: false, gitDiff: false },
	balanced: { defaultBudget: 16_000, activeFile: true, diagnostics: 'active', searchFiles: 4, fullFiles: 0, perFileTokens: 4_000, repoMap: 1_200, openFiles: false, gitDiff: false },
	deep: { defaultBudget: 48_000, activeFile: true, diagnostics: 'all', searchFiles: 8, fullFiles: 5, perFileTokens: 8_000, repoMap: 2_500, openFiles: true, gitDiff: true },
	maximum: { defaultBudget: 120_000, activeFile: true, diagnostics: 'all', searchFiles: 16, fullFiles: 14, perFileTokens: 16_000, repoMap: 4_000, openFiles: true, gitDiff: true },
};

export interface BuildInput {
	prompt: string;
	strategy: ContextStrategy;
	budgetTokens?: number;
	/** key -> content hash already sent earlier in this conversation */
	alreadySent?: ReadonlyMap<string, string>;
	/** keys the user removed from the context chips */
	exclude?: string[];
	/** pre-resolved extra items (e.g. attachments dropped into chat) */
	extra?: ContextItem[];
}

export function makeItem(p: Omit<ContextItem, 'tokens' | 'hash'>): ContextItem {
	return { ...p, tokens: estimateTokens(p.content) + 12, hash: hashText(p.content) };
}

export class ContextEngine {
	constructor(private readonly src: ContextSources) {}

	async build(input: BuildInput): Promise<ContextBundle> {
		const profile = STRATEGIES[input.strategy];
		const budget = input.budgetTokens ?? profile.defaultBudget;
		const mentions = parseMentions(input.prompt);
		const candidates: { item: ContextItem; fallback?: () => ContextItem }[] = [];
		const addFile = (rel: string, content: string, reason: string, priority: number, focusLines?: number[]) => {
			const full = makeItem({ key: `file:${rel}`, kind: 'file', label: rel, content, reason, priority });
			const small = () => {
				const body = focusLines?.length ? `${outlineFile(content, 500)}\n\n[relevant excerpt]\n${excerpt(content, focusLines, 15, profile.perFileTokens / 2)}` : outlineFile(content, 900);
				return makeItem({ key: `file:${rel}`, kind: 'file', label: `${rel} (summarized)`, content: body, reason, priority, truncated: true });
			};
			if (full.tokens > profile.perFileTokens && priority < 90) candidates.push({ item: small() });
			else candidates.push({ item: full, fallback: small });
		};

		// 1. Project instructions and memory (small, always relevant).
		for (const ins of await this.src.instructions()) {
			candidates.push({ item: makeItem({ key: `instructions:${ins.source}`, kind: 'instructions', label: ins.source, content: truncateMiddle(ins.content, 3_000).text, reason: 'project instructions', priority: 100 }) });
		}
		const explicitMemory = mentions.some(m => m.kind === 'memory');
		const mem = await this.src.memory();
		if (mem && (explicitMemory || input.strategy !== 'minimal')) {
			candidates.push({ item: makeItem({ key: 'memory', kind: 'memory', label: 'Project memory', content: truncateMiddle(mem, 2_000).text, reason: explicitMemory ? 'mentioned' : 'project memory', priority: 95 }) });
		}

		// 2. Explicit mentions: the user asked for these, include in full when possible.
		let explicitSelection = false;
		for (const m of mentions) {
			switch (m.kind) {
				case 'file': {
					const content = await this.src.readFile(m.arg!);
					if (content === undefined) candidates.push({ item: makeItem({ key: `note:${m.arg}`, kind: 'note', label: `${m.arg} (not readable)`, content: `File "${m.arg}" could not be read (missing, binary, ignored secret, or outside the workspace).`, reason: 'mentioned', priority: 90 }) });
					else addFile(m.arg!, content, 'mentioned', 92);
					break;
				}
				case 'folder': {
					const listing = await this.src.listFolder(m.arg!);
					candidates.push({ item: makeItem({ key: `folder:${m.arg}`, kind: 'folder', label: `${m.arg}/`, content: listing.join('\n') || '(empty or not found)', reason: 'mentioned', priority: 90 }) });
					for (const f of listing.slice(0, 6)) {
						const c = await this.src.readFile(f);
						if (c !== undefined) candidates.push({ item: makeItem({ key: `file:${f}`, kind: 'file', label: `${f} (outline)`, content: outlineFile(c, 500), reason: `in mentioned folder ${m.arg}`, priority: 70, truncated: true }) });
					}
					break;
				}
				case 'selection': {
					explicitSelection = true;
					const sel = await this.src.selection();
					if (sel) candidates.push({ item: makeItem({ key: `selection:${sel.file}:${sel.startLine}`, kind: 'selection', label: `Selection in ${sel.file}:${sel.startLine}`, content: sel.text, reason: 'mentioned', priority: 93 }) });
					break;
				}
				case 'terminal': {
					const t = await this.src.terminal();
					candidates.push({ item: makeItem({ key: 'terminal', kind: 'terminal', label: 'Terminal output', content: t || '(no terminal output captured yet - run the command in an AIDE-tracked terminal or select the text and use @selection)', reason: 'mentioned', priority: 91 }) });
					break;
				}
				case 'errors': {
					const d = await this.src.diagnostics('all');
					candidates.push({ item: makeItem({ key: 'diagnostics:all', kind: 'diagnostics', label: 'Problems', content: d || 'No problems reported.', reason: 'mentioned', priority: 91 }) });
					break;
				}
				case 'git': {
					const d = await this.src.gitDiff();
					candidates.push({ item: makeItem({ key: 'git:diff', kind: 'git', label: 'Git changes', content: d || 'No uncommitted changes (or not a git repository).', reason: 'mentioned', priority: 90 }) });
					break;
				}
				case 'workspace': {
					candidates.push({ item: makeItem({ key: 'repomap', kind: 'repomap', label: 'Repository map', content: await this.src.repoMap(Math.max(profile.repoMap, 3_000)), reason: 'mentioned', priority: 89 }) });
					break;
				}
				case 'symbol': {
					const hits = await this.src.symbol(m.arg!);
					for (const h of hits.slice(0, 3)) {
						const c = await this.src.readFile(h.file);
						if (c) candidates.push({ item: makeItem({ key: `symbol:${m.arg}:${h.file}`, kind: 'symbol', label: `${m.arg} in ${h.file}:${h.line}`, content: excerpt(c, [h.line], 30, 3_000), reason: 'mentioned', priority: 90 }) });
					}
					if (!hits.length) candidates.push({ item: makeItem({ key: `note:symbol:${m.arg}`, kind: 'note', label: `symbol ${m.arg} not found`, content: `No symbol named "${m.arg}" was found in the workspace.`, reason: 'mentioned', priority: 90 }) });
					break;
				}
				case 'doc': {
					const d = await this.src.fetchDoc?.(m.arg!);
					candidates.push({ item: makeItem({ key: `doc:${m.arg}`, kind: 'doc', label: d?.label ?? m.arg!, content: d ? truncateMiddle(d.content, 12_000).text : `Document "${m.arg}" is unavailable (connector not connected or not permitted).`, reason: 'mentioned', priority: 90 }) });
					break;
				}
				case 'url': {
					const u = await this.src.fetchUrl?.(m.arg!);
					candidates.push({ item: makeItem({ key: `url:${m.arg}`, kind: 'url', label: m.arg!, content: u ? truncateMiddle(u, 8_000).text : `Could not fetch ${m.arg} (network permission denied or unreachable).`, reason: 'mentioned', priority: 90 }) });
					break;
				}
				case 'output': {
					const o = await this.src.output?.(m.arg ?? '');
					candidates.push({ item: makeItem({ key: `output:${m.arg ?? ''}`, kind: 'terminal', label: o?.label ?? `Output ${m.arg ?? ''}`.trim(), content: o ? truncateMiddle(o.content, 6_000).text : `No output found${m.arg ? ` for "${m.arg}"` : ''}.`, reason: 'mentioned', priority: 90 }) });
					break;
				}
			}
		}

		// 2b. Files named in plain text ("edit C:\python\tests\calc.py", "fix calc.py").
		if (this.src.resolveFileRef) {
			const mentioned = new Set(mentions.filter(m => m.kind === 'file').map(m => m.arg));
			for (const ref of extractFileRefs(input.prompt)) {
				const rel = await this.src.resolveFileRef(ref);
				if (!rel || mentioned.has(rel)) continue;
				mentioned.add(rel);
				const content = await this.src.readFile(rel);
				if (content !== undefined) addFile(rel, content, 'named in message', 88);
			}
		}

		// 3. Automatic context according to strategy.
		if (!explicitSelection) {
			const sel = await this.src.selection();
			if (sel && sel.text.trim()) candidates.push({ item: makeItem({ key: `selection:${sel.file}:${sel.startLine}`, kind: 'selection', label: `Selection in ${sel.file}:${sel.startLine}`, content: sel.text, reason: 'current selection', priority: 80 }) });
		}
		if (profile.activeFile) {
			const af = await this.src.activeFile();
			if (af) addFile(af.file, af.content, 'active editor', 60, [af.cursorLine]);
		}
		if (profile.diagnostics !== 'none' && !mentions.some(m => m.kind === 'errors')) {
			const d = await this.src.diagnostics(profile.diagnostics);
			if (d) candidates.push({ item: makeItem({ key: `diagnostics:${profile.diagnostics}`, kind: 'diagnostics', label: profile.diagnostics === 'active' ? 'Problems (active file)' : 'Problems', content: truncateMiddle(d, 2_000).text, reason: 'diagnostics', priority: 55 }) });
		}
		if (profile.searchFiles > 0) {
			const terms = extractSearchTerms(input.prompt);
			if (terms.length) {
				const hits = await this.src.search(terms, profile.searchFiles);
				let full = profile.fullFiles;
				for (const h of hits) {
					const c = await this.src.readFile(h.file);
					if (c === undefined) continue;
					if (full-- > 0) addFile(h.file, c, `matches ${terms.slice(0, 3).join(', ')}`, 50, h.lines);
					else candidates.push({ item: makeItem({ key: `file:${h.file}`, kind: 'search', label: `${h.file} (excerpt)`, content: excerpt(c, h.lines, 12, 1_200), reason: `matches ${terms.slice(0, 3).join(', ')}`, priority: 50, truncated: true }) });
				}
			}
		}
		if (profile.repoMap > 0 && !mentions.some(m => m.kind === 'workspace')) {
			candidates.push({ item: makeItem({ key: 'repomap', kind: 'repomap', label: 'Repository map', content: await this.src.repoMap(profile.repoMap), reason: 'orientation', priority: 40 }) });
		}
		if (profile.gitDiff && !mentions.some(m => m.kind === 'git')) {
			const d = await this.src.gitDiff();
			if (d) candidates.push({ item: makeItem({ key: 'git:diff', kind: 'git', label: 'Git changes', content: truncateMiddle(d, 4_000).text, reason: 'uncommitted changes', priority: 35 }) });
		}
		if (profile.openFiles) {
			const open = await this.src.openFiles();
			for (const f of open.slice(0, 8)) {
				const c = await this.src.readFile(f);
				if (c) candidates.push({ item: makeItem({ key: `file:${f}`, kind: 'file', label: `${f} (outline)`, content: outlineFile(c, 400), reason: 'open editor', priority: 30, truncated: true }) });
			}
		}
		for (const e of input.extra ?? []) candidates.push({ item: e });

		return this.pack(candidates, budget, input);
	}

	private pack(candidates: { item: ContextItem; fallback?: () => ContextItem }[], budget: number, input: BuildInput): ContextBundle {
		// Deduplicate by key, keeping the highest-priority version.
		const byKey = new Map<string, { item: ContextItem; fallback?: () => ContextItem }>();
		for (const c of candidates) {
			const prev = byKey.get(c.item.key);
			if (!prev || c.item.priority > prev.item.priority) byKey.set(c.item.key, c);
		}
		const sorted = [...byKey.values()].sort((a, b) => b.item.priority - a.item.priority);
		const items: ContextItem[] = [];
		const dropped: ContextBundle['dropped'] = [];
		let used = 0;
		const exclude = new Set(input.exclude ?? []);
		for (const c of sorted) {
			let item = c.item;
			if (exclude.has(item.key)) {
				dropped.push({ label: item.label, reason: 'removed by user', tokens: item.tokens });
				continue;
			}
			if (input.alreadySent?.get(item.key) === item.hash) {
				item = { ...item, content: `(unchanged - already provided earlier in this conversation)`, tokens: 14, deduped: true };
			}
			if (used + item.tokens > budget && c.fallback) {
				const small = c.fallback();
				if (used + small.tokens <= budget) item = small;
			}
			if (used + item.tokens > budget) {
				dropped.push({ label: item.label, reason: 'over context budget', tokens: item.tokens });
				continue;
			}
			items.push(item);
			used += item.tokens;
		}
		return { items, dropped, totalTokens: used, budget, strategy: input.strategy, mentions: parseMentions(input.prompt) };
	}
}

const LANG: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', rs: 'rust', go: 'go', cs: 'csharp', java: 'java', lua: 'lua', luau: 'lua', cpp: 'cpp', c: 'c', h: 'c', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', ps1: 'powershell', html: 'html', css: 'css', sql: 'sql' };

/** Render a bundle as a single user-context block. */
export function renderContext(bundle: ContextBundle): string {
	if (!bundle.items.length) return '';
	const parts = bundle.items.map(it => {
		const ext = it.label.split(/[.\s]/).length > 1 ? it.label.replace(/ \(.*\)$/, '').split('.').pop()!.toLowerCase() : '';
		const fence = it.kind === 'file' || it.kind === 'selection' || it.kind === 'symbol' || it.kind === 'search' ? LANG[ext] ?? '' : '';
		const body = fence || it.kind === 'terminal' || it.kind === 'git' ? `\`\`\`${fence || (it.kind === 'git' ? 'diff' : '')}\n${it.content}\n\`\`\`` : it.content;
		return `<context source="${it.kind}" label="${it.label.replace(/"/g, "'")}" reason="${it.reason}">\n${body}\n</context>`;
	});
	return parts.join('\n\n');
}
