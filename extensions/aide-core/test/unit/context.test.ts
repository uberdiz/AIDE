import { describe, expect, it } from 'vitest';
import { compressOutput, outlineFile, stripAnsi } from '../../src/ai/context/compress';
import { ContextEngine, renderContext, type ContextSources } from '../../src/ai/context/engine';
import { autoContextAllowed, IgnoreMatcher, isSecretPath } from '../../src/ai/context/ignore';
import { extractSearchTerms, parseMentions } from '../../src/ai/context/mentions';
import { compactHistory } from '../../src/ai/history';
import type { ChatMessage } from '../../src/ai/types';

describe('ignore rules', () => {
	it('ignores dependency/build folders and honors gitignore syntax', () => {
		const m = new IgnoreMatcher().add('*.log\n/secret-dir/\nbuild/\n!keep.log\ndocs/**/*.tmp');
		expect(m.ignores('node_modules/x/index.js')).toBe(true);
		expect(m.ignores('src/.venv/lib.py')).toBe(true);
		expect(m.ignores('app.log')).toBe(true);
		expect(m.ignores('keep.log')).toBe(false);
		expect(m.ignores('secret-dir', true)).toBe(true);
		expect(m.ignores('nested/secret-dir/a.txt')).toBe(false);
		expect(m.ignores('packages/a/build/out.js')).toBe(true);
		expect(m.ignores('docs/a/b/c.tmp')).toBe(true);
		expect(m.ignores('src/main.ts')).toBe(false);
	});

	it('never auto-includes secrets, binaries or lockfiles', () => {
		const m = new IgnoreMatcher([]);
		expect(isSecretPath('.env')).toBe(true);
		expect(isSecretPath('config/.env.production')).toBe(true);
		expect(isSecretPath('.env.example')).toBe(false);
		expect(autoContextAllowed('package-lock.json', m)).toBe(false);
		expect(autoContextAllowed('assets/logo.png', m)).toBe(false);
		expect(autoContextAllowed('src/a.ts', m)).toBe(true);
	});
});

describe('mentions', () => {
	it('parses all mention forms', () => {
		const ms = parseMentions('Fix @file:src/main.py and @file "my dir/a b.ts" using @selection, see @errors @git @workspace @folder backend/ @symbol:Router.route');
		expect(ms.map(m => [m.kind, m.arg])).toEqual([
			['file', 'src/main.py'], ['file', 'my dir/a b.ts'], ['selection', undefined], ['errors', undefined], ['git', undefined], ['workspace', undefined], ['folder', 'backend/'], ['symbol', 'Router.route'],
		]);
	});

	it('extracts identifiers for retrieval', () => {
		const t = extractSearchTerms('Why does `parseConfig` crash in config_loader.py when UserSession is null?');
		expect(t).toContain('parseConfig');
		expect(t).toContain('config_loader.py');
		expect(t).toContain('UserSession');
	});
});

describe('compression', () => {
	it('strips ANSI, resolves progress bars and collapses repeats', () => {
		const raw = '\x1b[32mok\x1b[0m\nprogress 10%\rprogress 100%\n' + 'downloading chunk 1\n'.repeat(1) + Array.from({ length: 50 }, (_, i) => `downloading chunk ${i + 2}`).join('\n') + '\nError: boom';
		const out = compressOutput(raw, 500);
		expect(stripAnsi('\x1b[1;31mred\x1b[0m')).toBe('red');
		expect(out).toContain('progress 100%');
		expect(out).not.toContain('progress 10%');
		expect(out).toMatch(/repeated 50 more times/);
		expect(out).toContain('Error: boom');
	});

	it('keeps error lines from the middle of huge logs', () => {
		const lines = Array.from({ length: 5000 }, (_, i) => (i === 2500 ? 'FATAL ERROR: disk full' : `line ${i} ${'x'.repeat(i % 7)}${i % 3 ? 'a' : 'b'}`));
		const out = compressOutput(lines.join('\n'), 800);
		expect(out).toContain('FATAL ERROR: disk full');
		expect(out).toMatch(/lines omitted/);
		expect(out.length).toBeLessThan(800 * 4.5);
	});

	it('outlines source files', () => {
		const src = "import fs from 'fs';\n\nexport class Foo {\n  bar() {\n    return 1;\n  }\n}\n\nexport function baz(x: number): number {\n  return x;\n}\n";
		const o = outlineFile(src);
		expect(o).toContain("1: import fs from 'fs';");
		expect(o).toContain('3: export class Foo');
		expect(o).toContain('9: export function baz(x: number): number');
	});
});

