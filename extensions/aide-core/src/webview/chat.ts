import { button, fmtCost, fmtTokens, h, icon, post, renderMarkdown, timeAgo, vscode } from './common';

type Part =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool'; id: string; name: string; summary: string; result?: string; isError?: boolean; denied?: boolean; durationMs?: number; path?: string }
	| { type: 'notice'; text: string; level: 'info' | 'warn' | 'error' }
	| { type: 'checkpoint'; id: string; files: number; paths?: string[] }
	| { type: 'action'; label: string; action: string; arg?: string };

interface Attachment {
	kind: 'terminal' | 'text' | 'output';
	label: string;
	text: string;
}

interface Turn {
	role: 'user' | 'assistant';
	text?: string;
	context?: { label: string; tokens: number; kind: string }[];
	attachments?: { kind: string; label: string; lines: number; text?: string }[];
	parts?: Part[];
	agent?: string;
	agentId?: string;
	model?: string;
	route?: { auto: boolean; reason: string; modelReason?: string };
	usage?: { input: number; output: number; cost?: number };
	status?: string;
	requestIds?: string[];
	ts: number;
}

interface State {
	conversation?: { id: string; title: string; turns: Turn[]; kind?: string; branchOf?: { id: string; title: string } };
	conversations: { id: string; title: string; updated: number; agentId: string; turns: number; kind?: string }[];
	agents: { id: string; name: string; description: string; icon?: string; source: string }[];
	models: { ref: string; label: string; provider: string; providerId: string; local: boolean; caps: string[] }[];
	providers: { id: string; label: string; local: boolean }[];
	autoProviders: string[];
	autoModels: { chat?: string; coding?: string; planning?: string };
	slash: { cmd: string; agent?: string; label: string; detail: string }[];
	selected: { agentMode: string; agentName: string; model: string; strategy: string };
	running?: { id: string; conversationId: string };
	summary: string;
	hasWorkspace: boolean;
	providersConfigured: number;
}

type MenuItem = { label: string; detail?: string; icon?: string; kind?: string; insert?: string; run?: () => void; checked?: boolean; header?: boolean };

const boot = (window as any).__AIDE_STATE__ ?? {};
let state: State | undefined;
const saved = vscode.getState() ?? {};
let excluded: string[] = [];
let images: { mediaType: string; data: string; name: string }[] = [];
let attachments: Attachment[] = saved.attachments ?? [];
let streamTurn: Turn | undefined;
let streamEl: HTMLElement | undefined;
let renderPending = false;
let previewTimer: number | undefined;
let menuState: { el: HTMLElement; items: MenuItem[]; sel: number; onPick: (it: MenuItem) => void } | undefined;

const app = document.getElementById('app')!;

// ------------------------------------------------------------------ layout

const titleEl = h('div', { class: 'title' }, 'Agent');
const newBtn = button('', 'add', () => post({ type: 'newChat' }), { title: 'New chat (Ctrl+Alt+N)', cls: 'icon-btn' });
const historyBtn = button('', 'history', () => toggleHistory(), { title: 'Chat history', cls: 'icon-btn' });
const moreBtn = button('', 'ellipsis', () => openMoreMenu(), { title: 'More actions', cls: 'icon-btn' });
const header = h('div', { class: 'bar' }, titleEl, h('div', { class: 'spacer' }), newBtn, historyBtn, moreBtn);

const historyPanel = h('div', { class: 'history hidden' });
const historySearch = h('input', { type: 'search', placeholder: 'Search chats...' });
const historyList = h('div', { class: 'history-list' });
historyPanel.append(historySearch, historyList);
historySearch.addEventListener('input', () => post({ type: 'search', query: historySearch.value }));

const messages = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
const approvals = h('div', { class: 'approvals' });

// chat terminal
const termOut = h('pre', { class: 'term-out' });
const termInput = h('input', { type: 'text', class: 'term-input', placeholder: 'Run a command (PowerShell) - Enter to run, Ctrl+C to stop', spellcheck: 'false' });
const termStatus = h('span', { class: 'muted term-status' });
const termDrawer = h('div', { class: 'term hidden' },
	h('div', { class: 'term-head' }, icon('terminal'), h('span', {}, 'Terminal'), termStatus, h('div', { class: 'spacer' }),
		button('', 'comment-discussion', () => attachTerminalOutput(), { cls: 'icon-btn', title: 'Add the last command and its output to the message' }),
		button('', 'clear-all', () => (termOut.textContent = ''), { cls: 'icon-btn', title: 'Clear' }),
		button('', 'close', () => toggleTerminal(false), { cls: 'icon-btn', title: 'Close' })),
	termOut,
	h('div', { class: 'term-line' }, h('span', { class: 'term-prompt' }, '❯'), termInput),
);
let termRunning = false;
let termLast: { command: string; output: string; exitCode?: number } | undefined;
const termHistory: string[] = [];
let termHistIdx = -1;

// composer
const chips = h('div', { class: 'chips' });
const input = h('textarea', { rows: '1', placeholder: 'Ask anything, @ to mention, / for actions', 'aria-label': 'Message', spellcheck: 'true' });
input.value = saved.draft ?? '';
const menu = h('div', { class: 'menu hidden', role: 'listbox' });
const addBtn = button('', 'add', () => openAddMenu(), { title: 'Add context', cls: 'icon-btn round' });
const modelPill = h('button', { class: 'pill', type: 'button', title: 'Model' });
modelPill.addEventListener('click', () => openModelMenu());
const agentPill = h('button', { class: 'pill agent hidden', type: 'button', title: 'Agent pinned for every message. Click to go back to Auto.' });
agentPill.addEventListener('click', () => post({ type: 'select', agentMode: 'auto' }));
const intentHint = h('span', { class: 'intent muted' });
const termBtn = button('', 'terminal', () => toggleTerminal(), { title: 'Chat terminal: run and test scripts here', cls: 'icon-btn' });
const sendBtn = button('', 'arrow-right', () => send(), { title: 'Send (Enter)', cls: 'send' });
const stopBtn = button('', 'debug-stop', () => post({ type: 'cancel' }), { title: 'Stop (Esc)', cls: 'send stop hidden' });
const composer = h('div', { class: 'composer' }, chips, h('div', { class: 'input-wrap' }, input, menu), h('div', { class: 'composer-bar' }, addBtn, modelPill, agentPill, intentHint, h('div', { class: 'spacer' }), termBtn, sendBtn, stopBtn));
const hero = h('div', { class: 'hero' });
const disclaimer = h('div', { class: 'disclaimer' }, 'AI may make mistakes. Double-check all generated code.');
const toastEl = h('div', { class: 'toast hidden', role: 'status' });
const imageInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', multiple: true });

const stage = h('div', { class: 'stage' }, messages, hero, approvals, termDrawer, composer);
app.append(header, historyPanel, stage, disclaimer, toastEl, imageInput);

// ------------------------------------------------------------------ rendering

