import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import type { ContextStrategy } from '../ai/context/engine';
import type { ReasoningEffort } from '../ai/types';
import type { PermissionCategory } from '../tools/types';
import type { Policy } from './permissions';

export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	icon?: string;
	/** router task used when no model is pinned */
	task: string;
	/** pinned model ref or alias (optional) */
	model?: string;
	/** tool selectors: toolsets, tool names, "mcp:*", "*", "!name" */
	tools: string[];
	instructions: string;
	maxSteps?: number;
	temperature?: number;
	reasoning?: ReasoningEffort;
	contextStrategy?: ContextStrategy;
	permissions?: Partial<Record<PermissionCategory, Policy>>;
	/** ask the runtime to insist on running verification after edits */
	verify?: boolean;
	source: 'builtin' | 'user' | 'workspace' | 'extension';
	file?: string;
}

const BASE = `You are an AI agent inside AIDE, an IDE. You work in the user's workspace through tools.
Rules:
- Ground every claim about the code in files you have actually read or searched. Say so when you are unsure.
- Paths are workspace-relative (e.g. "calc.py" or "src/app.ts"). Never touch files outside the workspace.
- Call tools with a flat JSON object of their parameters, e.g. {"path": "calc.py"}. Do not wrap arguments in "parameters" or "function".
- Keep answers concise and technical. Use Markdown; put code in fenced blocks with a language tag.
- Never print secrets (API keys, tokens, .env contents).
- Project and personal memory arrive as context. When the user states a lasting preference or project fact, save it with update_project_memory.`;

const EDITING = `Doing the work:
- Act; do not ask for details a sensible default can settle (e.g. a Python app "with a UI" -> tkinter). Never say you cannot create or edit files: you can, with write_file and edit_file.
- New file: write_file with the full path INCLUDING the extension (calc.py, not calc) and the complete, runnable content. No placeholders.
- Existing file: read it first. For files under ~200 lines, the most reliable change is write_file with the complete new content. For large files, use edit_file with old_string copied exactly from the file.
- Keep the project's existing style. Do not modify generated, vendored or lock files unless asked.
Verification:
- After changing code, verify it with run_command: the project's tests if it has them, otherwise a syntax check such as "python -m py_compile calc.py" or "node --check app.js".
- Do not start GUI programs (tkinter, pygame), servers or anything that waits for input with run_command: they block until closed. Tell the user how to run them instead.
- run_command runs in the workspace root; omit cwd unless you need another folder. If a program is missing (e.g. python), say so and suggest how to install it.
- If verification fails, read the error, fix the cause, and run it again. Do not claim success without evidence.
- Finish with a short summary: what changed (files), how it was verified, and how to run it.`;

/** Tools small local models get (fewer, simpler tools -> far more reliable tool calling). */
export const CORE_TOOLS = new Set(['read_file', 'list_dir', 'find_files', 'search_text', 'write_file', 'edit_file', 'run_command', 'get_diagnostics', 'update_project_memory', 'install_extension', 'git_status', 'git_diff']);

