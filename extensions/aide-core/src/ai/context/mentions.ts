/**
 * @-mentions let the user say exactly what context to send:
 *   @file:src/main.py  @file src/main.py  @folder:backend/  @selection  @terminal
 *   @error / @errors / @problems  @git  @workspace  @symbol:Name  @url:https://...
 *   @doc:<connector>:<id>  (connected documents, when allowed)
 * Paths with spaces use quotes: @file:"My Folder/a b.py"
 */

export type MentionKind = 'file' | 'folder' | 'selection' | 'terminal' | 'errors' | 'git' | 'workspace' | 'symbol' | 'url' | 'doc' | 'memory' | 'output';

export interface Mention {
	kind: MentionKind;
	arg?: string;
	/** character range in the source text */
	start: number;
	end: number;
}

const NO_ARG: Record<string, MentionKind> = {
	selection: 'selection',
	terminal: 'terminal',
	error: 'errors',
	errors: 'errors',
	problems: 'errors',
	git: 'git',
	diff: 'git',
	workspace: 'workspace',
	codebase: 'workspace',
	memory: 'memory',
};
const WITH_ARG: Record<string, MentionKind> = { file: 'file', folder: 'folder', dir: 'folder', symbol: 'symbol', url: 'url', doc: 'doc' };

const TOKEN = /(^|[\s(])@([a-z]+)(?::("([^"]+)"|[^\s]+)| ("([^"]+)"|[^\s@]+))?/gi;

export function parseMentions(text: string): Mention[] {
	const out: Mention[] = [];
	TOKEN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN.exec(text))) {
		const word = m[2].toLowerCase();
		const start = m.index + m[1].length;
		if (word === 'output') {
			const arg = m[4] ?? m[3];
			const end = arg ? m.index + m[1].length + 1 + m[2].length + 1 + m[3].length : start + 1 + m[2].length;
			out.push({ kind: 'output', arg: arg ? cleanArg(arg) : undefined, start, end });
			TOKEN.lastIndex = end;
			continue;
		}
		if (NO_ARG[word]) {
			// "@git" followed by a space+word: the word is not an argument
			const end = start + 1 + m[2].length;
			out.push({ kind: NO_ARG[word], start, end });
			TOKEN.lastIndex = end;
			continue;
		}
		const kind = WITH_ARG[word];
		if (!kind) continue;
		const arg = m[4] ?? m[3] ?? m[6] ?? m[5];
		if (!arg) continue;
		out.push({ kind, arg: cleanArg(arg), start, end: m.index + m[0].length });
	}
	return out;
}

function cleanArg(a: string): string {
	return a.replace(/[,.;:)]+$/, '');
}

/** Replace mentions with short readable labels, e.g. "@file:src/a.ts" -> "`src/a.ts`". */
export function describeMentions(text: string, mentions: Mention[]): string {
	let out = '';
	let pos = 0;
	for (const m of mentions) {
		out += text.slice(pos, m.start);
		out += m.arg ? `\`${m.arg}\`` : `[${m.kind}]`;
		pos = m.end;
	}
	return out + text.slice(pos);
}

/**
 * File references written as plain text (not @mentions): absolute paths like
 * C:\python\tests\calc.py, relative paths like src/app.ts, or bare names like calc.py.
 */
export function extractFileRefs(text: string, max = 6): string[] {
	const withoutMentions = text.replace(/@[a-z]+:("[^"]+"|\S+)/gi, ' ').replace(/```[\s\S]*?```/g, ' ');
	const out: string[] = [];
	const push = (s: string) => {
		const clean = s.replace(/^["'`(]+|["'`),.;:!?]+$/g, '');
		if (clean && !out.includes(clean) && !/^https?:/i.test(clean) && !/^\d+(\.\d+)+$/.test(clean)) out.push(clean);
	};
	for (const m of withoutMentions.matchAll(/"([^"\n]+\.[A-Za-z0-9]{1,8})"/g)) push(m[1]);
	for (const m of withoutMentions.matchAll(/(?:[A-Za-z]:[\\/]|\\\\|\/)?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g)) push(m[0]);
	return out.filter(r => !/^(e\.g|i\.e|etc|vs|mr|dr|st)\.?$/i.test(r)).slice(0, max);
}

/** Candidate identifiers in free text used for cheap deterministic retrieval. */
export function extractSearchTerms(text: string, max = 8): string[] {
	const terms = new Map<string, number>();
	const bump = (t: string, w: number) => terms.set(t, (terms.get(t) ?? 0) + w);
	for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) bump(m[1].trim(), 5);
	for (const m of text.matchAll(/\b[\w./-]+\.(?:[a-z]{1,5})\b/gi)) if (/[a-z]/i.test(m[0]) && !/^\d/.test(m[0])) bump(m[0], 4);
	for (const m of text.matchAll(/\b([a-z]+[A-Z][\w]*|[A-Z][a-z0-9]+[A-Z][\w]*|[a-z0-9]+_[a-z0-9_]+|[A-Z]{2,}[a-z]\w*)\b/g)) bump(m[1], 3);
	for (const m of text.matchAll(/\b[A-Z][a-zA-Z0-9]{3,}\b/g)) bump(m[0], 1);
	const stop = new Set(['This', 'That', 'What', 'When', 'Where', 'Which', 'Please', 'There', 'These', 'Those', 'Could', 'Would', 'Should', 'README']);
	return [...terms.entries()]
		.filter(([t]) => !stop.has(t) && t.length >= 3)
		.sort((a, b) => b[1] - a[1])
		.slice(0, max)
		.map(([t]) => t);
}
