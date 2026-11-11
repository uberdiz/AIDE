import * as vscode from 'vscode';
import { truncateMiddle } from '../ai/context/compress';
import type { Tool } from './types';

/** Lets agents inspect a paused debug session through the Debug Adapter Protocol. */
export function debugTools(): Tool[] {
	const session = () => {
		const s = vscode.debug.activeDebugSession;
		if (!s) throw new Error('No active debug session. Start debugging (F5) and pause at a breakpoint first.');
		return s;
	};
	return [
		{
			name: 'debug_get_state',
			toolset: 'debug',
			category: 'read',
			readOnly: true,
			description: 'Inspect the active debug session: threads, call stack of the stopped thread, and local variables of the top frames. Also lists breakpoints.',
			inputSchema: { type: 'object', properties: { frames: { type: 'integer', description: 'How many frames to expand (default 2)' } } },
			describe: () => 'Inspect debugger state',
			async run(input) {
				const s = session();
				const out: string[] = [`Session: ${s.name} (${s.type})`];
				const threads = (await s.customRequest('threads')).threads as { id: number; name: string }[];
				out.push(`Threads: ${threads.map(t => `${t.id}:${t.name}`).join(', ')}`);
				const bps = vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint);
				out.push(`Breakpoints: ${bps.map(b => `${vscode.workspace.asRelativePath(b.location.uri)}:${b.location.range.start.line + 1}${b.condition ? ` if ${b.condition}` : ''}${b.enabled ? '' : ' (disabled)'}`).join(', ') || 'none'}`);
				const expand = Math.min(5, Number(input.frames ?? 2));
				for (const t of threads.slice(0, 4)) {
					let st;
					try {
						st = await s.customRequest('stackTrace', { threadId: t.id, startFrame: 0, levels: 20 });
					} catch {
						continue; // thread is running
					}
					out.push(`\nThread ${t.name} stack:`);
					for (const [i, f] of (st.stackFrames as any[]).entries()) {
						out.push(`  #${i} ${f.name} ${f.source?.path ? `${vscode.workspace.asRelativePath(f.source.path)}:${f.line}` : ''}`);
						if (i < expand) {
							const scopes = (await s.customRequest('scopes', { frameId: f.id })).scopes as any[];
							for (const sc of scopes.filter(x => !x.expensive).slice(0, 2)) {
								const vars = (await s.customRequest('variables', { variablesReference: sc.variablesReference })).variables as any[];
								out.push(`     ${sc.name}: ${vars.slice(0, 40).map(v => `${v.name}=${String(v.value).slice(0, 120)}`).join(', ')}`);
							}
						}
					}
				}
				return { content: truncateMiddle(out.join('\n'), 6000).text };
			},
		},
		{
			name: 'debug_evaluate',
			toolset: 'debug',
			category: 'command',
			description: 'Evaluate an expression in the paused debug session (top frame of the first stopped thread). May have side effects.',
			inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
			describe: i => `Evaluate \`${i.expression}\` in debugger`,
			async run(input) {
				const s = session();
				const threads = (await s.customRequest('threads')).threads as { id: number }[];
				for (const t of threads) {
					try {
						const st = await s.customRequest('stackTrace', { threadId: t.id, startFrame: 0, levels: 1 });
						const frameId = st.stackFrames?.[0]?.id;
						const r = await s.customRequest('evaluate', { expression: input.expression, frameId, context: 'repl' });
						return { content: `${input.expression} = ${r.result}${r.type ? ` (${r.type})` : ''}` };
					} catch {
						continue;
					}
				}
				return { content: 'No stopped thread to evaluate in.', isError: true };
			},
		},
		{
			name: 'debug_start',
			toolset: 'debug',
			category: 'command',
			description: 'Start a debug session using a launch configuration name from .vscode/launch.json.',
			inputSchema: { type: 'object', properties: { configuration: { type: 'string' } }, required: ['configuration'] },
			describe: i => `Start debugging "${i.configuration}"`,
			async run(input) {
				const folder = vscode.workspace.workspaceFolders?.[0];
				const ok = await vscode.debug.startDebugging(folder, String(input.configuration));
				return ok ? { content: `Started "${input.configuration}".` } : { content: `Could not start "${input.configuration}" (check launch.json).`, isError: true };
			},
		},
	];
}