function renderState(): void {
	if (!state) return;
	const conv = state.conversation;
	titleEl.textContent = conv?.title ?? 'Agent';
	titleEl.title = conv?.branchOf ? `Branched from "${conv.branchOf.title}"` : conv?.title ?? '';
	const empty = !conv?.turns.length;
	app.classList.toggle('is-empty', empty);
	renderHero();
	renderModelPill();
	agentPill.classList.toggle('hidden', state.selected.agentMode === 'auto');
	agentPill.replaceChildren(icon('pinned'), h('span', {}, state.selected.agentName), icon('close'));
	disclaimer.title = state.summary;
	const running = !!state.running;
	sendBtn.classList.toggle('hidden', running);
	stopBtn.classList.toggle('hidden', !running);
	renderMessages();
	renderHistory(state.conversations.map(c => ({ summary: c, snippet: '' })));
}

function renderHero(): void {
	hero.replaceChildren();
	if (!state) return;
	const logo = boot.logo ? h('img', { src: boot.logo, alt: '', class: 'hero-logo' }) : icon('sparkle');
	hero.append(h('div', { class: 'hero-title' }, logo, h('span', {}, 'AIDE')));
	if (!state.providersConfigured) {
		hero.append(h('p', { class: 'warn' }, 'No AI provider is configured yet.'), button('Set up AI providers', 'plug', () => post({ type: 'command', command: 'aide.settings.open' }), { primary: true }));
		return;
	}
	if (!state.hasWorkspace) hero.append(h('p', { class: 'muted small' }, 'Open a folder so agents can read, create and run files.'));
	const ideas = ['Build a calculator app with a UI in Python', 'Explain how this project is structured', 'Find and fix bugs in the open file'];
	const row = h('div', { class: 'ideas' });
	for (const idea of ideas) {
		const b = h('button', { class: 'idea', type: 'button' }, idea);
		b.addEventListener('click', () => {
			input.value = idea;
			autosize();
			input.focus();
			requestPreview();
		});
		row.append(b);
	}
	hero.append(row);
}

function shortModel(ref: string | undefined): string {
	if (!ref) return '';
	const id = ref.split('/').slice(1).join('/');
	return id.replace(/:latest$/, '');
}

function renderModelPill(): void {
	if (!state) return;
	const m = state.selected.model;
	modelPill.replaceChildren(icon(m ? (state.models.find(x => x.ref === m)?.local ? 'vm' : 'cloud') : 'sparkle'), h('span', {}, m ? shortModel(m) : 'Auto'), icon('chevron-down'));
	modelPill.title = m ? `Model: ${m} (all agents). Click for Auto or another model.` : `Auto picks a model per task:\nchat: ${state.autoModels.chat ?? '-'}\ncoding: ${state.autoModels.coding ?? '-'}\nplanning/review/debug: ${state.autoModels.planning ?? '-'}`;
}

function renderMessages(): void {
	messages.replaceChildren();
	streamEl = undefined;
	streamTurn = undefined;
	const turns = state?.conversation?.turns ?? [];
	if (state?.conversation?.branchOf) messages.append(h('div', { class: 'branch-note muted' }, icon('git-branch'), ` Branched from "${state.conversation.branchOf.title}"`));
	turns.forEach((t, i) => messages.append(renderTurn(t, i, turns)));
	if (state?.running && state.running.conversationId === state.conversation?.id) {
		streamTurn = turns[turns.length - 1];
		streamEl = messages.lastElementChild as HTMLElement;
		streamEl?.classList.add('streaming');
		updateWorking();
	}
	scrollToBottom(true);
}

function laterCheckpoints(turns: Turn[], from: number): number {
	return turns.slice(from).reduce((n, t) => n + (t.parts ?? []).filter(p => p.type === 'checkpoint').length, 0);
}

function renderTurn(t: Turn, index: number, turns: Turn[]): HTMLElement {
	return t.role === 'user' ? renderUser(t, index, turns) : renderAssistant(t, index, turns);
}

function renderUserText(text: string): HTMLElement {
	const el = h('div', { class: 'user-text' });
	let pos = 0;
	for (const m of text.matchAll(/@(file|folder|symbol|output|doc|url):("[^"]+"|\S+)|@(selection|terminal|errors|problems|git|workspace|memory|output)\b|^\/[\w-]+/g)) {
		el.append(text.slice(pos, m.index));
		const label = m[0].startsWith('/') ? m[0] : m[2] ? m[2].replace(/^"|"$/g, '') : m[3];
		const pill = h('span', { class: `mention-pill ${m[0].startsWith('/') ? 'slash' : ''}`, title: m[0] }, icon(m[0].startsWith('/') ? 'symbol-event' : kindIcon(m[1] ?? m[3] ?? 'file')), ` ${label.split('/').pop()}`);
		if (m[1] === 'file') {
			pill.classList.add('clickable');
			pill.addEventListener('click', () => post({ type: 'openFile', path: label }));
		}
		el.append(pill);
		pos = m.index! + m[0].length;
	}
	el.append(text.slice(pos));
	return el;
}

function renderUser(t: Turn, index: number, turns: Turn[]): HTMLElement {
	const el = h('div', { class: 'msg user', 'data-index': String(index) });
	const bubble = h('div', { class: 'bubble' }, renderUserText(t.text ?? ''));
	if (t.attachments?.length) bubble.append(h('div', { class: 'att-row' }, ...t.attachments.map(a => attachmentPill(a, a.text))));
	el.append(bubble);
	const running = !!state?.running;
	const actions = h('div', { class: 'msg-actions' },
		button('', 'copy', () => post({ type: 'copyTurn', index }), { cls: 'icon-btn', title: 'Copy' }),
		button('', 'edit', () => startEdit(el, t, index, turns), { cls: 'icon-btn', title: 'Edit and resend' }),
		button('', 'git-branch', () => post({ type: 'branch', index: index }), { cls: 'icon-btn', title: 'Branch: continue from here in a new chat' }),
		button('', 'discard', () => confirmRevert(el, index, turns), { cls: 'icon-btn', title: 'Revert: go back to before this message' }),
	);
	if (!running) el.append(actions);
	if (t.context?.length) {
		const total = t.context.reduce((n, c) => n + c.tokens, 0);
		const ctx = h('details', { class: 'sent-context' }, h('summary', {}, `${t.context.length} context item${t.context.length > 1 ? 's' : ''} · ~${fmtTokens(total)} tokens`));
		for (const c of t.context) ctx.append(h('div', { class: 'ctx-row' }, icon(kindIcon(c.kind)), ` ${c.label}`, h('span', { class: 'muted' }, ` ${fmtTokens(c.tokens)}`)));
		el.append(ctx);
	}
	return el;
}

function renderAssistant(t: Turn, index: number, turns: Turn[]): HTMLElement {
	const el = h('div', { class: 'msg assistant', 'data-index': String(index) });
	const who = h('div', { class: 'who' }, icon(agentIcon(t.agentId)), h('span', { class: 'agent' }, t.agent ?? 'AIDE'));
	if (t.route?.auto) who.append(h('span', { class: 'auto-badge', title: `Auto chose ${t.agent}: ${t.route.reason}${t.route.modelReason ? `\nModel: ${t.route.modelReason}` : ''}` }, 'auto'));
	if (t.model) who.append(h('span', { class: 'model muted', title: t.model }, shortModel(t.model)));
	el.append(who);
	const body = h('div', { class: 'parts' });
	for (const p of t.parts ?? []) body.append(renderPart(p));
	el.append(body);
	const foot = h('div', { class: 'msg-foot' });
	const u = t.usage;
	if (u && (u.input || u.output)) foot.append(h('span', { class: 'muted usage' }, `${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${fmtCost(u.cost)}`));
	if (t.status && t.status !== 'completed') foot.append(h('span', { class: `status ${t.status}` }, t.status.replace('_', ' ')));
	const isLast = index === turns.length - 1;
	const actions = h('div', { class: 'msg-actions inline' },
		button('', 'copy', () => post({ type: 'copyTurn', index }), { cls: 'icon-btn', title: 'Copy response' }),
		button('', 'refresh', () => confirmRegenerate(el, index, turns), { cls: 'icon-btn', title: 'Regenerate' }),
		button('', 'git-branch', () => post({ type: 'branch', index }), { cls: 'icon-btn', title: 'Branch: continue from here in a new chat' }),
	);
	const last = t.requestIds?.[t.requestIds.length - 1];
	if (last) actions.append(button('', 'inspect', () => post({ type: 'inspect', requestId: last }), { cls: 'icon-btn', title: 'Context Inspector: exactly what was sent' }));
	foot.append(h('div', { class: 'spacer' }), actions);
	el.classList.toggle('last', isLast);
	el.append(foot);
	return el;
}

function agentIcon(id?: string): string {
	return ({ chat: 'comment-discussion', coder: 'code', 'coder-github': 'github', planner: 'checklist', debugger: 'debug', reviewer: 'eye', docs: 'book', tester: 'beaker', 'extension-builder': 'extensions', memory: 'database', inline: 'sparkle' } as Record<string, string>)[id ?? ''] ?? 'hubot';
}

function kindIcon(kind: string): string {
	return ({ file: 'file', folder: 'folder', selection: 'selection', terminal: 'terminal', output: 'output', errors: 'warning', problems: 'warning', diagnostics: 'warning', git: 'git-commit', repomap: 'type-hierarchy', workspace: 'type-hierarchy', instructions: 'book', memory: 'database', search: 'search', symbol: 'symbol-method', doc: 'cloud', url: 'globe', note: 'note', text: 'note' } as Record<string, string>)[kind] ?? 'file';
}

function renderPart(p: Part): HTMLElement {
	switch (p.type) {
		case 'text': {
			const el = h('div', { class: 'md' });
			el.innerHTML = renderMarkdown(p.text);
			enhance(el);
			return el;
		}
		case 'thinking': {
			const d = h('details', { class: 'thinking' }, h('summary', {}, icon('lightbulb'), ' Thinking'));
			d.append(h('div', { class: 'thinking-body' }, p.text));
			return d;
		}
		case 'tool':
			return renderTool(p);
		case 'notice':
			return h('div', { class: `notice ${p.level}` }, icon(p.level === 'error' ? 'error' : p.level === 'warn' ? 'warning' : 'info'), h('span', {}, p.text));
		case 'checkpoint':
			return renderCheckpoint(p);
		case 'action': {
			const el = h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('checklist'), h('span', {}, ` Plan saved to ${p.arg ?? ''}`)));
			el.append(h('div', { class: 'card-actions' }, button('Open plan', 'go-to-file', () => post({ type: 'openFile', path: p.arg }), { cls: 'small' }), button(p.label, 'play', () => post({ type: 'implementPlan', planFile: p.arg }), { cls: 'small', primary: true })));
			return el;
		}
	}
}

