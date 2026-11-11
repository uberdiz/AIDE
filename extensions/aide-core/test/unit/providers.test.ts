import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../src/ai/providers/anthropic';
import { GeminiProvider, sanitizeSchema } from '../../src/ai/providers/gemini';
import { OllamaProvider } from '../../src/ai/providers/ollama';
import { OpenAICompatibleProvider } from '../../src/ai/providers/openai';
import type { ChatRequest, Provider, StreamEvent } from '../../src/ai/types';

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;
let handler: Handler = () => undefined;
let base = '';
const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
const server = http.createServer((req, res) => {
	let data = '';
	req.on('data', c => (data += c));
	req.on('end', () => {
		const body = data ? JSON.parse(data) : undefined;
		seen.push({ url: req.url!, headers: req.headers, body });
		handler(req, body, res);
	});
});
beforeAll(async () => {
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const sse = (res: http.ServerResponse, events: ({ event?: string; data: unknown } | string)[]) => {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const e of events) {
		if (typeof e === 'string') res.write(`data: ${e}\n\n`);
		else res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`);
	}
	res.end();
};

async function collect(p: Provider, req: ChatRequest) {
	const events: StreamEvent[] = [];
	for await (const e of p.chat(req, new AbortController().signal)) events.push(e);
	const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
	const thinking = events.filter(e => e.type === 'thinking').map(e => (e as { text: string }).text).join('');
	const calls = events.filter(e => e.type === 'tool_call').map(e => (e as any).call);
	const usage = (events.find(e => e.type === 'usage') as any)?.usage;
	const done = events.find(e => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
	return { text, thinking, calls, usage, done };
}

const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }];

describe('OpenAI-compatible provider', () => {
	it('streams text and assembles fragmented tool calls', async () => {
		handler = (_req, _body, res) => sse(res, [
			JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
			JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
			JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] }),
			JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] }),
			JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }),
			'[DONE]',
		]);
		const p = new OpenAICompatibleProvider({ id: 'oai', kind: 'openai-compatible', baseUrl: base + '/v1' }, 'sk-test');
		const r = await collect(p, { model: 'gpt-x', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, maxTokens: 100 });
		expect(r.text).toBe('Hello');
		expect(r.calls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
		expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 5 });
		expect(r.done.stopReason).toBe('tool_use');
		const req = seen.at(-1)!;
		expect(req.url).toBe('/v1/chat/completions');
		expect(req.headers.authorization).toBe('Bearer sk-test');
		expect(req.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
		expect(req.body.tools[0].function.name).toBe('read_file');
	});

	it('maps tool history to the wire format and reports HTTP errors', async () => {
		handler = (_req, _body, res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'bad key' } }));
		};
		const p = new OpenAICompatibleProvider({ id: 'oai', kind: 'openai-compatible', baseUrl: base + '/v1' }, 'x');
		await expect(collect(p, {
			model: 'm',
			messages: [
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a' } }] },
				{ role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'data' },
			],
		})).rejects.toThrow(/HTTP 401.*check the API key.*bad key/);
		const msgs = seen.at(-1)!.body.messages;
		expect(msgs[1].tool_calls[0]).toEqual({ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } });
		expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'data' });
	});
});

describe('Ollama provider', () => {
	it('streams NDJSON with tool calls and usage', async () => {
		handler = (req, _body, res) => {
			if (req.url === '/api/tags') {
				res.end(JSON.stringify({ models: [{ name: 'llama3.1:latest', details: { parameter_size: '8B', context_length: 131072 }, capabilities: ['completion', 'tools'] }] }));
				return;
			}
			res.writeHead(200, { 'content-type': 'application/x-ndjson' });
			res.write(JSON.stringify({ message: { role: 'assistant', content: 'Let me ' } }) + '\n');
			res.write(JSON.stringify({ message: { role: 'assistant', content: 'check.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'x.py' } } }] } }) + '\n');
			res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 7, eval_duration: 700_000_000 }) + '\n');
		};
		const p = new OllamaProvider({ id: 'ollama', kind: 'ollama', baseUrl: base });
		const models = await p.listModels();
		expect(models[0]).toMatchObject({ id: 'llama3.1:latest', local: true, contextWindow: 131072 });
		expect(models[0].capabilities).toContain('tools');
		const r = await collect(p, { model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }], tools });
		expect(r.text).toBe('Let me check.');
		expect(r.calls[0]).toMatchObject({ name: 'read_file', input: { path: 'x.py' } });
		expect(r.usage).toMatchObject({ inputTokens: 30, outputTokens: 7 });
		expect(seen.at(-1)!.body.options.num_ctx).toBe(16384);
	});
});

describe('Gemini provider', () => {
	it('streams SSE, parses function calls, sends key as header, sanitizes schemas', async () => {
		handler = (_req, _body, res) => sse(res, [
			{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }] } }] } },
			{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Sure' }] } }] } },
			{ data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'b.ts' } }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 } } },
		]);
		const p = new GeminiProvider({ id: 'gemini', kind: 'gemini', baseUrl: base + '/v1beta' }, 'g-key');
		const r = await collect(p, { model: 'gemini-x', system: 's', messages: [{ role: 'user', content: 'hi' }], tools });
		expect(r.thinking).toBe('thinking...');
		expect(r.text).toBe('Sure');
		expect(r.calls[0]).toMatchObject({ name: 'read_file', input: { path: 'b.ts' } });
		expect(r.usage).toMatchObject({ inputTokens: 20, outputTokens: 4 });
		const req = seen.at(-1)!;
		expect(req.url).toBe('/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
		expect(req.headers['x-goog-api-key']).toBe('g-key');
		expect(req.url).not.toContain('g-key');
		expect(req.body.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
		// native parts (with thought signature) are kept for replay
		expect(JSON.stringify(r.done.message.native)).toContain('sig');
		expect(sanitizeSchema({ type: ['string', 'null'] }).type).toBe('string');
	});
});

describe('Anthropic provider (official SDK against a mock server)', () => {
	it('streams thinking, text and tool_use; maps usage and stop reason; replays native content', async () => {
		handler = (_req, _body, res) => sse(res, [
			{ event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } } },
			{ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
			{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Consider files.' } } },
			{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sigA' } } },
			{ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
			{ event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
			{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading it.' } } },
			{ event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
			{ event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } } },
			{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path": "src/' } } },
			{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'x.ts"}' } } },
			{ event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
			{ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } } },
			{ event: 'message_stop', data: { type: 'message_stop' } },
		]);
		const p = new AnthropicProvider({ id: 'anthropic', kind: 'anthropic', baseUrl: base }, 'sk-ant-test');
		const r = await collect(p, { model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, cacheHint: true, reasoning: 'high' });
		expect(r.thinking).toBe('Consider files.');
		expect(r.text).toBe('Reading it.');
		expect(r.calls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'src/x.ts' } }]);
		expect(r.usage).toMatchObject({ inputTokens: 50, outputTokens: 42, cacheReadTokens: 10 });
		expect(r.done.stopReason).toBe('tool_use');
		const req = seen.at(-1)!;
		expect(req.headers['x-api-key']).toBe('sk-ant-test');
		expect(req.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
		expect(req.body.output_config).toEqual({ effort: 'high' });
		expect(req.body.temperature).toBeUndefined();
		expect(req.body.cache_control).toEqual({ type: 'ephemeral' });
		expect(req.body.tools[0]).toMatchObject({ name: 'read_file', eager_input_streaming: true });

		// Next turn: native content (with the thinking block) is replayed; tool results grouped in one user turn.
		handler = (_req, _body, res) => sse(res, [
			{ event: 'message_start', data: { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 80, output_tokens: 1 } } } },
			{ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
			{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } },
			{ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
			{ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } } },
			{ event: 'message_stop', data: { type: 'message_stop' } },
		]);
		const r2 = await collect(p, {
			model: 'claude-opus-5-5',
			messages: [{ role: 'user', content: 'hi' }, r.done.message, { role: 'tool', toolCallId: 'toolu_1', toolName: 'read_file', content: 'file body' }],
		});
		expect(r2.text).toBe('Done.');
		expect(r2.done.stopReason).toBe('end');
		const wire = seen.at(-1)!.body.messages;
		expect(wire[1].content[0]).toMatchObject({ type: 'thinking', thinking: 'Consider files.', signature: 'sigA' });
		expect(wire[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }] });
	});

	it('maps authentication errors', async () => {
		handler = (_req, _body, res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
		};
		const p = new AnthropicProvider({ id: 'anthropic', kind: 'anthropic', baseUrl: base }, 'bad');
		await expect(collect(p, { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/authentication failed/);
	});
});

// Live test against a local Ollama server when available (skipped otherwise).
const ollamaUp = await fetch('http://localhost:11434/api/tags').then(r => r.ok).catch(() => false);
// Prefer the largest tool-capable model: tiny models are too unreliable for assertions.
const liveModel = ollamaUp
	? ((await (await fetch('http://localhost:11434/api/tags')).json()) as { models: { name: string; size: number; capabilities?: string[] }[] }).models
		.filter(m => m.capabilities?.includes('tools'))
		.sort((a, b) => b.size - a.size)[0]?.name
	: undefined;

describe.skipIf(!liveModel)('live Ollama', () => {
	it(`streams a real completion and a real tool call from ${liveModel}`, async () => {
		const p = new OllamaProvider({ id: 'ollama', kind: 'ollama' });
		const r = await collect(p, { model: liveModel!, messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }], maxTokens: 20, temperature: 0 });
		expect(r.text.toLowerCase()).toContain('pong');
		expect(r.usage.outputTokens).toBeGreaterThan(0);
		const t = await collect(p, {
			model: liveModel!,
			system: 'You are a coding agent. Use the tools to answer.',
			messages: [{ role: 'user', content: 'Read the file named config.json using the read_file tool.' }],
			tools,
			temperature: 0,
		});
		expect(t.calls.length).toBeGreaterThan(0);
		expect(t.calls[0].name).toBe('read_file');
		expect(String(t.calls[0].input.path)).toContain('config.json');
	}, 180_000);
});
