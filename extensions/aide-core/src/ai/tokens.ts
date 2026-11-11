import type { ChatMessage, ModelInfo, ToolSpec, Usage } from './types';

/**
 * Fast, dependency-free token estimate. Real tokenizers differ per vendor, so
 * AIDE treats this as an estimate for budgeting and replaces it with the
 * provider's reported usage whenever a response includes it.
 *
 * Heuristic: ~4 chars/token for prose, denser for code/symbol-heavy text.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	const len = text.length;
	let symbols = 0;
	let whitespace = 0;
	// Sample long strings to keep this O(1)-ish for huge inputs.
	const step = len > 20_000 ? Math.floor(len / 20_000) : 1;
	let sampled = 0;
	for (let i = 0; i < len; i += step) {
		const c = text.charCodeAt(i);
		sampled++;
		if (c === 32 || c === 9 || c === 10 || c === 13) whitespace++;
		else if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) symbols++;
		else if (c > 127) symbols += 0.5; // non-ASCII tends to tokenize densely
	}
	const symbolRatio = symbols / sampled;
	const charsPerToken = symbolRatio > 0.12 ? 3.1 : symbolRatio > 0.06 ? 3.5 : 4.0;
	const wsRatio = whitespace / sampled;
	// Heavy indentation compresses well in BPE tokenizers.
	const adjusted = len * (1 - Math.max(0, wsRatio - 0.25) * 0.5);
	return Math.max(1, Math.ceil(adjusted / charsPerToken));
}

export function estimateMessageTokens(m: ChatMessage): number {
	let n = 4; // role/framing overhead
	if (typeof m.content === 'string') n += estimateTokens(m.content);
	else for (const p of m.content) n += p.type === 'text' ? estimateTokens(p.text) : 1600; // images: flat estimate
	for (const c of m.toolCalls ?? []) n += estimateTokens(c.name) + estimateTokens(JSON.stringify(c.input)) + 8;
	return n;
}

export function estimateRequestTokens(system: string | undefined, messages: ChatMessage[], tools?: ToolSpec[]): number {
	let n = system ? estimateTokens(system) + 4 : 0;
	for (const m of messages) n += estimateMessageTokens(m);
	for (const t of tools ?? []) n += estimateTokens(t.name + t.description + JSON.stringify(t.inputSchema)) + 10;
	return n;
}

/** USD cost for a usage record, or undefined when the model has no known price. */
export function costOf(model: ModelInfo | undefined, usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | undefined {
	if (!model) return undefined;
	if (model.local) return 0;
	if (model.inputPrice === undefined || model.outputPrice === undefined) return undefined;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	const readPrice = model.cacheReadPrice ?? model.inputPrice * 0.1;
	return (
		(usage.inputTokens * model.inputPrice +
			usage.outputTokens * model.outputPrice +
			cacheRead * readPrice +
			cacheWrite * model.inputPrice * 1.25) /
		1_000_000
	);
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
	return n.toLocaleString('en-US');
}

export function formatCost(usd: number | undefined): string {
	if (usd === undefined) return 'n/a';
	if (usd === 0) return '$0';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}
