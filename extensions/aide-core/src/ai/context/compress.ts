import { estimateTokens } from '../tokens';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI, '');
}

const IMPORTANT = /\b(error|err!|fail(ed|ure)?|exception|traceback|panic|fatal|warn(ing)?|cannot|undefined|not found|denied|expected|assert)/i;

/**
 * Compress terminal/log output for a model: strip ANSI, resolve carriage-return
 * progress bars, collapse repeated lines, and keep head + tail (plus any error
 * lines from the middle) within the token budget.
 */
export function compressOutput(raw: string, maxTokens = 2000): string {
	let text = stripAnsi(raw);
	// progress bars rewrite the line with \r; keep only the final state
	text = text.split('\n').map(l => {
		const i = l.lastIndexOf('\r');
		return i >= 0 && i < l.length - 1 ? l.slice(i + 1) : l.replace(/\r$/, '');
	}).join('\n');
	const lines = text.split('\n');
	const collapsed: string[] = [];
	let prevNorm = '';
	let repeat = 0;
	const flush = () => {
		if (repeat > 0) collapsed.push(`  ... (similar line repeated ${repeat} more time${repeat > 1 ? 's' : ''})`);
		repeat = 0;
	};
	for (const line of lines) {
		const norm = line.replace(/\d+(\.\d+)?/g, '#').trim();
		if (norm && norm === prevNorm) {
			repeat++;
			continue;
		}
		flush();
		collapsed.push(line);
		prevNorm = norm;
	}
	flush();
	while (collapsed.length && !collapsed[collapsed.length - 1].trim()) collapsed.pop();
	const joined = collapsed.join('\n');
	if (estimateTokens(joined) <= maxTokens) return joined;

	// Budgeted head/tail with important middle lines.
	const budgetChars = maxTokens * 3.5;
	const headChars = Math.floor(budgetChars * 0.25);
	const tailChars = Math.floor(budgetChars * 0.55);
	const midChars = budgetChars - headChars - tailChars;
	const head: string[] = [];
	let used = 0;
	let i = 0;
	for (; i < collapsed.length && used + collapsed[i].length < headChars; i++) {
		head.push(collapsed[i]);
		used += collapsed[i].length + 1;
	}
	const tail: string[] = [];
	used = 0;
	let j = collapsed.length - 1;
	for (; j >= i && used + collapsed[j].length < tailChars; j--) {
		tail.unshift(collapsed[j]);
		used += collapsed[j].length + 1;
	}
	const mid: string[] = [];
	used = 0;
	for (let k = i; k <= j; k++) {
		if (IMPORTANT.test(collapsed[k]) && used + collapsed[k].length < midChars) {
			mid.push(`${collapsed[k]}`);
			used += collapsed[k].length + 1;
		}
	}
	const omitted = j - i + 1 - mid.length;
	return [...head, `... [${omitted} lines omitted${mid.length ? `; ${mid.length} error/warning lines kept` : ''}] ...`, ...mid, ...(mid.length ? ['...'] : []), ...tail].join('\n');
}

/** Keep the beginning and end of a long text. */
export function truncateMiddle(text: string, maxTokens: number): { text: string; truncated: boolean } {
	if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
	const chars = Math.floor(maxTokens * 3.5);
	const head = text.slice(0, Math.floor(chars * 0.6));
	const tail = text.slice(text.length - Math.floor(chars * 0.4));
	const omittedLines = text.slice(head.length, text.length - tail.length).split('\n').length;
	return { text: `${head}\n... [${omittedLines} lines omitted] ...\n${tail}`, truncated: true };
}

const OUTLINE_PATTERNS: RegExp[] = [
	/^\s*(export\s+)?(default\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|abstract class)\s+[\w$]+/,
	/^\s*(public|private|protected|static|async|override|readonly|\s)*[\w$<>[\],\s]*\s[\w$]+\s*\([^;]*\)\s*(\{|=>|:)/,
	/^\s*(async\s+)?def\s+\w+|^\s*class\s+\w+/,
	/^\s*(pub(\([\w:]+\))?\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod|type)\b/,
	/^\s*func\s+(\([^)]*\)\s*)?\w+|^\s*type\s+\w+\s+(struct|interface)/,
	/^\s*(local\s+)?function\s+[\w.:]+|^\s*[\w.]+\s*=\s*function\b/,
	/^\s*(namespace|module)\s+[\w.]+/,
	/^#{1,4}\s+\S/,
];
const IMPORT_LINE = /^\s*(import\s|from\s+\S+\s+import|#include|using\s+[\w.]+;|require\(|local\s+\w+\s*=\s*require|use\s+[\w:]+)/;

/** Structural summary of a source file: imports and top-level declarations with line numbers. */
export function outlineFile(content: string, maxTokens = 800): string {
	const lines = content.split('\n');
	const out: string[] = [];
	let imports = 0;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (IMPORT_LINE.test(l)) {
			if (imports++ < 25) out.push(`${i + 1}: ${l.trim()}`);
			continue;
		}
		if (l.length < 240 && OUTLINE_PATTERNS.some(p => p.test(l))) out.push(`${i + 1}: ${l.trimEnd().replace(/\s*\{\s*$/, '')}`);
	}
	if (imports > 25) out.push(`(${imports - 25} more imports)`);
	return truncateMiddle(`[outline of ${lines.length}-line file]\n${out.join('\n')}`, maxTokens).text;
}

/** Lines around each 1-based line number, merged into ranges. */
export function excerpt(content: string, lineNumbers: number[], radius = 12, maxTokens = 1500): string {
	const lines = content.split('\n');
	const ranges: [number, number][] = [];
	for (const n of [...lineNumbers].sort((a, b) => a - b)) {
		const s = Math.max(1, n - radius);
		const e = Math.min(lines.length, n + radius);
		const last = ranges[ranges.length - 1];
		if (last && s <= last[1] + 2) last[1] = Math.max(last[1], e);
		else ranges.push([s, e]);
	}
	const parts = ranges.map(([s, e]) => lines.slice(s - 1, e).map((l, k) => `${s + k}| ${l}`).join('\n'));
	return truncateMiddle(parts.join('\n...\n'), maxTokens).text;
}

/** Stable short hash for dedup (FNV-1a). */
export function hashText(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}
