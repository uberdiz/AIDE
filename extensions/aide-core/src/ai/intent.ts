/**
 * Auto mode: decide which agent handles a chat message from what it asks for.
 * Deterministic and instant (no model call), so it can run on every message and
 * be shown to the user before anything is sent.
 */

export type Complexity = 'simple' | 'moderate' | 'complex';

export interface IntentResult {
	agentId: string;
	/** router task (model role) for the request */
	task: string;
	complexity: Complexity;
	/** short human explanation shown in the chat */
	reason: string;
	/** text with a leading /command removed */
	text: string;
	/** true when the user forced the agent with a /command */
	forced: boolean;
}

export interface IntentContext {
	hasImages?: boolean;
	hasWorkspace?: boolean;
	/** agent of the previous turn in this conversation, for short follow-ups ("yes, do it") */
	previousAgent?: string;
	/** ids of all available agents, so "/<agent-id>" works for custom agents too */
	agentIds?: string[];
	/** pasted terminal/error output is attached */
	hasErrorOutput?: boolean;
}

/** Slash commands shown in the composer's "/" menu. */
export const SLASH_COMMANDS: { cmd: string; agent?: string; label: string; detail: string }[] = [
	{ cmd: 'code', agent: 'coder', label: 'Code', detail: 'Create or change files, then verify' },
	{ cmd: 'plan', agent: 'planner', label: 'Plan', detail: 'Investigate and write a plan before coding' },
	{ cmd: 'debug', agent: 'debugger', label: 'Debug', detail: 'Reproduce a failure, find the root cause, fix it' },
	{ cmd: 'fix', agent: 'debugger', label: 'Fix', detail: 'Fix an error or a bug' },
	{ cmd: 'review', agent: 'reviewer', label: 'Review', detail: 'Review changes for bugs, security, style' },
	{ cmd: 'test', agent: 'tester', label: 'Test', detail: 'Write and run tests' },
	{ cmd: 'docs', agent: 'docs', label: 'Docs', detail: 'Write or update documentation' },
	{ cmd: 'explain', agent: 'chat', label: 'Explain', detail: 'Explain code without changing anything' },
	{ cmd: 'ask', agent: 'chat', label: 'Ask', detail: 'Question about the project (read-only)' },
	{ cmd: 'git', agent: 'coder-github', label: 'Git', detail: 'Commit, branch, push, pull requests' },
	{ cmd: 'remember', label: 'Remember', detail: 'Save a fact to project memory' },
	{ cmd: 'new', label: 'New chat', detail: 'Start a new conversation' },
	{ cmd: 'terminal', label: 'Terminal', detail: 'Open the chat terminal' },
];

const AGENT_TASK: Record<string, string> = { chat: 'chat', coder: 'coding', 'coder-github': 'coding', planner: 'planning', debugger: 'debug', reviewer: 'review', docs: 'coding', tester: 'coding', 'extension-builder': 'coding' };

export function taskForAgent(agentId: string, fallback = 'coding'): string {
	return AGENT_TASK[agentId] ?? fallback;
}

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;

const ACTION_VERBS = [
	'create', 'creating', 'make', 'making', 'build', 'building', 'write', 'writing', 'add', 'adding', 'implement', 'implementing', 'generate', 'generating',
	'code', 'coding', 'program', 'edit', 'editing', 'change', 'changing', 'modify', 'modifying', 'update', 'updating', 'refactor', 'refactoring', 'rename',
	'convert', 'port', 'translate', 'remove', 'removing', 'delete', 'deleting', 'move', 'replace', 'insert', 'install', 'set ?up', 'setup', 'scaffold',
	'develop', 'fix', 'fixing', 'finish', 'complete', 'improve', 'improving', 'extend', 'rewrite', 'restructure', 'clean ?up', 'optimi[sz]e', 'upgrade',
	'migrate', 'hook up', 'wire up', 'connect', 'run', 'execute', 'launch', 'test', 'integrate',
].join('|');

