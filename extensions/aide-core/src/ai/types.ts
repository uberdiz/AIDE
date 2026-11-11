/**
 * Provider-neutral AI types. Every provider adapter translates between these
 * shapes and its own wire format, so the rest of AIDE (router, agents, UI)
 * never depends on a specific vendor.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image'; mediaType: string; data: string /* base64 */ }
export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ChatMessage {
	role: Role;
	content: string | ContentPart[];
	/** Assistant turns: tool calls requested by the model. */
	toolCalls?: ToolCall[];
	/** Tool turns: which call this result answers. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/**
	 * Opaque provider-native payload of an assistant turn (e.g. Anthropic content
	 * blocks including thinking blocks). Replayed verbatim when the next request
	 * goes to the same provider+model, ignored otherwise.
	 */
	native?: { provider: string; model: string; content: unknown };
}

/** JSON-schema subset used for tool inputs. */
export interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	description?: string;
	additionalProperties?: boolean | JsonSchema;
	[k: string]: unknown;
}

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: JsonSchema;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
	model: string;
	system?: string;
	messages: ChatMessage[];
	tools?: ToolSpec[];
	temperature?: number;
	maxTokens?: number;
	reasoning?: ReasoningEffort;
	/** Hint that a stable prefix (system + tools + early turns) may be cached. */
	cacheHint?: boolean;
	stop?: string[];
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** true when the numbers came from the provider rather than an estimate */
	exact: boolean;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'stop' | 'error' | 'cancelled';

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_call'; call: ToolCall }
	| { type: 'usage'; usage: Usage }
	| { type: 'done'; stopReason: StopReason; message: ChatMessage };

export interface ModelInfo {
	id: string;
	label?: string;
	contextWindow?: number;
	maxOutput?: number;
	capabilities?: ModelCapability[];
	/** USD per 1M tokens */
	inputPrice?: number;
	outputPrice?: number;
	cacheReadPrice?: number;
	local?: boolean;
}

export type ModelCapability = 'chat' | 'tools' | 'vision' | 'embeddings' | 'reasoning' | 'completion';

export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible' | 'ollama' | 'gemini';

export interface ProviderConfig {
	id: string;
	kind: ProviderKind;
	label?: string;
	baseUrl?: string;
	enabled?: boolean;
	/** Static model list / overrides merged over discovered models. */
	models?: ModelInfo[];
	/** Extra HTTP headers (never put secrets here; use the key store). */
	headers?: Record<string, string>;
	/** Mark all models of this provider as local (no network egress, zero cost). */
	local?: boolean;
	/** Provider-specific options (e.g. Ollama `num_ctx`, `keep_alive`). */
	options?: Record<string, unknown>;
}

export interface Provider {
	readonly config: ProviderConfig;
	listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
	chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
	embed?(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]>;
	/** Optional runtime info for local servers (VRAM, loaded models...). */
	runtimeInfo?(signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly provider: string,
		readonly status?: number,
		readonly retryable = false,
	) {
		super(message);
		this.name = 'ProviderError';
	}
}

export function messageText(m: ChatMessage): string {
	if (typeof m.content === 'string') return m.content;
	return m.content.filter((p): p is TextPart => p.type === 'text').map(p => p.text).join('');
}
