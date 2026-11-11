import * as fs from 'fs';
import * as path from 'path';
import { messageText, type ChatMessage } from '../ai/types';

export type DisplayPart =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool'; id: string; name: string; summary: string; result?: string; isError?: boolean; denied?: boolean; durationMs?: number; path?: string }
	| { type: 'notice'; text: string; level: 'info' | 'warn' | 'error' }
	| { type: 'checkpoint'; id: string; files: number; paths?: string[] }
	| { type: 'action'; label: string; action: 'implementPlan'; arg?: string };

/** Text pasted or attached to a message (terminal output, logs), sent as context instead of inline text. */
export interface Attachment {
	kind: 'terminal' | 'text' | 'output';
	label: string;
	text: string;
}

export interface DisplayTurn {
	role: 'user' | 'assistant';
	text?: string;
	context?: { label: string; tokens: number; kind: string }[];
	attachments?: { kind: Attachment['kind']; label: string; lines: number; text?: string }[];
	parts?: DisplayPart[];
	agent?: string;
	agentId?: string;
	model?: string;
	/** how Auto chose the agent and model for this turn */
	route?: { auto: boolean; reason: string; modelReason?: string };
	usage?: { input: number; output: number; cost?: number };
	status?: string;
	ts: number;
	requestIds?: string[];
	/** index into Conversation.messages where this user turn starts (valid while epoch matches) */
	msgIndex?: number;
	epoch?: number;
}

export interface Conversation {
	id: string;
	title: string;
	created: number;
	updated: number;
	agentId: string;
	model?: string;
	workspace?: string;
	messages: ChatMessage[];
	turns: DisplayTurn[];
	/** context item key -> hash already sent (for dedup); reset when history is compacted */
	sentContext: Record<string, string>;
	/** bumped when history is compacted or truncated, which invalidates DisplayTurn.msgIndex */
	epoch?: number;
	/** "inline" for editor actions (Ctrl+Alt+I / K / .) recorded as chats */
	kind?: 'chat' | 'inline';
	branchOf?: { id: string; title: string };
}

export interface ConversationSummary {
	id: string;
	title: string;
	updated: number;
	agentId: string;
	workspace?: string;
	turns: number;
	kind?: 'chat' | 'inline';
}

/** One JSON file per conversation plus an index for fast listing and search. */
export class ConversationStore {
	private index: ConversationSummary[] = [];
	private cache = new Map<string, Conversation>();

	constructor(private readonly dir: string) {
		fs.mkdirSync(dir, { recursive: true });
		try {
			this.index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
		} catch {
			this.index = this.rebuildIndex();
		}
	}

	private rebuildIndex(): ConversationSummary[] {
		const out: ConversationSummary[] = [];
		for (const f of fs.readdirSync(this.dir).filter(f => f.startsWith('conv-') && f.endsWith('.json'))) {
			try {
				const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Conversation;
				out.push(summary(c));
			} catch {
				/* skip corrupt conversation files */
			}
		}
		return out.sort((a, b) => b.updated - a.updated);
	}

