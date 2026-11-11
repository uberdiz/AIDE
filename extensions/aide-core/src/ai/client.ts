import type { ContextBundle } from './context/engine';
import { formatModelRef, type ModelRef, type ProviderRegistry } from './providers/registry';
import type { RouteRequest, Router, Task } from './router';
import { costOf, estimateRequestTokens } from './tokens';
import type { ChatMessage, ChatRequest, ModelCapability, ModelInfo, StopReason, StreamEvent, Usage } from './types';
import { ProviderError } from './types';
import type { LimitCheck, UsageStore } from './usage';

export interface RequestRecord {
	id: string;
	ts: number;
	task: string;
	source: string;
	ref?: string;
	modelInfo?: ModelInfo;
	system?: string;
	messages: ChatMessage[];
	tools: string[];
	context?: { label: string; kind: string; tokens: number; reason: string; truncated?: boolean; deduped?: boolean }[];
	droppedContext?: { label: string; reason: string; tokens: number }[];
	estimatedInputTokens: number;
	maxTokens?: number;
	usage?: Usage;
	cost?: number;
	durationMs?: number;
	status: 'running' | 'ok' | 'error' | 'cancelled';
	error?: string;
	attempts: { ref: string; error?: string }[];
	rejected?: { ref: string; reason: string }[];
}

export type LimitDecision = 'proceed' | 'skip' | 'reduce' | 'stop';

export interface AiClientHooks {
	project(): string;
	/** Called when a limit is exceeded and the configured action is "ask". */
	askLimit(check: LimitCheck, ref: string): Promise<LimitDecision>;
	warn(messages: string[]): void;
	onRecord(record: RequestRecord): void;
	onUsageChanged(): void;
	log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
	defaultMaxTokens(task: Task): number;
}

export type ClientEvent = StreamEvent | { type: 'attempt'; ref: string; reason: string; retry: boolean };

export interface RunOptions {
	task: Task;
	source: string;
	request: Omit<ChatRequest, 'model'>;
	manualModel?: string;
	requires?: ModelCapability[];
	/** route only through the task's own rule (e.g. autocomplete must never fall back to a cloud model) */
	strictRoute?: boolean;
	signal: AbortSignal;
	context?: ContextBundle;
	/** Rebuild the request with less context (used by the "reduce-context" limit action). */
	reduceContext?: () => Promise<Omit<ChatRequest, 'model'>>;
	onEvent?: (e: ClientEvent) => void;
}

export interface RunResult {
	message: ChatMessage;
	stopReason: StopReason;
	usage: Usage;
	ref: ModelRef;
	cost?: number;
	record: RequestRecord;
}

export class LimitExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LimitExceededError';
	}
}

export class CancelledError extends Error {
	constructor() {
		super('Cancelled');
		this.name = 'CancelledError';
	}
}

let seq = 0;

/**
 * The single gateway for every model call in AIDE. Handles routing,
 * fallback, usage limits, usage accounting and the request log shown in the
 * Context Inspector.
 */
export class AiClient {
	constructor(
		private readonly providers: ProviderRegistry,
		private readonly router: Router,
		private readonly usage: UsageStore,
		private readonly hooks: AiClientHooks,
	) {}