export function detectIntent(raw: string, ctx: IntentContext = {}): IntentResult {
	const trimmed = raw.trim();
	// 1. Explicit "/command" always wins.
	const slash = /^\/([\w-]+)\s*/.exec(trimmed);
	if (slash) {
		const word = slash[1].toLowerCase();
		const rest = trimmed.slice(slash[0].length);
		const known = SLASH_COMMANDS.find(c => c.cmd === word && c.agent);
		const agent = known?.agent ?? (ctx.agentIds?.includes(word) ? word : undefined);
		if (agent) return { agentId: agent, task: taskForAgent(agent), complexity: complexityOf(rest), reason: `/${word}`, text: rest || trimmed, forced: true };
	}

	// Score on prose: drop @mentions, code blocks and quoted output so file names and pasted code do not skew it.
	const prose = trimmed
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/@[\w-]+(:("[^"]*"|\S+))?/g, ' ')
		.toLowerCase();
	const words = prose.split(/\s+/).filter(Boolean);
	const complexity = complexityOf(trimmed);
	const result = (agentId: string, reason: string): IntentResult => ({ agentId, task: taskForAgent(agentId), complexity, reason, text: trimmed, forced: false });

	if (ctx.hasImages && !/\b(make|build|create|implement|code|write|change|fix)\b/.test(prose)) return { ...result('chat', 'image question'), task: 'vision' };

	const errorText = /traceback \(most recent call last\)|^\s*at [\w.<>$]+ \(|\b\w*(error|exception):|exit code [1-9]|npm err!|failed with exit code|segmentation fault/im.test(trimmed) || !!ctx.hasErrorOutput;
	const brokenWords = /\b(error|errors|exception|crash(es|ed|ing)?|traceback|stack ?trace|bug|bugs|broken|doesn'?t work|does not work|not working|won'?t (run|work|start|compile|build)|isn'?t working|fails?|failing|failed|wrong output|undefined is not|null pointer)\b/.test(prose);
	const questionStart = /^(what|why|how|where|when|who|which|explain|describe|tell me|is|are|does|do|can you explain|could you explain|what's|whats)\b/.test(prose);
	const actionVerb = new RegExp(`\\b(${ACTION_VERBS})\\b`).test(prose);
	const codeNoun = /\b(app|application|file|files|function|functions|class|method|script|component|module|api|endpoint|ui|gui|page|website|site|game|calculator|program|feature|code|project|cli|server|database|db|button|buttons|form|screen|window|menu|route|model|schema|test|tests|library|package|extension|plugin|bot|tool|parser|function|loop|variable)\b/.test(prose) || /\b[\w/-]+\.[a-z]{1,5}\b/.test(trimmed);
	const politeAsk = /\b(can you|could you|would you|please|i want you to|i need you to|help me|let'?s|i'?d like you to|go ahead|do it)\b/.test(prose);

	// 2. Specific agents by vocabulary.
	if (/\b(commit|push|pull request|open a pr|create a pr|\bpr\b|merge|rebase|branch|github issue|issue #\d+)\b/.test(prose) && !/\bbranch(ing)? (from|of) (this|the) chat\b/.test(prose)) return result('coder-github', 'git/GitHub request');
	if (/\b(review|audit|code smells?|look over|critique|security (issues|review|audit)|check (my|the|this) (code|changes|pr|diff))\b/.test(prose) && !actionVerb) return result('reviewer', 'review request');
	if (/\b(plan|roadmap|architecture|architect|design doc|spec(ification)?|break (it|this) down|step[- ]by[- ]step plan|how should (i|we) (structure|design|approach|build)|approach for|strategy for)\b/.test(prose) && !/\b(plan text|meal plan)\b/.test(prose)) return result('planner', 'planning request');
	if (/\b((write|add|create|generate|make)\s+(\w+\s+){0,3}(unit |integration |e2e )?tests?|test coverage|pytest|jest|vitest|unittest|mocha)\b/.test(prose)) return result('tester', 'test request');
	if (/\b(document|documentation|docstrings?|jsdoc|readme|write docs|add comments|comment (the|this) code)\b/.test(prose) && !/\bfix\b/.test(prose)) return result('docs', 'documentation request');
	if (/\b(vs ?code|aide) extension\b/.test(prose) && actionVerb) return result('extension-builder', 'extension request');

	// 3. Errors -> Debugger when the user wants something done about them, otherwise explain.
	if (errorText || brokenWords) {
		if (actionVerb || politeAsk || errorText || !questionStart) return result('debugger', errorText ? 'error output attached' : 'something is broken');
		return result('chat', 'question about an error');
	}

	// 4. Build/change requests -> Coder; questions ("how do I make...") -> Chat.
	const ask = questionStart && !politeAsk && !/^(how|what) (about|if) /.test(prose);
	if (actionVerb && !ask && (codeNoun || politeAsk || ctx.hasWorkspace !== false)) return result('coder', 'asks to create or change code');
	if (!ask && codeNoun && /\b(with|that|which) (a|an|the)?\s*\w+/.test(prose) && words.length <= 20) return result('coder', 'describes something to build');

	// 5. Short follow-ups continue with the previous agent ("yes", "like a normal app", "continue").
	if (ctx.previousAgent && ctx.previousAgent !== 'chat' && words.length <= 14 && !ask) return result(ctx.previousAgent, 'follow-up');
	if (ctx.previousAgent && /^(yes|yeah|yep|ok|okay|sure|do it|go ahead|continue|proceed|try again|again)\b/.test(prose)) return result(ctx.previousAgent, 'follow-up');

	return result('chat', ask ? 'question' : 'conversation');
}

/** True when the message asks for something to be done (create, change, run...), not just explained. */
export function mentionsAction(text: string): boolean {
	return new RegExp(`\\b(${ACTION_VERBS})\\b`).test(text.toLowerCase());
}

/**
 * The Chat agent answered a request that needs file changes: it replied HANDOFF:coder
 * (as instructed) or a refusal like "I'm unable to create...".
 */
export function isHandoff(answer: string, request: string): boolean {
	if (!mentionsAction(request)) return false;
	return /HANDOFF:\s*coder/i.test(answer) || /\bi(?:'m| am)? (?:can(?:'t|not)|unable to|not able to) (?:create|modify|edit|write|make|change|run|execute|build)\b/i.test(answer.slice(0, 400));
}

export function complexityOf(text: string): Complexity {
	const words = text.split(/\s+/).filter(Boolean).length;
	const bullets = count(/^\s*([-*]|\d+[.)])\s+/gm, text);
	const big = /\b(entire|whole|full[- ]stack|complete (app|application|system)|from scratch|architecture|multiple|several|all (the )?files|across the (codebase|project)|migrate|rewrite)\b/i.test(text);
	if (words > 120 || bullets >= 5 || (big && words > 12)) return 'complex';
	if (words <= 15 && !big && bullets < 2) return 'simple';
	return 'moderate';
}

/** "remember that X" / "/remember X" -> the fact to store, else undefined. */
export function rememberFact(text: string): string | undefined {
	const m = /^\s*(?:\/remember\s+|(?:please\s+)?remember(?:\s+that)?\s+)([\s\S]{3,})$/i.exec(text);
	if (!m) return undefined;
	const fact = m[1].trim();
	// "remember what I said earlier?" is a question, not a fact.
	if (/\?\s*$/.test(fact) || /^(what|when|how|where|why|who|if)\b/i.test(fact)) return undefined;
	return fact;
}
