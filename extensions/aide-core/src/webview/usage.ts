import { button, fmtCost, fmtTokens, h, icon, post } from './common';

const app = document.getElementById('app')!;

function tok(t: any): number {
	return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function stat(label: string, value: string, sub?: string, frac?: number): HTMLElement {
	const el = h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : undefined);
	if (frac !== undefined) {
		const pct = Math.min(100, Math.round(frac * 100));
		const fill = h('div');
		fill.style.width = `${pct}%`;
		el.append(h('div', { class: `meter ${frac >= 1 ? 'over' : frac >= 0.8 ? 'warn' : ''}` }, fill));
	}
	return el;
}

function table(headers: string[], rows: (string | HTMLElement)[][], numeric: number[] = []): HTMLElement {
	const t = h('table', { class: 'data' }, h('tr', {}, ...headers.map((x, i) => h('th', { class: numeric.includes(i) ? 'num' : '' }, x))));
	for (const r of rows) t.append(h('tr', {}, ...r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : '' }, c))));
	return t;
}

function render(d: any): void {
	const L = d.limits;
	const todayTok = tok(d.today);
	const monthTok = tok(d.month);
	const page = h('div', { class: 'page' }, h('h1', {}, 'Usage & Diagnostics'), h('p', { class: 'lead' }, 'Token usage, cost and limits across providers, plus AIDE health: requests, tool calls, MCP servers and recent warnings.'));

	const stats = h('div', { class: 'stats' });
	stats.append(
		stat('Today - cost', fmtCost(d.today.cost), L.daily.cost ? `of $${L.daily.cost.toFixed(2)} daily limit` : 'no daily cost limit', L.daily.cost ? d.today.cost / L.daily.cost : undefined),
		stat('Today - tokens', fmtTokens(todayTok), L.daily.tokens ? `of ${fmtTokens(L.daily.tokens)} daily limit` : `${d.today.requests} requests`, L.daily.tokens ? todayTok / L.daily.tokens : undefined),
		stat('This month - cost', fmtCost(d.month.cost), L.monthly.cost ? `of $${L.monthly.cost.toFixed(2)} monthly limit` : 'no monthly cost limit', L.monthly.cost ? d.month.cost / L.monthly.cost : undefined),
		stat('This month - tokens', fmtTokens(monthTok), L.monthly.tokens ? `of ${fmtTokens(L.monthly.tokens)}` : `${d.month.requests} requests`, L.monthly.tokens ? monthTok / L.monthly.tokens : undefined),
		stat('Cache reads (month)', fmtTokens(d.month.cacheRead), 'tokens served from prompt cache'),
		stat('All time', fmtCost(d.all.cost), `${fmtTokens(tok(d.all))} tokens · ${d.all.requests} requests${d.all.unpriced ? ` · ${d.all.unpriced} unpriced` : ''}`),
	);
	page.append(stats);
	for (const [pid, pl] of Object.entries<any>(L.providers ?? {})) {
		const p = d.byProvider.find((b: any) => b.key === pid);
		if (pl.daily?.cost || pl.monthly?.cost) page.append(h('div', { class: 'help' }, `${pid}: month ${fmtCost(p?.totals.cost ?? 0)}${pl.monthly?.cost ? ` / $${pl.monthly.cost}` : ''}`));
	}

	page.append(h('h2', {}, 'Last 30 days'));
	const max = Math.max(1, ...d.daily.map((x: any) => tok(x.totals)));
	const bars = h('div', { class: 'bars' });
	for (const day of d.daily) {
		const b = h('div', { class: 'bar', title: `${day.date}: ${fmtTokens(tok(day.totals))} tokens · ${fmtCost(day.totals.cost)} · ${day.totals.requests} requests` });
		b.style.height = `${Math.max(1, (tok(day.totals) / max) * 100)}%`;
		bars.append(b);
	}
	page.append(bars, h('div', { class: 'row muted' }, h('span', {}, d.daily[0]?.date ?? ''), h('div', { class: 'spacer' }), h('span', {}, d.daily[d.daily.length - 1]?.date ?? '')));

	const breakdown = (title: string, rows: any[]) => {
		page.append(h('h3', {}, title));
		page.append(rows.length ? table(['', 'Requests', 'Input', 'Output', 'Cache read', 'Cost'], rows.map(r => [r.key, String(r.totals.requests), fmtTokens(r.totals.input), fmtTokens(r.totals.output), fmtTokens(r.totals.cacheRead), fmtCost(r.totals.cost) + (r.totals.unpriced ? ' *' : '')]), [1, 2, 3, 4, 5]) : h('p', { class: 'muted' }, 'No usage this month.'));
	};
	page.append(h('h2', {}, 'This month'));
	breakdown('By provider', d.byProvider);
	breakdown('By model', d.byModel);
	breakdown('By project', d.byProject);
	page.append(h('div', { class: 'help' }, '* some requests used models with unknown pricing; set prices in aide.providers[].models.'));

	page.append(h('h2', {}, 'Recent requests'));
	page.append(d.recent.length ? table(['Time', 'Task', 'Model', 'Input', 'Output', 'Cost'], d.recent.map((e: any) => [new Date(e.ts).toLocaleTimeString(), e.task, `${e.providerId}/${e.model}`, fmtTokens(e.inputTokens + (e.cacheReadTokens ?? 0)), fmtTokens(e.outputTokens), fmtCost(e.cost) + (e.exact ? '' : ' ~')]), [3, 4, 5]) : h('p', { class: 'muted' }, 'No requests yet.'));

	page.append(h('h2', {}, 'Diagnostics'));
	page.append(h('div', { class: 'stats' }, stat('Requests (this session)', String(d.requests.total), `${d.requests.errors} failed · ${d.requests.cancelled} cancelled`), stat('Tool calls', String(d.tools.reduce((n: number, t: any) => n + t.calls, 0)), `${d.tools.reduce((n: number, t: any) => n + t.errors, 0)} returned errors`)));
	if (d.tools.length) page.append(table(['Tool', 'Calls', 'Errors', 'Avg time'], d.tools.map((t: any) => [t.name, String(t.calls), String(t.errors), `${(t.totalMs / t.calls / 1000).toFixed(2)}s`]), [1, 2, 3]));
	if (d.mcp.length) {
		page.append(h('h3', {}, 'MCP servers'));
		page.append(table(['Server', 'Status', 'Calls', 'Failures', 'Error'], d.mcp.map((m: any) => [m.name, m.status, String(m.calls), String(m.failures), m.error ?? '']), [2, 3]));
	}
	page.append(h('h3', {}, 'Recent warnings and errors'));
	page.append(h('div', { class: 'row' },
		button('Show full log', 'output', () => post({ type: 'command', command: 'aide.logs.show' })),
		button('Copy logs', 'copy', () => post({ type: 'command', command: 'aide.logs.copy' })),
		button('Export logs...', 'export', () => post({ type: 'command', command: 'aide.logs.export' })),
		button('Open log folder', 'folder-opened', () => post({ type: 'command', command: 'aide.logs.openFolder' })),
		button('Clear logs', 'clear-all', () => post({ type: 'command', command: 'aide.logs.clear' })),
		button('Context Inspector', 'inspect', () => post({ type: 'command', command: 'aide.inspector.open' })),
	));
	page.append(d.logs.length ? table(['Time', 'Level', 'Source', 'Message'], d.logs.map((l: any) => [new Date(l.ts).toLocaleTimeString(), h('span', { class: l.level === 'error' ? 'err' : 'warn' }, icon(l.level === 'error' ? 'error' : 'warning'), ` ${l.level}`), l.source ?? '', l.msg])) : h('p', { class: 'muted' }, 'No warnings or errors.'));
	app.replaceChildren(page);
}

window.addEventListener('message', e => e.data.type === 'data' && render(e.data));
app.append(h('div', { class: 'page muted' }, 'Loading...'));
post({ type: 'ready' });
