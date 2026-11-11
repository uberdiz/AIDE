import Anthropic from '@anthropic-ai/sdk';
import { anthropicRejectsSampling, anthropicSupportsEffort, BUILTIN_MODELS, mergeModels } from '../catalog';
import type { ChatMessage, ChatRequest, ModelInfo, Provider, ProviderConfig, StopReason, StreamEvent, ToolCall } from '../types';
import { ProviderError } from '../types';

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
function supportsServerFallback(model: string): boolean {
	return /claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/.test(model);
}

export class AnthropicProvider implements Provider {
	private readonly client: Anthropic;

	constructor(readonly config: ProviderConfig, apiKey: string | undefined) {
		this.client = new Anthropic({
			apiKey: apiKey || undefined,
			baseURL: config.baseUrl || undefined,
			defaultHeaders: config.headers,
			maxRetries: 2,
		});
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const discovered: ModelInfo[] = [];
		try {
			for await (const m of this.client.models.list({}, { signal })) {
				const raw = m as unknown as { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number };
				discovered.push({
					id: raw.id,
					label: raw.display_name,
					contextWindow: raw.max_input_tokens,
					maxOutput: raw.max_tokens,
					capabilities: ['chat', 'tools', 'vision'],
				});
			}
		} catch (err) {
			if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('Anthropic: invalid or missing API key', this.config.id, 401);
			// Offline or proxied endpoints without /v1/models: fall back to the built-in catalog.
		}
		if (!discovered.length) return mergeModels(BUILTIN_MODELS.anthropic, this.config.models);
		const known = BUILTIN_MODELS.anthropic?.filter(b => discovered.some(d => d.id === b.id));
		// Discovered data first so curated pricing/capabilities from the catalog win, then user overrides.
		return mergeModels(discovered, known, this.config.models);
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const model = req.model;
		const params: Record<string, unknown> = {
			model,
			max_tokens: req.maxTokens ?? 32_000,
			messages: this.toWire(req.messages, model),
		};
		if (req.system) params.system = req.system;
		if (req.tools?.length) {
			params.tools = req.tools.map(t => ({
				name: t.name,
				description: t.description,
				input_schema: t.inputSchema,
				// Stream large tool inputs (file contents) as they are generated; inputs are
				// validated against the schema by AIDE's tool registry before execution.
				eager_input_streaming: true,
			}));
		}
		if (req.cacheHint) params.cache_control = { type: 'ephemeral' };
		if (req.stop?.length) params.stop_sequences = req.stop;
		if (anthropicSupportsEffort(model)) {
			params.thinking = { type: 'adaptive', display: 'summarized' };
			params.output_config = { effort: req.reasoning ?? 'medium' };
		}
		if (req.temperature !== undefined && !anthropicRejectsSampling(model)) params.temperature = req.temperature;
		const betas: string[] = [];
		if (supportsServerFallback(model) && !this.config.baseUrl) {
			// On a policy decline the API re-runs the request on a fallback model inside the same call.
			betas.push('server-side-fallback-2026-07-01');
			params.fallbacks = 'default';
		}
		if (betas.length) params.betas = betas;

		let stream;
		try {
			stream = this.client.beta.messages.stream(params as any, { signal });
		} catch (err) {
			throw this.wrap(err);
		}
		try {
			for await (const event of stream as AsyncIterable<any>) {
				if (event.type === 'content_block_delta') {
					if (event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text };
					else if (event.delta.type === 'thinking_delta' && event.delta.thinking) yield { type: 'thinking', text: event.delta.thinking };
				}
			}
			const final: any = await stream.finalMessage();
			const toolCalls: ToolCall[] = [];
			let text = '';
			for (const block of final.content as any[]) {
				if (block.type === 'text') text += block.text;
				else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
			}
			for (const call of toolCalls) yield { type: 'tool_call', call };
			const u = final.usage ?? {};
			yield {
				type: 'usage',
				usage: {
					inputTokens: u.input_tokens ?? 0,
					outputTokens: u.output_tokens ?? 0,
					cacheReadTokens: u.cache_read_input_tokens ?? 0,
					cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
					exact: true,
				},
			};
			const stopReason: StopReason =
				final.stop_reason === 'tool_use' ? 'tool_use' :
				final.stop_reason === 'max_tokens' ? 'max_tokens' :
				final.stop_reason === 'refusal' ? 'refusal' :
				final.stop_reason === 'stop_sequence' ? 'stop' : 'end';
			yield {
				type: 'done',
				stopReason,
				message: {
					role: 'assistant',
					content: text,
					toolCalls: toolCalls.length ? toolCalls : undefined,
					native: { provider: this.config.id, model, content: final.content },
				},
			};
		} catch (err) {
			throw this.wrap(err);
		}
	}

	private wrap(err: unknown): Error {
		if (err instanceof ProviderError) return err;
		if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('Request cancelled', this.config.id);
		if (err instanceof Anthropic.AuthenticationError) return new ProviderError('Anthropic: authentication failed - check your API key', this.config.id, 401);
		if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Anthropic: ${err.message}`, this.config.id, 404);
		if (err instanceof Anthropic.RateLimitError) return new ProviderError(`Anthropic: rate limited - ${err.message}`, this.config.id, 429, true);
		if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic: ${err.message}`, this.config.id, 400);
		if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic: ${err.message}`, this.config.id, err.status, (err.status ?? 500) >= 500);
		if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Anthropic: connection failed - ${err.message}`, this.config.id, undefined, true);
		// Remaining errors come from parsing a streamed tool input; the turn can be re-issued.
		const e = err as Error;
		return new ProviderError(`Anthropic: ${e?.message ?? String(err)}`, this.config.id, undefined, true);
	}

	private toWire(messages: ChatMessage[], model: string): unknown[] {
		const out: { role: 'user' | 'assistant'; content: any }[] = [];
		const push = (role: 'user' | 'assistant', blocks: any[]) => {
			const last = out[out.length - 1];
			if (last && last.role === role) last.content.push(...blocks);
			else out.push({ role, content: [...blocks] });
		};
		for (const m of messages) {
			if (m.role === 'system') {
				// Operator notes mid-conversation are folded into the user turn.
				push('user', [{ type: 'text', text: `[system note]\n${typeof m.content === 'string' ? m.content : ''}` }]);
			} else if (m.role === 'user') {
				push('user', typeof m.content === 'string'
					? [{ type: 'text', text: m.content || ' ' }]
					: m.content.map(p => p.type === 'text'
						? { type: 'text', text: p.text }
						: { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }));
			} else if (m.role === 'assistant') {
				if (m.native && m.native.provider === this.config.id && m.native.model === model) {
					push('assistant', m.native.content as any[]);
				} else {
					const blocks: any[] = [];
					const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('');
					if (text) blocks.push({ type: 'text', text });
					for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
					if (!blocks.length) blocks.push({ type: 'text', text: ' ' });
					push('assistant', blocks);
				}
			} else if (m.role === 'tool') {
				push('user', [{
					type: 'tool_result',
					tool_use_id: m.toolCallId,
					content: typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } })),
					is_error: m.isError || undefined,
				}]);
			}
		}
		return out;
	}
}
