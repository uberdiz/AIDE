import { describe, expect, it } from 'vitest';
import { costOf, estimateTokens, formatCost } from '../../src/ai/tokens';
import { UsageStore, type UsageEntry } from '../../src/ai/usage';

const NOW = new Date('2026-09-29T12:00:00').getTime();
const entry = (p: Partial<UsageEntry> = {}): UsageEntry => ({
	ts: NOW, providerId: 'anthropic', model: 'claude-opus-5-5', project: 'aide', task: 'chat', inputTokens: 1000, outputTokens: 500, cost: 0.5, exact: true, ...p,
});

describe('UsageStore', () => {
	it('aggregates by day, month, provider, model, project', () => {
		const u = new UsageStore(undefined, () => NOW);
		u.record(entry());
		u.record(entry({ providerId: 'ollama', model: 'llama3.1', cost: 0, local: true }));
		u.record(entry({ ts: NOW - 5 * 86_400_000, project: 'other' }));
		u.record(entry({ ts: NOW - 40 * 86_400_000 }));
		expect(u.totals('day').requests).toBe(2);
		expect(u.totals('month').requests).toBe(3);
		expect(u.totals('all').requests).toBe(4);
		expect(u.totals('day', { providerId: 'anthropic' }).cost).toBeCloseTo(0.5);
		expect(u.breakdown('month', 'project').map(b => b.key).sort()).toEqual(['aide', 'other']);
		expect(u.daily(7)).toHaveLength(7);
		expect(u.daily(7).at(-1)!.totals.requests).toBe(2);
	});

	it('round-trips through JSON', () => {
		const u = new UsageStore(undefined, () => NOW);
		u.record(entry());
		const v = new UsageStore(undefined, () => NOW);
		v.load(JSON.parse(JSON.stringify(u.toJSON())));
		expect(v.totals('day').input).toBe(1000);
		expect(v.recentEntries()).toHaveLength(1);
	});

	it('warns before and blocks at limits, and dedupes warnings', () => {
		const u = new UsageStore({ daily: { cost: 5 }, monthly: { cost: 50 }, providers: {}, warnAt: [0.8], onLimit: 'ask' }, () => NOW);
		for (let i = 0; i < 7; i++) u.record(entry({ cost: 0.6 })); // $4.20
		const warn = u.check('anthropic', 1000, 0.01);
		expect(warn.status).toBe('warn');
		expect(warn.messages[0]).toMatch(/Daily cost at 84%/);
		expect(u.takeNewWarnings(warn)).toHaveLength(1);
		expect(u.takeNewWarnings(u.check('anthropic', 1000, 0.01))).toHaveLength(0);
		const over = u.check('anthropic', 1000, 1);
		expect(over.status).toBe('exceeded');
		expect(over.action).toBe('ask');
		// local models are not subject to global cost limits
		expect(u.check('ollama', 1000, 0, true).status).toBe('ok');
	});

	it('enforces per-request and per-provider token limits', () => {
		const u = new UsageStore({ daily: {}, monthly: {}, perRequestTokens: 5000, providers: { ollama: { daily: { tokens: 2000 } } }, warnAt: [0.9], onLimit: 'local' }, () => NOW);
		expect(u.check('anthropic', 6000, 0).status).toBe('exceeded');
		u.record(entry({ providerId: 'ollama', inputTokens: 1500, outputTokens: 0, cost: 0 }));
		expect(u.check('ollama', 600, 0, true).status).toBe('exceeded');
		expect(u.check('ollama', 100, 0, true).status).toBe('ok');
	});
});

describe('tokens', () => {
	it('estimates in a plausible range', () => {
		const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
		expect(estimateTokens(prose)).toBeGreaterThan(900);
		expect(estimateTokens(prose)).toBeLessThan(1400);
		const code = 'function f(a, b) { return a[b] + (c * 2); }\n'.repeat(100);
		expect(estimateTokens(code)).toBeGreaterThan(estimateTokens(prose) * 0.9);
		expect(estimateTokens('')).toBe(0);
	});

	it('computes cost and handles unknown prices', () => {
		expect(costOf({ id: 'm', inputPrice: 4, outputPrice: 20 }, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(6);
		expect(costOf({ id: 'm', local: true }, { inputTokens: 5, outputTokens: 5 })).toBe(0);
		expect(costOf({ id: 'm' }, { inputTokens: 5, outputTokens: 5 })).toBeUndefined();
		expect(formatCost(undefined)).toBe('n/a');
		expect(formatCost(3.8212)).toBe('$3.82');
	});
});