const RUNNABLE = /\.(py|pyw|js|mjs|cjs|ts|ps1|sh|go|rb|php|lua)$/i;

function renderCheckpoint(p: Extract<Part, { type: 'checkpoint' }>): HTMLElement {
	const el = h('div', { class: 'card changes' });
	el.append(h('div', { class: 'card-title' }, icon('diff'), h('span', {}, ` ${p.files} file${p.files === 1 ? '' : 's'} changed`)));
	for (const f of p.paths ?? []) {
		const row = h('div', { class: 'file-row' }, icon('file'), h('a', { href: '#', class: 'file-link', title: f }, f));
		row.querySelector('a')!.addEventListener('click', e => {
			e.preventDefault();
			post({ type: 'openFile', path: f });
		});
		if (RUNNABLE.test(f)) row.append(button('Run', 'play', () => post({ type: 'runFileInChat', path: f }), { cls: 'small ghost', title: `Run ${f} in the chat terminal` }));
		el.append(row);
	}
	el.append(h('div', { class: 'card-actions' },
		button('Review', 'diff', () => post({ type: 'reviewChanges' }), { cls: 'small' }),
		button('Undo', 'discard', () => post({ type: 'restoreCheckpoint', id: p.id }), { cls: 'small', title: 'Restore the files to before these changes' })));
	return el;
}

const TOOL_VERB: Record<string, [string, string]> = {
	read_file: ['Read', 'file'], list_dir: ['Listed', 'folder'], find_files: ['Searched files', 'search'], search_text: ['Searched', 'search'],
	write_file: ['Wrote', 'new-file'], edit_file: ['Edited', 'edit'], delete_file: ['Deleted', 'trash'], move_file: ['Moved', 'arrow-right'],
	run_command: ['Ran', 'terminal'], git_status: ['Git status', 'git-commit'], git_diff: ['Git diff', 'diff'], git_log: ['Git log', 'history'],
	git_commit: ['Committed', 'git-commit'], git_branch: ['Branch', 'git-branch'], git_push: ['Pushed', 'repo-push'], get_diagnostics: ['Checked problems', 'warning'],
	web_fetch: ['Fetched', 'globe'], update_project_memory: ['Updated memory', 'database'], install_extension: ['Installed extension', 'extensions'],
};

function renderTool(p: Extract<Part, { type: 'tool' }>): HTMLElement {
	const done = p.result !== undefined;
	const [, ic] = TOOL_VERB[p.name] ?? [p.name, p.name.startsWith('mcp__') ? 'plug' : p.name.startsWith('github_') ? 'github' : 'tools'];
	const statusIcon = !done ? icon('loading', 'codicon-modifier-spin') : p.denied ? icon('circle-slash', 'err') : p.isError ? icon('error', 'err') : icon(ic, 'tool-ic');
	const d = h('details', { class: `tool ${p.isError ? 'failed' : ''} ${done ? '' : 'running'}`, 'data-id': p.id });
	const label = h('span', { class: 'tool-summary' }, p.summary);
	d.append(h('summary', {}, statusIcon, label, p.durationMs !== undefined ? h('span', { class: 'muted dur' }, `${(p.durationMs / 1000).toFixed(1)}s`) : undefined, icon('chevron-right', 'chev')));
	const out = h('pre', { class: `tool-result ${p.name === 'run_command' ? 'terminal' : ''}` }, p.result ?? '');
	d.append(out);
	if (!done && p.name === 'run_command') d.open = true;
	if (p.path && /write_file|edit_file/.test(p.name) && done && !p.isError) {
		label.classList.add('clickable');
		label.addEventListener('click', e => {
			e.preventDefault();
			post({ type: 'openFile', path: p.path });
		});
	}
	return d;
}

