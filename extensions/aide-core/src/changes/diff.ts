import { diffLines } from 'diff';

/** A contiguous changed region between a baseline and the current text. */
export interface Hunk {
	index: number;
	/** 0-based line index in the baseline where the region starts */
	oldStart: number;
	oldLines: string[];
	/** 0-based line index in the current text where the region starts */
	newStart: number;
	newLines: string[];
}

type Segment = { kind: 'same'; lines: string[] } | { kind: 'change'; hunk: Hunk };

function splitLines(s: string): string[] {
	if (!s) return [];
	const parts = s.split('\n');
	// diffLines counts trailing newline as terminating the last line
	if (parts[parts.length - 1] === '') parts.pop();
	return parts;
}

function segments(oldText: string, newText: string): Segment[] {
	const segs: Segment[] = [];
	let oldPos = 0;
	let newPos = 0;
	let cur: Hunk | undefined;
	let idx = 0;
	for (const part of diffLines(oldText, newText)) {
		const lines = splitLines(part.value);
		if (!part.added && !part.removed) {
			if (cur) {
				segs.push({ kind: 'change', hunk: cur });
				cur = undefined;
			}
			segs.push({ kind: 'same', lines });
			oldPos += lines.length;
			newPos += lines.length;
			continue;
		}
		if (!cur) cur = { index: idx++, oldStart: oldPos, oldLines: [], newStart: newPos, newLines: [] };
		if (part.removed) {
			cur.oldLines.push(...lines);
			oldPos += lines.length;
		} else {
			cur.newLines.push(...lines);
			newPos += lines.length;
		}
	}
	if (cur) segs.push({ kind: 'change', hunk: cur });
	return segs;
}

export function computeHunks(oldText: string, newText: string): Hunk[] {
	return segments(oldText, newText).flatMap(s => (s.kind === 'change' ? [s.hunk] : []));
}

function rebuild(oldText: string, newText: string, takeNew: (h: Hunk) => boolean): string {
	const out: string[] = [];
	for (const s of segments(oldText, newText)) {
		if (s.kind === 'same') out.push(...s.lines);
		else out.push(...(takeNew(s.hunk) ? s.hunk.newLines : s.hunk.oldLines));
	}
	const eol = newText.endsWith('\n') || (!newText && oldText.endsWith('\n'));
	return out.join('\n') + (out.length && eol ? '\n' : '');
}

/** Baseline after accepting one hunk (the hunk's new text becomes the baseline). */
export function acceptHunk(baseline: string, current: string, index: number): string {
	return rebuild(baseline, current, h => h.index === index);
}

/** Current text after rejecting one hunk (the hunk reverts to the baseline). */
export function rejectHunk(baseline: string, current: string, index: number): string {
	return rebuild(baseline, current, h => h.index !== index);
}

export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const h of computeHunks(oldText, newText)) {
		added += h.newLines.length;
		removed += h.oldLines.length;
	}
	return { added, removed };
}

/** Compact unified-style diff for model context and previews. */
export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
	const oldL = splitLines(oldText);
	const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
	for (const h of computeHunks(oldText, newText)) {
		const pre = oldL.slice(Math.max(0, h.oldStart - context), h.oldStart);
		const post = oldL.slice(h.oldStart + h.oldLines.length, h.oldStart + h.oldLines.length + context);
		out.push(`@@ -${h.oldStart - pre.length + 1},${pre.length + h.oldLines.length + post.length} +${h.newStart - pre.length + 1},${pre.length + h.newLines.length + post.length} @@`);
		out.push(...pre.map(l => ` ${l}`), ...h.oldLines.map(l => `-${l}`), ...h.newLines.map(l => `+${l}`), ...post.map(l => ` ${l}`));
	}
	return out.join('\n');
}
