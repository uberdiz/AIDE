import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeProvider, describeTool, promptFor, sessionOf } from '../../src/ai/providers/claudeCode';
import type { ChatMessage, ChatRequest, StreamEvent } from '../../src/ai/types';

const SID = '5f0c2c1e-0000-4000-8000-000000000001';
const line = (o: unknown) => JSON.stringify(o) + '\n';

function fakeSpawn(lines: string[], code = 0, stderr = '') {
	const calls: { cmd: string; args: string[]; opts: any }[] = [];
	const spawn = (cmd: string, args: string[], opts: any) => {
		calls.push({ cmd, args, opts });
		const child: any = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => child.emit('close', 143);
		setImmediate(() => {
			for (const l of lines) child.stdout.write(l);
			child.stdout.end();
			if (stderr) child.stderr.write(stderr);
			setImmediate(() => child.emit('close', code));
		});
		return child;
	};
	return { spawn, calls };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

const STREAM = [
	line({ type: 'system', subtype: 'init', session_id: SID }),
	line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/src/date.ts' } }] } }),
	line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed the UTC branch.' }] } }),
	line({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the UTC branch.', session_id: SID, usage: { input_tokens: 1200, output_tokens: 80 } }),
];

const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const req = (messages: ChatMessage[], model = 'default'): ChatRequest => ({ model, messages, system: 'Be brief.' });

describe('ClaudeCodeProvider', () => {
	it('streams text and tool steps, and keeps the session in the answer', async () => {
		const { spawn, calls } = fakeSpawn(STREAM);
		const p = new ClaudeCodeProvider({ id: 'claude', kind: 'claude-code' }, () => '/w', spawn as any);
		const events = await collect(p.chat(req([user('fix the date bug')]), new AbortController().signal));
		const text = events.filter(e => e.type === 'text').map(e => (e as any).text).join('');
		expect(text).toContain('▸ Edit date.ts');
		expect(text).toContain('Fixed the UTC branch.');
		const done = events.at(-1) as any;
		expect(done.type).toBe('done');
		expect(done.message.native).toEqual({ provider: 'claude', model: 'default', content: { sessionId: SID } });
		expect(events.find(e => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 80, exact: true } });
		const args = calls[0].args;
		expect(calls[0].cmd).toBe('claude');
		expect(calls[0].opts.cwd).toBe('/w');
		expect(args.slice(0, 2)).toEqual(['-p', 'fix the date bug']);
		expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
		expect(args).not.toContain('--resume');
		expect(args.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
	});

	it('resumes the session and sends only the new message', async () => {
		const { spawn, calls } = fakeSpawn(STREAM);
		const p = new ClaudeCodeProvider({ id: 'claude', kind: 'claude-code' }, () => '/w', spawn as any);
		const history: ChatMessage[] = [
			user('fix the date bug'),
			{ role: 'assistant', content: 'Fixed.', native: { provider: 'claude', model: 'sonnet', content: { sessionId: SID } } },
			user('now add a test'),
		];
		await collect(p.chat(req(history, 'sonnet'), new AbortController().signal));
		const args = calls[0].args;
		expect(args[1]).toBe('now add a test');
		expect(args[args.indexOf('--resume') + 1]).toBe(SID);
		expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
		expect(args).not.toContain('--append-system-prompt');      // already in the session
	});

	it('refuses unsafe permission modes and explains sign-in problems', async () => {
		const bad = new ClaudeCodeProvider({ id: 'c', kind: 'claude-code', options: { permissionMode: 'bypassPermissions' } });
		expect(() => bad.argv(req([user('x')]), undefined)).toThrow(/Unsupported/);
		const { spawn } = fakeSpawn([], 1, 'Error: Not logged in · Please run /login');
		const p = new ClaudeCodeProvider({ id: 'c', kind: 'claude-code' }, () => '/w', spawn as any);
		await expect(collect(p.chat(req([user('x')]), new AbortController().signal))).rejects.toThrow(/signed in/);
	});

	it('helpers', () => {
		expect(describeTool('Bash', { command: 'npm test\nmore', description: undefined as any })).toBe('Run: npm test');
		expect(sessionOf([user('a')], 'c')).toBeUndefined();
		expect(promptFor(req([user('a'), { role: 'assistant', content: 'b' }, user('c')]), false)).toBe('User: a\n\nAssistant: b\n\nUser: c');
	});
});