/** Add actions to rendered code blocks and make file paths clickable. */
function enhance(root: HTMLElement): void {
	root.querySelectorAll<HTMLElement>('.codeblock').forEach(block => {
		const code = block.querySelector('code')?.textContent ?? '';
		const lang = block.dataset.lang ?? '';
		const actions = block.querySelector('.actions')!;
		actions.append(
			button('', 'copy', () => post({ type: 'copy', text: code }), { title: 'Copy', cls: 'icon-btn' }),
			button('', 'insert', () => post({ type: 'insertCode', code }), { title: 'Insert at cursor', cls: 'icon-btn' }),
			button('', 'git-pull-request-go-to-changes', () => post({ type: 'applyCode', code, lang }), { title: 'Apply to the active editor (diff first)', cls: 'icon-btn' }),
		);
		if (/^(sh|bash|shell|powershell|ps1|pwsh|cmd|console|zsh|bat)$/i.test(lang)) {
			actions.append(button('', 'terminal', () => {
				toggleTerminal(true);
				termInput.value = code.trim().split('\n')[0];
				termInput.focus();
			}, { title: 'Put into the chat terminal (you press Enter)', cls: 'icon-btn' }));
		}
	});
	root.querySelectorAll<HTMLElement>('code').forEach(c => {
		if (c.closest('pre')) return;
		const m = /^([\w./\\-]+\.[a-zA-Z0-9]{1,6})(?::(\d+))?$/.exec(c.textContent ?? '');
		if (m) {
			c.classList.add('file-link');
			c.title = 'Open file';
			c.addEventListener('click', () => post({ type: 'openFile', path: m[1], line: m[2] ? Number(m[2]) : undefined }));
		}
	});
}

// ------------------------------------------------------------------ inline confirmations / edit

function inlinePanel(anchor: HTMLElement, content: HTMLElement[]): HTMLElement {
	anchor.parentElement?.querySelectorAll('.inline-panel').forEach(p => p.remove());
	const panel = h('div', { class: 'inline-panel' }, ...content);
	anchor.after(panel);
	panel.scrollIntoView({ block: 'nearest' });
	return panel;
}

function filesCheckbox(count: number, text: string): { row?: HTMLElement; checked: () => boolean } {
	if (!count) return { checked: () => false };
	const cb = h('input', { type: 'checkbox' });
	cb.checked = true;
	return { row: h('label', { class: 'check' }, cb, ` ${text}`), checked: () => cb.checked };
}

function confirmRevert(el: HTMLElement, index: number, turns: Turn[]): void {
	const cps = laterCheckpoints(turns, index);
	const files = filesCheckbox(cps, 'Also undo the file changes made since this message');
	const panel = inlinePanel(el, [
		h('div', {}, icon('discard'), ' Revert the chat to before this message? The message goes back into the input box.'),
		...(files.row ? [files.row] : []),
		h('div', { class: 'row-btns' },
			button('Revert', 'discard', () => {
				panel.remove();
				post({ type: 'revert', index, restoreFiles: files.checked() });
			}, { primary: true, cls: 'small' }),
			button('Cancel', undefined, () => panel.remove(), { cls: 'small' })),
	]);
}

function confirmRegenerate(el: HTMLElement, index: number, turns: Turn[]): void {
	let u = index;
	while (u >= 0 && turns[u].role !== 'user') u--;
	const cps = laterCheckpoints(turns, u + 1);
	if (!cps) return post({ type: 'regenerate', index });
	const panel = inlinePanel(el, [
		h('div', {}, icon('refresh'), ` Regenerate? This undoes the file changes from this response (${cps} checkpoint${cps > 1 ? 's' : ''}) and runs the request again.`),
		h('div', { class: 'row-btns' },
			button('Regenerate', 'refresh', () => {
				panel.remove();
				post({ type: 'regenerate', index });
			}, { primary: true, cls: 'small' }),
			button('Cancel', undefined, () => panel.remove(), { cls: 'small' })),
	]);
}

function startEdit(el: HTMLElement, t: Turn, index: number, turns: Turn[]): void {
	const ta = h('textarea', { class: 'edit-box', rows: '3' });
	ta.value = t.text ?? '';
	const cps = laterCheckpoints(turns, index);
	const files = filesCheckbox(cps, 'Undo the file changes made since this message');
	const submit = () => {
		const text = ta.value.trim();
		if (!text) return;
		post({ type: 'edit', index, text, restoreFiles: files.checked() });
	};
	const panel = h('div', { class: 'edit-panel' }, ta, ...(files.row ? [files.row] : []), h('div', { class: 'row-btns' }, button('Send', 'arrow-right', submit, { primary: true, cls: 'small' }), button('Cancel', undefined, () => renderMessages(), { cls: 'small' })));
	el.replaceChildren(panel);
	ta.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') renderMessages();
	});
	ta.focus();
	ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ------------------------------------------------------------------ streaming

function ensureStream(): { turn: Turn; el: HTMLElement } {
	if (!streamTurn || !streamEl) {
		const turns = state?.conversation?.turns;
		streamTurn = turns?.[turns.length - 1] ?? { role: 'assistant', parts: [], ts: Date.now() };
		streamEl = messages.lastElementChild as HTMLElement;
	}
	return { turn: streamTurn, el: streamEl };
}

function partsEl(): HTMLElement | undefined {
	return ensureStream().el?.querySelector('.parts') as HTMLElement | undefined;
}

/** "Working..." dots until the first output of a turn arrives. */
function updateWorking(): void {
	const pe = partsEl();
	if (!pe) return;
	pe.querySelector('.working')?.remove();
	if (state?.running && !(streamTurn?.parts ?? []).length) pe.append(h('div', { class: 'working' }, h('span', {}), h('span', {}), h('span', {})));
}

function scheduleRender(): void {
	if (renderPending) return;
	renderPending = true;
	requestAnimationFrame(() => {
		renderPending = false;
		const { turn } = ensureStream();
		const pe = partsEl();
		if (!pe) return;
		pe.querySelector('.working')?.remove();
		const parts = turn.parts ?? [];
		const lastIdx = parts.length - 1;
		const last = parts[lastIdx];
		const lastEl = pe.children[lastIdx] as HTMLElement | undefined;
		if (last && lastEl && (last.type === 'text' || last.type === 'thinking') && pe.children.length === parts.length) {
			const fresh = renderPart(last);
			if (last.type === 'thinking' && lastEl.hasAttribute('open')) fresh.setAttribute('open', '');
			pe.replaceChild(fresh, lastEl);
		} else {
			pe.replaceChildren(...parts.map(renderPart));
		}
		scrollToBottom();
	});
}

function appendStreamPart(p: Part): void {
	const { turn } = ensureStream();
	turn.parts ??= [];
	turn.parts.push(p);
	const pe = partsEl();
	pe?.querySelector('.working')?.remove();
	pe?.append(renderPart(p));
	scrollToBottom();
}

function scrollToBottom(force = false): void {
	const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160;
	if (force || nearBottom) messages.scrollTop = messages.scrollHeight;
}

// ------------------------------------------------------------------ history

function toggleHistory(show?: boolean): void {
	const hidden = show === undefined ? !historyPanel.classList.contains('hidden') : !show;
	historyPanel.classList.toggle('hidden', hidden);
	historyBtn.classList.toggle('active', !hidden);
	if (!hidden) {
		historySearch.value = '';
		historySearch.focus();
	}
}