	async run(opts: RunOptions): Promise<RunResult> {
		let request = opts.request;
		let estimate = estimateRequestTokens(request.system, request.messages, request.tools);
		const needs = new Set<ModelCapability>(opts.requires ?? []);
		if (request.tools?.length) needs.add('tools');
		if (request.messages.some(m => typeof m.content !== 'string' && m.content.some(p => p.type === 'image'))) needs.add('vision');

		const record: RequestRecord = {
			id: `req-${Date.now().toString(36)}-${++seq}`,
			ts: Date.now(),
			task: opts.task,
			source: opts.source,
			system: request.system,
			messages: request.messages,
			tools: (request.tools ?? []).map(t => t.name),
			context: opts.context?.items.map(i => ({ label: i.label, kind: i.kind, tokens: i.tokens, reason: i.reason, truncated: i.truncated, deduped: i.deduped })),
			droppedContext: opts.context?.dropped,
			estimatedInputTokens: estimate,
			status: 'running',
			attempts: [],
		};

		const routeReq: RouteRequest = { task: opts.task, manual: opts.manualModel, requires: [...needs], estimatedInputTokens: estimate, exclude: [], strict: opts.strictRoute };
		const { candidates, rejected } = this.router.route(routeReq);
		record.rejected = rejected;
		if (!candidates.length) {
			record.status = 'error';
			record.error = 'No model available for this task.';
			this.hooks.onRecord(record);
			const why = rejected.length ? ` Rejected: ${rejected.map(r => `${r.ref} (${r.reason})`).join('; ')}` : ' Configure a provider and a routing rule in AIDE Settings > AI.';
			throw new ProviderError(`No model available for task "${opts.task}".${why}`, 'router');
		}

		let skipProvider: string | undefined;
		let localOnly = false;
		let lastErr: unknown;
		for (const cand of candidates) {
			const refStr = formatModelRef(cand.ref);
			if (opts.signal.aborted) break;
			if (skipProvider && cand.ref.providerId === skipProvider) continue;
			const local = this.providers.isLocal(cand.ref.providerId) || !!cand.info?.local;
			if (localOnly && !local) continue;

			// Limits
			const maxTokens = Math.min(request.maxTokens ?? this.hooks.defaultMaxTokens(opts.task), cand.info?.maxOutput ?? Number.MAX_SAFE_INTEGER);
			const estCost = costOf(cand.info, { inputTokens: estimate, outputTokens: Math.min(maxTokens, 2000) });
			let check = this.usage.check(cand.ref.providerId, estimate, estCost, local);
			const warnings = this.usage.takeNewWarnings(check);
			if (warnings.length) this.hooks.warn(warnings);
			if (check.status === 'exceeded') {
				let decision: LimitDecision;
				switch (check.action) {
					case 'stop': decision = 'stop'; break;
					case 'switch-model': decision = 'skip'; break;
					case 'switch-provider': decision = 'skip'; skipProvider = cand.ref.providerId; break;
					case 'local': decision = local ? 'proceed' : 'skip'; localOnly = true; break;
					case 'reduce-context': decision = 'reduce'; break;
					default: decision = await this.hooks.askLimit(check, refStr);
				}
				if (decision === 'reduce' && opts.reduceContext) {
					request = await opts.reduceContext();
					estimate = estimateRequestTokens(request.system, request.messages, request.tools);
					record.estimatedInputTokens = estimate;
					check = this.usage.check(cand.ref.providerId, estimate, costOf(cand.info, { inputTokens: estimate, outputTokens: 2000 }), local);
					decision = check.status === 'exceeded' ? 'skip' : 'proceed';
					this.hooks.log('info', `Context reduced to ~${estimate} tokens to respect limits`);
				} else if (decision === 'reduce') decision = 'skip';
				if (decision === 'stop') {
					record.status = 'error';
					record.error = check.messages.join('; ');
					this.hooks.onRecord(record);
					throw new LimitExceededError(`Usage limit reached: ${check.messages.join('; ')}`);
				}
				if (decision === 'skip') {
					record.attempts.push({ ref: refStr, error: `skipped: ${check.messages.join('; ')}` });
					continue;
				}
			}

			for (let attempt = 0; attempt < 2; attempt++) {
				opts.onEvent?.({ type: 'attempt', ref: refStr, reason: cand.reason, retry: attempt > 0 || record.attempts.length > 0 });
				record.ref = refStr;
				record.modelInfo = cand.info;
				record.maxTokens = maxTokens;
				const started = Date.now();
				try {
					const result = await this.streamOnce(cand.ref, { ...request, model: cand.ref.modelId, maxTokens }, opts);
					const usage = result.usage ?? { inputTokens: estimate, outputTokens: estimateRequestTokens(undefined, [result.message]), exact: false };
					const cost = costOf(cand.info ?? (local ? { id: cand.ref.modelId, local: true } : undefined), usage);
					this.usage.record({
						ts: Date.now(),
						providerId: cand.ref.providerId,
						model: cand.ref.modelId,
						project: this.hooks.project(),
						task: String(opts.task),
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						cacheReadTokens: usage.cacheReadTokens,
						cacheWriteTokens: usage.cacheWriteTokens,
						cost,
						exact: usage.exact,
						local,
					});
					this.hooks.onUsageChanged();
					record.attempts.push({ ref: refStr });
					Object.assign(record, { usage, cost, durationMs: Date.now() - started, status: 'ok' as const });
					this.hooks.onRecord(record);
					return { message: result.message, stopReason: result.stopReason, usage, ref: cand.ref, cost, record };
				} catch (err) {
					lastErr = err;
					const msg = (err as Error)?.message ?? String(err);
					if (opts.signal.aborted) {
						record.status = 'cancelled';
						record.attempts.push({ ref: refStr, error: 'cancelled' });
						this.hooks.onRecord(record);
						throw new CancelledError();
					}
					record.attempts.push({ ref: refStr, error: msg });
					this.hooks.log('warn', `Model ${refStr} failed (${String(opts.task)}): ${msg}`);
					const retryable = err instanceof ProviderError && err.retryable;
					if (!retryable || attempt === 1) break;
					await sleep(800, opts.signal);
				}
			}
		}
		if (opts.signal.aborted) {
			record.status = 'cancelled';
			this.hooks.onRecord(record);
			throw new CancelledError();
		}
		record.status = 'error';
		record.error = (lastErr as Error)?.message ?? 'All candidate models were skipped';
		this.hooks.onRecord(record);
		if (lastErr) throw lastErr;
		throw new LimitExceededError(record.attempts.map(a => `${a.ref}: ${a.error}`).join('; ') || 'No model could run this request.');
	}

	private async streamOnce(ref: ModelRef, req: ChatRequest, opts: RunOptions): Promise<{ message: ChatMessage; stopReason: StopReason; usage?: Usage }> {
		const provider = await this.providers.get(ref.providerId);
		let message: ChatMessage | undefined;
		let stopReason: StopReason = 'end';
		let usage: Usage | undefined;
		for await (const ev of provider.chat(req, opts.signal)) {
			if (opts.signal.aborted) throw new CancelledError();
			if (ev.type === 'usage') usage = ev.usage;
			else if (ev.type === 'done') {
				message = ev.message;
				stopReason = ev.stopReason;
			}
			opts.onEvent?.(ev);
		}
		if (!message) throw new ProviderError(`${ref.providerId}: stream ended without a final message`, ref.providerId, undefined, true);
		return { message, stopReason, usage };
	}

	/** Convenience: single-shot text completion through the router. */
	async complete(task: Task, system: string, prompt: string, signal: AbortSignal, source = 'internal', manualModel?: string): Promise<string> {
		const r = await this.run({ task, source, manualModel, signal, request: { system, messages: [{ role: 'user', content: prompt }] } });
		return typeof r.message.content === 'string' ? r.message.content : r.message.content.map(p => (p.type === 'text' ? p.text : '')).join('');
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(t);
			resolve();
		}, { once: true });
	});
}
