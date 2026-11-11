import { mergeModels, BUILTIN_MODELS } from '../catalog';
import type { ModelInfo, Provider, ProviderConfig } from '../types';
import { ProviderError } from '../types';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { OpenAICompatibleProvider } from './openai';

export type ProviderFactory = (config: ProviderConfig, apiKey: string | undefined) => Provider;

/** A model reference is `providerId/modelId` (model ids may themselves contain '/'). */
export interface ModelRef { providerId: string; modelId: string }

export function parseModelRef(ref: string): ModelRef | undefined {
	const i = ref.indexOf('/');
	if (i <= 0 || i === ref.length - 1) return undefined;
	return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export function formatModelRef(r: ModelRef): string {
	return `${r.providerId}/${r.modelId}`;
}

const builtinFactories: Record<string, ProviderFactory> = {
	anthropic: (c, k) => new AnthropicProvider(c, k),
	openai: (c, k) => new OpenAICompatibleProvider(c, k),
	'openai-compatible': (c, k) => new OpenAICompatibleProvider(c, k),
	ollama: c => new OllamaProvider(c),
	gemini: (c, k) => new GeminiProvider(c, k),
};

/**
 * Holds provider configurations, instantiates adapters lazily, and caches
 * model lists. Extensions can register additional provider kinds.
 */
export class ProviderRegistry {
	private configs: ProviderConfig[] = [];
	private instances = new Map<string, Provider>();
	private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
	private factories = new Map<string, ProviderFactory>(Object.entries(builtinFactories));
	private external = new Map<string, Provider>();

	constructor(private readonly getKey: (providerId: string) => Promise<string | undefined>) {}

	setConfigs(configs: ProviderConfig[]): void {
		this.configs = configs.filter(c => c.enabled !== false);
		this.instances.clear();
		this.modelCache.clear();
	}

	registerKind(kind: string, factory: ProviderFactory): () => void {
		this.factories.set(kind, factory);
		return () => this.factories.delete(kind);
	}

	/** Register a fully-constructed provider instance (from an extension). */
	registerInstance(provider: Provider): () => void {
		this.external.set(provider.config.id, provider);
		return () => this.external.delete(provider.config.id);
	}

	list(): ProviderConfig[] {
		return [...this.configs, ...[...this.external.values()].map(p => p.config)];
	}

	getConfig(id: string): ProviderConfig | undefined {
		return this.list().find(c => c.id === id);
	}

	async get(id: string): Promise<Provider> {
		const ext = this.external.get(id);
		if (ext) return ext;
		const cached = this.instances.get(id);
		if (cached) return cached;
		const config = this.configs.find(c => c.id === id);
		if (!config) throw new ProviderError(`Unknown or disabled provider "${id}"`, id);
		const factory = this.factories.get(config.kind);
		if (!factory) throw new ProviderError(`No adapter for provider kind "${config.kind}"`, id);
		const key = await this.getKey(id);
		const instance = factory(config, key);
		this.instances.set(id, instance);
		return instance;
	}

	/** Invalidate a cached instance, e.g. after its API key changed. */
	reset(id: string): void {
		this.instances.delete(id);
		this.modelCache.delete(id);
	}

	async models(id: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
		const hit = this.modelCache.get(id);
		if (hit && !opts.refresh && Date.now() - hit.at < 10 * 60_000) return hit.models;
		const provider = await this.get(id);
		const models = (await provider.listModels(opts.signal)).map(m => (provider.config.local ? { ...m, local: true } : m));
		this.modelCache.set(id, { at: Date.now(), models });
		return models;
	}

	/** Model metadata without network access where possible (catalog + config + cache). */
	modelInfo(ref: ModelRef): ModelInfo | undefined {
		const config = this.getConfig(ref.providerId);
		if (!config) return undefined;
		const cached = this.modelCache.get(ref.providerId)?.models.find(m => m.id === ref.modelId);
		const builtin = BUILTIN_MODELS[config.kind]?.find(m => m.id === ref.modelId);
		const configured = config.models?.find(m => m.id === ref.modelId);
		const merged = mergeModels(builtin ? [builtin] : [], cached ? [cached] : [], configured ? [configured] : [])[0];
		const local = config.local || config.kind === 'ollama';
		if (!merged) return { id: ref.modelId, local: local || undefined, ...(local ? { inputPrice: 0, outputPrice: 0 } : {}) };
		return local ? { ...merged, local: true } : merged;
	}

	isLocal(providerId: string): boolean {
		const c = this.getConfig(providerId);
		return !!c && (c.local === true || c.kind === 'ollama');
	}
}
