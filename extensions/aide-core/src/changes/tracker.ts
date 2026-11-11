import * as fs from 'fs';
import * as path from 'path';
import { acceptHunk, computeHunks, diffStats, rejectHunk, type Hunk } from './diff';

export interface Checkpoint {
	id: string;
	label: string;
	ts: number;
	runId?: string;
	files: { path: string; existed: boolean; blob?: string }[];
}

export interface PendingChange {
	path: string;
	/** baseline content before AI edits; null when the AI created the file */
	original: string | null;
	runIds: string[];
	ts: number;
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

/**
 * Records every AI file mutation. Provides:
 *  - checkpoints (snapshots taken before the first change of a run), restorable
 *    without git;
 *  - a pending review set (baseline vs. current) for accept/reject per file or hunk.
 */
export class ChangeTracker {
	private checkpoints: Checkpoint[] = [];
	private pending = new Map<string, PendingChange>();
	private runCheckpoint = new Map<string, Checkpoint>();
	private listeners = new Set<() => void>();

	constructor(private readonly dir: string, private readonly maxCheckpoints = 50) {
		fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
		this.load();
	}

	private load(): void {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(this.dir, 'state.json'), 'utf8'));
			this.checkpoints = data.checkpoints ?? [];
			for (const p of data.pending ?? []) this.pending.set(key(p.path), p);
		} catch {
			/* first run or corrupt state: start clean, blobs are reclaimed by prune() */
		}
	}

	private save(): void {
		const tmp = path.join(this.dir, 'state.json.tmp');
		fs.writeFileSync(tmp, JSON.stringify({ checkpoints: this.checkpoints, pending: [...this.pending.values()] }));
		fs.renameSync(tmp, path.join(this.dir, 'state.json'));
		for (const l of this.listeners) l();
	}

	onDidChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Create an explicit checkpoint for a run; subsequent snapshots attach to it. */
	beginRun(runId: string, label: string): void {
		if (this.runCheckpoint.has(runId)) return;
		const cp: Checkpoint = { id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, label, ts: Date.now(), runId, files: [] };
		this.runCheckpoint.set(runId, cp);
	}

	/** Must be called before any AI write/delete of `absPath`. */
	beforeWrite(runId: string, absPath: string): void {
		const cp = this.runCheckpoint.get(runId) ?? (this.beginRun(runId, 'AI changes'), this.runCheckpoint.get(runId)!);
		const k = key(absPath);
		let existed = false;
		let content: string | null = null;
		try {
			content = fs.readFileSync(absPath, 'utf8');
			existed = true;
		} catch {
			existed = false;
		}
		if (!cp.files.some(f => key(f.path) === k)) {
			let blob: string | undefined;
			if (existed) {
				blob = `${cp.id}-${cp.files.length}`;
				fs.writeFileSync(path.join(this.dir, 'blobs', blob), content!);
			}
			cp.files.push({ path: absPath, existed, blob });
			if (!this.checkpoints.includes(cp)) {
				this.checkpoints.push(cp);
				this.prune();
			}
		}
		const p = this.pending.get(k);
		if (!p) this.pending.set(k, { path: absPath, original: content, runIds: [runId], ts: Date.now() });
		else if (!p.runIds.includes(runId)) p.runIds.push(runId);
		this.save();
	}

	/** Call after the write completed (keeps review state fresh). */
	afterWrite(absPath: string): void {
		const p = this.pending.get(key(absPath));
		if (!p) return;
		const cur = readOrNull(absPath);
		// Change was a no-op or has been undone manually: nothing left to review.
		if (cur === p.original) this.pending.delete(key(absPath));
		this.save();
	}

	endRun(runId: string): Checkpoint | undefined {
		const cp = this.runCheckpoint.get(runId);
		this.runCheckpoint.delete(runId);
		return cp && cp.files.length ? cp : undefined;
	}

	listCheckpoints(): Checkpoint[] {
		return [...this.checkpoints].reverse();
	}

	/** Restore files to their state at `id`, rewinding newer checkpoints first. */
	restore(id: string): { restored: string[]; deleted: string[] } {
		const idx = this.checkpoints.findIndex(c => c.id === id);
		if (idx < 0) throw new Error(`Unknown checkpoint ${id}`);
		const restored: string[] = [];
		const deleted: string[] = [];
		for (let i = this.checkpoints.length - 1; i >= idx; i--) {
			for (const f of this.checkpoints[i].files) {
				if (f.existed && f.blob) {
					fs.mkdirSync(path.dirname(f.path), { recursive: true });
					fs.writeFileSync(f.path, fs.readFileSync(path.join(this.dir, 'blobs', f.blob)));
					restored.push(f.path);
				} else {
					try {
						fs.rmSync(f.path, { force: true });
						deleted.push(f.path);
					} catch {
						/* already gone */
					}
				}
				this.pending.delete(key(f.path));
			}
		}
		// Rewound checkpoints no longer describe the disk state.
		const removed = this.checkpoints.splice(idx);
		for (const c of removed) this.dropBlobs(c);
		this.save();
		return { restored: [...new Set(restored)], deleted: [...new Set(deleted)] };
	}

	deleteCheckpoint(id: string): void {
		const idx = this.checkpoints.findIndex(c => c.id === id);
		if (idx < 0) return;
		this.dropBlobs(this.checkpoints[idx]);
		this.checkpoints.splice(idx, 1);
		this.save();
	}

	// ---- review ----

	pendingChanges(): (PendingChange & { kind: ChangeKind; added: number; removed: number })[] {
		const out: (PendingChange & { kind: ChangeKind; added: number; removed: number })[] = [];
		for (const p of this.pending.values()) {
			const cur = readOrNull(p.path);
			const kind: ChangeKind = p.original === null ? 'added' : cur === null ? 'deleted' : 'modified';
			const s = diffStats(p.original ?? '', cur ?? '');
			out.push({ ...p, kind, ...s });
		}
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	getPending(absPath: string): PendingChange | undefined {
		return this.pending.get(key(absPath));
	}

	hunks(absPath: string): Hunk[] {
		const p = this.pending.get(key(absPath));
		if (!p) return [];
		return computeHunks(p.original ?? '', readOrNull(absPath) ?? '');
	}

	acceptFile(absPath: string): void {
		this.pending.delete(key(absPath));
		this.save();
	}

	rejectFile(absPath: string): void {
		const p = this.pending.get(key(absPath));
		if (!p) return;
		if (p.original === null) fs.rmSync(absPath, { force: true });
		else {
			fs.mkdirSync(path.dirname(absPath), { recursive: true });
			fs.writeFileSync(absPath, p.original);
		}
		this.pending.delete(key(absPath));
		this.save();
	}

	acceptHunk(absPath: string, index: number): void {
		const p = this.pending.get(key(absPath));
		if (!p) return;
		const cur = readOrNull(absPath) ?? '';
		p.original = acceptHunk(p.original ?? '', cur, index);
		if (p.original === cur) this.pending.delete(key(absPath));
		this.save();
	}

	rejectHunk(absPath: string, index: number): string {
		const p = this.pending.get(key(absPath));
		if (!p) throw new Error('No pending change for this file');
		const cur = readOrNull(absPath) ?? '';
		const next = rejectHunk(p.original ?? '', cur, index);
		fs.writeFileSync(absPath, next);
		if (next === (p.original ?? '')) {
			if (p.original === null && next === '') fs.rmSync(absPath, { force: true });
			this.pending.delete(key(absPath));
		}
		this.save();
		return next;
	}

	acceptAll(): void {
		this.pending.clear();
		this.save();
	}

	rejectAll(): string[] {
		const paths = [...this.pending.values()].map(p => p.path);
		for (const p of paths) this.rejectFile(p);
		return paths;
	}

	private prune(): void {
		while (this.checkpoints.length > this.maxCheckpoints) {
			const old = this.checkpoints.shift()!;
			this.dropBlobs(old);
		}
	}

	private dropBlobs(c: Checkpoint): void {
		for (const f of c.files) if (f.blob) fs.rmSync(path.join(this.dir, 'blobs', f.blob), { force: true });
	}
}

function key(p: string): string {
	const n = path.resolve(p);
	return process.platform === 'win32' ? n.toLowerCase() : n;
}

function readOrNull(p: string): string | null {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return null;
	}
}
