import { describe, expect, it } from 'vitest';
import { extractFileRefs, parseMentions } from '../../src/ai/context/mentions';
import { isHandoff } from '../../src/ai/intent';
import { normalizeToolCall, recoverTextToolCalls } from '../../src/agents/runtime';
import { branchTurns } from './helpers';
import { checkpointsIn, messagesUpTo, toMarkdown, truncateConversation, type Conversation } from '../../src/chat/conversations';
import { reindent } from '../../src/inline/reindent';
import { applyEdit, commandHints, inferMissingExtension, locate, quickCheckCommand } from '../../src/tools/builtin';
import type { Tool } from '../../src/tools/types';

const tool = (name: string, props: string[], required: string[] = props): Tool => ({
	name,
	toolset: 'filesystem',
	category: 'read',
	description: name,
	inputSchema: { type: 'object', properties: Object.fromEntries(props.map(p => [p, { type: 'string' }])), required },
	run: async () => ({ content: '' }),
});
const TOOLS = new Map([
	['read_file', tool('read_file', ['path', 'start_line', 'end_line'], ['path'])],
	['write_file', tool('write_file', ['path', 'content'])],
	['edit_file', tool('edit_file', ['path', 'old_string', 'new_string', 'replace_all'], ['path', 'old_string', 'new_string'])],
	['run_command', tool('run_command', ['command', 'cwd'], ['command'])],
]);

describe('small-model tool call repair', () => {
	it('unwraps arguments nested in "parameters" (seen with llama3.2:1b)', () => {
		const c = normalizeToolCall({ id: '1', name: 'read_file', input: { function: 'read_file', parameters: { end_line: 1, path: './calculator/src' }, type: 'function' } }, TOOLS);
		expect(c.name).toBe('read_file');
		expect(c.input).toEqual({ end_line: 1, path: './calculator/src' });
	});

	it('switches to the tool the nested arguments are really for', () => {
		const c = normalizeToolCall({ id: '1', name: 'read_file', input: { parameters: { command: 'edit_file', path: 'calc.py', old_string: 'a', new_string: 'b' }, type: 'function' } }, TOOLS);
		expect(c.name).toBe('edit_file');
		expect(c.input).toMatchObject({ path: 'calc.py', old_string: 'a', new_string: 'b' });
		expect(c.input).not.toHaveProperty('command');
	});

	it('maps common alias tool names', () => {
		expect(normalizeToolCall({ id: '1', name: 'create_file', input: { path: 'a.py', content: 'x' } }, TOOLS).name).toBe('write_file');
		expect(normalizeToolCall({ id: '1', name: 'execute_command', input: { command: 'ls' } }, TOOLS).name).toBe('run_command');
	});

	it('recovers tool calls printed as text in the OpenAI function shape', () => {
		const calls = recoverTextToolCalls('{"type":"function","function":{"name":"edit_file","parameters":{"path":"./calc.py","old_string":"a","new_string":"b"}}}', new Set(['edit_file']));
		expect(calls[0]).toMatchObject({ name: 'edit_file', input: { path: './calc.py' } });
	});
});

describe('edit_file matching', () => {
	const file = 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n';
	it('matches a snippet the model re-flowed onto one line', () => {
		const loc = locate(file, 'def add(a, b): return a + b');
		expect(loc).toBeDefined();
		expect(file.slice(loc!.start, loc!.end)).toBe('def add(a, b):\n    return a + b');
		expect(applyEdit(file, 'def add(a, b): return a + b', 'def add(a, b):\n    return a + b + 0', false)).toContain('return a + b + 0\n\ndef sub');
	});
	it('still refuses text that is not there', () => {
		expect(() => applyEdit(file, 'def mul(a, b): return a * b', 'x', false)).toThrow(/not found/);
	});
});

describe('write_file and run_command helpers', () => {
	it('adds the missing extension for code files', () => {
		expect(inferMissingExtension('calc', 'def add(a, b):\n    return a + b\n')).toBe('.py');
		expect(inferMissingExtension('app', 'const x = require("x");')).toBe('.js');
		expect(inferMissingExtension('calc.py', 'def f(): pass')).toBeUndefined();
		expect(inferMissingExtension('Makefile', 'all:\n\techo hi')).toBeUndefined();
		expect(inferMissingExtension('run', '#!/usr/bin/env python\nprint(1)')).toBeUndefined();
	});
	it('verifies with a real syntax check instead of invented commands', () => {
		expect(quickCheckCommand(['calc.py', 'README.md'])).toBe('python -m py_compile calc.py');
		expect(quickCheckCommand(['a.js'])).toBe('node --check a.js');
		expect(quickCheckCommand(['notes.md'])).toBeUndefined();
	});
	it('explains missing programs and cwd-relative paths', () => {
		expect(commandHints('lint test calc', "lint : The term 'lint' is not recognized as the name of a cmdlet", undefined, false)).toMatch(/not installed/);
		expect(commandHints('python calculator/src/calc.py', "can't open file 'C:\\x\\calculator\\src\\calculator\\src\\calc.py': [Errno 2] No such file or directory", 'calculator/src', false)).toMatch(/relative to that folder/);
		expect(commandHints('python app.py', 'Python was not found; run without arguments to install from the Microsoft Store', undefined, false)).toMatch(/winget/);
	});
});