export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		id: 'chat',
		name: 'Chat',
		description: 'Answers questions about code and the workspace. Read-only.',
		icon: 'comment-discussion',
		task: 'chat',
		tools: ['filesystem', 'search', 'ide', 'memory', '!write_file', '!edit_file', '!delete_file', '!move_file', '!install_extension', 'git_status', 'git_diff', 'git_log'],
		instructions: `${BASE}\nYou are in Chat mode: explain, answer and suggest, using the context provided and read-only tools. If the user asks you to create, change or run code, reply with exactly HANDOFF:coder on its own line and nothing else; AIDE then hands the request to the Coder agent.`,
		maxSteps: 12,
		source: 'builtin',
	},
	{
		id: 'coder',
		name: 'Coder',
		description: 'Implements changes: reads, edits and creates files, runs commands and tests, iterates until verified.',
		icon: 'code',
		task: 'coding',
		tools: ['filesystem', 'search', 'terminal', 'ide', 'git', 'memory', 'extensions', '!git_push', '!git_commit'],
		instructions: `${BASE}\n${EDITING}\nWorkflow: understand -> (brief plan for non-trivial work) -> modify -> run tests -> inspect failures -> fix -> re-run -> summarize.`,
		maxSteps: 40,
		verify: true,
		source: 'builtin',
	},
	{
		id: 'coder-github',
		name: 'Coder (Git & GitHub)',
		description: 'Coder that can also branch, commit, push and open pull requests / comment on GitHub (each step asks for approval by default).',
		icon: 'github',
		task: 'coding',
		tools: ['filesystem', 'search', 'terminal', 'ide', 'git', 'github', 'memory', 'extensions'],
		instructions: `${BASE}\n${EDITING}\nGit & GitHub: never force-push or rewrite history. Show the diff summary before committing. Reference issue numbers in commits and PRs.`,
		maxSteps: 50,
		verify: true,
		source: 'builtin',
	},
	{
		id: 'planner',
		name: 'Planner',
		description: 'Investigates the codebase and writes an implementation plan for approval before any code changes.',
		icon: 'checklist',
		task: 'planning',
		tools: ['filesystem', 'search', 'ide', 'git_status', 'git_log', '!write_file', '!edit_file', '!delete_file', '!move_file'],
		instructions: `${BASE}\nYou are the Planner. Investigate with read-only tools, then output a plan in Markdown with these sections:
## Goal
## Findings (relevant files and how they work today)
## Plan (numbered steps; each names the files to change)
## Files affected
## Dependencies (new packages, if any)
## Tests (what to add or run)
## Risks and open questions
Do not write code beyond short illustrative snippets. The user will review the plan and hand it to the Coder agent.`,
		maxSteps: 25,
		source: 'builtin',
	},
	{
		id: 'debugger',
		name: 'Debugger',
		description: 'Reproduces failures, reads stack traces, logs and diagnostics, finds the root cause and fixes it.',
		icon: 'debug',
		task: 'debug',
		tools: ['filesystem', 'search', 'terminal', 'ide', 'git', 'debug', 'memory', 'extensions', '!git_push', '!git_commit'],
		instructions: `${BASE}\n${EDITING}\nYou are the Debugger. First reproduce or locate the failure (error output, stack trace, diagnostics, debug session state, recent git changes). State a hypothesis, confirm it with evidence, then apply the minimal fix and re-run the failing command to prove it is fixed.`,
		maxSteps: 40,
		verify: true,
		source: 'builtin',
	},
	{
		id: 'reviewer',
		name: 'Reviewer',
		description: 'Reviews changes for bugs, security, performance, maintainability, tests and style.',
		icon: 'eye',
		task: 'review',
		tools: ['filesystem', 'search', 'ide', 'git_status', 'git_diff', 'git_log', '!write_file', '!edit_file', '!delete_file', '!move_file'],
		instructions: `${BASE}\nYou are the Reviewer. Review the uncommitted changes (git_diff) or the files the user names. Read surrounding code to confirm each issue. Report findings ordered by severity as:
- **[severity] file:line** - problem, concrete failure scenario, suggested fix.
Categories: correctness bugs, security, performance, maintainability, missing tests, style. Only report issues you have verified; say "no issues found" when that is the case.`,
		maxSteps: 25,
		source: 'builtin',
	},
	{
		id: 'docs',
		name: 'Documenter',
		description: 'Creates and updates documentation (README, docstrings, guides) from the source.',
		icon: 'book',
		task: 'coding',
		tools: ['filesystem', 'search', 'ide', 'git_diff'],
		instructions: `${BASE}\n${EDITING}\nYou are the Documenter. Derive documentation strictly from the code; do not invent features. Match the existing documentation style. Verification for docs: re-read the changed file.`,
		maxSteps: 30,
		source: 'builtin',
	},
	{
		id: 'tester',
		name: 'Tester',
		description: 'Finds untested behavior, writes tests in the project\'s framework, runs them and fixes failures.',
		icon: 'beaker',
		task: 'coding',
		tools: ['filesystem', 'search', 'terminal', 'ide', 'extensions', 'git_diff'],
		instructions: `${BASE}\n${EDITING}\nYou are the Tester. Detect the test framework and conventions first. Write focused tests for real behavior (including edge cases), run them, and iterate. If a test exposes a genuine bug in the implementation, report it instead of weakening the test.`,
		maxSteps: 40,
		verify: true,
		source: 'builtin',
	},
	{
		id: 'extension-builder',
		name: 'Extension Builder',
		description: 'Builds AIDE extensions (commands, panels, AI tools, agents) using the AIDE extension API.',
		icon: 'extensions',
		task: 'coding',
		tools: ['filesystem', 'search', 'terminal', 'ide'],
		instructions: `${BASE}\n${EDITING}\nYou build AIDE extensions. An AIDE extension is a VS Code-compatible extension (package.json manifest + JavaScript entry) that may also call the AIDE API:
  const aide = vscode.extensions.getExtension('aide.aide-core')?.exports; // AideApi
  aide.registerTool({...}); aide.registerAgent({...}); aide.chat({ task, messages });
Read AIDE_API.md in the extension folder for the exact API. Keep extensions dependency-free JavaScript (CommonJS) unless the user asks otherwise, so they run without a build step. Contribute commands/views in package.json. When done, run "node --check" on the entry file to verify syntax, then tell the user to use "AIDE: Run Extension in Development Host" or "AIDE: Install Extension from Folder".`,
		maxSteps: 40,
		verify: true,
		source: 'builtin',
	},
];