function renderHistory(items: { summary: { id: string; title: string; updated: number; turns: number; kind?: string }; snippet: string }[]): void {
	historyList.replaceChildren(...items.map(({ summary: c, snippet }) => {
		const row = h('div', { class: `hist-row ${state?.conversation?.id === c.id ? 'active' : ''}`, tabindex: '0', role: 'button' },
			icon(c.kind === 'inline' ? 'sparkle' : 'comment'),
			h('div', { class: 'hist-main' },
				h('div', { class: 'hist-title' }, c.title),
				h('div', { class: 'hist-meta muted' }, `${timeAgo(c.updated)} · ${Math.ceil(c.turns / 2)} message${c.turns > 2 ? 's' : ''}${c.kind === 'inline' ? ' · editor action' : ''}${snippet && snippet !== c.title ? ` · ${snippet}` : ''}`)),
		);
		row.append(button('', 'trash', () => post({ type: 'delete', id: c.id }), { title: 'Delete chat', cls: 'icon-btn del' }));
		const open = () => {
			post({ type: 'open', id: c.id });
			toggleHistory(false);
		};
		row.addEventListener('click', e => {
			if ((e.target as HTMLElement).closest('.del')) return;
			open();
		});
		row.addEventListener('keydown', e => e.key === 'Enter' && open());
		return row;
	}));
	if (!items.length) historyList.append(h('div', { class: 'muted pad' }, 'No chats yet.'));
}

// ------------------------------------------------------------------ menus (slash, @, files, model, add, more)

function showMenu(items: MenuItem[], onPick: (it: MenuItem) => void, anchor: 'input' | HTMLElement = 'input'): void {
	if (!items.length) return closeMenu();
	menu.replaceChildren();
	let first = -1;
	items.forEach((it, i) => {
		if (it.header) {
			menu.append(h('div', { class: 'menu-header' }, it.label));
			return;
		}
		if (first < 0) first = i;
		const row = h('div', { class: `menu-item ${it.checked ? 'checked' : ''}`, role: 'option', 'data-i': String(i) },
			it.icon ? icon(it.icon) : h('span', { class: 'menu-ic' }), h('span', { class: 'm-label' }, it.label), it.detail ? h('span', { class: 'm-detail muted' }, it.detail) : undefined, it.checked ? icon('check', 'm-check') : undefined);
		row.addEventListener('mousedown', e => {
			e.preventDefault();
			onPick(it);
		});
		menu.append(row);
	});
	menu.classList.toggle('floating', anchor !== 'input');
	menu.removeAttribute('style');
	if (anchor !== 'input') {
		// Anchored menus (model, +, ...) open next to their button, above or below depending on space.
		const r = anchor.getBoundingClientRect();
		const width = Math.min(300, window.innerWidth - 16);
		menu.style.width = `${width}px`;
		menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
		if (r.top < window.innerHeight / 2) {
			menu.style.top = `${r.bottom + 4}px`;
			menu.style.maxHeight = `${window.innerHeight - r.bottom - 16}px`;
		} else {
			menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
			menu.style.maxHeight = `${r.top - 16}px`;
		}
	}
	menu.classList.remove('hidden');
	menuState = { el: menu, items, sel: first, onPick };
	highlightMenu();
}

function highlightMenu(): void {
	if (!menuState) return;
	menu.querySelectorAll('.menu-item').forEach(r => r.classList.toggle('sel', Number((r as HTMLElement).dataset.i) === menuState!.sel));
	menu.querySelector('.menu-item.sel')?.scrollIntoView({ block: 'nearest' });
}

function moveMenu(delta: number): void {
	if (!menuState) return;
	const idx = menuState.items.map((it, i) => (it.header ? -1 : i)).filter(i => i >= 0);
	const cur = idx.indexOf(menuState.sel);
	menuState.sel = idx[Math.max(0, Math.min(idx.length - 1, cur + delta))];
	highlightMenu();
}

function closeMenu(): void {
	menu.classList.add('hidden');
	menuState = undefined;
}

function replaceToken(re: RegExp, insert: string): void {
	const before = input.value.slice(0, input.selectionStart).replace(re, '');
	const after = input.value.slice(input.selectionStart);
	input.value = before + insert + after;
	input.selectionStart = input.selectionEnd = (before + insert).length;
	autosize();
	input.focus();
	requestPreview();
}

function openSlash(query: string): void {
	const q = query.toLowerCase();
	const items: MenuItem[] = (state?.slash ?? []).filter(c => c.cmd.startsWith(q) || c.label.toLowerCase().startsWith(q)).map(c => ({ label: `/${c.cmd}`, detail: c.detail, icon: c.agent ? agentIcon(c.agent) : c.cmd === 'remember' ? 'database' : c.cmd === 'terminal' ? 'terminal' : 'add', insert: `/${c.cmd} ` }));
	showMenu(items, it => {
		closeMenu();
		if (it.insert === '/new ') {
			input.value = '';
			post({ type: 'newChat' });
			return;
		}
		if (it.insert === '/terminal ') {
			input.value = '';
			toggleTerminal(true);
			return;
		}
		replaceToken(/^\/[\w-]*$/, it.insert!);
	});
}

