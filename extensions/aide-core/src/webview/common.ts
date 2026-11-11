import { marked, type Tokens } from 'marked';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
export const vscode = acquireVsCodeApi();

export function post(msg: Record<string, unknown>): void {
	vscode.postMessage(msg);
}

export function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: (Node | string | undefined | false)[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === false) continue;
		if (k === 'class') el.className = String(v);
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	for (const c of children) if (c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
	return el;
}

export function icon(name: string, extra = ''): HTMLElement {
	return h('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function button(label: string, iconName: string | undefined, onClick: () => void, opts: { title?: string; cls?: string; primary?: boolean } = {}): HTMLButtonElement {
	const b = h('button', { class: `btn ${opts.primary ? 'primary' : ''} ${opts.cls ?? ''}`.trim(), title: opts.title ?? label, type: 'button' }, iconName ? icon(iconName) : undefined, label ? h('span', {}, label) : undefined);
	b.addEventListener('click', e => {
		e.preventDefault();
		onClick();
	});
	return b;
}

// Markdown: raw HTML from the model is escaped, never rendered.
marked.use({
	gfm: true,
	breaks: false,
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return esc(token.text);
		},
		code(token: Tokens.Code) {
			const lang = (token.lang ?? '').trim().split(/\s+/)[0];
			return `<div class="codeblock" data-lang="${esc(lang)}"><div class="codebar"><span class="lang">${esc(lang || 'text')}</span><span class="actions"></span></div><pre><code>${esc(token.text)}</code></pre></div>`;
		},
		link(token: Tokens.Link) {
			const href = token.href ?? '';
			const safe = /^(https?:|mailto:)/i.test(href) ? href : '';
			return safe ? `<a href="${esc(safe)}" title="${esc(token.title ?? href)}">${esc(token.text)}</a>` : esc(token.text);
		},
		image(token: Tokens.Image) {
			return `[image: ${esc(token.text || token.href)}]`;
		},
	},
});

export function renderMarkdown(md: string): string {
	return marked.parse(md, { async: false }) as string;
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
	return n.toLocaleString('en-US');
}

export function fmtCost(c: number | undefined): string {
	if (c === undefined) return 'n/a';
	if (c === 0) return '$0';
	return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function timeAgo(ts: number): string {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return new Date(ts).toLocaleDateString();
}
