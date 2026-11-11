/**
 * Auto model selection: for each role (chat, coding, planning...) rank the
 * models of the providers the user enabled for Auto. Chat prefers a small fast
 * model (~1B locally), coding prefers a tool-calling coder model around 7-16B
 * (or the strongest cloud model), planning/review/debugging prefer the most
 * capable model. Explicit per-role routing rules always take precedence.
 */

export interface PickableModel {
	ref: string;
	providerId: string;
	id: string;
	label?: string;
	local: boolean;
	caps: string[];
	contextWindow?: number;
}

export type Role = 'chat' | 'coding' | 'reasoning' | 'autocomplete' | 'light' | 'vision' | 'embeddings';

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
	chat: { label: 'Chat', description: 'Questions and conversation about the project. A small fast model (about 1B locally) is enough.' },
	coding: { label: 'Coding', description: 'Coder, Tester, Documenter and inline edits. A tool-calling coder model (7-16B locally) or a strong cloud model.' },
	reasoning: { label: 'Planning, review & debugging', description: 'Planner, Reviewer and Debugger. The most capable model available.' },
	autocomplete: { label: 'Autocomplete', description: 'Inline code completions. The smallest fast model, ideally a coder model.' },
	light: { label: 'Background', description: 'Commit messages, summaries, history compaction.' },
	vision: { label: 'Images', description: 'Requests that include images.' },
	embeddings: { label: 'Embeddings', description: 'Semantic search.' },
};

export function roleForTask(task: string): Role {
	switch (task) {
		case 'chat': case 'explain': return 'chat';
		case 'coding': case 'simple_edits': return 'coding';
		case 'planning': case 'review': case 'debug': return 'reasoning';
		case 'autocomplete': return 'autocomplete';
		case 'commit_message': case 'summarize': case 'background': return 'light';
		case 'vision': return 'vision';
		case 'embeddings': return 'embeddings';
		default: return 'coding';
	}
}

/** Parameter count in billions from an Ollama label "(8.0B)" / "(361.82M)" or a name like "qwen2.5-coder:7b". */
export function modelSizeB(m: { id: string; label?: string }): number | undefined {
	const fromLabel = /\((\d+(?:\.\d+)?)\s*([BM])\)/i.exec(m.label ?? '');
	if (fromLabel) return Number(fromLabel[1]) / (fromLabel[2].toUpperCase() === 'M' ? 1000 : 1);
	const fromId = /[:\-_](\d+(?:\.\d+)?)([bm])\b/i.exec(m.id) ?? /(\d+(?:\.\d+)?)([bm])\b/i.exec(m.id);
	if (fromId) return Number(fromId[1]) / (fromId[2].toLowerCase() === 'm' ? 1000 : 1);
	return undefined;
}

export function isCoderModel(id: string): boolean {
	return /coder|codellama|starcoder|codestral|devstral|codegemma|granite-code|codeqwen|deepseek-code|qwen3-coder/i.test(id);
}

/** 3 = flagship, 2 = strong mid-tier, 1 = small/fast. */
export function cloudTier(id: string): 1 | 2 | 3 {
	const s = id.toLowerCase();
	if (/haiku|mini|nano|flash|lite|small|tiny|8b|instant/.test(s)) return 1;
	if (/opus|fable|gpt-5(?!-mini)|o3|o4|\bpro\b|-pro|ultra|large|405b|grok-4/.test(s)) return 3;
	return 2;
}

function closeness(size: number, target: number): number {
	return Math.abs(Math.log2(size / target));
}

