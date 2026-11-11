export function leadingWs(s: string): string {
	return /^[ \t]*/.exec(s)![0];
}

/**
 * Models often return an edited block dedented (e.g. a method body at column 0),
 * which breaks Python. Shift the result so its indentation matches the original
 * block, and keep the original trailing newline.
 */
export function reindent(original: string, result: string): string {
	const minIndent = (text: string) => {
		const ws = text.split('\n').filter(l => l.trim()).map(leadingWs);
		return ws.length ? ws.reduce((a, b) => (b.length < a.length ? b : a)) : '';
	};
	const want = minIndent(original);
	const have = minIndent(result);
	let lines = result.replace(/\r\n/g, '\n').split('\n');
	if (want.length > have.length && want.startsWith(have)) {
		const pad = want.slice(have.length);
		lines = lines.map(l => (l.trim() ? pad + l : l));
	} else if (have.length > want.length && have.startsWith(want)) {
		const cut = have.length - want.length;
		lines = lines.map(l => (l.trim() ? l.slice(cut) : l));
	}
	// Tabs vs spaces: follow the original file.
	if (want.includes('\t') && !want.includes(' ')) lines = lines.map(l => l.replace(/^( {4})+/, m => '\t'.repeat(m.length / 4)));
	let out = lines.join('\n');
	if (original.endsWith('\n') && !out.endsWith('\n')) out += '\n';
	if (!original.endsWith('\n')) out = out.replace(/\n+$/, '');
	return original.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
}
