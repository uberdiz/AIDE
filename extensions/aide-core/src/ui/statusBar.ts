import * as vscode from 'vscode';
import { formatCost, formatTokens } from '../ai/tokens';
import type { ChatController } from '../chat/controller';
import type { Services } from '../services';

export function registerStatusBar(ctx: vscode.ExtensionContext, s: Services, chat: ChatController): void {
	const model = vscode.window.createStatusBarItem('aide.model', vscode.StatusBarAlignment.Right, 101);
	model.name = 'AIDE Model';
	model.command = 'aide.model.select';
	const usage = vscode.window.createStatusBarItem('aide.usage', vscode.StatusBarAlignment.Right, 100);
	usage.name = 'AIDE Usage';
	usage.command = 'aide.usage.open';
	const running = vscode.window.createStatusBarItem('aide.running', vscode.StatusBarAlignment.Left, 100);
	running.name = 'AIDE Agent';
	running.command = 'aide.agent.stopAll';

	const update = () => {
		const m = chat.selectedModel;
		model.text = `$(hubot) ${m ? m.split('/').slice(1).join('/') : 'Auto'}`;
		model.tooltip = m ? `AIDE chat model: ${m}\nClick to change` : 'AIDE chat model: automatic routing\nClick to pick a model';
		model.show();
		const d = s.usage.totals('day');
		const check = s.usage.check('*', 0, 0);
		usage.text = `$(pulse) ${formatCost(d.cost)}`;
		usage.tooltip = `AIDE usage today: ${formatTokens(d.input + d.output + d.cacheRead + d.cacheWrite)} tokens, ${d.requests} requests, ${formatCost(d.cost)}${check.messages.length ? `\n${check.messages.join('\n')}` : ''}\nClick for the usage dashboard`;
		usage.backgroundColor = check.status === 'exceeded' ? new vscode.ThemeColor('statusBarItem.errorBackground') : check.status === 'warn' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		usage.show();
		if (s.runs.size) {
			const r = [...s.runs.values()][0];
			running.text = `$(sync~spin) ${s.agent(r.agentId).name}${s.runs.size > 1 ? ` +${s.runs.size - 1}` : ''}`;
			running.tooltip = `Running: ${r.label}\nClick to stop all AI operations`;
			running.show();
		} else running.hide();
	};
	update();
	ctx.subscriptions.push(model, usage, running, s.onDidChangeUsage(update), s.onDidChangeRuns(update), vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('aide') && update()));
	ctx.subscriptions.push(vscode.commands.registerCommand('aide.internal.refreshStatus', update));
}