describe('files named in plain text', () => {
	it('finds absolute, relative and bare file names', () => {
		expect(extractFileRefs('edit this file and add the code:\nC:\\python\\tests\\calc.py')).toContain('C:\\python\\tests\\calc.py');
		expect(extractFileRefs('make a calculator in the calc.py file')).toEqual(['calc.py']);
		expect(extractFileRefs('fix src/app.ts and "my file.txt" please')).toEqual(expect.arrayContaining(['src/app.ts', 'my file.txt']));
		expect(extractFileRefs('see @file:a.py and e.g. version 1.2.3')).toEqual([]);
	});
	it('parses @output mentions', () => {
		expect(parseMentions('look at @output:Git please')).toEqual([expect.objectContaining({ kind: 'output', arg: 'Git' })]);
		expect(parseMentions('@output')[0]).toMatchObject({ kind: 'output', arg: undefined });
	});
});

describe('re-indent inline edits (Ctrl+Alt+. damaged calc.py)', () => {
	it('restores the indentation of a dedented method', () => {
		const original = '    def create_buttons(self):\n        buttons = [1]\n        return buttons\n';
		const model = 'def create_buttons(self):\n    buttons = [1, 2]\n    return buttons';
		expect(reindent(original, model)).toBe('    def create_buttons(self):\n        buttons = [1, 2]\n        return buttons\n');
	});
	it('leaves correctly indented output alone', () => {
		expect(reindent('  x = 1', '  x = 2')).toBe('  x = 2');
	});
});

describe('chat history operations', () => {
	const conv = (): Conversation => ({
		id: 'c', title: 't', created: 0, updated: 0, agentId: 'coder', sentContext: { a: 'b' }, epoch: 0,
		messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'r1' }, { role: 'user', content: 'two' }, { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'write_file', input: {} }] }, { role: 'tool', toolCallId: 't', content: 'ok' }, { role: 'assistant', content: 'r2' }],
		turns: [
			{ role: 'user', text: 'one', ts: 1, msgIndex: 0, epoch: 0 },
			{ role: 'assistant', parts: [{ type: 'text', text: 'r1' }], ts: 2 },
			{ role: 'user', text: 'two', ts: 3, msgIndex: 2, epoch: 0 },
			{ role: 'assistant', parts: [{ type: 'tool', id: 't', name: 'write_file', summary: 'Write a.py' }, { type: 'checkpoint', id: 'cp1', files: 1 }, { type: 'text', text: 'r2' }], ts: 4 },
		],
	});

	it('reverts to before a message using the exact model history', () => {
		const c = conv();
		const removed = truncateConversation(c, 2);
		expect(c.turns).toHaveLength(2);
		expect(c.messages).toEqual([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'r1' }]);
		expect(checkpointsIn(removed)).toEqual(['cp1']);
		expect(c.sentContext).toEqual({});
	});

	it('rebuilds a text history when indexes are stale (after compaction)', () => {
		const c = conv();
		c.epoch = 3;
		expect(messagesUpTo(c, 2)).toEqual([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'r1' }]);
	});

	it('branches and exports Markdown', () => {
		const b = branchTurns(conv(), 1);
		expect(b.turns).toHaveLength(2);
		expect(b.messages).toHaveLength(2);
		const md = toMarkdown(conv(), { tools: true });
		expect(md).toContain('## You');
		expect(md).toContain('Write a.py');
		expect(md).toContain('r2');
	});

	it('only hands Chat requests to the Coder when something should be done', () => {
		expect(isHandoff('HANDOFF:coder', 'make a calculator app')).toBe(true);
		expect(isHandoff("I'm unable to create a calculator app", 'make a calculator app with a UI')).toBe(true);
		expect(isHandoff('HANDOFF:coder', 'what does this do?')).toBe(false);
	});
});
