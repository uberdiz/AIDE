import { mergeModels } from '../catalog';
import type { ChatMessage, ChatRequest, ModelCapability, ModelInfo, Provider, ProviderConfig, StopReason, StreamEvent, ToolCall } from '../types';
import { ProviderError } from '../types';
import { checkResponse, joinUrl, ndjson, networkError } from './http';

export const OLLAMA_DEFAULT_BASE = 'http://localhost:11434';

/** Native Ollama API: streaming chat, tool calling, embeddings and runtime stats. */
export class OllamaProvider implements Provider {
	private lastStats: { model: string; tokensPerSecond: number; promptTokens: number; evalTokens: number } | undefined;

	constructor(readonly config: ProviderConfig) {}

	private get base(): string {
		return this.config.baseUrl || OLLAMA_DEFAULT_BASE;
	}

	private async request(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
		const url = joinUrl(this.base, path);
		let res: Response;
		try {
			res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...this.config.headers } });
		} catch (err) {
			throw networkError(this.config.id, err, url);
		}
		await checkResponse(res, this.config.id);
		return res;
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const res = await this.request('api/tags', { signal });
		const body = (await res.json()) as { models?: { name: string; details?: { parameter_size?: string; context_length?: number }; capabilities?: string[] }[] };
		const discovered: ModelInfo[] = (body.models ?? []).map(m => {
			const caps = new Set<ModelCapability>(['chat']);
			for (const c of m.capabilities ?? []) {
				if (c === 'tools') caps.add('tools');
				if (c === 'vision') caps.add('vision');
				if (c === 'embedding') caps.add('embeddings');
				if (c === 'thinking') caps.add('reasoning');
				if (c === 'completion') caps.add('completion');
			}
			if (/embed/i.test(m.name)) caps.add('embeddings');
			return {
				id: m.name,
				label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
				contextWindow: m.details?.context_length,
				capabilities: [...caps],
				local: true,
				inputPrice: 0,
				outputPrice: 0,
			};
		});
		return mergeModels(discovered, this.config.models);
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const opts = this.config.options ?? {};
		const options: Record<string, unknown> = { num_ctx: opts.num_ctx ?? 16_384 };
		if (req.temperature !== undefined) options.temperature = req.temperature;
		if (req.maxTokens) options.num_predict = req.maxTokens;
		if (req.stop?.length) options.stop = req.stop;
		const body: Record<string, unknown> = {
			model: req.model,
			messages: this.toWire(req),
			stream: true,
			options,
		};
		if (opts.keep_alive !== undefined) body.keep_alive = opts.keep_alive;
		if (req.tools?.length) {
			body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
		}
		const res = await this.request('api/chat', { method: 'POST', body: JSON.stringify(body), signal });
		if (!res.body) throw new ProviderError(`${this.config.id}: empty response body`, this.config.id);

		let text = '';
		const toolCalls: ToolCall[] = [];
		let doneReason: string | undefined;
		let promptTokens = 0;
		let evalTokens = 0;
		try {
			for await (const chunk of ndjson(res.body, signal)) {
				if (chunk.error) throw new ProviderError(`${this.config.id}: ${chunk.error}`, this.config.id);
				const msg = chunk.message ?? {};
				if (msg.thinking) yield { type: 'thinking', text: msg.thinking };
				if (msg.content) {
					text += msg.content;
					yield { type: 'text', text: msg.content };
				}
				for (const tc of msg.tool_calls ?? []) {
					const args = tc.function?.arguments;
					toolCalls.push({
						id: `call_${toolCalls.length}_${Date.now().toString(36)}`,
						name: tc.function?.name ?? '',
						input: typeof args === 'string' ? safeJson(args) : (args ?? {}),
					});
				}
				if (chunk.done) {
					doneReason = chunk.done_reason;
					promptTokens = chunk.prompt_eval_count ?? 0;
					evalTokens = chunk.eval_count ?? 0;
					if (chunk.eval_duration) {
						this.lastStats = { model: req.model, tokensPerSecond: evalTokens / (chunk.eval_duration / 1e9), promptTokens, evalTokens };
					}
				}
			}
		} catch (err) {
			if (err instanceof ProviderError) throw err;
			throw networkError(this.config.id, err, this.base);
		}
		for (const call of toolCalls) yield { type: 'tool_call', call };
		yield { type: 'usage', usage: { inputTokens: promptTokens, outputTokens: evalTokens, exact: true } };
		const stopReason: StopReason = toolCalls.length ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end';
		yield { type: 'done', stopReason, message: { role: 'assistant', content: text, toolCalls: toolCalls.length ? toolCalls : undefined } };
	}

	async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
		const res = await this.request('api/embed', { method: 'POST', body: JSON.stringify({ model, input: texts }), signal });
		const body = (await res.json()) as { embeddings: number[][] };
		return body.embeddings;
	}

	async runtimeInfo(signal?: AbortSignal): Promise<Record<string, unknown>> {
		const res = await this.request('api/ps', { signal });
		const body = (await res.json()) as { models?: { name: string; size?: number; size_vram?: number; context_length?: number; expires_at?: string }[] };
		return {
			loaded: (body.models ?? []).map(m => ({
				model: m.name,
				sizeMB: m.size ? Math.round(m.size / 1048576) : undefined,
				vramMB: m.size_vram ? Math.round(m.size_vram / 1048576) : undefined,
				gpuPercent: m.size && m.size_vram !== undefined ? Math.round((m.size_vram / m.size) * 100) : undefined,
				context: m.context_length,
				expiresAt: m.expires_at,
			})),
			lastRun: this.lastStats,
		};
	}

	private toWire(req: ChatRequest): unknown[] {
		const out: unknown[] = [];
		if (req.system) out.push({ role: 'system', content: req.system });
		for (const m of req.messages) out.push(toOllamaMessage(m));
		return out;
	}
}

function toOllamaMessage(m: ChatMessage): unknown {
	const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('');
	const images = typeof m.content === 'string' ? undefined : m.content.filter(p => p.type === 'image').map(p => (p as { data: string }).data);
	if (m.role === 'tool') return { role: 'tool', content: text, tool_name: m.toolName };
	if (m.role === 'assistant') {
		return {
			role: 'assistant',
			content: text,
			tool_calls: m.toolCalls?.map(c => ({ function: { name: c.name, arguments: c.input } })),
		};
	}
	return { role: m.role, content: text, images: images?.length ? images : undefined };
}

function safeJson(s: string): Record<string, unknown> {
	try {
		return JSON.parse(s);
	} catch {
		return { __invalid_json__: s };
	}
}
