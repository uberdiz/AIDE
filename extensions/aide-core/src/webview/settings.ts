import { button, fmtTokens, h, icon, post } from './common';

let data: any;
let tab: string = (window as any).__AIDE_STATE__?.tab ?? 'providers';
const app = document.getElementById('app')!;
const toastEl = h('div', { class: 'notice hidden', role: 'status' });

const TABS: [string, string, string][] = [
	['providers', 'Providers', 'plug'],
	['routing', 'Routing', 'git-merge'],
	['limits', 'Usage limits', 'dashboard'],
	['permissions', 'Permissions', 'shield'],
	['context', 'Context & agents', 'references'],
	['mcp', 'MCP', 'server-process'],
	['profile', 'Profile', 'export'],
];

function field(label: string, control: HTMLElement, help?: string): HTMLElement[] {
	return [h('label', {}, label), h('div', {}, control, help ? h('div', { class: 'help' }, help) : undefined)];
}

function input(value: unknown, attrs: Record<string, string> = {}): HTMLInputElement {
	const el = h('input', { type: 'text', ...attrs });
	el.value = value === undefined || value === null ? '' : String(value);
	return el;
}

function select(options: [string, string][], value: string): HTMLSelectElement {
	const el = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l)));
	el.value = value;
	return el;
}

function render(): void {
	if (!data) {
		app.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading...')));
		return;
	}
	const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...TABS.map(([id, label, ic]) => {
		const b = h('button', { class: `tab ${tab === id ? 'active' : ''}`, role: 'tab', 'aria-selected': String(tab === id) }, icon(ic), ` ${label}`);
		b.addEventListener('click', () => {
			tab = id;
			render();
		});
		return b;
	}));
	const body = ({ providers, routing, limits, permissions, context, mcp, profile } as Record<string, () => HTMLElement>)[tab]();
	app.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'AIDE Settings'), h('p', { class: 'lead' }, 'AI providers, routing, limits and safety. Everything here is also in Settings (search "aide") and settings.json.'), tabs, toastEl, body));
}

// ------------------------------------------------------------------ providers

function providers(): HTMLElement {
	const root = h('div');
	root.append(h('h2', {}, 'Configured providers'));
	if (!data.providers.length) root.append(h('p', { class: 'muted' }, 'No providers yet. Add one below - local models (Ollama, LM Studio) need no API key.'));
	for (const p of data.providers) root.append(providerCard(p));
	root.append(h('h2', {}, 'Add a provider'));
	const grid = h('div', { class: 'row' });
	for (const t of data.templates) {
		grid.append(button(t.label, 'add', () => {
			const id = uniqueId(t.id);
			root.append(providerEditor({ ...t, id }, true));
		}, { title: t.help }));
	}
	root.append(grid);
	return root;
}

function uniqueId(base: string): string {
	let id = base;
	let i = 2;
	while (data.providers.some((p: any) => p.id === id)) id = `${base}${i++}`;
	return id;
}

function providerCard(p: any): HTMLElement {
	const status = p.error ? h('span', { class: 'badge bad', title: p.error }, 'error') : p.models.length ? h('span', { class: 'badge good' }, `${p.models.length} models`) : h('span', { class: 'badge' }, 'not checked');
	const card = h('div', { class: 'card' },
		h('div', { class: 'card-head' }, icon(p.local ? 'vm' : 'cloud'), h('span', { class: 'name' }, p.label ?? p.id), h('span', { class: 'muted' }, `${p.id} · ${p.kind}${p.baseUrl ? ' · ' + p.baseUrl : ''}`), status,
			p.hasKey ? h('span', { class: 'badge', title: 'Stored in the OS keychain via VS Code SecretStorage' }, icon('key'), ' key stored') : p.envKey ? h('span', { class: 'badge' }, 'key from environment') : undefined,
			p.enabled === false ? h('span', { class: 'badge' }, 'disabled') : undefined,
			h('div', { class: 'spacer' }),
			button('Test', 'debug-start', () => post({ type: 'testProvider', id: p.id })),
			button('Edit', 'edit', () => card.replaceWith(providerEditor(p, false))),
			button('', 'trash', () => post({ type: 'deleteProvider', id: p.id }), { cls: 'icon-btn', title: 'Remove provider' })),
	);
	if (p.error) card.append(h('div', { class: 'inline-error' }, p.error));
	if (p.models.length) {
		const d = h('details', {}, h('summary', { class: 'muted' }, 'Models'));
		const t = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Context'), h('th', {}, 'Capabilities'), h('th', { class: 'num' }, '$/1M in'), h('th', { class: 'num' }, '$/1M out')));
		for (const m of p.models) t.append(h('tr', {}, h('td', {}, `${p.id}/${m.id}`), h('td', {}, m.contextWindow ? fmtTokens(m.contextWindow) : '?'), h('td', {}, m.caps.join(', ')), h('td', { class: 'num' }, m.inputPrice ?? (p.local ? '0' : '?')), h('td', { class: 'num' }, m.outputPrice ?? (p.local ? '0' : '?'))));
		d.append(t, h('div', { class: 'help' }, 'Unknown prices ("?") can be set per model in settings.json under aide.providers[].models so cost tracking is exact.'));
		card.append(d);
	}
	return card;
}

