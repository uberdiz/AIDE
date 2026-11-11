/**
 * Usage tracking and limits. Stores daily rollups (small, kept forever) plus a
 * short tail of individual requests for the dashboard. Pure logic: the
 * extension layer persists `toJSON()` and asks the user when `check()` says so.
 */

export interface UsageEntry {
	ts: number;
	providerId: string;
	model: string;
	project: string;
	task: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
	exact: boolean;
	local?: boolean;
}

interface Rollup {
	date: string; // YYYY-MM-DD (local time)
	providerId: string;
	model: string;
	project: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** requests whose cost could not be computed (unknown pricing) */
	unpriced: number;
}

export interface LimitSet {
	tokens?: number;
	cost?: number;
}

export type LimitAction = 'stop' | 'ask' | 'switch-model' | 'switch-provider' | 'local' | 'reduce-context';

export interface LimitsConfig {
	daily: LimitSet;
	monthly: LimitSet;
	perRequestTokens?: number;
	providers: Record<string, { daily?: LimitSet; monthly?: LimitSet }>;
	/** fractions of a limit at which to warn, e.g. [0.8, 0.95] */
	warnAt: number[];
	onLimit: LimitAction;
}

export const DEFAULT_LIMITS: LimitsConfig = { daily: {}, monthly: {}, providers: {}, warnAt: [0.8, 0.95], onLimit: 'ask' };

export interface Totals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	unpriced: number;
}

export interface LimitCheck {
	status: 'ok' | 'warn' | 'exceeded';
	messages: string[];
	action?: LimitAction;
	/** the scope that tripped: 'global' or a provider id */
	scope?: string;
}

const emptyTotals = (): Totals => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });

