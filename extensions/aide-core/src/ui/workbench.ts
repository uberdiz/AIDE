import * as vscode from 'vscode';
import * as config from '../core/config';

/**
 * Saved workbench layouts. A layout is a set of settings plus view commands,
 * applied on demand ("Coding", "Debugging", "AI Development", "Git", "Web Development").
 */
export interface Layout {
	sidebar?: 'explorer' | 'search' | 'scm' | 'debug' | 'extensions' | 'aide' | 'hidden';
	sidebarLocation?: 'left' | 'right';
	panel?: 'terminal' | 'problems' | 'output' | 'debug' | 'hidden';
	panelPosition?: 'bottom' | 'right' | 'left';
	chat?: boolean;
	activityBar?: 'default' | 'top' | 'bottom' | 'hidden';
	minimap?: boolean;
	statusBar?: boolean;
	zen?: boolean;
	settings?: Record<string, unknown>;
}

export const BUILTIN_LAYOUTS: Record<string, Layout> = {
	Coding: { sidebar: 'explorer', sidebarLocation: 'left', panel: 'terminal', panelPosition: 'bottom', chat: true, activityBar: 'default', minimap: true },
	Debugging: { sidebar: 'debug', sidebarLocation: 'left', panel: 'debug', panelPosition: 'bottom', chat: false, minimap: false },
	'AI Development': { sidebar: 'aide', sidebarLocation: 'left', panel: 'terminal', panelPosition: 'bottom', chat: true, minimap: false },
	Git: { sidebar: 'scm', sidebarLocation: 'left', panel: 'hidden', chat: true },
	'Web Development': { sidebar: 'explorer', panel: 'terminal', panelPosition: 'right', chat: true, minimap: false },
	Focus: { sidebar: 'hidden', panel: 'hidden', chat: false, minimap: false, activityBar: 'hidden' },
};

const SIDEBAR_CMD: Record<string, string> = { explorer: 'workbench.view.explorer', search: 'workbench.view.search', scm: 'workbench.view.scm', debug: 'workbench.view.debug', extensions: 'workbench.view.extensions', aide: 'workbench.view.extension.aide' };
const PANEL_CMD: Record<string, string> = { terminal: 'workbench.action.terminal.focus', problems: 'workbench.actions.view.problems', output: 'workbench.action.output.toggleOutput', debug: 'workbench.debug.action.toggleRepl' };

async function exec(cmd: string): Promise<void> {
	try {
		await vscode.commands.executeCommand(cmd);
	} catch {
		/* command unavailable in this build: skip */
	}
}

export async function applyLayout(l: Layout): Promise<void> {
	const wb = vscode.workspace.getConfiguration();
	const T = vscode.ConfigurationTarget.Global;
	if (l.sidebarLocation) await wb.update('workbench.sideBar.location', l.sidebarLocation, T);
	if (l.activityBar) await wb.update('workbench.activityBar.location', l.activityBar, T);
	if (l.minimap !== undefined) await wb.update('editor.minimap.enabled', l.minimap, T);
	if (l.statusBar !== undefined) await wb.update('workbench.statusBar.visible', l.statusBar, T);
	for (const [k, v] of Object.entries(l.settings ?? {})) await wb.update(k, v, T);
	if (l.sidebar === 'hidden') await exec('workbench.action.closeSidebar');
	else if (l.sidebar) await exec(SIDEBAR_CMD[l.sidebar]);
	if (l.panelPosition) await exec(`workbench.action.positionPanel${l.panelPosition[0].toUpperCase()}${l.panelPosition.slice(1)}`);
	if (l.panel === 'hidden') await exec('workbench.action.closePanel');
	else if (l.panel) await exec(PANEL_CMD[l.panel]);
	if (l.chat === true) await exec('aide.chat.focus');
	else if (l.chat === false) await exec('workbench.action.closeAuxiliaryBar');
	if (l.zen) await exec('workbench.action.toggleZenMode');
	await exec('workbench.action.focusActiveEditorGroup');
}

export function registerLayouts(ctx: vscode.ExtensionContext): void {
	const all = () => ({ ...BUILTIN_LAYOUTS, ...config.get<Record<string, Layout>>('layouts', {}) });
	ctx.subscriptions.push(
		vscode.commands.registerCommand('aide.layout.apply', async (name?: string) => {
			const layouts = all();
			const n = name ?? (await vscode.window.showQuickPick(Object.keys(layouts).map(k => ({ label: k, description: BUILTIN_LAYOUTS[k] ? 'built-in' : 'custom' })), { placeHolder: 'Apply workspace layout' }))?.label;
			if (!n || !layouts[n]) return;
			await applyLayout(layouts[n]);
			await ctx.globalState.update('aide.layout.current', n);
		}),
		vscode.commands.registerCommand('aide.layout.save', async () => {
			const name = await vscode.window.showInputBox({ prompt: 'Save current layout as' });
			if (!name) return;
			const wb = vscode.workspace.getConfiguration();
			const sidebar = (await vscode.window.showQuickPick(['explorer', 'search', 'scm', 'debug', 'extensions', 'aide', 'hidden'], { placeHolder: 'Sidebar view for this layout' })) as Layout['sidebar'];
			const panel = (await vscode.window.showQuickPick(['terminal', 'problems', 'output', 'debug', 'hidden'], { placeHolder: 'Panel for this layout' })) as Layout['panel'];
			const chat = (await vscode.window.showQuickPick(['show AI chat', 'hide AI chat'], { placeHolder: 'AI chat' })) === 'show AI chat';
			const layout: Layout = {
				sidebar,
				panel,
				chat,
				sidebarLocation: wb.get('workbench.sideBar.location'),
				activityBar: wb.get('workbench.activityBar.location'),
				minimap: wb.get('editor.minimap.enabled'),
				statusBar: wb.get('workbench.statusBar.visible'),
			};
			await config.update('layouts', { ...config.get<Record<string, Layout>>('layouts', {}), [name]: layout });
			void vscode.window.showInformationMessage(`Saved layout "${name}". Apply it with "AIDE: Apply Layout"; edit under "aide.layouts" in settings.`);
		}),
	);
}