function applyMention(it: MenuItem): void {
	closeMenu();
	replaceToken(/@[\w./:"\\-]*$/, `${it.insert} `);
}

function applyFileLink(it: MenuItem): void {
	closeMenu();
	replaceToken(/(?:[A-Za-z]:)?[\w./\\-]+$/, `${it.insert} `);
}

function openModelMenu(): void {
	if (!state) return;
	const items: MenuItem[] = [];
	const cur = state.selected.model;
	items.push({ label: 'Auto', detail: `chat: ${shortModel(state.autoModels.chat) || '-'} · code: ${shortModel(state.autoModels.coding) || '-'}`, icon: 'sparkle', checked: !cur, run: () => post({ type: 'select', model: null }) });
	if (state.providers.length > 1) {
		items.push({ label: 'Providers Auto may use', header: true });
		const chosen = state.autoProviders;
		for (const p of state.providers) {
			const on = !chosen.length || chosen.includes(p.id);
			items.push({ label: p.label, detail: p.local ? 'local' : 'cloud', icon: p.local ? 'vm' : 'cloud', checked: on, run: () => {
				const base = chosen.length ? chosen : state!.providers.map(x => x.id);
				const next = on ? base.filter(x => x !== p.id) : [...base, p.id];
				if (!next.length) return toast('Keep at least one provider for Auto.');
				post({ type: 'setAutoProviders', providers: next.length === state!.providers.length ? [] : next });
			} });
		}
	}
	const byProvider = new Map<string, State['models']>();
	for (const m of state.models.filter(x => !(x.caps.includes('embeddings') && !x.caps.includes('chat')))) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
	for (const [prov, list] of byProvider) {
		items.push({ label: `${prov} - use for everything`, header: true });
		for (const m of list) items.push({ label: m.label.replace(/:latest/, ''), detail: m.caps.includes('tools') ? 'tools' : '', icon: m.local ? 'vm' : 'cloud', checked: cur === m.ref, run: () => post({ type: 'select', model: m.ref }) });
	}
	items.push({ label: 'Settings', header: true }, { label: 'Model for each role...', icon: 'settings-gear', run: () => post({ type: 'command', command: 'aide.settings.open', args: ['routing'] }) }, { label: 'Refresh models', icon: 'refresh', run: () => post({ type: 'command', command: 'aide.model.refresh' }) });
	showMenu(items, it => {
		closeMenu();
		it.run?.();
	}, modelPill);
}

function openAddMenu(): void {
	const strategies: [string, string][] = [['minimal', 'only what you mention'], ['balanced', 'active file, problems, search hits'], ['deep', '+ related and open files, git diff'], ['maximum', 'as much as fits']];
	const items: MenuItem[] = [
		{ label: 'File or folder...', icon: 'file', detail: '@', run: () => {
			replaceToken(/$/, `${input.value && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' ' : ''}@`);
			openMentions('');
		} },
		{ label: 'Terminal output', icon: 'terminal', detail: '@terminal', run: () => replaceToken(/$/, ' @terminal ') },
		{ label: 'Problems', icon: 'warning', detail: '@errors', run: () => replaceToken(/$/, ' @errors ') },
		{ label: 'Git changes', icon: 'git-commit', detail: '@git', run: () => replaceToken(/$/, ' @git ') },
		{ label: 'Output panel log...', icon: 'output', detail: '@output', run: () => {
			replaceToken(/$/, ' @output:');
			openMentions('output:');
		} },
		{ label: 'Image...', icon: 'file-media', run: () => imageInput.click() },
		{ label: 'Context level', header: true },
		...strategies.map(([s, d]) => ({ label: s[0].toUpperCase() + s.slice(1), detail: d, icon: 'layers', checked: state?.selected.strategy === s, run: () => {
			post({ type: 'select', strategy: s });
			requestPreview();
		} })),
	];
	showMenu(items, it => {
		closeMenu();
		it.run?.();
	}, addBtn);
}

function openMoreMenu(): void {
	const has = !!state?.conversation?.turns.length;
	const items: MenuItem[] = [
		...(has ? [{ label: 'Copy chat as Markdown', icon: 'copy', run: () => post({ type: 'copyChat' }) }, { label: 'Open chat log', icon: 'output', run: () => post({ type: 'openLog' }) }] : []),
		{ label: 'Memory', icon: 'database', detail: 'what agents remember', run: () => post({ type: 'command', command: 'aide.project.openMemory' }) },
		{ label: 'Personal memory', icon: 'account', detail: 'all projects', run: () => post({ type: 'command', command: 'aide.memory.openUser' }) },
		{ label: 'Context Inspector', icon: 'inspect', run: () => post({ type: 'command', command: 'aide.inspector.open' }) },
		{ label: 'Usage', icon: 'graph', detail: state?.summary.replace(/^Today: /, ''), run: () => post({ type: 'command', command: 'aide.usage.open' }) },
		{ label: 'Chat logs folder', icon: 'folder-opened', run: () => post({ type: 'command', command: 'aide.chat.openLogsFolder' }) },
		{ label: 'Agent', header: true },
		{ label: 'Auto (recommended)', icon: 'sparkle', checked: state?.selected.agentMode === 'auto', detail: 'picks the agent per message', run: () => post({ type: 'select', agentMode: 'auto' }) },
		...(state?.agents ?? []).map(a => ({ label: a.name, icon: agentIcon(a.id), checked: state?.selected.agentMode === a.id, detail: 'always', run: () => post({ type: 'select', agentMode: a.id }) })),
		{ label: 'Settings', header: true },
		{ label: 'AI settings', icon: 'settings-gear', run: () => post({ type: 'command', command: 'aide.settings.open' }) },
	];
	showMenu(items, it => {
		closeMenu();
		it.run?.();
	}, moreBtn);
}

function openMentions(query: string): void {
	post({ type: 'mentionQuery', query });
}

// ------------------------------------------------------------------ composer

function autosize(): void {
	input.style.height = 'auto';
	input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

function persistDraft(): void {
	vscode.setState({ ...vscode.getState(), draft: input.value, attachments });
}

function send(): void {
	const text = input.value.trim();
	if ((!text && !attachments.length) || state?.running) return;
	window.clearTimeout(previewTimer);
	closeMenu();
	post({ type: 'send', text: text || 'See the attached output.', model: state?.selected.model || undefined, strategy: state?.selected.strategy, exclude: excluded, images, attachments });
	input.value = '';
	images = [];
	excluded = [];
	attachments = [];
	intentHint.textContent = '';
	chips.replaceChildren();
	autosize();
	persistDraft();
}

function requestPreview(): void {
	window.clearTimeout(previewTimer);
	previewTimer = window.setTimeout(() => post({ type: 'preview', text: input.value, strategy: state?.selected.strategy, exclude: excluded, attachments }), 250);
}

input.addEventListener('input', () => {
	autosize();
	persistDraft();
	requestPreview();
	const upto = input.value.slice(0, input.selectionStart);
	const slash = /^\/([\w-]*)$/.exec(upto);
	const at = /(^|\s)@([\w./:"\\-]*)$/.exec(upto);
	const file = /(^|\s)((?:[A-Za-z]:[\\/])?[\w-][\w.\\/-]*\.[A-Za-z0-9]{1,6}|[\w-]+[\\/][\w.\\/-]+)$/.exec(upto);
	if (slash) openSlash(slash[1]);
	else if (at) openMentions(at[2].replace(/^(file|folder|symbol):/, ''));
	else if (file && file[2].length >= 3) post({ type: 'fileSuggest', query: file[2] });
	else closeMenu();
});

input.addEventListener('keydown', e => {
	if (menuState && !menu.classList.contains('hidden')) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			moveMenu(e.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if ((e.key === 'Enter' || e.key === 'Tab') && menuState.sel >= 0) {
			e.preventDefault();
			menuState.onPick(menuState.items[menuState.sel]);
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			closeMenu();
			return;
		}
	}
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		send();
	} else if (e.key === 'Escape' && state?.running) {
		post({ type: 'cancel' });
	}
});

input.addEventListener('blur', () => setTimeout(() => {
	if (document.activeElement !== input && !menu.matches(':hover')) closeMenu();
}, 150));

/** Long or terminal-like pastes become a compact block instead of flooding the input. */
function classifyPaste(text: string): Attachment | undefined {
	const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
	const terminalish = /^(PS [A-Z]:\\|[$>#] |\w+@[\w-]+:|C:\\[^>]*>)|Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)|npm (ERR|WARN)|error(\[\w+\])?:|exit code|Exception/im.test(text);
	if (lines.length >= 12 || text.length > 1500 || (terminalish && lines.length >= 3)) {
		const errorish = /error|exception|traceback|failed/i.test(text);
		return { kind: terminalish ? 'terminal' : 'text', label: terminalish ? (errorish ? 'Error output' : 'Terminal output') : 'Pasted text', text: lines.join('\n') };
	}
	return undefined;
}

input.addEventListener('paste', e => {
	const dt = e.clipboardData;
	for (const item of dt?.items ?? []) {
		if (item.type.startsWith('image/')) {
			const file = item.getAsFile();
			if (!file) continue;
			e.preventDefault();
			readImage(file, item.type);
			return;
		}
	}
	const text = dt?.getData('text/plain') ?? '';
	const block = classifyPaste(text);
	if (block) {
		e.preventDefault();
		addAttachment(block);
		return;
	}
	// A pasted path to a workspace file becomes a file link.
	if (/^\s*"?([A-Za-z]:[\\/]|\/|\.{0,2}[\\/]?[\w-]+[\\/])[^\n]*\.[A-Za-z0-9]{1,8}"?\s*$/.test(text)) {
		e.preventDefault();
		post({ type: 'pastePath', text: text.trim().replace(/^"|"$/g, '') });
	}
});

function readImage(file: File, type: string): void {
	const reader = new FileReader();
	reader.onload = () => {
		images.push({ mediaType: type, data: String(reader.result).split(',')[1], name: file.name || 'image' });
		renderChips();
	};
	reader.readAsDataURL(file);
}

imageInput.addEventListener('change', () => {
	for (const f of imageInput.files ?? []) readImage(f, f.type);
	imageInput.value = '';
});

function addAttachment(a: Attachment): void {
	attachments.push(a);
	persistDraft();
	renderChips();
	requestPreview();
	input.focus();
}

function attachmentPill(a: { kind: string; label: string; text?: string; lines?: number }, text?: string, onRemove?: () => void): HTMLElement {
	const lines = a.lines ?? (text ?? '').split('\n').length;
	const pill = h('span', { class: `att ${a.kind}`, title: text ? text.split('\n').slice(0, 25).join('\n') + (lines > 25 ? '\n...' : '') : a.label }, icon(a.kind === 'terminal' ? 'terminal' : a.kind === 'output' ? 'output' : 'note'), h('span', {}, `${a.label}`), h('span', { class: 'muted' }, ` ${lines} lines`));
	if (text) {
		pill.classList.add('clickable');
		pill.addEventListener('click', e => {
			if ((e.target as HTMLElement).closest('.icon-btn')) return;
			showAttachmentPreview(pill, a.label, text);
		});
	}
	if (onRemove) pill.append(button('', 'close', onRemove, { cls: 'icon-btn tiny', title: 'Remove' }));
	return pill;
}

function showAttachmentPreview(anchor: HTMLElement, label: string, text: string): void {
	document.querySelectorAll('.att-preview').forEach(p => p.remove());
	const pop = h('div', { class: 'att-preview' }, h('div', { class: 'att-preview-head' }, h('strong', {}, label), h('div', { class: 'spacer' }), button('', 'close', () => pop.remove(), { cls: 'icon-btn' })), h('pre', {}, text.length > 20_000 ? `${text.slice(0, 20_000)}\n...` : text));
	anchor.closest('.msg, .composer')?.append(pop);
}

let lastPreview: any;
function renderChips(p = lastPreview): void {
	lastPreview = p;
	chips.replaceChildren();
	attachments.forEach((a, i) => chips.append(attachmentPill(a, a.text, () => {
		attachments.splice(i, 1);
		persistDraft();
		renderChips();
		requestPreview();
	})));
	images.forEach((img, i) => chips.append(h('span', { class: 'att' }, icon('file-media'), ` ${img.name} `, button('', 'close', () => {
		images.splice(i, 1);
		renderChips();
	}, { cls: 'icon-btn tiny', title: 'Remove' }))));
	// A late preview for an already-sent message must not leave chips behind.
	if (!p || (!input.value.trim() && !attachments.length)) return;
	for (const it of p.items.filter((x: any) => !x.key.startsWith('attach:'))) {
		const chip = h('span', { class: `chip ${it.deduped ? 'deduped' : ''}`, title: `${it.reason}${it.truncated ? ' (summarized)' : ''}${it.deduped ? ' (already sent earlier - not resent)' : ''} · ~${fmtTokens(it.tokens)} tokens` }, icon(kindIcon(it.kind)), h('span', { class: 'chip-label' }, it.label));
		chip.append(button('', 'close', () => {
			excluded.push(it.key);
			requestPreview();
		}, { cls: 'icon-btn tiny', title: 'Do not send this' }));
		chips.append(chip);
	}
	const pct = Math.round((p.total / p.budget) * 100);
	if (p.items.length) chips.append(h('span', { class: `ctx-total ${pct > 90 ? 'warn' : ''}`, title: p.dropped.length ? `Not included: ${p.dropped.map((d: any) => `${d.label} (${d.reason})`).join(', ')}` : `Estimated context tokens / budget (${state?.selected.strategy} context)` }, `~${fmtTokens(p.total)}`));
}

function renderIntent(intent?: { agent: string; reason: string; forced: boolean }): void {
	intentHint.textContent = intent && input.value.trim() ? `→ ${intent.agent}` : '';
	intentHint.title = intent ? `${intent.forced ? 'Chosen' : 'Auto'}: ${intent.reason}` : '';
}

// ------------------------------------------------------------------ chat terminal

function toggleTerminal(show?: boolean): void {
	const visible = show ?? termDrawer.classList.contains('hidden');
	termDrawer.classList.toggle('hidden', !visible);
	termBtn.classList.toggle('active', visible);
	if (visible) termInput.focus();
}

function termWrite(text: string, cls?: string): void {
	const span = h('span', cls ? { class: cls } : {}, text);
	termOut.append(span);
	if (termOut.textContent!.length > 400_000) termOut.firstChild?.remove();
	termOut.scrollTop = termOut.scrollHeight;
}

function runInTerminal(command: string): void {
	if (!command.trim() || termRunning) return;
	toggleTerminal(true);
	termRunning = true;
	termLast = { command, output: '' };
	termStatus.textContent = ' · running';
	termWrite(`❯ ${command}\n`, 'term-cmd');
	termHistory.push(command);
	termHistIdx = termHistory.length;
	post({ type: 'termRun', command });
}

function attachTerminalOutput(): void {
	if (!termLast) return toast('Run a command first.');
	addAttachment({ kind: 'terminal', label: /error|exception|traceback/i.test(termLast.output) || (termLast.exitCode ?? 0) !== 0 ? 'Error output' : 'Terminal output', text: `$ ${termLast.command}\n${termLast.output.trimEnd()}${termLast.exitCode !== undefined ? `\n[exit code ${termLast.exitCode}]` : ''}` });
}

termInput.addEventListener('keydown', e => {
	if (e.key === 'Enter') {
		e.preventDefault();
		const cmd = termInput.value;
		termInput.value = '';
		runInTerminal(cmd);
	} else if (e.key === 'c' && e.ctrlKey && termRunning && !termInput.selectionStart) {
		e.preventDefault();
		post({ type: 'termKill' });
	} else if (e.key === 'ArrowUp' && termHistory.length) {
		e.preventDefault();
		termHistIdx = Math.max(0, termHistIdx - 1);
		termInput.value = termHistory[termHistIdx] ?? '';
	} else if (e.key === 'ArrowDown' && termHistory.length) {
		e.preventDefault();
		termHistIdx = Math.min(termHistory.length, termHistIdx + 1);
		termInput.value = termHistory[termHistIdx] ?? '';
	} else if (e.key === 'Escape') toggleTerminal(false);
});

// ------------------------------------------------------------------ approvals

function renderApproval(id: string, r: { category: string; toolName: string; agentId: string; summary: string; dangerous?: string; detail?: string; hasDiff: boolean; afterPreview?: string }): void {
	const card = h('div', { class: `approval ${r.dangerous ? 'dangerous' : ''}`, 'data-id': id, role: 'alertdialog', 'aria-label': 'Approval required' });
	card.append(h('div', { class: 'ap-title' }, icon(r.dangerous ? 'warning' : 'shield'), h('strong', {}, r.summary)));
	card.append(h('div', { class: 'muted small' }, `${r.agentId} · ${r.category} (${r.toolName})`));
	if (r.dangerous) card.append(h('div', { class: 'danger-text' }, `Potentially destructive: ${r.dangerous}. This approval is not remembered.`));
	if (r.detail) card.append(h('pre', { class: 'ap-detail' }, r.detail));
	if (r.afterPreview) card.append(h('pre', { class: 'ap-detail' }, r.afterPreview));
	const answer = (allow: boolean, scope: string) => {
		post({ type: 'approval', id, allow, scope });
		card.remove();
	};
	const row = h('div', { class: 'ap-buttons' });
	row.append(button('Allow', 'check', () => answer(true, 'once'), { primary: true, cls: 'small', title: 'Allow this action once' }));
	if (r.hasDiff) row.append(button('Diff', 'diff', () => post({ type: 'approvalDiff', id }), { cls: 'small' }));
	if (!r.dangerous) {
		const more = h('select', { class: 'small-select', title: 'Remember this approval' }, h('option', { value: '' }, 'Always allow...'), h('option', { value: 'session' }, 'for this session'), h('option', { value: 'workspace' }, 'in this workspace'), h('option', { value: 'always' }, 'everywhere'));
		more.addEventListener('change', () => more.value && answer(true, more.value));
		row.append(more);
	}
	row.append(h('div', { class: 'spacer' }), button('Deny', 'close', () => answer(false, 'once'), { cls: 'small danger' }));
	card.append(row);
	approvals.append(card);
	card.scrollIntoView({ block: 'nearest' });
}

function toast(text: string): void {
	toastEl.textContent = text;
	toastEl.classList.remove('hidden');
	window.clearTimeout((toastEl as any)._t);
	(toastEl as any)._t = window.setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

// ------------------------------------------------------------------ messages from the extension

window.addEventListener('message', ev => {
	const m = ev.data;
	switch (m.type) {
		case 'state':
			state = m;
			renderState();
			break;
		case 'runStart':
			sendBtn.classList.add('hidden');
			stopBtn.classList.remove('hidden');
			break;
		case 'runEnd':
			sendBtn.classList.remove('hidden');
			stopBtn.classList.add('hidden');
			approvals.replaceChildren();
			break;
		case 'delta': {
			const { turn } = ensureStream();
			turn.parts ??= [];
			const last = turn.parts[turn.parts.length - 1];
			if (last?.type === 'text') last.text += m.text;
			else appendStreamPart({ type: 'text', text: m.text });
			scheduleRender();
			break;
		}
		case 'thinking': {
			const { turn } = ensureStream();
			turn.parts ??= [];
			const last = turn.parts[turn.parts.length - 1];
			if (last?.type === 'thinking') last.text += m.text;
			else appendStreamPart({ type: 'thinking', text: m.text });
			scheduleRender();
			break;
		}
		case 'resetStream': {
			const { turn } = ensureStream();
			while (turn.parts?.length && ['text', 'thinking'].includes(turn.parts[turn.parts.length - 1].type)) turn.parts.pop();
			partsEl()?.replaceChildren(...(turn.parts ?? []).map(renderPart));
			updateWorking();
			break;
		}
		case 'part':
			appendStreamPart(m.part);
			break;
		case 'toolOutput': {
			const el = partsEl()?.querySelector(`details.tool[data-id="${CSS.escape(m.id)}"] .tool-result`);
			if (el) {
				el.textContent += m.text;
				if (el.textContent!.length > 60_000) el.textContent = el.textContent!.slice(-50_000);
				el.scrollTop = el.scrollHeight;
			}
			break;
		}
		case 'toolEnd': {
			const { turn } = ensureStream();
			const p = turn.parts?.find(x => x.type === 'tool' && x.id === m.id) as Extract<Part, { type: 'tool' }> | undefined;
			if (p) {
				Object.assign(p, { result: m.result, isError: m.isError, denied: m.denied, durationMs: m.durationMs });
				partsEl()?.querySelector(`details.tool[data-id="${CSS.escape(m.id)}"]`)?.replaceWith(renderTool(p));
			}
			break;
		}
		case 'model': {
			const { turn, el } = ensureStream();
			turn.model = m.ref;
			const who = el?.querySelector('.who');
			if (who) {
				who.querySelector('.model')?.remove();
				who.append(h('span', { class: 'model muted', title: m.ref }, shortModel(m.ref)));
			}
			break;
		}
		case 'usage': {
			const { turn } = ensureStream();
			turn.usage = m.usage;
			turn.requestIds = [...(turn.requestIds ?? []), m.requestId];
			break;
		}
		case 'usageSummary':
			disclaimer.title = m.summary;
			break;
		case 'approval':
			renderApproval(m.id, m.request);
			break;
		case 'contextPreview':
			renderChips(m);
			renderIntent(m.intent);
			break;
		case 'mentionResults':
			showMenu(m.items.map((it: any) => ({ label: it.label, detail: it.detail, icon: kindIcon(it.kind === 'special' ? it.label : it.kind), insert: it.insert })), applyMention);
			break;
		case 'fileSuggestions':
			if (m.items.length) showMenu([{ label: 'Link file', header: true }, ...m.items.map((it: any) => ({ label: it.label, detail: it.detail, icon: 'file', insert: it.insert }))], applyFileLink);
			else closeMenu();
			break;
		case 'searchResults':
			renderHistory(m.results);
			break;
		case 'insert':
			if (m.replace) input.value = '';
			if (m.attachments) for (const a of m.attachments) if (a.text) attachments.push({ kind: a.kind, label: a.label, text: a.text });
			if (m.text) replaceToken(/$/, m.text);
			renderChips();
			requestPreview();
			if (m.send) send();
			break;
		case 'attach':
			addAttachment(m.attachment);
			break;
		case 'openTerminal':
			toggleTerminal(true);
			break;
		case 'termData':
			if (termLast && termLast.output.length < 200_000) termLast.output += m.text;
			termWrite(m.text);
			break;
		case 'termEnd':
			termRunning = false;
			if (termLast) termLast.exitCode = m.exitCode ?? undefined;
			termStatus.textContent = m.exitCode === 0 ? '' : ` · exit ${m.exitCode ?? (m.killed ? 'stopped' : '?')}`;
			termWrite(m.exitCode === 0 ? '' : `[${m.killed ? 'stopped' : `exit code ${m.exitCode}`}]\n`, 'term-exit');
			break;
		case 'termStart':
			runInTerminal(m.command);
			break;
		case 'toast':
			toast(m.text);
			break;
		case 'error':
			toast(String(m.message));
			break;
	}
});

document.addEventListener('mousedown', e => {
	const t = e.target as HTMLElement;
	if (!t.closest('.menu') && !t.closest('.pill') && !t.closest('.icon-btn')) closeMenu();
	if (!t.closest('.history') && !t.closest('.bar')) toggleHistory(false);
	if (!t.closest('.att-preview') && !t.closest('.att')) document.querySelectorAll('.att-preview').forEach(p => p.remove());
});

composer.addEventListener('dragover', e => e.preventDefault());
composer.addEventListener('drop', e => {
	e.preventDefault();
	const uris = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('application/vnd.code.uri-list') || '';
	if (uris) post({ type: 'dropUris', uris });
	for (const f of e.dataTransfer?.files ?? []) if (f.type.startsWith('image/')) readImage(f, f.type);
});

post({ type: 'ready' });
autosize();
renderChips();
if (input.value || attachments.length) requestPreview();
input.focus();
