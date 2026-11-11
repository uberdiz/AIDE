import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { acceptHunk, computeHunks, rejectHunk, unifiedDiff } from '../../src/changes/diff';
import { ChangeTracker } from '../../src/changes/tracker';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aide-test-'));

describe('diff hunks', () => {
	const base = 'a\nb\nc\nd\ne\nf\n';
	const cur = 'a\nB\nc\nd\ne\nF\ng\n';

	it('computes hunks', () => {
		const hs = computeHunks(base, cur);
		expect(hs).toHaveLength(2);
		expect(hs[0]).toMatchObject({ oldStart: 1, oldLines: ['b'], newLines: ['B'] });
		expect(hs[1]).toMatchObject({ oldLines: ['f'], newLines: ['F', 'g'] });
	});

	it('accepts and rejects individual hunks', () => {
		expect(acceptHunk(base, cur, 0)).toBe('a\nB\nc\nd\ne\nf\n');
		expect(rejectHunk(base, cur, 0)).toBe('a\nb\nc\nd\ne\nF\ng\n');
		expect(rejectHunk(base, cur, 1)).toBe('a\nB\nc\nd\ne\nf\n');
	});

	it('renders a unified diff', () => {
		const d = unifiedDiff('x.txt', base, cur, 1);
		expect(d).toContain('-b');
		expect(d).toContain('+B');
		expect(d).toContain('@@ -1,3 +1,3 @@');
	});
});

describe('ChangeTracker', () => {
	it('checkpoints and restores (including created files), rewinding newer checkpoints', () => {
		const root = tmp();
		const store = tmp();
		const t = new ChangeTracker(store);
		const a = path.join(root, 'a.txt');
		const b = path.join(root, 'sub', 'b.txt');
		fs.writeFileSync(a, 'original A');

		t.beginRun('run1', 'first');
		t.beforeWrite('run1', a);
		fs.writeFileSync(a, 'changed A');
		t.afterWrite(a);
		const cp1 = t.endRun('run1')!;

		t.beginRun('run2', 'second');
		t.beforeWrite('run2', b);
		fs.mkdirSync(path.dirname(b), { recursive: true });
		fs.writeFileSync(b, 'new B');
		t.afterWrite(b);
		t.beforeWrite('run2', a);
		fs.writeFileSync(a, 'changed A twice');
		t.afterWrite(a);
		t.endRun('run2');

		expect(t.listCheckpoints()).toHaveLength(2);
		const pending = t.pendingChanges();
		expect(pending.map(p => p.kind).sort()).toEqual(['added', 'modified']);

		const r = t.restore(cp1.id);
		expect(fs.readFileSync(a, 'utf8')).toBe('original A');
		expect(fs.existsSync(b)).toBe(false);
		expect(r.deleted.length).toBe(1);
		expect(t.listCheckpoints()).toHaveLength(0);
		expect(t.pendingChanges()).toHaveLength(0);

		// state persists across instances
		const t2 = new ChangeTracker(store);
		expect(t2.listCheckpoints()).toHaveLength(0);
	});

	it('supports review: reject file, reject hunk, accept', () => {
		const root = tmp();
		const t = new ChangeTracker(tmp());
		const f = path.join(root, 'f.txt');
		fs.writeFileSync(f, '1\n2\n3\n4\n5\n6\n7\n8\n');
		t.beforeWrite('r', f);
		fs.writeFileSync(f, '1\nTWO\n3\n4\n5\n6\nSEVEN\n8\n');
		t.afterWrite(f);
		expect(t.hunks(f)).toHaveLength(2);
		t.rejectHunk(f, 0);
		expect(fs.readFileSync(f, 'utf8')).toBe('1\n2\n3\n4\n5\n6\nSEVEN\n8\n');
		expect(t.hunks(f)).toHaveLength(1);
		t.acceptHunk(f, 0);
		expect(t.pendingChanges()).toHaveLength(0);

		const g = path.join(root, 'g.txt');
		t.beforeWrite('r', g);
		fs.writeFileSync(g, 'created');
		t.afterWrite(g);
		t.rejectFile(g);
		expect(fs.existsSync(g)).toBe(false);
	});
});
