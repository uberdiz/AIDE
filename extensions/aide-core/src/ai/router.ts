import type { ModelCapability, ModelInfo } from './types';
import { formatModelRef, parseModelRef, type ModelRef } from './providers/registry';

/** Task categories the router understands. Extensions may use any string. */
export const TASKS = [
	'chat', 'coding', 'planning', 'review', 'debug', 'explain', 'simple_edits',
	'autocomplete', 'commit_message', 'summarize', 'vision', 'embeddings', 'background',
] as const;
export type Task = (typeof TASKS)[number] | (string & {});

export type RoutingStrategy = 'rules' | 'local-first' | 'cloud-first' | 'cost' | 'capability';

export interface RoutingConfig {
	strategy: RoutingStrategy;
	/** task -> ordered model refs or aliases; first is primary, the rest are fallbacks */
	rules: Record<string, string | string[]>;
	/** used for tasks without a rule */
	default: string | string[];
	/** alias -> model ref, e.g. { "local_fast": "ollama/llama3.2:1b" } */
	aliases: Record<string, string>;
	/** allow falling back to any other configured model when all candidates fail */
	autoFallback: boolean;
}

export interface RouteRequest {
	task: Task;
	/** explicit model chosen by the user (overrides rules, still falls back if allowed) */
	manual?: string;
	requires?: ModelCapability[];
	estimatedInputTokens?: number;
	/** refs that already failed during this request */
	exclude?: string[];
	/** only the task's own rule (no related-task, default or auto-fallback routes) */
	strict?: boolean;
}

export interface RouteCandidate {
	ref: ModelRef;
	info: ModelInfo | undefined;
	reason: string;
}

export interface RouterEnv {
	providerExists(id: string): boolean;
	isLocal(providerId: string): boolean;
	modelInfo(ref: ModelRef): ModelInfo | undefined;
	/** Every model the user has configured or discovered, for auto-fallback. */
	knownModels(): ModelRef[];
	/** Returns a reason string when usage limits block this model. */
	blockedByLimits?(ref: ModelRef, estimatedInputTokens: number): string | undefined;
	/** Auto mode: models ranked for the task's role, used when the task has no explicit rule. */
	autoPick?(task: Task): { refs: string[]; reason: string };
}

/** Tasks that use another task's explicit rule before auto-selection (same role only). */
const TASK_FALLBACK: Record<string, string> = {
	simple_edits: 'coding',
	explain: 'chat',
	commit_message: 'background',
	summarize: 'background',
};

export class Router {
	constructor(private config: RoutingConfig, private readonly env: RouterEnv) {}

	setConfig(config: RoutingConfig): void {
		this.config = config;
	}

	getConfig(): RoutingConfig {
		return this.config;
	}

	resolveAlias(name: string): string {
		let cur = name;
		for (let i = 0; i < 5 && this.config.aliases[cur]; i++) cur = this.config.aliases[cur];
		return cur;
	}

	/** Candidate list for a task, best first, with rejected entries filtered out. */
	route(req: RouteRequest): { candidates: RouteCandidate[]; rejected: { ref: string; reason: string }[] } {
		const rejected: { ref: string; reason: string }[] = [];
		const ordered: { ref: string; reason: string }[] = [];
		const seen = new Set<string>();
		const add = (raw: string, reason: string) => {
			const ref = this.resolveAlias(raw.trim());
			if (!ref || seen.has(ref)) return;
			seen.add(ref);
			ordered.push({ ref, reason });
		};

		if (req.manual) add(req.manual, 'selected manually');
		if (req.strict) {
			for (const r of toList(this.config.rules[req.task])) add(r, `rule "${req.task}"`);
		} else {
			const rule = this.ruleFor(req.task);
			if (rule) for (const r of rule.refs) add(r, rule.source);
			else {
				const auto = this.env.autoPick?.(req.task);
				for (const r of auto?.refs ?? []) add(r, `auto (${auto!.reason})`);
				for (const r of toList(this.config.default)) add(r, 'default route');
			}
			if (this.config.autoFallback) for (const r of this.env.knownModels()) add(formatModelRef(r), 'auto-fallback');
		}

		let cands: RouteCandidate[] = [];
		for (const { ref, reason } of ordered) {
			const parsed = parseModelRef(ref);
			if (!parsed) {
				rejected.push({ ref, reason: 'not a provider/model reference (unknown alias?)' });
				continue;
			}
			if (!this.env.providerExists(parsed.providerId)) {
				rejected.push({ ref, reason: `provider "${parsed.providerId}" is not configured or disabled` });
				continue;
			}
			if (req.exclude?.includes(ref)) {
				rejected.push({ ref, reason: 'already failed for this request' });
				continue;
			}
			const info = this.env.modelInfo(parsed);
			const missing = (req.requires ?? []).filter(c => info?.capabilities && !info.capabilities.includes(c));
			if (missing.length) {
				rejected.push({ ref, reason: `missing capability: ${missing.join(', ')}` });
				continue;
			}
			if (req.estimatedInputTokens && info?.contextWindow && req.estimatedInputTokens > info.contextWindow * 0.95) {
				rejected.push({ ref, reason: `context too large (${req.estimatedInputTokens} > ${info.contextWindow})` });
				continue;
			}
			const blocked = this.env.blockedByLimits?.(parsed, req.estimatedInputTokens ?? 0);
			if (blocked) {
				rejected.push({ ref, reason: blocked });
				continue;
			}
			cands.push({ ref: parsed, info, reason });
		}

		// A manual choice stays first regardless of strategy; strategy orders the rest.
		const manual = req.manual ? cands.filter(c => formatModelRef(c.ref) === this.resolveAlias(req.manual!)) : [];
		const rest = cands.filter(c => !manual.includes(c));
		cands = [...manual, ...this.applyStrategy(rest, req)];
		return { candidates: cands, rejected };
	}