/** Higher is better; undefined means unsuitable for the role. */
export function scoreModel(role: Role, m: PickableModel): number | undefined {
	const caps = m.caps ?? [];
	const embedOnly = caps.includes('embeddings') && !caps.includes('chat');
	if (role === 'embeddings') return caps.includes('embeddings') ? (m.local ? 5 : 3) : undefined;
	if (embedOnly) return undefined;
	if (role === 'vision' && !caps.includes('vision')) return undefined;
	const knownCaps = caps.length > 1;
	const tools = caps.includes('tools') ? 1 : knownCaps ? -1 : 0;
	const coder = isCoderModel(m.id);
	const size = modelSizeB(m) ?? (m.local ? 7 : undefined);
	const tier = cloudTier(m.id);

	switch (role) {
		case 'chat':
			if (m.local) return 12 - 3 * closeness(size!, 1.0) - (coder ? 1 : 0);
			return tier === 1 ? 9 : tier === 2 ? 7 : 5;
		case 'coding':
			if (!m.local) return tier === 3 ? 22 : tier === 2 ? 20 : 10;
			return 6 + (coder ? 4 : 0) + (size! >= 6 && size! <= 16 ? 4 : size! > 16 && size! <= 40 ? 3 : size! > 40 ? 1 : size! >= 3 ? 0 : -8) + (tools > 0 ? 3 : tools < 0 ? -8 : 0);
		case 'reasoning':
			if (!m.local) return tier === 3 ? 24 : tier === 2 ? 19 : 10;
			return 5 + (size! >= 30 ? 7 : size! >= 12 ? 6 : size! >= 6 ? 4 : size! >= 3 ? 0 : -8) + (tools > 0 ? 2 : tools < 0 ? -6 : 0);
		case 'autocomplete':
			if (!m.local) return tier === 1 ? 3 : 0;
			return (size! <= 3 ? 10 : size! <= 8 ? 6 : 1) + (coder ? 4 : 0);
		case 'light':
			if (m.local) return 10 - 2 * closeness(size!, 2);
			return tier === 1 ? 8 : tier === 2 ? 5 : 2;
		case 'vision':
			return m.local ? 6 + Math.min(4, (size ?? 7) / 4) : tier === 3 ? 10 : tier === 2 ? 9 : 7;
	}
}

export function describePick(role: Role, m: PickableModel): string {
	const size = modelSizeB(m);
	const bits = [m.local ? 'local' : 'cloud'];
	if (size !== undefined) bits.push(size < 1 ? `${Math.round(size * 1000)}M` : `${+size.toFixed(1)}B`);
	if (isCoderModel(m.id)) bits.push('coder model');
	if (m.caps.includes('tools')) bits.push('tool calling');
	return `${ROLE_INFO[role].label}: ${bits.join(', ')}`;
}

/** Ranked refs for a role; the first is used, the rest are fallbacks. */
export function pickForRole(role: Role, models: PickableModel[], max = 4): PickableModel[] {
	return models
		.map((m, i) => ({ m, i, s: scoreModel(role, m) }))
		.filter((x): x is { m: PickableModel; i: number; s: number } => x.s !== undefined)
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.slice(0, max)
		.map(x => x.m);
}

/** Suggestions shown when the user's models are a poor fit for a role (never downloaded automatically). */
export function recommendations(models: PickableModel[]): { role: Role; text: string; command: string }[] {
	const local = models.filter(m => m.local && !(m.caps.includes('embeddings') && !m.caps.includes('chat')));
	if (!local.length) return [];
	const out: { role: Role; text: string; command: string }[] = [];
	const hasCoder = local.some(m => isCoderModel(m.id) && (modelSizeB(m) ?? 7) >= 6 && m.caps.includes('tools'));
	if (!hasCoder && !models.some(m => !m.local)) out.push({ role: 'coding', text: 'No local tool-calling coder model found. qwen2.5-coder:7b (4.7 GB) edits code much more reliably than a general chat model.', command: 'ollama pull qwen2.5-coder:7b' });
	const hasSmall = local.some(m => (modelSizeB(m) ?? 7) <= 2 && (modelSizeB(m) ?? 0) >= 0.5);
	if (!hasSmall) out.push({ role: 'chat', text: 'A small chat model keeps chat fast. qwen3:0.6b (523 MB) or llama3.2:1b (1.3 GB) work well.', command: 'ollama pull qwen3:0.6b' });
	return out;
}
