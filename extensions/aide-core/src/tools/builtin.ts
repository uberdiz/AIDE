import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compressOutput, stripAnsi, truncateMiddle } from '../ai/context/compress';
import { globToRegex, IgnoreMatcher, isBinaryPath, isSecretPath } from '../ai/context/ignore';
import { listRepoFiles, loadIgnoreMatcher } from '../ai/context/repoMap';
import { dangerousCommand } from '../agents/permissions';
import { unifiedDiff } from '../changes/diff';
import type { Tool, ToolContext, ToolResult } from './types';
import { ToolInputError } from './types';

const MAX_READ_CHARS = 60_000;

/** Resolve a model-supplied path and refuse anything outside the workspace root. */
export function resolveInRoot(root: string, p: unknown): string {
	if (typeof p !== 'string' || !p.trim()) throw new ToolInputError('path is required');
	const abs = path.resolve(root, p.trim().replace(/^["']|["']$/g, ''));
	const rel = path.relative(root, abs);
	if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new ToolInputError(`path "${p}" is outside the workspace`);
	// Resolve symlinks of the existing prefix to prevent escaping through links.
	let probe = abs;
	while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
	try {
		const real = fs.realpathSync(probe);
		const realRoot = fs.realpathSync(root);
		const r = path.relative(realRoot, real);
		if (r.startsWith('..') || path.isAbsolute(r)) throw new ToolInputError(`path "${p}" resolves outside the workspace`);
	} catch (e) {
		if (e instanceof ToolInputError) throw e;
	}
	return abs;
}

const relOf = (ctx: ToolContext, abs: string) => path.relative(ctx.root, abs).replace(/\\/g, '/') || '.';

function readText(abs: string): string {
	const buf = fs.readFileSync(abs);
	if (buf.subarray(0, 8000).includes(0)) throw new ToolInputError('file appears to be binary');
	return buf.toString('utf8');
}

async function writeTracked(ctx: ToolContext, abs: string, content: string): Promise<void> {
	ctx.changes.beforeWrite(ctx.runId, abs);
	await fs.promises.mkdir(path.dirname(abs), { recursive: true });
	await fs.promises.writeFile(abs, content, 'utf8');
	ctx.changes.afterWrite(abs);
	ctx.ide.fileChanged?.(abs);
}

function str(v: unknown, name: string): string {
	if (typeof v !== 'string') throw new ToolInputError(`${name} must be a string`);
	return v;
}

// ---------------------------------------------------------------- filesystem

const readFile: Tool = {
	name: 'read_file',
	toolset: 'filesystem',
	category: 'read',
	readOnly: true,
	description: 'Read a text file from the workspace. Optionally pass start_line/end_line (1-based, inclusive) to read part of a large file.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Workspace-relative path' },
			start_line: { type: 'integer' },
			end_line: { type: 'integer' },
		},
		required: ['path'],
	},
	describe: i => `Read ${i.path}${i.start_line ? ` (lines ${i.start_line}-${i.end_line ?? 'end'})` : ''}`,
	async run(input, ctx) {
		const abs = resolveInRoot(ctx.root, input.path);
		const rel = relOf(ctx, abs);
		if (isSecretPath(rel)) return { content: `Refused: ${rel} looks like a secrets file and is never sent to models.`, isError: true };
		if (isBinaryPath(rel)) return { content: `${rel} is a binary file.`, isError: true };
		if (!fs.existsSync(abs)) return { content: `File not found: ${rel}`, isError: true };
		if (fs.statSync(abs).isDirectory()) return { content: `${rel} is a directory; use list_dir.`, isError: true };
		const text = readText(abs);
		const lines = text.split('\n');
		const start = Math.max(1, Number(input.start_line ?? 1));
		const end = Math.min(lines.length, Number(input.end_line ?? lines.length));
		let body = lines.slice(start - 1, end).join('\n');
		let note = '';
		if (body.length > MAX_READ_CHARS) {
			const kept = body.slice(0, MAX_READ_CHARS);
			const keptLines = kept.split('\n').length;
			body = kept;
			note = `\n[truncated: showing lines ${start}-${start + keptLines - 1} of ${lines.length}; use start_line/end_line to read more]`;
		}
		const header = start > 1 || end < lines.length ? `[${rel} lines ${start}-${end} of ${lines.length}]\n` : '';
		return { content: header + body + note };
	},
};