	/** The explicit rule for a task (or a same-role task), if the user set one. */
	ruleFor(task: Task): { refs: string[]; source: string } | undefined {
		let t: string | undefined = task;
		const visited = new Set<string>();
		while (t && !visited.has(t)) {
			visited.add(t);
			const refs = toList(this.config.rules[t]);
			if (refs.length) return { refs, source: t === task ? `rule "${task}"` : `rule "${t}" (via ${task})` };
			t = TASK_FALLBACK[t];
		}
		return undefined;
	}

	private applyStrategy(cands: RouteCandidate[], req: RouteRequest): RouteCandidate[] {
		const stable = (fn: (a: RouteCandidate, b: RouteCandidate) => number) =>
			cands.map((c, i) => ({ c, i })).sort((a, b) => fn(a.c, b.c) || a.i - b.i).map(x => x.c);
		const local = (c: RouteCandidate) => (this.env.isLocal(c.ref.providerId) || c.info?.local ? 1 : 0);
		switch (this.config.strategy) {
			case 'local-first':
				return stable((a, b) => local(b) - local(a));
			case 'cloud-first':
				return stable((a, b) => local(a) - local(b));
			case 'cost': {
				const est = req.estimatedInputTokens ?? 2000;
				const price = (c: RouteCandidate) => {
					if (local(c)) return 0;
					const i = c.info?.inputPrice;
					const o = c.info?.outputPrice;
					return i === undefined || o === undefined ? Number.MAX_SAFE_INTEGER : est * i + 1000 * o;
				};
				return stable((a, b) => price(a) - price(b));
			}
			case 'capability': {
				const score = (c: RouteCandidate) =>
					(c.info?.capabilities?.includes('reasoning') ? 2 : 0) + (c.info?.capabilities?.includes('tools') ? 1 : 0) + Math.log10((c.info?.contextWindow ?? 8000) / 1000);
				return stable((a, b) => score(b) - score(a));
			}
			default:
				return cands;
		}
	}
}

function toList(v: string | string[] | undefined): string[] {
	if (!v) return [];
	return (Array.isArray(v) ? v : [v]).map(s => s.trim()).filter(Boolean);
}

/** Cheap heuristic task classification for free-form chat input. */
export function classifyTask(prompt: string, opts: { hasImages?: boolean; agentMode?: string } = {}): Task {
	if (opts.hasImages) return 'vision';
	if (opts.agentMode === 'coder' || opts.agentMode === 'tester' || opts.agentMode === 'debugger') return opts.agentMode === 'debugger' ? 'debug' : 'coding';
	if (opts.agentMode === 'planner') return 'planning';
	if (opts.agentMode === 'reviewer') return 'review';
	const p = prompt.toLowerCase();
	if (/\b(plan|architect|design|roadmap|strategy)\b/.test(p)) return 'planning';
	if (/\b(review|audit|security issues?)\b/.test(p)) return 'review';
	if (/\b(why does|crash|stack ?trace|exception|error|debug|fails?|failing)\b/.test(p)) return 'debug';
	if (/\b(explain|what does|how does|what is)\b/.test(p)) return 'explain';
	if (/\b(implement|refactor|write|add|create|fix|change|update|rename|generate)\b/.test(p)) return 'coding';
	return 'chat';
}