	create(agentId: string, workspace?: string): Conversation {
		const now = Date.now();
		const c: Conversation = { id: `conv-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title: 'New chat', created: now, updated: now, agentId, workspace, messages: [], turns: [], sentContext: {}, epoch: 0 };
		this.cache.set(c.id, c);
		return c;
	}

	/** Copy of a conversation up to and including turn `upto` ("branch from here"). */
	branch(src: Conversation, upto: number): Conversation {
		const c = this.create(src.agentId, src.workspace);
		c.turns = structuredClone(src.turns.slice(0, upto + 1));
		c.messages = messagesUpTo(src, upto + 1);
		c.title = `Branch: ${src.title.replace(/^Branch: /, '')}`.slice(0, 60);
		c.branchOf = { id: src.id, title: src.title };
		c.model = src.model;
		for (const t of c.turns) delete t.msgIndex;
		this.save(c);
		return c;
	}

	get(id: string): Conversation | undefined {
		const hit = this.cache.get(id);
		if (hit) return hit;
		try {
			const c = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as Conversation;
			c.sentContext ??= {};
			this.cache.set(id, c);
			return c;
		} catch {
			return undefined;
		}
	}

	save(c: Conversation): void {
		c.updated = Date.now();
		if (c.title === 'New chat') {
			const first = c.turns.find(t => t.role === 'user')?.text;
			if (first) c.title = first.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
		}
		const file = path.join(this.dir, `${c.id}.json`);
		fs.writeFileSync(file + '.tmp', JSON.stringify(c));
		fs.renameSync(file + '.tmp', file);
		this.index = [summary(c), ...this.index.filter(s => s.id !== c.id)].sort((a, b) => b.updated - a.updated);
		this.writeIndex();
	}

	rename(id: string, title: string): void {
		const c = this.get(id);
		if (!c) return;
		c.title = title;
		this.save(c);
	}

	delete(id: string): void {
		this.cache.delete(id);
		fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
		this.index = this.index.filter(s => s.id !== id);
		this.writeIndex();
	}

	list(workspace?: string): ConversationSummary[] {
		return workspace ? this.index.filter(s => !s.workspace || s.workspace === workspace) : this.index;
	}

	/** Full-text search over titles and displayed turns. */
	search(query: string, workspace?: string): { summary: ConversationSummary; snippet: string }[] {
		const q = query.toLowerCase().trim();
		if (!q) return this.list(workspace).map(s => ({ summary: s, snippet: '' }));
		const out: { summary: ConversationSummary; snippet: string }[] = [];
		for (const s of this.list(workspace)) {
			if (s.title.toLowerCase().includes(q)) {
				out.push({ summary: s, snippet: s.title });
				continue;
			}
			const c = this.get(s.id);
			if (!c) continue;
			for (const t of c.turns) {
				const text = [t.text ?? '', ...(t.parts ?? []).map(p => (p.type === 'text' ? p.text : ''))].join(' ');
				const i = text.toLowerCase().indexOf(q);
				if (i >= 0) {
					out.push({ summary: s, snippet: text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ') });
					break;
				}
			}
		}
		return out;
	}

	private writeIndex(): void {
		const file = path.join(this.dir, 'index.json');
		fs.writeFileSync(file + '.tmp', JSON.stringify(this.index));
		fs.renameSync(file + '.tmp', file);
	}
}

/**
 * Model history for the first `turnCount` display turns. Uses the recorded
 * message index when history was not compacted since; otherwise rebuilds a
 * text-only history from the display turns.
 */
export function messagesUpTo(c: Conversation, turnCount: number): ChatMessage[] {
	if (turnCount >= c.turns.length) return [...c.messages];
	const next = c.turns[turnCount];
	if (next?.role === 'user' && next.msgIndex !== undefined && (next.epoch ?? 0) === (c.epoch ?? 0)) return c.messages.slice(0, next.msgIndex);
	return messagesFromTurns(c.turns.slice(0, turnCount));
}

export function messagesFromTurns(turns: DisplayTurn[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const t of turns) {
		if (t.role === 'user') out.push({ role: 'user', content: t.text ?? '' });
		else {
			const text = assistantText(t);
			if (text) out.push({ role: 'assistant', content: text });
		}
	}
	return out;
}

export function assistantText(t: DisplayTurn): string {
	return (t.parts ?? []).flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n\n').trim();
}

/** Remove turn `index` and everything after it. Returns the removed turns. */
export function truncateConversation(c: Conversation, index: number): DisplayTurn[] {
	const next = c.turns[index];
	const exact = next?.role === 'user' && next.msgIndex !== undefined && (next.epoch ?? 0) === (c.epoch ?? 0);
	const messages = messagesUpTo(c, index);
	const removed = c.turns.splice(index);
	c.messages = messages;
	// Dedup state may refer to context that was only sent in the removed turns.
	c.sentContext = {};
	// A rebuilt history no longer lines up with the remaining turns' message indexes.
	if (!exact) c.epoch = (c.epoch ?? 0) + 1;
	return removed;
}

/** Checkpoint ids created by the given turns, oldest first. */
export function checkpointsIn(turns: DisplayTurn[]): string[] {
	return turns.flatMap(t => (t.parts ?? []).flatMap(p => (p.type === 'checkpoint' ? [p.id] : [])));
}

/** Readable Markdown transcript (copy chat, chat logs). */
export function toMarkdown(c: Conversation, opts: { tools?: boolean } = {}): string {
	const lines = [`# ${c.title}`, '', `_${new Date(c.created).toLocaleString()}${c.workspace ? ` · ${c.workspace}` : ''}_`, ''];
	for (const t of c.turns) {
		const time = new Date(t.ts).toLocaleTimeString();
		if (t.role === 'user') {
			lines.push(`## You · ${time}`, '', t.text ?? '');
			for (const a of t.attachments ?? []) lines.push('', `> [${a.label} · ${a.lines} lines]`);
			if (t.context?.length) lines.push('', `> Context: ${t.context.map(x => x.label).join(', ')}`);
			lines.push('');
			continue;
		}
		lines.push(`## ${t.agent ?? 'AIDE'}${t.model ? ` (${t.model})` : ''} · ${time}`, '');
		if (t.route?.auto) lines.push(`> Auto: ${t.route.reason}${t.route.modelReason ? ` · ${t.route.modelReason}` : ''}`, '');
		for (const p of t.parts ?? []) {
			if (p.type === 'text') lines.push(p.text, '');
			else if (p.type === 'tool') {
				lines.push(`- ${p.denied ? 'denied' : p.isError ? 'failed' : 'tool'}: \`${p.summary}\`${p.durationMs !== undefined ? ` (${(p.durationMs / 1000).toFixed(1)}s)` : ''}`);
				if (opts.tools && p.result) lines.push('', '```text', p.result.length > 4000 ? `${p.result.slice(0, 4000)}\n...` : p.result, '```', '');
			} else if (p.type === 'notice') lines.push(`> ${p.level}: ${p.text}`, '');
			else if (p.type === 'checkpoint') lines.push(`> checkpoint ${p.id}: ${p.files} file(s) changed`, '');
		}
		if (t.status && t.status !== 'completed') lines.push(`_${t.status}_`, '');
		if (t.usage && (t.usage.input || t.usage.output)) lines.push(`_${t.usage.input} tokens in · ${t.usage.output} out_`, '');
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Plain transcript of a model history. */
export function historyText(messages: ChatMessage[]): string {
	return messages.map(m => `[${m.role}] ${messageText(m)}`).join('\n');
}

function summary(c: Conversation): ConversationSummary {
	return { id: c.id, title: c.title, updated: c.updated, agentId: c.agentId, workspace: c.workspace, turns: c.turns.length, kind: c.kind };
}