export function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class UsageStore {
	private rollups = new Map<string, Rollup>();
	private recent: UsageEntry[] = [];
	private warned = new Set<string>();
	static readonly RECENT_MAX = 500;

	constructor(public limits: LimitsConfig = DEFAULT_LIMITS, private readonly now: () => number = Date.now) {}

	load(data: unknown): void {
		const d = data as { rollups?: Rollup[]; recent?: UsageEntry[] } | undefined;
		this.rollups.clear();
		for (const r of d?.rollups ?? []) this.rollups.set(rollKey(r), { ...r });
		this.recent = (d?.recent ?? []).slice(-UsageStore.RECENT_MAX);
	}

	toJSON(): { rollups: Rollup[]; recent: UsageEntry[] } {
		return { rollups: [...this.rollups.values()], recent: this.recent };
	}

	record(e: UsageEntry): void {
		const r: Rollup = { date: dayKey(e.ts), providerId: e.providerId, model: e.model, project: e.project, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
		const key = rollKey(r);
		const cur = this.rollups.get(key) ?? r;
		cur.requests++;
		cur.input += e.inputTokens;
		cur.output += e.outputTokens;
		cur.cacheRead += e.cacheReadTokens ?? 0;
		cur.cacheWrite += e.cacheWriteTokens ?? 0;
		if (e.cost === undefined) cur.unpriced++;
		else cur.cost += e.cost;
		this.rollups.set(key, cur);
		this.recent.push(e);
		if (this.recent.length > UsageStore.RECENT_MAX) this.recent.splice(0, this.recent.length - UsageStore.RECENT_MAX);
	}

	recentEntries(): readonly UsageEntry[] {
		return this.recent;
	}

	totals(period: 'day' | 'month' | 'all', filter: { providerId?: string; model?: string; project?: string } = {}): Totals {
		const today = dayKey(this.now());
		const month = today.slice(0, 7);
		const t = emptyTotals();
		for (const r of this.rollups.values()) {
			if (period === 'day' && r.date !== today) continue;
			if (period === 'month' && !r.date.startsWith(month)) continue;
			if (filter.providerId && r.providerId !== filter.providerId) continue;
			if (filter.model && r.model !== filter.model) continue;
			if (filter.project && r.project !== filter.project) continue;
			addInto(t, r);
		}
		return t;
	}

	/** Group totals by a dimension for a period. */
	breakdown(period: 'day' | 'month' | 'all', by: 'providerId' | 'model' | 'project'): { key: string; totals: Totals }[] {
		const today = dayKey(this.now());
		const month = today.slice(0, 7);
		const groups = new Map<string, Totals>();
		for (const r of this.rollups.values()) {
			if (period === 'day' && r.date !== today) continue;
			if (period === 'month' && !r.date.startsWith(month)) continue;
			const k = by === 'model' ? `${r.providerId}/${r.model}` : r[by];
			const t = groups.get(k) ?? emptyTotals();
			addInto(t, r);
			groups.set(k, t);
		}
		return [...groups.entries()].map(([key, totals]) => ({ key, totals })).sort((a, b) => b.totals.input + b.totals.output - (a.totals.input + a.totals.output));
	}

	/** Daily series for the last N days (oldest first). */
	daily(days = 30): { date: string; totals: Totals }[] {
		const out: { date: string; totals: Totals }[] = [];
		const now = this.now();
		for (let i = days - 1; i >= 0; i--) {
			const date = dayKey(now - i * 86_400_000);
			const t = emptyTotals();
			for (const r of this.rollups.values()) if (r.date === date) addInto(t, r);
			out.push({ date, totals: t });
		}
		return out;
	}

	/**
	 * Check a prospective request against limits. `estimatedTokens`/`estimatedCost`
	 * are added to current usage so the check blocks before a limit is crossed.
	 */
	check(providerId: string, estimatedTokens: number, estimatedCost: number | undefined, local = false): LimitCheck {
		const msgs: string[] = [];
		const state: { status: LimitCheck['status']; scope?: string } = { status: 'ok' };
		const L = this.limits;
		if (L.perRequestTokens && estimatedTokens > L.perRequestTokens) {
			return { status: 'exceeded', messages: [`Request is ~${estimatedTokens.toLocaleString()} tokens, above the per-request limit of ${L.perRequestTokens.toLocaleString()}.`], action: L.onLimit, scope: 'request' };
		}
		// Local models cost nothing; token limits still apply when configured per provider.
		const evaluate = (label: string, period: 'day' | 'month', lim: LimitSet | undefined, filter: { providerId?: string }, sc: string) => {
			if (!lim) return;
			const t = this.totals(period, filter);
			const usedTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
			const checks: [string, number, number | undefined][] = [
				['tokens', usedTokens + estimatedTokens, lim.tokens],
				['cost', t.cost + (local ? 0 : estimatedCost ?? 0), lim.cost],
			];
			for (const [kind, value, limit] of checks) {
				if (!limit || limit <= 0) continue;
				if (sc === 'global' && local && kind === 'cost') continue;
				const frac = value / limit;
				const pretty = kind === 'cost' ? `$${value.toFixed(2)} / $${limit.toFixed(2)}` : `${Math.round(value).toLocaleString()} / ${limit.toLocaleString()} tokens`;
				if (frac >= 1) {
					state.status = 'exceeded';
					state.scope = sc;
					msgs.push(`${label} ${kind} limit reached: ${pretty}`);
				} else {
					const threshold = [...L.warnAt].sort((a, b) => b - a).find(w => frac >= w);
					if (threshold !== undefined) {
						if (state.status === 'ok') state.status = 'warn';
						msgs.push(`${label} ${kind} at ${Math.round(frac * 100)}%: ${pretty}`);
					}
				}
			}
		};
		if (!local) {
			evaluate('Daily', 'day', L.daily, {}, 'global');
			evaluate('Monthly', 'month', L.monthly, {}, 'global');
		}
		const p = L.providers[providerId];
		if (p) {
			evaluate(`${providerId} daily`, 'day', p.daily, { providerId }, providerId);
			evaluate(`${providerId} monthly`, 'month', p.monthly, { providerId }, providerId);
		}
		return { status: state.status, messages: msgs, action: state.status === 'exceeded' ? L.onLimit : undefined, scope: state.scope };
	}

	/** Returns warning messages not yet shown today (dedup per message stem). */
	takeNewWarnings(check: LimitCheck): string[] {
		if (check.status !== 'warn') return [];
		const today = dayKey(this.now());
		const fresh: string[] = [];
		for (const m of check.messages) {
			const stem = `${today}:${m.replace(/[\d$.,/%]+/g, '#')}`;
			const pct = /at (\d+)%/.exec(m)?.[1];
			const key = `${stem}:${pct && Number(pct) >= 95 ? 'high' : 'low'}`;
			if (!this.warned.has(key)) {
				this.warned.add(key);
				fresh.push(m);
			}
		}
		return fresh;
	}
}

function rollKey(r: Pick<Rollup, 'date' | 'providerId' | 'model' | 'project'>): string {
	return `${r.date}|${r.providerId}|${r.model}|${r.project}`;
}

function addInto(t: Totals, r: Rollup): void {
	t.requests += r.requests;
	t.input += r.input;
	t.output += r.output;
	t.cacheRead += r.cacheRead;
	t.cacheWrite += r.cacheWrite;
	t.cost += r.cost;
	t.unpriced += r.unpriced;
}
