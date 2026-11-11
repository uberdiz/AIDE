import { describe, expect, it } from 'vitest';
import { classifyTask, Router, type RoutingConfig } from '../../src/ai/router';
import type { ModelInfo } from '../../src/ai/types';

const models: Record<string, ModelInfo> = {
	'anthropic/claude-opus-5-5': { id: 'claude-opus-5-5', contextWindow: 1_000_000, inputPrice: 4, outputPrice: 20, capabilities: ['chat', 'tools', 'vision', 'reasoning'] },
	'anthropic/claude-haiku-4-5': { id: 'claude-haiku-4-5', contextWindow: 200_000, inputPrice: 1, outputPrice: 5, capabilities: ['chat', 'tools', 'vision'] },
	'ollama/llama3.1': { id: 'llama3.1', contextWindow: 8192, local: true, inputPrice: 0, outputPrice: 0, capabilities: ['chat', 'tools'] },
	'ollama/smollm2': { id: 'smollm2', contextWindow: 8192, local: true, capabilities: ['chat'] },
};

function makeRouter(cfg: Partial<RoutingConfig> = {}, blocked: string[] = []) {
	const config: RoutingConfig = {
		strategy: 'rules',
		rules: { chat: ['claude', 'local'], autocomplete: 'local_fast', coding: ['anthropic/claude-opus-5-5'] },
		default: ['anthropic/claude-haiku-4-5'],
		aliases: { claude: 'anthropic/claude-opus-5-5', local: 'ollama/llama3.1', local_fast: 'ollama/smollm2' },
		autoFallback: false,
		...cfg,
	};
	return new Router(config, {
		providerExists: id => id === 'anthropic' || id === 'ollama',
		isLocal: id => id === 'ollama',
		modelInfo: r => models[`${r.providerId}/${r.modelId}`],
		knownModels: () => Object.keys(models).map(k => ({ providerId: k.split('/')[0], modelId: k.split('/').slice(1).join('/') })),
		blockedByLimits: r => (blocked.includes(`${r.providerId}/${r.modelId}`) ? 'limit' : undefined),
	});
}

const refs = (r: ReturnType<Router['route']>) => r.candidates.map(c => `${c.ref.providerId}/${c.ref.modelId}`);

describe('Router', () => {
	it('resolves aliases and keeps rule order as fallback chain', () => {
		expect(refs(makeRouter().route({ task: 'chat' }))).toEqual(['anthropic/claude-opus-5-5', 'ollama/llama3.1']);
		expect(refs(makeRouter().route({ task: 'autocomplete' }))).toEqual(['ollama/smollm2']);
	});

	it('uses same-role rules, then the default route', () => {
		// simple_edits -> coding rule
		expect(refs(makeRouter().route({ task: 'simple_edits' }))).toEqual(['anthropic/claude-opus-5-5']);
		// no rule and no auto-pick -> default
		expect(refs(makeRouter().route({ task: 'debug' }))).toEqual(['anthropic/claude-haiku-4-5']);
		expect(refs(makeRouter().route({ task: 'something-else' }))).toEqual(['anthropic/claude-haiku-4-5']);
	});

	it('auto-picks per role when a task has no rule, before the default route', () => {
		const r = makeRouter();
		const withAuto = new Router(r.getConfig(), {
			providerExists: () => true,
			isLocal: id => id === 'ollama',
			modelInfo: x => models[`${x.providerId}/${x.modelId}`],
			knownModels: () => [],
			autoPick: task => ({ refs: task === 'planning' ? ['anthropic/claude-opus-5-5'] : [], reason: 'test' }),
		});
		expect(refs(withAuto.route({ task: 'planning' }))).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5']);
		// explicit rules still win over auto
		expect(refs(withAuto.route({ task: 'chat' }))).toEqual(['anthropic/claude-opus-5-5', 'ollama/llama3.1']);
	});

	it('puts a manual choice first', () => {
		expect(refs(makeRouter().route({ task: 'chat', manual: 'local' }))[0]).toBe('ollama/llama3.1');
	});

	it('filters by capability and context window', () => {
		const r = makeRouter({ rules: { chat: ['local_fast', 'local', 'claude'] } });
		expect(refs(r.route({ task: 'chat', requires: ['tools'] }))).toEqual(['ollama/llama3.1', 'anthropic/claude-opus-5-5']);
		const big = r.route({ task: 'chat', estimatedInputTokens: 50_000 });
		expect(refs(big)).toEqual(['anthropic/claude-opus-5-5']);
		expect(big.rejected.map(x => x.reason).join()).toMatch(/context too large/);
	});

	it('rejects unknown providers and blocked models with reasons', () => {
		const r = makeRouter({ rules: { chat: ['openai/gpt-x', 'claude', 'local'] } }, ['anthropic/claude-opus-5-5']);
		const out = r.route({ task: 'chat' });
		expect(refs(out)).toEqual(['ollama/llama3.1']);
		expect(out.rejected.map(x => x.ref)).toEqual(['openai/gpt-x', 'anthropic/claude-opus-5-5']);
	});

	it('applies strategies', () => {
		const rules = { chat: ['claude', 'anthropic/claude-haiku-4-5', 'local'] };
		expect(refs(makeRouter({ rules, strategy: 'local-first' }).route({ task: 'chat' }))[0]).toBe('ollama/llama3.1');
		expect(refs(makeRouter({ rules, strategy: 'cost' }).route({ task: 'chat' }))).toEqual(['ollama/llama3.1', 'anthropic/claude-haiku-4-5', 'anthropic/claude-opus-5-5']);
		expect(refs(makeRouter({ rules, strategy: 'cloud-first' }).route({ task: 'chat' })).pop()).toBe('ollama/llama3.1');
	});

	it('auto-fallback appends all known models', () => {
		expect(refs(makeRouter({ rules: { chat: ['claude'] }, autoFallback: true }).route({ task: 'chat' })).length).toBe(4);
	});
});

describe('classifyTask', () => {
	it('detects common intents', () => {
		expect(classifyTask('Why does this crash with a TypeError?')).toBe('debug');
		expect(classifyTask('Explain what this function does')).toBe('explain');
		expect(classifyTask('Add a login button')).toBe('coding');
		expect(classifyTask('plan the architecture for sync')).toBe('planning');
		expect(classifyTask('hello there')).toBe('chat');
		expect(classifyTask('x', { hasImages: true })).toBe('vision');
	});
});
