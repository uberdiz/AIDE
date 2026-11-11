import { AiClient, CancelledError, type ClientEvent } from '../ai/client';
import { compactHistory, SUMMARIZE_PROMPT } from '../ai/history';
import type { ChatMessage, ToolCall, Usage } from '../ai/types';
import { ProviderError, messageText } from '../ai/types';
import type { ChangeTracker } from '../changes/tracker';
import { quickCheckCommand } from '../tools/builtin';
import { coerceInput, validateInput, type ToolRegistry } from '../tools/registry';
import type { IdeServices, Tool, ToolContext, ToolResult } from '../tools/types';
import { ToolInputError } from '../tools/types';
import type { AgentDefinition } from './definitions';
import { dangerousCommand, type PermissionService } from './permissions';

export type AgentEvent =
	| { type: 'attempt'; ref: string; reason: string; retry: boolean }
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'step'; step: number }
	| { type: 'tool_start'; id: string; name: string; summary: string; input: Record<string, unknown> }
	| { type: 'tool_end'; id: string; name: string; content: string; isError: boolean; durationMs: number; denied?: boolean }
	| { type: 'tool_output'; id: string; text: string }
	/** the streamed text of the last model turn was really a tool call; remove it from the display */
	| { type: 'retract_text' }
	| { type: 'usage'; usage: Usage; cost?: number; ref: string; requestId: string }
	| { type: 'notice'; text: string; level: 'info' | 'warn' }
	| { type: 'checkpoint'; id: string; files: number }
	| { type: 'done'; status: AgentStatus; error?: string };

export type AgentStatus = 'completed' | 'cancelled' | 'error' | 'max_steps' | 'refusal';

export interface AgentRunInput {
	runId: string;
	agent: AgentDefinition;
	system: string;
	/** conversation so far, ending with the new user message */
	messages: ChatMessage[];
	root: string | undefined;
	signal: AbortSignal;
	manualModel?: string;
	historyBudget: number;
	verifyCommand?: string;
	onEvent: (e: AgentEvent) => void;
	contextBundle?: import('../ai/context/engine').ContextBundle;
	/** narrows the agent's tools (e.g. a core set for small local models) */
	toolFilter?: (t: Tool) => boolean;
}

export interface AgentRunResult {
	status: AgentStatus;
	/** messages produced by this run (assistant + tool turns) */
	messages: ChatMessage[];
	error?: string;
	checkpointId?: string;
	/** history after compaction, when compaction happened */
	compactedHistory?: ChatMessage[];
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file']);

/**
 * Provider-neutral agent loop: model turn -> tool calls (permission-gated,
 * validated, cancellable) -> tool results -> next turn, until the model answers
 * without tools, the step budget runs out, or the user cancels.
 */
export class AgentRunner {
	constructor(
		private readonly client: AiClient,
		private readonly tools: ToolRegistry,
		private readonly permissions: PermissionService,
		private readonly changes: ChangeTracker,
		private readonly ide: IdeServices,
		private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void,
		private readonly onToolEnd?: (name: string, isError: boolean, ms: number) => void,
	) {}