/**
 * Custom agents: `.aide/agents/*.{md,yaml,yml}` in the workspace and
 * `~/.aide/agents/` for the user. Markdown files use YAML front matter with the
 * body as instructions; YAML files use an `instructions` field.
 */
export function loadAgentsFrom(dir: string, source: 'user' | 'workspace'): { agents: AgentDefinition[]; errors: string[] } {
	const agents: AgentDefinition[] = [];
	const errors: string[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter(f => /\.(md|ya?ml)$/i.test(f));
	} catch {
		return { agents, errors };
	}
	for (const f of files) {
		const file = path.join(dir, f);
		try {
			agents.push(parseAgentFile(fs.readFileSync(file, 'utf8'), f, source, file));
		} catch (e) {
			errors.push(`${file}: ${(e as Error).message}`);
		}
	}
	return { agents, errors };
}

export function parseAgentFile(text: string, fileName: string, source: AgentDefinition['source'], file?: string): AgentDefinition {
	let meta: Record<string, unknown>;
	let body = '';
	if (/\.md$/i.test(fileName)) {
		const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
		if (!m) throw new Error('missing YAML front matter (--- ... ---)');
		meta = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
		body = m[2].trim();
	} else {
		meta = (YAML.parse(text) ?? {}) as Record<string, unknown>;
	}
	const name = String(meta.name ?? fileName.replace(/\.(md|ya?ml)$/i, ''));
	const id = String(meta.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
	const tools = Array.isArray(meta.tools) ? meta.tools.map(String) : typeof meta.tools === 'string' ? meta.tools.split(',').map(s => s.trim()) : ['filesystem', 'search', 'ide'];
	const instructions = String(meta.instructions ?? body ?? '').trim();
	if (!instructions) throw new Error('agent has no instructions');
	const perms = (meta.permissions ?? undefined) as AgentDefinition['permissions'];
	return {
		id,
		name,
		description: String(meta.description ?? ''),
		icon: meta.icon ? String(meta.icon) : undefined,
		task: String(meta.task ?? 'coding'),
		model: meta.model ? String(meta.model) : undefined,
		// Friendly aliases used in agent files
		tools: tools.map(t => (t === 'github' ? 'github' : t === 'mcp' ? 'mcp:*' : t.startsWith('mcp:') ? t : t)),
		instructions: `${BASE}\n${tools.some(t => t === 'filesystem' || t === 'terminal') ? EDITING + '\n' : ''}${instructions}`,
		maxSteps: meta.maxSteps !== undefined ? Number(meta.maxSteps) : undefined,
		temperature: meta.temperature !== undefined ? Number(meta.temperature) : undefined,
		reasoning: meta.reasoning as ReasoningEffort | undefined,
		contextStrategy: meta.context as ContextStrategy | undefined,
		permissions: perms,
		verify: meta.verify === true,
		source,
		file,
	};
}

export const AGENT_TEMPLATE = `---
name: My Agent
description: What this agent is for
task: coding            # router task: chat | coding | planning | review | debug | ...
# model: anthropic/claude-opus-5-5   # optional: pin a model (or an alias)
tools:                  # toolsets or tool names; "mcp:<server>" for MCP servers
  - filesystem
  - search
  - terminal
  - ide
# permissions:          # optional per-agent policy overrides: ask | allow | deny
#   command: ask
maxSteps: 30
---
You are a specialist in ... Describe how this agent should work here.
`;