const listDir: Tool = {
	name: 'list_dir',
	toolset: 'filesystem',
	category: 'read',
	readOnly: true,
	description: 'List files and folders in a workspace directory (ignores node_modules, .git, build output). depth defaults to 1, max 4.',
	inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Directory, default "."' }, depth: { type: 'integer' } } },
	describe: i => `List ${i.path ?? '.'}`,
	async run(input, ctx) {
		const abs = resolveInRoot(ctx.root, input.path ?? '.');
		if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { content: `Not a directory: ${input.path ?? '.'}`, isError: true };
		const depth = Math.min(4, Math.max(1, Number(input.depth ?? 1)));
		const matcher = await loadIgnoreMatcher(ctx.root);
		const lines: string[] = [];
		const walk = (dir: string, d: number, indent: string) => {
			if (lines.length > 800) return;
			let entries = fs.readdirSync(dir, { withFileTypes: true });
			entries = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
			for (const e of entries) {
				const rel = relOf(ctx, path.join(dir, e.name));
				if (matcher.ignores(rel, e.isDirectory())) continue;
				lines.push(`${indent}${e.name}${e.isDirectory() ? '/' : ''}`);
				if (e.isDirectory() && d < depth) walk(path.join(dir, e.name), d + 1, indent + '  ');
			}
		};
		walk(abs, 1, '');
		return { content: lines.length ? lines.join('\n') + (lines.length > 800 ? '\n...' : '') : '(empty)' };
	},
};

const findFiles: Tool = {
	name: 'find_files',
	toolset: 'filesystem',
	category: 'read',
	readOnly: true,
	description: 'Find files by glob pattern, e.g. "**/*.test.ts" or "src/**/router*". Returns workspace-relative paths.',
	inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
	describe: i => `Find ${i.pattern}`,
	async run(input, ctx) {
		const pattern = str(input.pattern, 'pattern').replace(/^\.\//, '');
		const re = new RegExp(`^${globToRegex(pattern.includes('/') ? pattern : `**/${pattern}`)}$`, 'i');
		const files = await listRepoFiles(ctx.root, await loadIgnoreMatcher(ctx.root), 20_000);
		const hits = files.filter(f => re.test(f.rel)).map(f => f.rel);
		return { content: hits.length ? hits.slice(0, 300).join('\n') + (hits.length > 300 ? `\n... ${hits.length - 300} more` : '') : 'No files matched.' };
	},
};

const searchText: Tool = {
	name: 'search_text',
	toolset: 'search',
	category: 'read',
	readOnly: true,
	description: 'Search file contents in the workspace (ripgrep). Literal by default; set regex=true for regular expressions. Optional glob filter like "*.py".',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string' },
			regex: { type: 'boolean' },
			glob: { type: 'string' },
			path: { type: 'string' },
			case_sensitive: { type: 'boolean' },
			max_results: { type: 'integer' },
		},
		required: ['query'],
	},
	describe: i => `Search "${i.query}"${i.glob ? ` in ${i.glob}` : ''}`,
	async run(input, ctx) {
		const query = str(input.query, 'query');
		const max = Math.min(500, Number(input.max_results ?? 80));
		const dir = input.path ? resolveInRoot(ctx.root, input.path) : ctx.root;
		const results = await grep(ctx, query, { regex: !!input.regex, glob: input.glob as string | undefined, dir, caseSensitive: !!input.case_sensitive, max });
		return { content: results.length ? results.join('\n') : 'No matches.' };
	},
};

