import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as os from 'os';
import type { ChatMessage, ChatRequest, ModelInfo, Provider, ProviderConfig, StreamEvent } from '../types';
import { messageText, ProviderError } from '../types';

/**
 * Claude Code as a provider: AIDE (and SAINT on HalOS) use the person's Claude subscription through the `claude`
 * command, with no API key. Each request runs `claude -p <message> --output-format stream-json`; a conversation
 * keeps its Claude Code session (stored in the assistant turn's `native` field) and resumes it, so only the new
 * message is sent, never the whole history again.
 *
 * Claude Code runs its own tools (reading and editing files in the workspace) under its own permission mode;
 * they're shown in the reply as "▸ Edit foo.ts" lines, not handed to AIDE's tool loop.
 */
export const CLAUDE_CODE_MODELS: ModelInfo[] = [
	{ id: 'default', label: 'Claude Code (your plan\'s default model)', contextWindow: 200_000, capabilities: ['chat', 'reasoning'], inputPrice: 0, outputPrice: 0 },
	{ id: 'sonnet', label: 'Claude Code: Sonnet', contextWindow: 200_000, capabilities: ['chat', 'reasoning'], inputPrice: 0, outputPrice: 0 },
	{ id: 'opus', label: 'Claude Code: Opus', contextWindow: 200_000, capabilities: ['chat', 'reasoning'], inputPrice: 0, outputPrice: 0 },
];

/** Never bypassPermissions: "acceptEdits" lets Claude Code change files in the workspace and nothing else unasked. */
const MODES = new Set(['plan', 'acceptEdits', 'dontAsk', 'auto']);

type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/** Any of these makes Claude Code bill an API account instead of using the signed-in Claude subscription. */
export const API_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL'];

/** The environment for `claude`: without API-billing variables, unless the provider's options.allowApiKey is true. */
export function subscriptionEnv(env: NodeJS.ProcessEnv, allowApiKey = false): NodeJS.ProcessEnv {
	const out = { ...env };
	if (!allowApiKey) for (const v of API_VARS) delete out[v];
	return out;
}

