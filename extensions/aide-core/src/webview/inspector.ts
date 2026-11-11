import { button, fmtCost, fmtTokens, h, post } from './common';

const app = document.getElementById('app')!;
let selected: string | undefined = (window as any).__AIDE_STATE__?.selected;
let requests: any[] = [];

function kv(pairs: [string, string | HTMLElement | undefined][]): HTMLElement {
	const el = h('div', { class: 'kv' });
	for (const [k, v] of pairs) if (v !== undefined && v !== '') el.append(h('div', { class: 'k' }, k), h('div', {}, v));
	return el;
}

function detail(r: any): HTMLElement {
	const u = r.usage;
	const info = r.modelInfo ?? {};
	const el = h('div');
	el.append(h('h2', {}, `${r.ref ?? '(no model)'}`));
	el.append(kv([
		['Status', r.status + (r.error ? ` - ${r.error}` : '')],
		['Task / source', `${r.task} · ${r.source}`],
		['Time', new Date(r.ts).toLocaleString() + (r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : '')],
		['Estimated input', `${fmtTokens(r.estimatedInputTokens)} tokens`],
		['Actual input', u ? `${fmtTokens(u.inputTokens)} uncached + ${fmtTokens(u.cacheReadTokens ?? 0)} cache read + ${fmtTokens(u.cacheWriteTokens ?? 0)} cache write${u.exact ? '' : ' (estimated)'}` : undefined],
		['Output', u ? `${fmtTokens(u.outputTokens)} tokens (limit ${r.maxTokens ? fmtTokens(r.maxTokens) : 'default'})` : r.maxTokens ? `limit ${fmtTokens(r.maxTokens)}` : undefined],
		['Cost', fmtCost(r.cost)],
		['Model context window', info.contextWindow ? fmtTokens(info.contextWindow) : 'unknown'],
		['Pricing ($/1M in/out)', info.inputPrice !== undefined ? `${info.inputPrice} / ${info.outputPrice}` : info.local ? 'local (free)' : 'unknown'],
		['Tools offered', r.tools.length ? r.tools.join(', ') : 'none'],
	]));
	if (r.attempts?.length > 1 || r.rejected?.length) {
		el.append(h('h3', {}, 'Routing'));
		const t = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Outcome')));
		for (const a of r.attempts) t.append(h('tr', {}, h('td', {}, a.ref), h('td', {}, a.error ?? 'used')));
		for (const x of r.rejected ?? []) t.append(h('tr', {}, h('td', {}, x.ref), h('td', { class: 'muted' }, `not tried: ${x.reason}`)));
		el.append(t);
	}
	if (r.context?.length || r.droppedContext?.length) {
		el.append(h('h3', {}, 'Context items (added by AIDE for this turn)'));
		const t = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Kind'), h('th', {}, 'Why'), h('th', { class: 'num' }, 'Tokens')));
		for (const c of r.context ?? []) t.append(h('tr', {}, h('td', {}, c.label + (c.truncated ? ' (summarized)' : '') + (c.deduped ? ' (already sent - reference only)' : '')), h('td', {}, c.kind), h('td', {}, c.reason), h('td', { class: 'num' }, fmtTokens(c.tokens))));
		for (const c of r.droppedContext ?? []) t.append(h('tr', { class: 'muted' }, h('td', {}, `${c.label} (not sent)`), h('td', {}, ''), h('td', {}, c.reason), h('td', { class: 'num' }, fmtTokens(c.tokens))));
		el.append(t);
	}
	if (r.system) {
		el.append(h('h3', {}, 'System instructions'));
		el.append(h('pre', { class: 'block' }, r.system));
	}
	el.append(h('h3', {}, `Messages (${r.messages.length})`));
	for (const m of r.messages) {
		const blk = h('details', { class: `msg-block ${m.role}` }, h('summary', {}, `${m.role}${m.toolName ? ` · ${m.toolName}` : ''}${m.isError ? ' · error' : ''} · ~${fmtTokens(m.tokens)} tokens`));
		if (m.text) blk.append(h('pre', { class: 'block' }, m.text));
		for (const c of m.toolCalls ?? []) blk.append(h('pre', { class: 'block' }, `→ ${c.name}(${c.input})`));
		el.append(blk);
	}
	const last = el.querySelectorAll('details.msg-block');
	last[last.length - 1]?.setAttribute('open', '');
	return el;
}

function render(): void {
	const page = h('div', { class: 'page' }, h('h1', {}, 'Context Inspector'), h('p', { class: 'lead' }, 'Exactly what AIDE sent to a model for each request: model, tokens, context items, tools, system instructions and messages.'));
	if (!requests.length) {
		page.append(h('p', { class: 'muted' }, 'No AI requests in this session yet.'));
		app.replaceChildren(page);
		return;
	}
	if (!selected || !requests.some(r => r.id === selected)) selected = requests[0].id;
	const list = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Model'), h('th', {}, 'Task'), h('th', { class: 'num' }, 'In'), h('th', { class: 'num' }, 'Cost')));
	for (const r of requests) {
		const tr = h('tr', { class: `clickable ${r.id === selected ? 'sel' : ''}` },
			h('td', {}, new Date(r.ts).toLocaleTimeString()),
			h('td', { class: r.status === 'error' ? 'err' : '' }, (r.ref ?? '-') + (r.status !== 'ok' ? ` (${r.status})` : '')),
			h('td', {}, r.task),
			h('td', { class: 'num' }, fmtTokens(r.usage ? r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0) : r.estimatedInputTokens)),
			h('td', { class: 'num' }, fmtCost(r.cost)),
		);
		tr.addEventListener('click', () => {
			selected = r.id;
			render();
		});
		list.append(tr);
	}
	const sel = requests.find(r => r.id === selected);
	page.append(h('div', { class: 'row' }, button('Usage dashboard', 'graph', () => post({ type: 'command', command: 'aide.usage.open' }))));
	page.append(h('div', { class: 'split' }, h('div', {}, list), h('div', {}, sel ? detail(sel) : '')));
	app.replaceChildren(page);
}

window.addEventListener('message', e => {
	if (e.data.type === 'data') {
		requests = e.data.requests;
		render();
	} else if (e.data.type === 'select') {
		selected = e.data.id;
		render();
	}
});
app.append(h('div', { class: 'page muted' }, 'Loading...'));
post({ type: 'ready' });