function fakeSources(files: Record<string, string>, extra: Partial<ContextSources> = {}): ContextSources {
	return {
		readFile: async p => files[p],
		listFolder: async p => Object.keys(files).filter(f => f.startsWith(p)),
		selection: async () => undefined,
		activeFile: async () => undefined,
		openFiles: async () => [],
		terminal: async () => 'npm ERR! missing script: test',
		diagnostics: async () => 'src/a.ts:3 error TS2304: Cannot find name x',
		gitDiff: async () => undefined,
		search: async terms => Object.entries(files).filter(([, c]) => terms.some(t => c.includes(t))).map(([f, c]) => ({ file: f, lines: [c.split('\n').findIndex(l => terms.some(t => l.includes(t))) + 1] })),
		symbol: async () => [],
		repoMap: async () => 'Repository: demo (2 files)',
		instructions: async () => [{ source: '.aide/instructions.md', content: 'Use tabs.' }],
		memory: async () => undefined,
		...extra,
	};
}

describe('ContextEngine', () => {
	const files = { 'src/a.ts': 'export function parseConfig() {\n  return 1;\n}\n', 'src/b.ts': 'import { parseConfig } from "./a";\nparseConfig();\n' };

	it('includes explicit mentions, instructions and retrieval hits within budget', async () => {
		const e = new ContextEngine(fakeSources(files));
		const b = await e.build({ prompt: 'why is `parseConfig` wrong? see @file:src/b.ts and @terminal', strategy: 'balanced' });
		const labels = b.items.map(i => i.label);
		expect(labels).toContain('.aide/instructions.md');
		expect(labels).toContain('src/b.ts');
		expect(labels).toContain('Terminal output');
		expect(labels.some(l => l.startsWith('src/a.ts'))).toBe(true);
		expect(b.totalTokens).toBeLessThanOrEqual(b.budget);
		const text = renderContext(b);
		expect(text).toContain('<context source="file" label="src/b.ts" reason="mentioned">');
	});

	it('minimal strategy sends only instructions and explicit context', async () => {
		const e = new ContextEngine(fakeSources(files));
		const b = await e.build({ prompt: 'what does parseConfig do', strategy: 'minimal' });
		expect(b.items.map(i => i.kind)).toEqual(['instructions']);
	});

	it('drops low-priority items over budget and honors user exclusions', async () => {
		const big = { 'src/huge.ts': 'export const parseConfig = 1;\n' + 'const x = 1;\n'.repeat(20000) };
		const e = new ContextEngine(fakeSources(big));
		const b = await e.build({ prompt: '`parseConfig`', strategy: 'balanced', budgetTokens: 600, exclude: ['instructions:.aide/instructions.md'] });
		expect(b.items.find(i => i.kind === 'instructions')).toBeUndefined();
		expect(b.dropped.find(d => d.reason === 'removed by user')).toBeDefined();
		expect(b.totalTokens).toBeLessThanOrEqual(600);
	});

	it('dedupes context already sent in the conversation', async () => {
		const e = new ContextEngine(fakeSources(files));
		const first = await e.build({ prompt: '@file:src/a.ts', strategy: 'minimal' });
		const sent = new Map(first.items.map(i => [i.key, i.hash]));
		const second = await e.build({ prompt: '@file:src/a.ts again', strategy: 'minimal', alreadySent: sent });
		const a = second.items.find(i => i.key === 'file:src/a.ts')!;
		expect(a.deduped).toBe(true);
		expect(a.tokens).toBeLessThan(20);
	});
});

describe('compactHistory', () => {
	it('summarizes old turns and keeps recent ones intact', async () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 20; i++) {
			msgs.push({ role: 'user', content: `question ${i} ` + 'lorem ipsum '.repeat(200) });
			msgs.push({ role: 'assistant', content: `answer ${i} ` + 'dolor sit '.repeat(200) });
		}
		const r = await compactHistory(msgs, 3000, async () => 'SUMMARY', 4);
		expect(r.compacted).toBe(true);
		expect(r.messages[0].content).toContain('SUMMARY');
		expect(r.messages[r.messages.length - 1].content).toContain('answer 19');
	});

	it('does nothing when under budget', async () => {
		const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
		expect((await compactHistory(msgs, 1000)).compacted).toBe(false);
	});
});
