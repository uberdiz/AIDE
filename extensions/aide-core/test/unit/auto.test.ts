import { describe, expect, it } from 'vitest';
import { complexityOf, detectIntent, rememberFact } from '../../src/ai/intent';
import { modelSizeB, pickForRole, recommendations, roleForTask, type PickableModel } from '../../src/ai/modelPicker';

const agent = (text: string, ctx = {}) => detectIntent(text, { hasWorkspace: true, ...ctx }).agentId;

describe('detectIntent (auto agent)', () => {
	it('sends build and change requests to the Coder', () => {
		expect(agent('make a calculator app with a UI')).toBe('coder');
		expect(agent('make a calculator app with a UI in the calc.py file')).toBe('coder');
		expect(agent('make a new python file named calc')).toBe('coder');
		expect(agent('edit this file and add the code:\nC:\\python\\tests\\calc.py')).toBe('coder');
		expect(agent('like a normal app, add the functions and the numbers')).toBe('coder');
		expect(agent('can you add a clear button?')).toBe('coder');
		expect(agent('run the script')).toBe('coder');
	});

	it('keeps questions in Chat', () => {
		expect(agent('what does this function do?')).toBe('chat');
		expect(agent('how do I make a calculator app in python?')).toBe('chat');
		expect(agent('explain the project structure')).toBe('chat');
		expect(agent('hello')).toBe('chat');
	});

	it('routes errors, plans, reviews, tests, docs and git', () => {
		expect(agent('fix the bug in calc.py')).toBe('debugger');
		expect(agent('Traceback (most recent call last):\n  File "calc.py", line 3\nNameError: name x is not defined')).toBe('debugger');
		expect(agent("my script doesn't work")).toBe('debugger');
		expect(agent('why does it crash?')).toBe('chat');
		expect(agent('plan the architecture for a sync service')).toBe('planner');
		expect(agent('review my changes')).toBe('reviewer');
		expect(agent('write unit tests for the parser')).toBe('tester');
		expect(agent('add docstrings to utils.py')).toBe('docs');
		expect(agent('commit and push my changes')).toBe('coder-github');
	});

	it('honours /commands and short follow-ups', () => {
		const r = detectIntent('/plan add login', { agentIds: ['chat', 'coder'] });
		expect(r.agentId).toBe('planner');
		expect(r.forced).toBe(true);
		expect(r.text).toBe('add login');
		expect(detectIntent('/myagent do x', { agentIds: ['myagent'] }).agentId).toBe('myagent');
		expect(agent('no, use tkinter instead', { previousAgent: 'coder' })).toBe('coder');
		expect(agent('yes', { previousAgent: 'debugger' })).toBe('debugger');
	});

	it('maps agents to model roles and rates complexity', () => {
		expect(detectIntent('make a calculator app').task).toBe('coding');
		expect(detectIntent('what is this?').task).toBe('chat');
		expect(complexityOf('fix typo')).toBe('simple');
		expect(complexityOf('rewrite the entire backend from scratch with a new architecture and migrate every service to the new database layer')).toBe('complex');
	});

	it('extracts facts to remember', () => {
		expect(rememberFact('remember that tests run with pytest -q')).toBe('tests run with pytest -q');
		expect(rememberFact('/remember use tabs')).toBe('use tabs');
		expect(rememberFact('remember what I said?')).toBeUndefined();
		expect(rememberFact('make a calculator')).toBeUndefined();
	});
});

const m = (id: string, label: string, caps: string[], local = true): PickableModel => ({ ref: `${local ? 'ollama' : 'anthropic'}/${id}`, providerId: local ? 'ollama' : 'anthropic', id, label, local, caps });
const USER_MODELS = [
	m('smollm2:360m', 'smollm2:360m (361.82M)', ['chat', 'tools']),
	m('llama3.2:1b', 'llama3.2:1b (1.2B)', ['chat', 'tools']),
	m('llama3.1:latest', 'llama3.1:latest (8.0B)', ['chat', 'tools']),
];

describe('pickForRole (auto model)', () => {
	it('parses model sizes', () => {
		expect(modelSizeB({ id: 'x', label: 'x (361.82M)' })).toBeCloseTo(0.36, 2);
		expect(modelSizeB({ id: 'qwen2.5-coder:7b' })).toBe(7);
		expect(modelSizeB({ id: 'qwen3:0.6b' })).toBe(0.6);
		expect(modelSizeB({ id: 'llama3.1:latest' })).toBeUndefined();
	});

	it('uses the 8B model for coding and the ~1B model for chat', () => {
		expect(pickForRole('coding', USER_MODELS)[0].id).toBe('llama3.1:latest');
		expect(pickForRole('chat', USER_MODELS)[0].id).toBe('llama3.2:1b');
		expect(pickForRole('reasoning', USER_MODELS)[0].id).toBe('llama3.1:latest');
		expect(pickForRole(roleForTask('debug'), USER_MODELS)[0].id).toBe('llama3.1:latest');
	});

	it('prefers coder models for coding and small ones for autocomplete', () => {
		const models = [...USER_MODELS, m('qwen2.5-coder:7b', 'qwen2.5-coder:7b (7.6B)', ['chat', 'tools', 'completion']), m('qwen2.5-coder:1.5b', 'qwen2.5-coder:1.5b (1.5B)', ['chat', 'completion'])];
		expect(pickForRole('coding', models)[0].id).toBe('qwen2.5-coder:7b');
		expect(pickForRole('autocomplete', models)[0].id).toBe('qwen2.5-coder:1.5b');
	});

	it('prefers strong cloud models for coding and reasoning when enabled', () => {
		const models = [...USER_MODELS, m('claude-opus-5-5', 'Claude Opus 5.5', ['chat', 'tools', 'vision'], false), m('claude-haiku-4-5', 'Claude Haiku 4.5', ['chat', 'tools'], false)];
		expect(pickForRole('coding', models)[0].id).toBe('claude-opus-5-5');
		expect(pickForRole('reasoning', models)[0].id).toBe('claude-opus-5-5');
		expect(pickForRole('chat', models)[0].id).toBe('llama3.2:1b');
		expect(pickForRole('vision', models)[0].id).toBe('claude-opus-5-5');
	});

	it('recommends a coder model when none is installed', () => {
		expect(recommendations(USER_MODELS).map(r => r.role)).toEqual(['coding']);
	});
});
