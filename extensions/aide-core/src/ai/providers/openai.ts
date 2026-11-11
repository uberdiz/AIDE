import { mergeModels } from '../catalog';
import type { ChatMessage, ChatRequest, ModelInfo, Provider, ProviderConfig, StopReason, StreamEvent, ToolCall, Usage } from '../types';
import { ProviderError } from '../types';
import { checkResponse, joinUrl, networkError, sseEvents } from './http';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

/**
 * OpenAI Chat Completions protocol. Covers OpenAI itself plus every
 * OpenAI-compatible server: OpenRouter, LM Studio, vLLM, llama.cpp server,
 * Together, Groq, DeepSeek, custom gateways...
 */
export class OpenAICompatibleProvider implements Provider {
	constructor(readonly config: ProviderConfig, private readonly apiKey: string | undefined) {}

	private get base(): string {
		return this.config.baseUrl || OPENAI_DEFAULT_BASE;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { 'content-type': 'application/json', ...this.config.headers };
		if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
		return h;
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const url = joinUrl(this.base, 'models');
		let res: Response;
		try {
			res = await fetch(url, { headers: this.headers(), signal });
		} catch (err) {
			if (this.config.models?.length) return this.config.models;
			throw networkError(this.config.id, err, url);
		}
		await checkResponse(res, this.config.id);
		const body = (await res.json()) as { data?: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] };
		const discovered: ModelInfo[] = (body.data ?? []).map(m => ({
			id: m.id,
			contextWindow: m.context_length,
			// OpenRouter reports per-token USD prices as strings.
			inputPrice: m.pricing?.prompt !== undefined ? Number(m.pricing.prompt) * 1_000_000 : undefined,
			outputPrice: m.pricing?.completion !== undefined ? Number(m.pricing.completion) * 1_000_000 : undefined,
			local: this.config.local || undefined,
			capabilities: /embed/i.test(m.id) ? ['embeddings'] : ['chat', 'tools'],
		}));
		return mergeModels(discovered, this.config.models);
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const isOpenAI = this.config.kind === 'openai';
		const body: Record<string, unknown> = {
			model: req.model,
			messages: this.toWire(req),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (req.maxTokens) body[isOpenAI ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
		if (req.temperature !== undefined) body.temperature = req.temperature;
		if (req.stop?.length) body.stop = req.stop;
		if (req.tools?.length) {
			body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
		}
		const modelInfo = this.config.models?.find(m => m.id === req.model);
		if (req.reasoning && modelInfo?.capabilities?.includes('reasoning')) body.reasoning_effort = req.reasoning === 'xhigh' || req.reasoning === 'max' ? 'high' : req.reasoning;

		const url = joinUrl(this.base, 'chat/completions');
		let res: Response;
		try {
			res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
		} catch (err) {
			throw networkError(this.config.id, err, url);
		}
		await checkResponse(res, this.config.id);
		if (!res.body) throw new ProviderError(`${this.config.id}: empty response body`, this.config.id);

		let text = '';
		let finish: string | undefined;
		let usage: Usage | undefined;
		const partial = new Map<number, { id: string; name: string; args: string }>();
		try {
			for await (const ev of sseEvents(res.body, signal)) {
				if (ev.data === '[DONE]') break;
				let chunk: any;
				try {
					chunk = JSON.parse(ev.data);
				} catch {
					continue;
				}
				if (chunk.error) throw new ProviderError(`${this.config.id}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, this.config.id);
				if (chunk.usage) {
					usage = {
						inputTokens: chunk.usage.prompt_tokens ?? 0,
						outputTokens: chunk.usage.completion_tokens ?? 0,
						cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
						exact: true,
					};
					if (usage.cacheReadTokens) usage.inputTokens -= usage.cacheReadTokens;
				}
				const choice = chunk.choices?.[0];
				if (!choice) continue;
				const delta = choice.delta ?? {};
				const reasoning = delta.reasoning_content ?? delta.reasoning;
				if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', text: reasoning };
				if (typeof delta.content === 'string' && delta.content) {
					text += delta.content;
					yield { type: 'text', text: delta.content };
				}
				for (const tc of delta.tool_calls ?? []) {
					const idx = tc.index ?? 0;
					const cur = partial.get(idx) ?? { id: '', name: '', args: '' };
					if (tc.id) cur.id = tc.id;
					if (tc.function?.name) cur.name += tc.function.name;
					if (tc.function?.arguments) cur.args += tc.function.arguments;
					partial.set(idx, cur);
				}
				if (choice.finish_reason) finish = choice.finish_reason;
			}
		} catch (err) {
			if (err instanceof ProviderError) throw err;
			throw networkError(this.config.id, err, url);
		}

		const toolCalls: ToolCall[] = [];
		for (const [idx, p] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
			let input: Record<string, unknown> = {};
			if (p.args.trim()) {
				try {
					input = JSON.parse(p.args);
				} catch {
					input = { __invalid_json__: p.args };
				}
			}
			toolCalls.push({ id: p.id || `call_${idx}_${Date.now()}`, name: p.name, input });
		}
		for (const call of toolCalls) yield { type: 'tool_call', call };
		if (usage) yield { type: 'usage', usage };
		const stopReason: StopReason = toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end';
		yield { type: 'done', stopReason, message: { role: 'assistant', content: text, toolCalls: toolCalls.length ? toolCalls : undefined } };
	}

	async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
		const url = joinUrl(this.base, 'embeddings');
		let res: Response;
		try {
			res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ model, input: texts }), signal });
		} catch (err) {
			throw networkError(this.config.id, err, url);
		}
		await checkResponse(res, this.config.id);
		const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
		return body.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
	}

	private toWire(req: ChatRequest): unknown[] {
		const out: unknown[] = [];
		if (req.system) out.push({ role: 'system', content: req.system });
		for (const m of req.messages) out.push(toOpenAIMessage(m));
		return out;
	}
}

export function toOpenAIMessage(m: ChatMessage): unknown {
	const content = typeof m.content === 'string'
		? m.content
		: m.content.map(p => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }));
	switch (m.role) {
		case 'tool':
			return { role: 'tool', tool_call_id: m.toolCallId, content: typeof content === 'string' ? content : JSON.stringify(content) };
		case 'assistant':
			return {
				role: 'assistant',
				content: typeof content === 'string' ? content || null : content,
				tool_calls: m.toolCalls?.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
			};
		default:
			return { role: m.role, content };
	}
}
