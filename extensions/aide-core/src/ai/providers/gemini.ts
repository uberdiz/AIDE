import { mergeModels } from '../catalog';
import type { ChatMessage, ChatRequest, JsonSchema, ModelInfo, Provider, ProviderConfig, StopReason, StreamEvent, ToolCall, Usage } from '../types';
import { ProviderError } from '../types';
import { checkResponse, joinUrl, networkError, sseEvents } from './http';

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Google Gemini (Generative Language API). The API key is sent as a header, never in the URL. */
export class GeminiProvider implements Provider {
	constructor(readonly config: ProviderConfig, private readonly apiKey: string | undefined) {}

	private get base(): string {
		return this.config.baseUrl || GEMINI_DEFAULT_BASE;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { 'content-type': 'application/json', ...this.config.headers };
		if (this.apiKey) h['x-goog-api-key'] = this.apiKey;
		return h;
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const url = joinUrl(this.base, 'models?pageSize=200');
		let res: Response;
		try {
			res = await fetch(url, { headers: this.headers(), signal });
		} catch (err) {
			throw networkError(this.config.id, err, url);
		}
		await checkResponse(res, this.config.id);
		const body = (await res.json()) as { models?: { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }[] };
		const discovered: ModelInfo[] = (body.models ?? [])
			.filter(m => m.supportedGenerationMethods?.some(g => g === 'generateContent' || g === 'embedContent'))
			.map(m => {
				const embed = m.supportedGenerationMethods?.includes('embedContent') && !m.supportedGenerationMethods.includes('generateContent');
				return {
					id: m.name.replace(/^models\//, ''),
					label: m.displayName,
					contextWindow: m.inputTokenLimit,
					maxOutput: m.outputTokenLimit,
					capabilities: embed ? ['embeddings'] : ['chat', 'tools', 'vision'],
				};
			});
		return mergeModels(discovered, this.config.models);
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const body: Record<string, unknown> = { contents: this.toWire(req.messages, req.model) };
		if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
		if (req.tools?.length) {
			body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) })) }];
		}
		const gen: Record<string, unknown> = {};
		if (req.temperature !== undefined) gen.temperature = req.temperature;
		if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
		if (req.stop?.length) gen.stopSequences = req.stop;
		if (req.reasoning) gen.thinkingConfig = { includeThoughts: true };
		if (Object.keys(gen).length) body.generationConfig = gen;

		const url = joinUrl(this.base, `models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`);
		let res: Response;
		try {
			res = await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
		} catch (err) {
			throw networkError(this.config.id, err, url);
		}
		await checkResponse(res, this.config.id);
		if (!res.body) throw new ProviderError(`${this.config.id}: empty response body`, this.config.id);

		let text = '';
		const toolCalls: ToolCall[] = [];
		const nativeParts: unknown[] = [];
		let usage: Usage | undefined;
		let finish: string | undefined;
		try {
			for await (const ev of sseEvents(res.body, signal)) {
				let chunk: any;
				try {
					chunk = JSON.parse(ev.data);
				} catch {
					continue;
				}
				if (chunk.error) throw new ProviderError(`${this.config.id}: ${chunk.error.message}`, this.config.id, chunk.error.code);
				const cand = chunk.candidates?.[0];
				for (const part of cand?.content?.parts ?? []) {
					nativeParts.push(part);
					if (part.functionCall) {
						toolCalls.push({ id: `call_${toolCalls.length}_${Date.now().toString(36)}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
					} else if (typeof part.text === 'string') {
						if (part.thought) yield { type: 'thinking', text: part.text };
						else {
							text += part.text;
							yield { type: 'text', text: part.text };
						}
					}
				}
				if (cand?.finishReason) finish = cand.finishReason;
				if (chunk.usageMetadata) {
					const cached = chunk.usageMetadata.cachedContentTokenCount ?? 0;
					usage = {
						inputTokens: (chunk.usageMetadata.promptTokenCount ?? 0) - cached,
						outputTokens: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
						cacheReadTokens: cached,
						exact: true,
					};
				}
			}
		} catch (err) {
			if (err instanceof ProviderError) throw err;
			throw networkError(this.config.id, err, url);
		}
		for (const call of toolCalls) yield { type: 'tool_call', call };
		if (usage) yield { type: 'usage', usage };
		const stopReason: StopReason = toolCalls.length ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' ? 'refusal' : 'end';
		yield {
			type: 'done',
			stopReason,
			message: {
				role: 'assistant',
				content: text,
				toolCalls: toolCalls.length ? toolCalls : undefined,
				native: { provider: this.config.id, model: req.model, content: mergeTextParts(nativeParts) },
			},
		};
	}

	async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
		const url = joinUrl(this.base, `models/${encodeURIComponent(model)}:batchEmbedContents`);
		const res = await fetch(url, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ requests: texts.map(t => ({ model: `models/${model}`, content: { parts: [{ text: t }] } })) }),
			signal,
		}).catch(err => {
			throw networkError(this.config.id, err, url);
		});
		await checkResponse(res, this.config.id);
		const body = (await res.json()) as { embeddings: { values: number[] }[] };
		return body.embeddings.map(e => e.values);
	}

	private toWire(messages: ChatMessage[], model: string): unknown[] {
		const out: { role: 'user' | 'model'; parts: unknown[] }[] = [];
		const push = (role: 'user' | 'model', parts: unknown[]) => {
			const last = out[out.length - 1];
			if (last && last.role === role) last.parts.push(...parts);
			else out.push({ role, parts: [...parts] });
		};
		for (const m of messages) {
			if (m.role === 'user' || m.role === 'system') {
				push('user', typeof m.content === 'string'
					? [{ text: m.content || ' ' }]
					: m.content.map(p => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } })));
			} else if (m.role === 'assistant') {
				if (m.native && m.native.provider === this.config.id && m.native.model === model) {
					push('model', m.native.content as unknown[]);
				} else {
					const parts: unknown[] = [];
					const t = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('');
					if (t) parts.push({ text: t });
					for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.input } });
					push('model', parts.length ? parts : [{ text: ' ' }]);
				}
			} else if (m.role === 'tool') {
				const t = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('');
				push('user', [{ functionResponse: { name: m.toolName, response: m.isError ? { error: t } : { result: t } } }]);
			}
		}
		return out;
	}
}

/** Gemini accepts an OpenAPI subset; strip keywords it rejects. */
export function sanitizeSchema(s: JsonSchema): JsonSchema {
	const out: JsonSchema = {};
	for (const [k, v] of Object.entries(s)) {
		if (k === 'additionalProperties' || k === '$schema' || k === 'default' || k === 'examples' || k === '$ref') continue;
		if (k === 'properties' && v && typeof v === 'object') {
			out.properties = Object.fromEntries(Object.entries(v as Record<string, JsonSchema>).map(([pk, pv]) => [pk, sanitizeSchema(pv)]));
		} else if (k === 'items' && v && typeof v === 'object') {
			out.items = sanitizeSchema(v as JsonSchema);
		} else if (k === 'type' && Array.isArray(v)) {
			out.type = (v as string[]).find(t => t !== 'null') ?? 'string';
		} else {
			out[k] = v;
		}
	}
	return out;
}

/** Streaming splits text into many parts; collapse adjacent plain-text parts for replay. */
function mergeTextParts(parts: unknown[]): unknown[] {
	const out: any[] = [];
	for (const p of parts as any[]) {
		const last = out[out.length - 1];
		if (last && typeof last.text === 'string' && typeof p.text === 'string' && !last.thought && !p.thought && !p.thoughtSignature && Object.keys(p).length === 1 && Object.keys(last).length === 1) {
			last.text += p.text;
		} else out.push({ ...p });
	}
	return out;
}