	async run(input: AgentRunInput): Promise<AgentRunResult> {
		const { agent, signal, onEvent } = input;
		const produced: ChatMessage[] = [];
		let history = [...input.messages];
		let compactedHistory: ChatMessage[] | undefined;
		let tools: Tool[] = input.root ? this.tools.select(agent.tools).filter(t => !input.toolFilter || input.toolFilter(t)) : [];
		const maxSteps = agent.maxSteps ?? 30;
		let wroteSinceVerify = false;
		let nudged = false;
		const written = new Set<string>();
		const failures = new Map<string, number>();
		let status: AgentStatus = 'completed';
		let error: string | undefined;
		this.changes.beginRun(input.runId, `${agent.name}: ${firstLine(messageText(input.messages[input.messages.length - 1]))}`);

		const ctx: ToolContext = {
			root: input.root ?? '',
			signal,
			runId: input.runId,
			agentId: agent.id,
			changes: this.changes,
			ide: this.ide,
			log: (l, m) => this.log(l, `[${agent.id}] ${m}`),
		};

		try {
			for (let step = 1; ; step++) {
				if (signal.aborted) throw new CancelledError();
				if (step > maxSteps) {
					status = 'max_steps';
					onEvent({ type: 'notice', level: 'warn', text: `Stopped after ${maxSteps} steps (agent step limit). Ask to continue if more work is needed.` });
					break;
				}
				onEvent({ type: 'step', step });

				const compacted = await compactHistory(history, input.historyBudget, text =>
					this.client.complete('summarize', SUMMARIZE_PROMPT, text, signal, 'history-compaction'),
				);
				if (compacted.compacted) {
					history = compacted.messages;
					compactedHistory = history;
					onEvent({ type: 'notice', level: 'info', text: compacted.summary ? 'Older conversation summarized to stay within the context budget.' : 'Older tool output compressed to stay within the context budget.' });
				}

				let result;
				try {
					result = await this.client.run({
						task: agent.task,
						source: `agent:${agent.id}`,
						manualModel: input.manualModel ?? agent.model,
						signal,
						context: step === 1 ? input.contextBundle : undefined,
						request: {
							system: input.system,
							messages: history,
							tools: this.tools.specs(tools),
							temperature: agent.temperature,
							reasoning: agent.reasoning,
							cacheHint: true,
						},
						onEvent: (e: ClientEvent) => {
							if (e.type === 'text' || e.type === 'thinking') onEvent(e);
							else if (e.type === 'attempt') onEvent(e);
						},
					});
				} catch (err) {
					if (tools.length && err instanceof ProviderError && err.provider === 'router' && /missing capability: tools/.test(err.message)) {
						tools = [];
						onEvent({ type: 'notice', level: 'warn', text: 'No configured model for this task supports tool calling - continuing as plain chat without tools.' });
						step--;
						continue;
					}
					throw err;
				}
				onEvent({ type: 'usage', usage: result.usage, cost: result.cost, ref: `${result.ref.providerId}/${result.ref.modelId}`, requestId: result.record.id });

				let assistant = result.message;
				if (!assistant.toolCalls?.length && tools.length) {
					// Some local models print the tool call as JSON text instead of using native tool calling.
					const recovered = recoverTextToolCalls(messageText(assistant), new Set([...tools.map(t => t.name), ...Object.keys(TOOL_ALIASES)]));
					if (recovered.length) {
						assistant = { role: 'assistant', content: '', toolCalls: recovered };
						onEvent({ type: 'retract_text' });
						this.log('debug', `[${agent.id}] recovered ${recovered.length} tool call(s) written as text`);
					}
				}
				if (assistant.toolCalls?.length) {
					const byName = new Map(tools.map(t => [t.name, t]));
					assistant = { ...assistant, toolCalls: assistant.toolCalls.map(c => normalizeToolCall(c, byName)) };
				}
				history.push(assistant);
				produced.push(assistant);

				if (result.stopReason === 'refusal') {
					status = 'refusal';
					onEvent({ type: 'notice', level: 'warn', text: 'The model declined this request.' });
					break;
				}
				const calls = assistant.toolCalls ?? [];
				if (!calls.length) {
					if (result.stopReason === 'max_tokens') onEvent({ type: 'notice', level: 'warn', text: 'The response hit the output token limit and may be truncated.' });
					// Only nudge with a real command: small models invent ones like "lint test calc".
					const check = input.verifyCommand ?? quickCheckCommand([...written]);
					const canRun = tools.some(t => t.name === 'run_command');
					if (agent.verify && wroteSinceVerify && !nudged && input.root && check && canRun) {
						nudged = true;
						const nudge: ChatMessage = {
							role: 'user',
							content: `[AIDE] You modified files but have not verified the result. Run \`${check}\` with run_command, fix any failures, then give your final summary.`,
						};
						history.push(nudge);
						produced.push(nudge);
						onEvent({ type: 'notice', level: 'info', text: 'Asking the agent to verify its changes before finishing.' });
						continue;
					}
					break;
				}
				if (result.stopReason === 'max_tokens') {
					// Tool input may be truncated: never execute it.
					for (const c of calls) {
						const msg: ChatMessage = { role: 'tool', toolCallId: c.id, toolName: c.name, content: 'Tool call was cut off by the output token limit and was not executed. Retry with a smaller input (e.g. several smaller edits).', isError: true };
						history.push(msg);
						produced.push(msg);
					}
					continue;
				}

				const results = await this.executeCalls(calls, tools, agent, ctx, onEvent);
				let stuck = false;
				for (const r of results) {
					if (r.message.isError) {
						// Repeating an identical failing call is a loop small models fall into.
						const sig = `${r.call.name}:${JSON.stringify(r.call.input)}`;
						const n = (failures.get(sig) ?? 0) + 1;
						failures.set(sig, n);
						if (n >= 2 && typeof r.message.content === 'string') r.message = { ...r.message, content: `${r.message.content}\n[AIDE] This exact call has now failed ${n} times. Do not repeat it; change the approach.` };
						if (n >= 3) stuck = true;
					}
					history.push(r.message);
					produced.push(r.message);
					if (WRITE_TOOLS.has(r.call.name) && !r.message.isError) {
						wroteSinceVerify = true;
						const p = r.call.input?.path ?? r.call.input?.to;
						if (typeof p === 'string') written.add(p.replace(/\\/g, '/').replace(/^\.\//, ''));
					}
					if (r.call.name === 'run_command' && !r.message.isError) wroteSinceVerify = false;
				}
				if (stuck) {
					status = 'error';
					error = 'The agent kept repeating the same failing action and was stopped. Try rephrasing the request or choosing a stronger model.';
					break;
				}
			}
		} catch (err) {
			if (err instanceof CancelledError || signal.aborted) {
				status = 'cancelled';
			} else {
				status = 'error';
				error = (err as Error)?.message ?? String(err);
				this.log('error', `Agent ${agent.id} failed: ${error}`);
			}
		}
		const cp = this.changes.endRun(input.runId);
		if (cp) onEvent({ type: 'checkpoint', id: cp.id, files: cp.files.length });
		onEvent({ type: 'done', status, error });
		return { status, messages: produced, error, checkpointId: cp?.id, compactedHistory };
	}

	private async executeCalls(calls: ToolCall[], tools: Tool[], agent: AgentDefinition, ctx: ToolContext, onEvent: (e: AgentEvent) => void): Promise<{ call: ToolCall; message: ChatMessage }[]> {
		const allowed = new Map(tools.map(t => [t.name, t]));
		const runOne = async (call: ToolCall): Promise<{ call: ToolCall; message: ChatMessage }> => {
			const started = Date.now();
			const tool = allowed.get(call.name);
			const finish = (r: ToolResult, denied = false) => {
				this.onToolEnd?.(call.name, !!r.isError, Date.now() - started);
				onEvent({ type: 'tool_end', id: call.id, name: call.name, content: r.content, isError: !!r.isError, durationMs: Date.now() - started, denied });
				return { call, message: { role: 'tool' as const, toolCallId: call.id, toolName: call.name, content: r.images?.length ? [{ type: 'text' as const, text: r.content }, ...r.images] : r.content, isError: r.isError } };
			};
			if (!tool) {
				onEvent({ type: 'tool_start', id: call.id, name: call.name, summary: call.name, input: call.input });
				return finish({ content: `Unknown or unavailable tool "${call.name}". Available: ${[...allowed.keys()].join(', ')}`, isError: true });
			}
			const input = coerceInput(call.input ?? {}, tool.inputSchema);
			let summary = call.name;
			try {
				summary = tool.describe?.(input) ?? call.name;
			} catch {
				/* describe is cosmetic */
			}
			onEvent({ type: 'tool_start', id: call.id, name: call.name, summary, input });
			const errs = validateInput(input, tool.inputSchema);
			if (errs.length) return finish({ content: `Invalid input: ${errs.join('; ')}`, isError: true });
			if (ctx.signal.aborted) return finish({ content: 'Cancelled', isError: true });

			let preview;
			if (!tool.readOnly && tool.preview) {
				try {
					preview = await tool.preview(input, ctx);
				} catch (e) {
					if (e instanceof ToolInputError) return finish({ content: e.message, isError: true });
				}
			}
			const dangerous = call.name === 'run_command' ? dangerousCommand(String(input.command ?? '')) : undefined;
			const decision = await this.permissions.check({ category: tool.category, toolName: tool.name, agentId: agent.id, summary, preview, dangerous }, agent.permissions);
			if (!decision.allowed) return finish({ content: `Permission denied (${decision.reason}). Do not retry this exact action; adjust the approach or ask the user.`, isError: true }, true);
			try {
				return finish(await tool.run(input, { ...ctx, progress: text => onEvent({ type: 'tool_output', id: call.id, text }) }));
			} catch (e) {
				if (ctx.signal.aborted) return finish({ content: 'Cancelled by user', isError: true });
				const msg = e instanceof ToolInputError ? e.message : `Tool failed: ${(e as Error)?.message ?? String(e)}`;
				if (!(e instanceof ToolInputError)) this.log('warn', `Tool ${call.name} threw: ${(e as Error)?.stack ?? e}`);
				return finish({ content: msg, isError: true });
			}
		};
		const allReadOnly = calls.every(c => allowed.get(c.name)?.readOnly);
		if (allReadOnly) return Promise.all(calls.map(runOne));
		const out: { call: ToolCall; message: ChatMessage }[] = [];
		for (const c of calls) {
			if (ctx.signal.aborted) {
				out.push({ call: c, message: { role: 'tool', toolCallId: c.id, toolName: c.name, content: 'Cancelled by user', isError: true } });
				continue;
			}
			out.push(await runOne(c));
		}
		return out;
	}
}

/**
 * Extract tool calls a model wrote as JSON text, e.g.
 *   {"name": "read_file", "parameters": {"path": "a.ts"}}
 * Only objects naming an offered tool are accepted; everything else is ignored.
 */
export function recoverTextToolCalls(text: string, toolNames: Set<string>): ToolCall[] {
	const calls: ToolCall[] = [];
	for (let i = text.indexOf('{'); i >= 0 && calls.length < 8; i = text.indexOf('{', i + 1)) {
		let depth = 0;
		let inStr = false;
		let end = -1;
		for (let j = i; j < text.length; j++) {
			const c = text[j];
			if (inStr) {
				if (c === '\\') j++;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === '{') depth++;
			else if (c === '}' && --depth === 0) {
				end = j;
				break;
			}
		}
		if (end < 0) break;
		try {
			const obj = JSON.parse(text.slice(i, end + 1));
			const name = obj?.name ?? obj?.function?.name ?? obj?.tool ?? (typeof obj?.function === 'string' ? obj.function : undefined);
			let input = obj?.parameters ?? obj?.arguments ?? obj?.input ?? obj?.function?.parameters ?? obj?.function?.arguments ?? {};
			if (typeof input === 'string') input = JSON.parse(input);
			if (typeof name === 'string' && toolNames.has(name) && input && typeof input === 'object') {
				calls.push({ id: `text_call_${Date.now().toString(36)}_${calls.length}`, name, input });
				i = end;
			}
		} catch {
			/* not JSON; keep scanning */
		}
	}
	return calls;
}

/** Names small models use for our tools. */
export const TOOL_ALIASES: Record<string, string> = {
	create_file: 'write_file', write: 'write_file', save_file: 'write_file', new_file: 'write_file', create: 'write_file',
	edit: 'edit_file', replace_in_file: 'edit_file', str_replace: 'edit_file', modify_file: 'edit_file', update_file: 'edit_file',
	read: 'read_file', open_file: 'read_file', view_file: 'read_file', cat: 'read_file', get_file: 'read_file',
	ls: 'list_dir', list_files: 'list_dir', list_directory: 'list_dir', dir: 'list_dir',
	run: 'run_command', execute: 'run_command', execute_command: 'run_command', shell: 'run_command', bash: 'run_command', powershell: 'run_command', terminal: 'run_command', run_terminal_command: 'run_command', run_shell_command: 'run_command',
	search: 'search_text', grep: 'search_text', find: 'find_files', glob: 'find_files',
};

const WRAPPER_KEYS = ['parameters', 'arguments', 'args', 'input', 'properties', 'params'];

/**
 * Repair tool calls from models that nest or mislabel arguments, e.g.
 *   read_file({"function": "read_file", "parameters": {"path": "a.py"}, "type": "function"})
 *   read_file({"parameters": {"command": "edit_file", "path": ..., "old_string": ...}})
 */
export function normalizeToolCall(call: ToolCall, tools: Map<string, Tool>): ToolCall {
	let name = tools.has(call.name) ? call.name : TOOL_ALIASES[call.name] ?? call.name;
	let input: Record<string, unknown> = call.input && typeof call.input === 'object' ? { ...call.input } : {};
	for (let depth = 0; depth < 4; depth++) {
		const props = tools.get(name)?.inputSchema.properties ?? {};
		const key = WRAPPER_KEYS.find(k => !(k in props) && input[k] !== undefined);
		if (!key) break;
		let inner = input[key];
		if (typeof inner === 'string') {
			try {
				inner = JSON.parse(inner);
			} catch {
				break;
			}
		}
		if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break;
		const rest = { ...input };
		delete rest[key];
		input = { ...rest, ...(inner as Record<string, unknown>) };
	}
	// A nested "function"/"command"/"name" that names another tool whose inputs are all present wins.
	for (const k of ['function', 'command', 'name', 'tool']) {
		const v = input[k];
		const target = typeof v === 'string' ? (tools.has(v) ? v : TOOL_ALIASES[v]) : undefined;
		if (!target || target === name || !tools.has(target)) continue;
		const t = tools.get(target)!;
		if ((t.inputSchema.required ?? []).every(r => r !== k && input[r] !== undefined)) {
			name = target;
			if (!(k in (t.inputSchema.properties ?? {}))) delete input[k];
			break;
		}
	}
	const props = tools.get(name)?.inputSchema.properties ?? {};
	for (const junk of ['type', 'function']) if (!(junk in props) && typeof input[junk] === 'string') delete input[junk];
	if (!('name' in props) && input.name === name) delete input.name;
	return { ...call, name, input };
}

function firstLine(s: string): string {
	const l = s.split('\n').find(x => x.trim()) ?? '';
	return l.length > 60 ? l.slice(0, 57) + '...' : l;
}