export async function grep(
	ctx: Pick<ToolContext, 'root' | 'ide' | 'signal'>,
	query: string,
	o: { regex?: boolean; glob?: string; dir?: string; caseSensitive?: boolean; max: number },
): Promise<string[]> {
	const rg = ctx.ide.ripgrepPath?.();
	const dir = o.dir ?? ctx.root;
	if (rg && fs.existsSync(rg)) {
		const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-count', '20', '-g', '!**/node_modules/**', '-g', '!**/.git/**', '-g', '!**/.venv/**', '-g', '!**/dist/**', '-g', '!*.lock', '-g', '!package-lock.json'];
		if (!o.regex) args.push('--fixed-strings');
		if (!o.caseSensitive) args.push('--smart-case');
		if (o.glob) args.push('-g', o.glob);
		args.push('--', query, dir);
		const out = await new Promise<string>(resolve => {
			execFile(rg, args, { cwd: ctx.root, maxBuffer: 8 * 1024 * 1024, signal: ctx.signal }, (_err, stdout) => resolve(stdout ?? ''));
		});
		return out.split('\n').filter(Boolean).slice(0, o.max).map(l => l.replace(ctx.root + path.sep, '').replace(/\\/g, '/'));
	}
	// Fallback: JS search.
	const matcher = await loadIgnoreMatcher(ctx.root);
	const files = await listRepoFiles(ctx.root, matcher, 20_000);
	const re = o.regex ? new RegExp(query, o.caseSensitive ? '' : 'i') : undefined;
	const globRe = o.glob ? new RegExp(`(^|/)${globToRegex(o.glob)}$`) : undefined;
	const hits: string[] = [];
	for (const f of files) {
		if (hits.length >= o.max) break;
		if (globRe && !globRe.test(f.rel)) continue;
		if (isBinaryPath(f.rel) || f.size > 2_000_000) continue;
		const abs = path.join(ctx.root, f.rel);
		if (o.dir && !abs.startsWith(o.dir)) continue;
		let text: string;
		try {
			text = fs.readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		const lines = text.split('\n');
		for (let i = 0; i < lines.length && hits.length < o.max; i++) {
			const ok = re ? re.test(lines[i]) : o.caseSensitive ? lines[i].includes(query) : lines[i].toLowerCase().includes(query.toLowerCase());
			if (ok) hits.push(`${f.rel}:${i + 1}:${lines[i].slice(0, 300)}`);
		}
	}
	return hits;
}

const EXTENSIONLESS = /^(makefile|dockerfile|containerfile|license|licence|readme|procfile|gemfile|rakefile|jenkinsfile|vagrantfile|codeowners|brewfile|justfile|notice|authors|changelog)$/i;

/**
 * A file created without an extension can't be run or highlighted ("calc" instead of "calc.py").
 * Returns the extension implied by the content, or undefined when the name is fine as it is.
 */
export function inferMissingExtension(filePath: string, content: string): string | undefined {
	const base = path.basename(filePath);
	if (base.includes('.') || EXTENSIONLESS.test(base) || /^#!/.test(content)) return undefined;
	const c = content.slice(0, 4000);
	if (/^\s*(import \w|from [\w.]+ import |def \w+\(|class \w+[(:]|print\(|if __name__ ==)/m.test(c)) return '.py';
	if (/<!doctype html|<html[\s>]/i.test(c)) return '.html';
	if (/^\s*(const|let|var|function|import|export)\b.*|require\(|module\.exports|console\.log\(/m.test(c)) return /:\s*(string|number|boolean)\b|\binterface \w+/.test(c) ? '.ts' : '.js';
	if (/^\s*(param\s*\(|Write-Host|Get-\w+|Set-\w+)/m.test(c)) return '.ps1';
	if (/^\s*#include\s*[<"]/m.test(c)) return /\b(std::|class |namespace )/.test(c) ? '.cpp' : '.c';
	if (/^\s*(package main|func \w+\()/m.test(c)) return '.go';
	if (/^\s*(fn main\(|use std::)/m.test(c)) return '.rs';
	if (/^\s*(public (static )?class |using System;)/m.test(c)) return /using System;/.test(c) ? '.cs' : '.java';
	return undefined;
}

/** How to run a file from a shell, for hints after creating one. */
export function runHint(rel: string): string | undefined {
	const runner = runnerFor(rel);
	return runner ? `${runner} ${/\s/.test(rel) ? `"${rel}"` : rel}` : undefined;
}

/** The interpreter command for a script file, by extension. */
export function runnerFor(file: string): string | undefined {
	switch (path.extname(file).toLowerCase()) {
		case '.py': case '.pyw': return 'python';
		case '.js': case '.mjs': case '.cjs': return 'node';
		case '.ps1': return 'powershell -ExecutionPolicy Bypass -File';
		case '.sh': return 'bash';
		case '.go': return 'go run';
		case '.ts': return 'npx tsx';
		case '.rb': return 'ruby';
		case '.php': return 'php';
		case '.lua': return 'lua';
		default: return undefined;
	}
}

/** A fast syntax check for changed files, used to verify edits when the project has no test command. */
export function quickCheckCommand(files: string[]): string | undefined {
	const q = (f: string) => (/\s/.test(f) ? `"${f}"` : f);
	const py = files.filter(f => /\.py$/i.test(f));
	if (py.length) return `python -m py_compile ${py.slice(0, 20).map(q).join(' ')}`;
	const js = files.filter(f => /\.(c|m)?js$/i.test(f));
	if (js.length) return js.slice(0, 10).map(f => `node --check ${q(f)}`).join('; ');
	return undefined;
}

const writeFile: Tool = {
	name: 'write_file',
	toolset: 'filesystem',
	category: 'write',
	description: 'Create a new file, or replace the whole content of an existing file. Always include the file extension (e.g. calc.py). For small files, rewriting the complete file is the most reliable way to change it.',
	inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path including the extension' }, content: { type: 'string', description: 'The complete file content' } }, required: ['path', 'content'] },
	describe: i => `${fs.existsSync(String(i.path ?? '')) ? 'Overwrite' : 'Write'} ${i.path}`,
	async preview(input, ctx) {
		const abs = withExtension(resolveInRoot(ctx.root, input.path), String(input.content ?? ''));
		const before = fs.existsSync(abs) ? readText(abs) : '';
		return { title: `${before ? 'Overwrite' : 'Create'} ${relOf(ctx, abs)}`, path: abs, before, after: String(input.content ?? '') };
	},
	async run(input, ctx) {
		const requested = resolveInRoot(ctx.root, input.path);
		const content = str(input.content, 'content');
		const abs = withExtension(requested, content);
		const rel = relOf(ctx, abs);
		if (isSecretPath(rel)) return { content: `Refused: ${rel} is a protected secrets file.`, isError: true };
		const existed = fs.existsSync(abs);
		const before = existed ? readText(abs) : '';
		await writeTracked(ctx, abs, content);
		const notes: string[] = [];
		if (abs !== requested) notes.push(`Note: "${relOf(ctx, requested)}" had no file extension, so it was saved as ${rel}. Use ${rel} from now on.`);
		const hint = !existed ? runHint(rel) : undefined;
		if (hint) notes.push(`Run it with: ${hint}`);
		return { content: `${existed ? 'Updated' : 'Created'} ${rel} (${content.split('\n').length} lines)${existed ? `\n${truncateMiddle(unifiedDiff(rel, before, content), 1500).text}` : ''}${notes.length ? `\n${notes.join('\n')}` : ''}` };
	},
};

function withExtension(abs: string, content: string): string {
	if (fs.existsSync(abs)) return abs;
	const ext = inferMissingExtension(abs, content);
	return ext ? abs + ext : abs;
}

/** Map a range of a whitespace-collapsed string back to the original text. */
function collapseWs(s: string): { text: string; map: number[] } {
	let text = '';
	const map: number[] = [];
	let inWs = false;
	for (let i = 0; i < s.length; i++) {
		if (/\s/.test(s[i])) {
			if (!inWs && text.length) {
				text += ' ';
				map.push(i);
			}
			inWs = true;
		} else {
			text += s[i];
			map.push(i);
			inWs = false;
		}
	}
	if (text.endsWith(' ')) {
		text = text.slice(0, -1);
		map.pop();
	}
	return { text, map };
}

/** Locate old_string in content: exact, then line-trimmed, then whitespace-insensitive (a model rewrote "def f():\n    x" as "def f(): x"). */
export function locate(content: string, oldStr: string): { start: number; end: number; count: number } | undefined {
	let idx = content.indexOf(oldStr);
	if (idx >= 0) {
		let count = 0;
		for (let i = idx; i >= 0; i = content.indexOf(oldStr, i + 1)) count++;
		return { start: idx, end: idx + oldStr.length, count };
	}
	// Tolerate CRLF vs LF and trailing whitespace differences.
	const norm = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd());
	const hay = norm(content);
	const needle = norm(oldStr);
	while (needle.length && needle[needle.length - 1] === '') needle.pop();
	if (!needle.length) return undefined;
	const matches: number[] = [];
	for (let i = 0; i + needle.length <= hay.length; i++) {
		let ok = true;
		for (let j = 0; j < needle.length && ok; j++) ok = hay[i + j].trim() === needle[j].trim();
		if (ok) matches.push(i);
	}
	if (matches.length) {
		const lines = content.split('\n');
		const startLine = matches[0];
		const start = lines.slice(0, startLine).reduce((n, l) => n + l.length + 1, 0);
		const end = start + lines.slice(startLine, startLine + needle.length).join('\n').length;
		return { start, end, count: matches.length };
	}
	const hayWs = collapseWs(content);
	const needleWs = collapseWs(oldStr).text;
	if (needleWs.length < 8) return undefined;
	const first = hayWs.text.indexOf(needleWs);
	if (first < 0) return undefined;
	let count = 0;
	for (let i = first; i >= 0; i = hayWs.text.indexOf(needleWs, i + 1)) count++;
	return { start: hayWs.map[first], end: hayWs.map[first + needleWs.length - 1] + 1, count };
}

export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll: boolean): string {
	if (oldStr === '') throw new ToolInputError('old_string must not be empty (use write_file to create files)');
	if (replaceAll && content.includes(oldStr)) return content.split(oldStr).join(newStr);
	const loc = locate(content, oldStr);
	if (!loc) throw new ToolInputError('old_string was not found in the file.');
	if (loc.count > 1 && !replaceAll) throw new ToolInputError(`old_string matches ${loc.count} places; include more surrounding lines to make it unique, or set replace_all=true.`);
	return content.slice(0, loc.start) + newStr + content.slice(loc.end);
}

/** applyEdit with a failure message that shows the model what the file really contains. */
function applyEditExplained(rel: string, content: string, input: Record<string, unknown>): string {
	try {
		return applyEdit(content, str(input.old_string, 'old_string'), str(input.new_string, 'new_string'), !!input.replace_all);
	} catch (e) {
		if (!(e instanceof ToolInputError) || !/not found/.test(e.message)) throw e;
		const lines = content.split('\n');
		const shown = lines.length <= 200 ? `Current content of ${rel}:\n\`\`\`\n${content}\n\`\`\`\n` : '';
		throw new ToolInputError(`old_string was not found in ${rel}. ${shown}Copy old_string exactly from the file (including indentation and line breaks)${lines.length <= 200 ? ', or rewrite the whole file with write_file' : ''}.`);
	}
}

const editFile: Tool = {
	name: 'edit_file',
	toolset: 'filesystem',
	category: 'write',
	description: 'Replace an exact snippet in an existing file. old_string must match the file text exactly (including indentation) and be unique unless replace_all=true. Read the file first.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			old_string: { type: 'string', description: 'Exact existing text to replace' },
			new_string: { type: 'string', description: 'Replacement text' },
			replace_all: { type: 'boolean' },
		},
		required: ['path', 'old_string', 'new_string'],
	},
	describe: i => `Edit ${i.path}`,
	async preview(input, ctx) {
		const abs = resolveInRoot(ctx.root, input.path);
		if (!fs.existsSync(abs)) throw new ToolInputError(`File not found: ${relOf(ctx, abs)}. Use write_file to create it.`);
		const before = readText(abs);
		const after = applyEditExplained(relOf(ctx, abs), before, input);
		return { title: `Edit ${relOf(ctx, abs)}`, path: abs, before, after };
	},
	async run(input, ctx) {
		const abs = resolveInRoot(ctx.root, input.path);
		const rel = relOf(ctx, abs);
		if (!fs.existsSync(abs)) return { content: `File not found: ${rel}. Use write_file to create it.`, isError: true };
		const before = readText(abs);
		const after = applyEditExplained(rel, before, input);
		if (after === before) return { content: 'No change (new_string equals old_string).' };
		await writeTracked(ctx, abs, after);
		return { content: `Edited ${rel}\n${truncateMiddle(unifiedDiff(rel, before, after, 2), 1500).text}` };
	},
};

const deleteFile: Tool = {
	name: 'delete_file',
	toolset: 'filesystem',
	category: 'delete',
	description: 'Delete a file from the workspace (restorable through AIDE checkpoints).',
	inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
	describe: i => `Delete ${i.path}`,
	async run(input, ctx) {
		const abs = resolveInRoot(ctx.root, input.path);
		if (!fs.existsSync(abs)) return { content: `File not found: ${relOf(ctx, abs)}`, isError: true };
		if (fs.statSync(abs).isDirectory()) return { content: 'delete_file only deletes files; delete the files inside the directory individually.', isError: true };
		ctx.changes.beforeWrite(ctx.runId, abs);
		await fs.promises.rm(abs);
		ctx.changes.afterWrite(abs);
		ctx.ide.fileChanged?.(abs);
		return { content: `Deleted ${relOf(ctx, abs)}` };
	},
};

const moveFile: Tool = {
	name: 'move_file',
	toolset: 'filesystem',
	category: 'write',
	description: 'Move or rename a file inside the workspace.',
	inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
	describe: i => `Move ${i.from} -> ${i.to}`,
	async run(input, ctx) {
		const from = resolveInRoot(ctx.root, input.from);
		const to = resolveInRoot(ctx.root, input.to);
		if (!fs.existsSync(from)) return { content: `Not found: ${relOf(ctx, from)}`, isError: true };
		if (fs.existsSync(to)) return { content: `Target exists: ${relOf(ctx, to)}`, isError: true };
		const content = fs.readFileSync(from, 'utf8');
		ctx.changes.beforeWrite(ctx.runId, from);
		ctx.changes.beforeWrite(ctx.runId, to);
		await fs.promises.mkdir(path.dirname(to), { recursive: true });
		await fs.promises.writeFile(to, content);
		await fs.promises.rm(from);
		ctx.changes.afterWrite(from);
		ctx.changes.afterWrite(to);
		ctx.ide.fileChanged?.(from);
		ctx.ide.fileChanged?.(to);
		return { content: `Moved ${relOf(ctx, from)} -> ${relOf(ctx, to)}` };
	},
};

// ---------------------------------------------------------------- terminal

const runCommand: Tool = {
	name: 'run_command',
	toolset: 'terminal',
	category: 'command',
	description: 'Run a shell command (PowerShell on Windows, bash elsewhere) and return its output and exit code. Runs in the workspace root unless cwd is given; file paths in the command are relative to that folder. Use for builds, tests, linters and scripts. Not for interactive programs, GUI windows or long-running servers.',
	inputSchema: {
		type: 'object',
		properties: {
			command: { type: 'string' },
			cwd: { type: 'string', description: 'Workspace-relative working directory (omit to use the workspace root)' },
			timeout_seconds: { type: 'integer', description: 'Default 120, max 1800' },
		},
		required: ['command'],
	},
	describe: i => `Run \`${i.command}\``,
	async preview(input, ctx) {
		return { title: 'Run command', detail: `${input.command}\n(cwd: ${input.cwd ?? '.'})${dangerousCommand(String(input.command)) ? `\nWARNING: ${dangerousCommand(String(input.command))}` : ''}`, path: ctx.root };
	},
	async run(input, ctx) {
		const command = str(input.command, 'command');
		const cwdIn = typeof input.cwd === 'string' && input.cwd.trim() && input.cwd.trim() !== '.' ? input.cwd.trim() : undefined;
		const cwd = cwdIn ? resolveInRoot(ctx.root, cwdIn) : ctx.root;
		// A missing cwd makes the spawn itself fail with a misleading "powershell.exe ENOENT".
		if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { content: `cwd "${cwdIn}" is not a folder in the workspace. Omit cwd to run in the workspace root.`, isError: true };
		const timeoutMs = Math.min(1800, Math.max(1, Number(input.timeout_seconds ?? 120))) * 1000;
		const r = await ctx.ide.runCommand(command, { cwd, timeoutMs, signal: ctx.signal, onData: ctx.progress });
		const status = r.timedOut ? `timed out after ${timeoutMs / 1000}s` : r.killed ? 'killed' : `exit code ${r.exitCode}`;
		const hints = commandHints(command, r.output, cwdIn ? relOf(ctx, cwd) : undefined, r.timedOut);
		return { content: `$ ${command}${cwdIn ? `   (in ${relOf(ctx, cwd)})` : ''}\n${compressOutput(r.output, 3000)}\n[${status}]${hints ? `\n${hints}` : ''}`, isError: r.exitCode !== 0 };
	},
};

/** Explain common failure patterns so the model (especially a small one) does not loop on them. */
export function commandHints(command: string, output: string, cwdRel: string | undefined, timedOut: boolean): string | undefined {
	const hints: string[] = [];
	if (/Python was not found|python3?(\.exe)?: command not found|'python3?' is not recognized/i.test(output)) {
		hints.push('Python is not installed or not on PATH. Tell the user; it can be installed with `winget install -e --id Python.Python.3.12` (ask before running it).');
	} else if (/is not recognized as the name of a cmdlet|command not found/i.test(output)) {
		const tool = /^\s*([\w.-]+)/.exec(command)?.[1];
		hints.push(`\`${tool}\` is not installed or not on PATH. Do not guess other command names; use a command that exists, or tell the user what to install.`);
	}
	if (cwdRel && /No such file or directory|can't open file|cannot find (the )?(path|file)|ENOENT/i.test(output)) {
		hints.push(`The command ran inside "${cwdRel}", so paths in it are relative to that folder. Omit cwd and use workspace-relative paths.`);
	}
	if (timedOut) hints.push('It timed out. If the program opens a window (e.g. tkinter) or waits for input, do not run it here; verify with `python -m py_compile <file>` or tests, and let the user run it.');
	return hints.length ? `[hint] ${hints.join(' ')}` : undefined;
}

/** Default command runner (no IDE): spawn with a shell, capture output, support timeout and abort. */
export function spawnCommand(command: string, opts: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: Record<string, string>; onData?: (s: string) => void }): Promise<{ output: string; exitCode: number | null; timedOut: boolean; killed: boolean }> {
	return new Promise(resolve => {
		const isWin = process.platform === 'win32';
		const child = isWin
			? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}\n$aideOk = $?; $aideCode = $LASTEXITCODE; if ($aideCode) { exit $aideCode } elseif (-not $aideOk) { exit 1 } else { exit 0 }`], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true })
			: spawn('/bin/bash', ['-lc', command], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true });
		let output = '';
		let timedOut = false;
		let killed = false;
		const onData = (b: Buffer) => {
			const s = b.toString('utf8');
			if (output.length < 4_000_000) output += s;
			opts.onData?.(s);
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		const kill = () => {
			if (child.exitCode !== null) return;
			if (isWin && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
			else if (child.pid) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					child.kill('SIGKILL');
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutMs);
		const onAbort = () => {
			killed = true;
			kill();
		};
		opts.signal.addEventListener('abort', onAbort, { once: true });
		child.on('error', err => {
			output += `\n[failed to start: ${err.message}]`;
		});
		child.on('close', code => {
			clearTimeout(timer);
			opts.signal.removeEventListener('abort', onAbort);
			// PowerShell reports exit $null as 0 when the last command was a cmdlet
			resolve({ output: stripAnsi(output), exitCode: timedOut || killed ? null : code, timedOut, killed });
		});
	});
}

// ---------------------------------------------------------------- git (read-only and mutating)

export function git(root: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise(resolve => {
		execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
			resolve({ stdout: stdout ?? '', stderr: stderr ?? (err as Error | null)?.message ?? '', code: err ? ((err as { code?: number }).code ?? 1) : 0 });
		});
	});
}

const gitResult = (r: { stdout: string; stderr: string; code: number }, empty = '(no output)'): ToolResult =>
	r.code === 0 ? { content: truncateMiddle(r.stdout.trim() || empty, 6000).text } : { content: `git failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, isError: true };

const gitStatus: Tool = {
	name: 'git_status',
	toolset: 'git',
	category: 'read',
	readOnly: true,
	description: 'Show git branch and working tree status.',
	inputSchema: { type: 'object', properties: {} },
	describe: () => 'git status',
	async run(_i, ctx) {
		return gitResult(await git(ctx.root, ['status', '--short', '--branch'], ctx.signal), 'clean');
	},
};

const gitDiff: Tool = {
	name: 'git_diff',
	toolset: 'git',
	category: 'read',
	readOnly: true,
	description: 'Show uncommitted changes (unified diff). staged=true shows the index. Optional path filter.',
	inputSchema: { type: 'object', properties: { staged: { type: 'boolean' }, path: { type: 'string' } } },
	describe: i => `git diff${i.staged ? ' --staged' : ''} ${i.path ?? ''}`,
	async run(input, ctx) {
		const args = ['diff', '--no-color'];
		if (input.staged) args.push('--staged');
		if (input.path) args.push('--', relOf(ctx, resolveInRoot(ctx.root, input.path)));
		return gitResult(await git(ctx.root, args, ctx.signal), 'no changes');
	},
};

const gitLog: Tool = {
	name: 'git_log',
	toolset: 'git',
	category: 'read',
	readOnly: true,
	description: 'Show recent commits (default 15).',
	inputSchema: { type: 'object', properties: { count: { type: 'integer' }, path: { type: 'string' } } },
	describe: () => 'git log',
	async run(input, ctx) {
		const args = ['log', `-${Math.min(100, Number(input.count ?? 15))}`, '--pretty=format:%h %ad %an %s', '--date=short'];
		if (input.path) args.push('--', relOf(ctx, resolveInRoot(ctx.root, input.path)));
		return gitResult(await git(ctx.root, args, ctx.signal));
	},
};

const gitCommit: Tool = {
	name: 'git_commit',
	toolset: 'git',
	category: 'git',
	description: 'Stage the given files (or all changes when files is omitted) and create a commit.',
	inputSchema: { type: 'object', properties: { message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['message'] },
	describe: i => `git commit -m "${String(i.message).split('\n')[0]}"`,
	async run(input, ctx) {
		const files = Array.isArray(input.files) ? (input.files as string[]).map(f => relOf(ctx, resolveInRoot(ctx.root, f))) : ['-A'];
		const add = await git(ctx.root, files[0] === '-A' ? ['add', '-A'] : ['add', '--', ...files], ctx.signal);
		if (add.code !== 0) return gitResult(add);
		return gitResult(await git(ctx.root, ['commit', '-m', str(input.message, 'message')], ctx.signal));
	},
};

const gitBranch: Tool = {
	name: 'git_branch',
	toolset: 'git',
	category: 'git',
	description: 'Create a branch (and switch to it when checkout=true), or switch to an existing branch.',
	inputSchema: { type: 'object', properties: { name: { type: 'string' }, checkout: { type: 'boolean' }, create: { type: 'boolean' } }, required: ['name'] },
	describe: i => `git ${i.create === false ? 'switch' : 'switch -c'} ${i.name}`,
	async run(input, ctx) {
		const name = str(input.name, 'name');
		if (!/^[\w./-]+$/.test(name)) return { content: 'Invalid branch name', isError: true };
		const create = input.create !== false;
		const args = input.checkout === false && create ? ['branch', name] : create ? ['switch', '-c', name] : ['switch', name];
		return gitResult(await git(ctx.root, args, ctx.signal), `ok: ${args.join(' ')}`);
	},
};

const gitPush: Tool = {
	name: 'git_push',
	toolset: 'git',
	category: 'git',
	description: 'Push the current branch to its remote (sets upstream to origin if missing). Never force-pushes.',
	inputSchema: { type: 'object', properties: { remote: { type: 'string' } } },
	describe: i => `git push ${i.remote ?? 'origin'}`,
	async run(input, ctx) {
		const branch = (await git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.signal)).stdout.trim();
		const remote = typeof input.remote === 'string' && /^[\w.-]+$/.test(input.remote) ? input.remote : 'origin';
		return gitResult(await git(ctx.root, ['push', '-u', remote, branch], ctx.signal), `pushed ${branch}`);
	},
};

// ---------------------------------------------------------------- IDE / misc

const getDiagnostics: Tool = {
	name: 'get_diagnostics',
	toolset: 'ide',
	category: 'read',
	readOnly: true,
	description: 'Get current compiler/linter problems (errors and warnings) from the IDE, optionally for one file.',
	inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
	describe: i => `Problems${i.path ? ` in ${i.path}` : ''}`,
	async run(input, ctx) {
		const filter = input.path ? relOf(ctx, resolveInRoot(ctx.root, input.path)) : undefined;
		return { content: (await ctx.ide.diagnostics(filter)) || 'No problems reported.' };
	},
};

const webFetch: Tool = {
	name: 'web_fetch',
	toolset: 'web',
	category: 'network',
	readOnly: true,
	description: 'Fetch a URL (documentation, API reference) and return its text content.',
	inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
	describe: i => `Fetch ${i.url}`,
	async run(input, ctx) {
		const url = str(input.url, 'url');
		if (!/^https?:\/\//i.test(url)) return { content: 'Only http(s) URLs are supported', isError: true };
		const res = await fetch(url, { signal: ctx.signal, headers: { 'user-agent': 'AIDE/2.0' } });
		const type = res.headers.get('content-type') ?? '';
		let text = await res.text();
		if (/html/i.test(type)) text = htmlToText(text);
		return { content: `[${res.status}] ${url}\n${truncateMiddle(text, 8000).text}`, isError: !res.ok };
	},
};

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
		.replace(/<\/(p|div|h\d|li|tr|pre|section|article)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

const updateMemory: Tool = {
	name: 'update_project_memory',
	toolset: 'memory',
	category: 'write',
	description: 'Record durable project knowledge (architecture facts, conventions, commands, gotchas) in .aide/memory.md, which the user can read and edit. Use mode "append" for a new fact.',
	inputSchema: { type: 'object', properties: { content: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } }, required: ['content'] },
	describe: i => `${i.mode === 'replace' ? 'Rewrite' : 'Append to'} project memory`,
	async run(input, ctx) {
		const abs = path.join(ctx.root, '.aide', 'memory.md');
		const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '# Project memory\n\nFacts AIDE agents should remember about this project. Edit freely.\n';
		const content = str(input.content, 'content').trim();
		const next = input.mode === 'replace' ? content + '\n' : `${prev.trimEnd()}\n- ${content.replace(/^-\s*/, '')}\n`;
		await writeTracked(ctx, abs, next);
		return { content: 'Project memory updated (.aide/memory.md).' };
	},
};

export const BUILTIN_TOOLS: Tool[] = [readFile, listDir, findFiles, searchText, writeFile, editFile, deleteFile, moveFile, runCommand, gitStatus, gitDiff, gitLog, gitCommit, gitBranch, gitPush, getDiagnostics, webFetch, updateMemory];

export { IgnoreMatcher };