function providerEditor(p: any, isNew: boolean): HTMLElement {
	const id = input(p.id);
	const label = input(p.label ?? '');
	const kind = select([['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['gemini', 'Google Gemini'], ['ollama', 'Ollama'], ['openai-compatible', 'OpenAI-compatible']], p.kind);
	const baseUrl = input(p.baseUrl ?? '', { placeholder: 'default endpoint' });
	const key = h('input', { type: 'password', placeholder: p.hasKey ? '•••••••• (stored - leave blank to keep)' : p.needsKey === false ? 'not required' : 'paste API key' });
	const local = h('input', { type: 'checkbox' });
	local.checked = !!p.local;
	const enabled = h('input', { type: 'checkbox' });
	enabled.checked = p.enabled !== false;
	const numCtx = input(p.options?.num_ctx ?? '', { placeholder: '16384' });
	// "editing" keeps background data refreshes from wiping the form (see message handler)
	const card = h('div', { class: 'card editing' }, h('div', { class: 'card-head' }, h('span', { class: 'name' }, isNew ? `New provider: ${p.label ?? p.kind}` : `Edit ${p.id}`)));
	const grid = h('div', { class: 'grid' },
		...field('Id', id, 'Used in model references: <id>/<model>'),
		...field('Label', label),
		...field('Protocol', kind),
		...field('Base URL', baseUrl, p.help),
		...field('API key', key, 'Stored in the OS keychain (SecretStorage). Never written to settings, never sent to models, never exported.'),
		...field('Local (no cost, offline)', local),
		...field('Enabled', enabled),
	);
	if (p.kind === 'ollama') grid.append(...field('Context size (num_ctx)', numCtx, 'Larger values let agents see more but use more VRAM.'));
	card.append(grid);
	const row = h('div', { class: 'row' },
		button('Save & test', 'save', () => {
			card.classList.remove('editing');
			const opts = p.kind === 'ollama' && numCtx.value ? { ...(p.options ?? {}), num_ctx: Number(numCtx.value) } : p.options;
			post({ type: 'saveProvider', originalId: isNew ? undefined : p.id, apiKey: key.value, provider: { id: id.value.trim(), label: label.value.trim(), kind: kind.value, baseUrl: baseUrl.value.trim(), local: local.checked, enabled: enabled.checked, models: p.models?.length && !isNew ? undefined : p.modelsConfig, options: opts } });
		}, { primary: true }),
		button('Cancel', undefined, () => render()),
	);
	if (p.hasKey) row.append(button('Remove stored key', 'key', () => post({ type: 'clearKey', id: p.id })));
	card.append(row);
	setTimeout(() => card.scrollIntoView({ block: 'nearest' }));
	return card;
}

// ------------------------------------------------------------------ routing

function routing(): HTMLElement {
	const r = data.routing;
	const root = h('div');
	const refs: string[] = data.models.map((m: any) => m.ref);
	const aliasNames = Object.keys(r.aliases ?? {});
	const datalist = h('datalist', { id: 'model-refs' }, ...[...aliasNames, ...refs].map(v => h('option', { value: v })));
	root.append(datalist);
	root.append(h('p', { class: 'lead' }, 'Auto chooses the agent from each chat message and a model for each role: a small fast model for chat, a tool-calling coder model for coding, the most capable model for planning, review and debugging. Set a role to a specific model to override Auto.'));

	// Providers Auto may use
	root.append(h('h2', {}, 'Providers used by Auto'));
	const provChecks: Record<string, HTMLInputElement> = {};
	const provRow = h('div', { class: 'row' });
	const chosen: string[] = r.autoProviders ?? [];
	for (const p of data.providers) {
		const cb = h('input', { type: 'checkbox' });
		cb.checked = !chosen.length || chosen.includes(p.id);
		provChecks[p.id] = cb;
		provRow.append(h('label', { class: 'check-pill' }, cb, icon(p.local ? 'vm' : 'cloud'), ` ${p.label ?? p.id}`));
	}
	root.append(data.providers.length ? provRow : h('p', { class: 'muted' }, 'Add a provider on the Providers tab first.'));
	root.append(h('div', { class: 'help' }, 'Auto picks only from these. Cloud providers cost money per token; local ones (Ollama, LM Studio) are free.'));

	for (const rec of data.recommendations ?? []) {
		const card = h('div', { class: 'notice info' }, icon('lightbulb'), h('span', {}, ` ${rec.text} `), h('code', {}, rec.command), ' ');
		card.append(button('Copy', 'copy', () => post({ type: 'copy', text: rec.command }), { cls: 'small' }), button('Open in terminal', 'terminal', () => post({ type: 'pasteCommand', command: rec.command }), { cls: 'small', title: 'Types the command into a terminal; you press Enter to download' }));
		root.append(card);
	}

	// Per-role models
	root.append(h('h2', {}, 'Model for each role'));
	const roles: [string, string, string][] = [
		['chat', 'Chat', 'Questions and conversation (Chat agent)'],
		['coding', 'Coding', 'Coder, Tester, Documenter, code generation'],
		['planning', 'Planning', 'Planner agent'],
		['review', 'Review', 'Reviewer agent'],
		['debug', 'Debugging', 'Debugger agent, fixing errors'],
		['simple_edits', 'Inline edits', 'Ctrl+Alt+K, fix at cursor, refactor (uses Coding when on Auto)'],
		['autocomplete', 'Autocomplete', 'Inline completions while typing (off until set)'],
		['explain', 'Explain', 'Explain selection (uses Chat when on Auto)'],
		['commit_message', 'Commit messages', 'Commit messages and PR text'],
		['summarize', 'Summaries', 'Compacting long conversations'],
		['vision', 'Images', 'Messages with images'],
	];
	const rows: Record<string, { sel: HTMLSelectElement; fb: HTMLInputElement }> = {};
	const tbl = h('table', { class: 'data roles' }, h('tr', {}, h('th', {}, 'Role'), h('th', {}, 'Model'), h('th', {}, 'Fallbacks (optional)')));
	for (const [task, label, desc] of roles) {
		const cur = r.rules?.[task];
		const list = (Array.isArray(cur) ? cur : cur ? [cur] : []) as string[];
		const auto = data.autoPreview?.[task];
		const autoLabel = task === 'autocomplete' ? 'Off' : `Auto${auto?.refs?.[0] ? ` → ${auto.refs[0]}` : ' (no suitable model)'}`;
		const opts: [string, string][] = [['', autoLabel], ...refs.map(ref => [ref, ref] as [string, string])];
		if (list[0] && !refs.includes(list[0])) opts.push([list[0], `${list[0]} (not available)`]);
		const sel = select(opts, list[0] ?? '');
		sel.title = auto?.reason ?? '';
		const fb = input(list.slice(1).join(', '), { list: 'model-refs', placeholder: 'e.g. ollama/llama3.1:latest' });
		fb.style.width = '100%';
		rows[task] = { sel, fb };
		tbl.append(h('tr', {}, h('td', {}, h('strong', {}, label), h('div', { class: 'help' }, desc)), h('td', {}, sel), h('td', {}, fb)));
	}
	root.append(tbl);

	// Advanced
	const adv = h('details', { class: 'advanced' }, h('summary', {}, 'Advanced routing'));
	const strategy = select([['rules', 'As listed'], ['local-first', 'Local first'], ['cloud-first', 'Cloud first'], ['cost', 'Cheapest first'], ['capability', 'Most capable first']], r.strategy);
	const autoFallback = h('input', { type: 'checkbox' });
	autoFallback.checked = r.autoFallback;
	const def = input((Array.isArray(r.default) ? r.default : [r.default]).filter(Boolean).join(', '), { list: 'model-refs', placeholder: 'ollama/llama3.1:latest' });
	const aliases = h('textarea', { rows: '4' });
	aliases.value = Object.entries(r.aliases ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n');
	adv.append(h('div', { class: 'grid' },
		...field('Fallback order', strategy, 'Reorders the fallbacks of every role; a model picked in the chat always goes first.'),
		...field('Last resort', def, 'Used when Auto finds no suitable model (e.g. before model lists load).'),
		...field('Try any model on failure', autoFallback, 'If every listed model fails, try the other models of the Auto providers.'),
		...field('Aliases', aliases, 'One per line: name = provider/model. Usable in custom agents.'),
	));
	root.append(adv);

	const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
	root.append(h('div', { class: 'row' }, button('Save routing', 'save', () => {
		const ruleOut: Record<string, string[]> = {};
		// Keep rules for tasks this page does not show (set in settings.json).
		for (const [t, v] of Object.entries(r.rules ?? {})) if (!rows[t]) ruleOut[t] = (Array.isArray(v) ? v : [v]) as string[];
		for (const [t, { sel, fb }] of Object.entries(rows)) if (sel.value) ruleOut[t] = [sel.value, ...list(fb.value)];
		const aliasOut: Record<string, string> = {};
		for (const line of aliases.value.split('\n')) {
			const m = /^\s*([\w.-]+)\s*[=:]\s*(\S+)\s*$/.exec(line);
			if (m) aliasOut[m[1]] = m[2];
		}
		const provs = Object.entries(provChecks).filter(([, cb]) => cb.checked).map(([id]) => id);
		if (data.providers.length && !provs.length) return toast('error', 'Select at least one provider for Auto.');
		post({ type: 'saveRouting', routing: { strategy: strategy.value, rules: ruleOut, default: list(def.value), aliases: aliasOut, autoFallback: autoFallback.checked, autoProviders: provs.length === data.providers.length ? [] : provs } });
	}, { primary: true }), button('Refresh model lists', 'refresh', () => post({ type: 'refreshModels' }))));
	return root;
}

// ------------------------------------------------------------------ limits

function limits(): HTMLElement {
	const L = data.limits;
	const root = h('div');
	root.append(h('p', { class: 'lead' }, 'Limits are checked before every request using estimated tokens, so AIDE stops before crossing them. Global limits apply to cloud models; per-provider limits can also cap local providers.'));
	const f = {
		dailyTokens: input(L.dailyTokens, { placeholder: 'no limit' }),
		dailyCost: input(L.dailyCost, { placeholder: 'no limit (USD)' }),
		monthlyTokens: input(L.monthlyTokens, { placeholder: 'no limit' }),
		monthlyCost: input(L.monthlyCost, { placeholder: 'no limit (USD)' }),
		perRequestTokens: input(L.perRequestTokens, { placeholder: 'no limit' }),
	};
	const warnAt = input((L.warnAt ?? []).map((x: number) => Math.round(x * 100)).join(', '), { placeholder: '80, 95' });
	const onLimit = select([['ask', 'Ask me'], ['stop', 'Stop'], ['switch-model', 'Switch to the next model in the route'], ['switch-provider', 'Switch to another provider'], ['local', 'Use a local model'], ['reduce-context', 'Reduce context and retry']], L.onLimit ?? 'ask');
	const prov = h('textarea', { rows: '6' });
	prov.value = JSON.stringify(L.providers ?? {}, null, 2);
	root.append(h('div', { class: 'grid' },
		...field('Daily tokens', f.dailyTokens), ...field('Daily cost ($)', f.dailyCost),
		...field('Monthly tokens', f.monthlyTokens), ...field('Monthly cost ($)', f.monthlyCost),
		...field('Per-request tokens', f.perRequestTokens, 'Blocks any single request whose estimated input exceeds this.'),
		...field('Warn at (%)', warnAt), ...field('When a limit is reached', onLimit),
		...field('Per-provider limits (JSON)', prov, 'e.g. { "anthropic": { "daily": { "cost": 5 }, "monthly": { "cost": 50 } } }'),
	));
	root.append(h('div', { class: 'row' }, button('Save limits', 'save', () => {
		let providers = {};
		try {
			providers = JSON.parse(prov.value || '{}');
		} catch {
			return toast('error', 'Per-provider limits must be valid JSON');
		}
		const out: Record<string, unknown> = { onLimit: onLimit.value, providers, warnAt: warnAt.value.split(',').map(x => Number(x.trim()) / 100).filter(x => x > 0 && x < 1) };
		for (const [k, el] of Object.entries(f)) out[k] = el.value.trim() === '' ? null : Number(el.value);
		post({ type: 'saveLimits', limits: out });
	}, { primary: true }), button('Open usage dashboard', 'graph', () => post({ type: 'command', command: 'aide.usage.open' }))));
	return root;
}

// ------------------------------------------------------------------ permissions

function permissions(): HTMLElement {
	const root = h('div');
	root.append(h('p', { class: 'lead' }, 'What agents may do without asking. "Ask" shows an approval with a diff or the exact command. Dangerous commands (force push, recursive delete, piping downloads to a shell...) always ask.'));
	const desc: Record<string, string> = { read: 'Read files, search, list, diagnostics', write: 'Create and edit files', delete: 'Delete files', command: 'Run shell commands', network: 'Fetch URLs', git: 'Commit, branch, push', github: 'GitHub API actions (issues, PRs)', external: 'Connected services (Drive, ...)', mcp: 'Call MCP server tools' };
	const sels: Record<string, HTMLSelectElement> = {};
	const tbl = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Category'), h('th', {}, 'Policy'), h('th', {}, '')));
	for (const c of data.categories) {
		sels[c] = select([['ask', 'Ask'], ['allow', 'Allow'], ['deny', 'Deny']], data.permissions[c]);
		tbl.append(h('tr', {}, h('td', {}, h('code', {}, c)), h('td', {}, sels[c]), h('td', { class: 'help' }, desc[c] ?? '')));
	}
	root.append(tbl, h('div', { class: 'row' }, button('Save permissions', 'save', () => post({ type: 'savePermissions', policy: Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value])) }), { primary: true })));
	root.append(h('h2', {}, 'Remembered approvals'));
	if (!data.grants.length) root.append(h('p', { class: 'muted' }, 'None. Approvals given as "session", "workspace" or "always" appear here.'));
	else {
		const g = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Scope'), h('th', {}, 'Rule'), h('th', {}, 'Decision'), h('th', {}, '')));
		for (const x of data.grants) g.append(h('tr', {}, h('td', {}, x.scope), h('td', {}, h('code', {}, x.key)), h('td', {}, x.value), h('td', {}, button('Revoke', undefined, () => post({ type: 'revokeGrant', scope: x.scope, key: x.key }), { cls: 'small' }))));
		root.append(g);
	}
	return root;
}

// ------------------------------------------------------------------ context

function context(): HTMLElement {
	const c = data.context;
	const root = h('div');
	const strategy = select([['minimal', 'Minimal - only what you mention'], ['balanced', 'Balanced - + active file, problems, search hits, repo map'], ['deep', 'Deep - + related files, open editors, git diff'], ['maximum', 'Maximum - as much as the budget allows']], c.strategy);
	const hist = input(c.historyBudget, { type: 'number' });
	const maxOut = input(c.maxOutputTokens, { type: 'number' });
	const inline = h('input', { type: 'checkbox' });
	inline.checked = !!c.inlineEnabled;
	const reveal = h('input', { type: 'checkbox' });
	reveal.checked = !!c.revealTerminal;
	root.append(h('div', { class: 'grid' },
		...field('Default context strategy', strategy, 'Per-chat override in the chat toolbar. Never sends node_modules, .git, build output, binaries, lockfiles or secrets automatically.'),
		...field('History budget (tokens)', hist, 'Older turns are compressed/summarized beyond this.'),
		...field('Max output tokens', maxOut),
		...field('Inline completions', inline, 'Uses the "autocomplete" routing rule; nothing runs until that rule is set.'),
		...field('Show agent commands in terminal', reveal),
	));
	root.append(h('div', { class: 'row' }, button('Save', 'save', () => post({ type: 'saveContext', context: { strategy: strategy.value, historyBudget: hist.value, maxOutputTokens: maxOut.value, inlineEnabled: inline.checked, revealTerminal: reveal.checked } }), { primary: true })));
	root.append(h('h2', {}, 'Project context'));
	root.append(h('p', { class: 'help' }, 'Per-project files in .aide/: instructions.md (rules for AI), memory.md (facts agents record - editable), rules/*.md, agents/, workflows/, mcp.json. AGENTS.md, CLAUDE.md, .cursorrules and .github/copilot-instructions.md are also read.'));
	root.append(h('div', { class: 'row' }, button('Open project instructions', 'book', () => post({ type: 'command', command: 'aide.project.openInstructions' })), button('Open project memory', 'database', () => post({ type: 'command', command: 'aide.project.openMemory' })), button('New custom agent', 'add', () => post({ type: 'command', command: 'aide.agents.new' }))));
	return root;
}

// ------------------------------------------------------------------ MCP

function mcp(): HTMLElement {
	const root = h('div');
	root.append(h('p', { class: 'lead' }, 'MCP servers add tools for agents. User servers live in ~/.aide/mcp.json, project servers in .aide/mcp.json. Servers start on demand when an agent that uses them runs.'));
	const t = h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Server'), h('th', {}, 'Scope'), h('th', {}, 'Status'), h('th', {}, 'Tools')));
	for (const s of data.mcp) t.append(h('tr', {}, h('td', {}, s.name), h('td', {}, s.scope), h('td', { title: s.error ?? '' }, s.status + (s.error ? ` - ${s.error}` : '')), h('td', { class: 'num' }, String(s.tools))));
	root.append(data.mcp.length ? t : h('p', { class: 'muted' }, 'No MCP servers configured.'));
	root.append(h('div', { class: 'row' }, button('Add MCP server', 'add', () => post({ type: 'command', command: 'aide.mcp.add' }), { primary: true }), button('Edit user config', 'json', () => post({ type: 'command', command: 'aide.mcp.openConfig', args: ['user'] })), button('Edit project config', 'json', () => post({ type: 'command', command: 'aide.mcp.openConfig', args: ['workspace'] }))));
	root.append(h('p', { class: 'help' }, 'Give agents access with a tool selector: "mcp:<server>" for one server or "mcp:*" for all. Each MCP call is gated by the "mcp" permission.'));
	return root;
}

// ------------------------------------------------------------------ profile

function profile(): HTMLElement {
	const root = h('div');
	root.append(h('p', { class: 'lead' }, 'Export your AIDE setup (settings, theme, keybindings, providers, routing, agents, MCP servers, layouts, installed extensions list) to a single file. API keys and secrets are never exported.'));
	root.append(h('div', { class: 'row' }, button('Export profile...', 'export', () => post({ type: 'command', command: 'aide.profile.export' }), { primary: true }), button('Import profile...', 'cloud-download', () => post({ type: 'command', command: 'aide.profile.import' })), button('Open settings.json', 'json', () => post({ type: 'command', command: 'workbench.action.openSettingsJson' }))));
	return root;
}

function toast(level: string, text: string): void {
	toastEl.className = `notice ${level === 'error' ? 'error' : 'info'}`;
	toastEl.textContent = text;
	window.clearTimeout((toastEl as any)._t);
	(toastEl as any)._t = window.setTimeout(() => toastEl.classList.add('hidden'), 8000);
}

window.addEventListener('message', e => {
	const m = e.data;
	if (m.type === 'data') {
		data = m;
		if (document.querySelector('.editing')) return;
		const scrollY = window.scrollY;
		render();
		window.scrollTo(0, scrollY);
	} else if (m.type === 'toast') toast(m.level, m.text);
	else if (m.type === 'tab') {
		tab = m.tab;
		render();
	}
});
render();
post({ type: 'ready' });
