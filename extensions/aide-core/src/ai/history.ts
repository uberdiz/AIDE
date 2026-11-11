import { compressOutput } from './context/compress';
import { estimateMessageTokens } from './tokens';
import type { ChatMessage } from './types';
import { messageText } from './types';

/**
 * Keep conversation history inside a token budget:
 *  1. shrink old tool results (cheap, deterministic),
 *  2. summarize the oldest turns with a cheap model (when a summarizer is given),
 *  3. as a last resort drop the oldest turns.
 * Tool-call/result pairs are never split.
 */
export async function compactHistory(
	messages: ChatMessage[],
	budgetTokens: number,
	summarize?: (text: string) => Promise<string>,
	keepRecent = 6,
): Promise<{ messages: ChatMessage[]; compacted: boolean; summary?: string }> {
	const total = (ms: ChatMessage[]) => ms.reduce((n, m) => n + estimateMessageTokens(m), 0);
	if (total(messages) <= budgetTokens) return { messages, compacted: false };

	// 1. Compress tool outputs outside the recent window.
	let out = messages.map((m, i) => {
		if (m.role !== 'tool' || i >= messages.length - keepRecent) return m;
		const text = messageText(m);
		if (text.length < 1200) return m;
		return { ...m, content: compressOutput(text, 250) };
	});
	if (total(out) <= budgetTokens) return { messages: out, compacted: true };

	// 2. Split into [old | recent] at a safe boundary (a user message).
	let cut = Math.max(0, out.length - keepRecent);
	while (cut > 0 && out[cut].role !== 'user') cut--;
	if (cut === 0) return { messages: out, compacted: true };
	const old = out.slice(0, cut);
	const recent = out.slice(cut);

	let summary: string | undefined;
	if (summarize) {
		const transcript = old.map(m => {
			const t = messageText(m);
			const calls = m.toolCalls?.map(c => `[called ${c.name}(${JSON.stringify(c.input).slice(0, 200)})]`).join(' ') ?? '';
			return `${m.role.toUpperCase()}${m.toolName ? `(${m.toolName})` : ''}: ${t.slice(0, 4000)} ${calls}`.trim();
		}).join('\n\n');
		try {
			summary = await summarize(transcript);
		} catch {
			summary = undefined;
		}
	}
	if (summary) {
		out = [{ role: 'user', content: `[Summary of the earlier conversation]\n${summary}` }, { role: 'assistant', content: 'Understood - continuing from that summary.' }, ...recent];
	} else {
		out = recent;
	}
	// 3. Still too large: drop from the front (keeping pairs intact).
	while (total(out) > budgetTokens && out.length > 2) {
		out.shift();
		while (out.length && out[0].role !== 'user') out.shift();
	}
	return { messages: out, compacted: true, summary };
}

export const SUMMARIZE_PROMPT =
	'Summarize this conversation between a developer and an AI coding assistant so the assistant can continue the work. ' +
	'Keep: goals, decisions, file paths touched, commands run and their outcomes, open problems, and user preferences. ' +
	'Omit pleasantries. Use terse bullet points.';