export function describeTool(name: string, input: Record<string, unknown>): string {
	const file = String(input.file_path ?? input.path ?? '').split(/[\\/]/).pop() ?? '';
	switch (name) {
		case 'Bash': return `Run: ${String(input.description ?? input.command ?? '').split('\n')[0].slice(0, 90)}`;
		case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Edit ${file}`;
		case 'Write': return `Write ${file}`;
		case 'Read': return `Read ${file}`;
		case 'Grep': case 'Glob': return `Search for ${String(input.pattern ?? '').slice(0, 60)}`;
		case 'TodoWrite': return 'Update the plan';
		default: return name;
	}
}

/** The session to resume: the newest assistant turn this provider answered. */
export function sessionOf(messages: ChatMessage[], providerId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const n = messages[i].native;
		if (messages[i].role === 'assistant' && n?.provider === providerId) {
			const s = (n.content as { sessionId?: string } | undefined)?.sessionId;
			if (s) return s;
		}
	}
	return undefined;
}

/** What to send: with a session, only the user turns after its last answer; without, the whole conversation. */
export function promptFor(req: ChatRequest, resuming: boolean): string {
	const msgs = req.messages;
	if (resuming) {
		let i = msgs.length - 1;
		while (i >= 0 && msgs[i].role !== 'assistant') i--;
		return msgs.slice(i + 1).filter(m => m.role === 'user').map(messageText).join('\n\n');
	}
	const turns = msgs.filter(m => m.role === 'user' || m.role === 'assistant')
		.map(m => (msgs.length > 1 ? `${m.role === 'user' ? 'User' : 'Assistant'}: ` : '') + messageText(m));
	return turns.join('\n\n');
}

export class ClaudeCodeProvider implements Provider {
	constructor(
		readonly config: ProviderConfig,
		private readonly getCwd: () => string | undefined = () => undefined,
		private readonly spawn: Spawn = nodeSpawn as unknown as Spawn,
	) {}

	async listModels(): Promise<ModelInfo[]> {
		return CLAUDE_CODE_MODELS;
	}

	argv(req: ChatRequest, session: string | undefined): string[] {
		const mode = String(this.config.options?.permissionMode ?? 'acceptEdits');
		if (!MODES.has(mode)) throw new ProviderError(`Unsupported Claude Code permission mode "${mode}"`, this.config.id);
		const args = ['-p', promptFor(req, !!session), '--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
		if (req.system && !session) args.push('--append-system-prompt', req.system);
		if (session) args.push('--resume', session);
		if (req.model && req.model !== 'default') args.push('--model', req.model);
		return args;
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		const session = sessionOf(req.messages, this.config.id);
		const exe = String(this.config.options?.command ?? 'claude');
		const cwd = String(this.config.options?.cwd ?? this.getCwd() ?? os.homedir());
		let child: ChildProcess;
		try {
			child = this.spawn(exe, this.argv(req, session), { cwd, env: subscriptionEnv(process.env, this.config.options?.allowApiKey === true), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
		} catch (err) {
			throw new ProviderError(`Claude Code couldn't start: ${String(err)}`, this.config.id);
		}
		const abort = () => child.kill();
		signal.addEventListener('abort', abort);
		const queue: StreamEvent[] = [];
		let wake: (() => void) | undefined;
		let ended = false;
		let text = '';
		let sessionId = session;
		let stderr = '';
		let buf = '';
		const push = (e: StreamEvent) => { queue.push(e); wake?.(); };
		const handle = (line: string) => {
			let ev: any;
			try { ev = JSON.parse(line); } catch { return; }
			if (ev.type === 'system' && ev.subtype === 'init') sessionId = ev.session_id ?? sessionId;
			if (ev.type === 'assistant') {
				for (const b of ev.message?.content ?? []) {
					if (b.type === 'text' && b.text) { text += b.text; push({ type: 'text', text: b.text }); }
					else if (b.type === 'thinking' && b.thinking) push({ type: 'thinking', text: b.thinking });
					else if (b.type === 'tool_use') { const t = `\n▸ ${describeTool(b.name, b.input ?? {})}\n`; text += t; push({ type: 'text', text: t }); }
				}
			}
			if (ev.type === 'result') {
				sessionId = ev.session_id ?? sessionId;
				const u = ev.usage ?? {};
				push({ type: 'usage', usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens, exact: true } });
				if (ev.is_error) push({ type: 'text', text: `\n${ev.result || String(ev.subtype).replace(/_/g, ' ')}` });
			}
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => {
			buf += d;
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
		});
		child.stderr?.on('data', (d: Buffer | string) => { stderr += String(d); });
		const exited = new Promise<number>(resolve => {
			child.on('error', err => { stderr += String(err); resolve(127); });
			child.on('close', code => { if (buf.trim()) handle(buf); ended = true; wake?.(); resolve(code ?? 0); });
		});
		try {
			while (!ended || queue.length) {
				if (!queue.length) await new Promise<void>(r => (wake = r));
				wake = undefined;
				while (queue.length) yield queue.shift()!;
			}
			const code = await exited;
			if (signal.aborted) {
				yield { type: 'done', stopReason: 'cancelled', message: { role: 'assistant', content: text } };
				return;
			}
			if (code !== 0 && !text) {
				const low = stderr.toLowerCase();
				const why = low.includes('login') || low.includes('logged in') ? 'Claude Code isn\'t signed in: run `claude` once in a terminal and sign in.'
					: code === 127 || low.includes('enoent') ? 'Claude Code isn\'t installed (npm install -g @anthropic-ai/claude-code, or the SAINT Store on HalOS).'
					: stderr.trim().split('\n').pop() || `Claude Code stopped (code ${code}).`;
				throw new ProviderError(why, this.config.id, undefined, false);
			}
			yield {
				type: 'done',
				stopReason: 'end',
				message: { role: 'assistant', content: text, native: { provider: this.config.id, model: req.model, content: { sessionId } } },
			};
		} finally {
			signal.removeEventListener('abort', abort);
		}
	}
}
