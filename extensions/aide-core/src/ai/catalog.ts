import type { ModelInfo, ProviderKind } from './types';

/**
 * Built-in model knowledge. Only facts AIDE is confident about are listed;
 * anything else is discovered from the provider at runtime or configured by the
 * user in `aide.providers[].models`. Prices are USD per 1M tokens.
 */
const ANTHROPIC: ModelInfo[] = [
	{ id: 'claude-fable-5-1', label: 'Claude Fable 5.1', contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 10, outputPrice: 50, cacheReadPrice: 0.25, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
	{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 4, outputPrice: 20, cacheReadPrice: 0.2, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
	{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 2, outputPrice: 10, cacheReadPrice: 0.2, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutput: 64_000, inputPrice: 1, outputPrice: 5, cacheReadPrice: 0.1, capabilities: ['chat', 'tools', 'vision'] },
	{ id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 5, outputPrice: 25, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
	{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 2, outputPrice: 10, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000, maxOutput: 128_000, inputPrice: 5, outputPrice: 25, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
];

export const BUILTIN_MODELS: Partial<Record<ProviderKind, ModelInfo[]>> = {
	anthropic: ANTHROPIC,
};

/** Models whose API rejects explicit sampling parameters (temperature etc.). */
export function anthropicRejectsSampling(model: string): boolean {
	return /claude-(fable|mythos|opus-5|opus-4-[78]|sonnet-5)/.test(model);
}

/** Models that only support adaptive thinking (no budget_tokens, no disabling). */
export function anthropicSupportsEffort(model: string): boolean {
	return /claude-(fable|mythos|opus-5|opus-4-[5678]|sonnet-5|sonnet-4-6|opus-4-6)/.test(model);
}

export function findBuiltin(kind: ProviderKind, id: string): ModelInfo | undefined {
	return BUILTIN_MODELS[kind]?.find(m => m.id === id);
}

/** Merge discovered models with built-in knowledge and user overrides (later wins). */
export function mergeModels(...lists: (ModelInfo[] | undefined)[]): ModelInfo[] {
	const byId = new Map<string, ModelInfo>();
	for (const list of lists) {
		for (const m of list ?? []) {
			const prev = byId.get(m.id);
			byId.set(m.id, prev ? { ...prev, ...stripUndefined(m) } : { ...m });
		}
	}
	return [...byId.values()];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}
