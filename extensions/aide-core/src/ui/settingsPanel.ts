import * as vscode from 'vscode';
import { recommendations } from '../ai/modelPicker';
import { TASKS } from '../ai/router';
import type { ProviderConfig } from '../ai/types';
import * as config from '../core/config';
import type { Services } from '../services';
import { PERMISSION_CATEGORIES } from '../tools/types';
import { webviewHtml } from './webviewHtml';

export const PROVIDER_TEMPLATES: (ProviderConfig & { needsKey: boolean; help: string })[] = [
	{ id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', needsKey: true, help: 'API key from console.anthropic.com' },
	{ id: 'openai', kind: 'openai', label: 'OpenAI', needsKey: true, help: 'API key from platform.openai.com' },
	{ id: 'gemini', kind: 'gemini', label: 'Google Gemini', needsKey: true, help: 'API key from aistudio.google.com' },
	{ id: 'ollama', kind: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434', local: true, needsKey: false, help: 'Runs models locally; install from ollama.com' },
	{ id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, help: 'One key for many models; openrouter.ai/keys' },
	{ id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', local: true, needsKey: false, help: 'Start the local server in LM Studio' },
	{ id: 'llamacpp', kind: 'openai-compatible', label: 'llama.cpp server (local)', baseUrl: 'http://localhost:8080/v1', local: true, needsKey: false, help: 'llama-server --port 8080' },
	{ id: 'vllm', kind: 'openai-compatible', label: 'vLLM (local/server)', baseUrl: 'http://localhost:8000/v1', local: true, needsKey: false, help: 'vllm serve <model>' },
	{ id: 'custom', kind: 'openai-compatible', label: 'Custom OpenAI-compatible endpoint', baseUrl: 'https://', needsKey: true, help: 'Any server implementing /v1/chat/completions' },
];

export class SettingsPanel {
	private static current: SettingsPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];

	static show(s: Services, tab?: string): void {
		if (SettingsPanel.current) {
			SettingsPanel.current.panel.reveal();
			if (tab) void SettingsPanel.current.panel.webview.postMessage({ type: 'tab', tab });
			return;
		}
		SettingsPanel.current = new SettingsPanel(s, tab);
	}

	private constructor(private readonly s: Services, tab?: string) {
		this.panel = vscode.window.createWebviewPanel('aide.settings', 'AIDE Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(s.context.extensionUri, 'media'), vscode.Uri.joinPath(s.context.extensionUri, 'dist')] });
		this.panel.iconPath = vscode.Uri.joinPath(s.context.extensionUri, 'media', 'AIDE_Logo.png');
		this.panel.webview.html = webviewHtml(this.panel.webview, s.context.extensionUri, 'settings', 'AIDE Settings', { tab: tab ?? 'providers' });
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'toast', level: 'error', text: (e as Error).message })), null, this.disposables);
		this.disposables.push(
			s.onDidChangeModels(() => void this.sendData()),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('aide') && void this.sendData()),
		);
	}

	private post(m: Record<string, unknown>): void {
		void this.panel.webview.postMessage(m);
	}

	private async sendData(): Promise<void> {
		const providers = await Promise.all(this.s.providers.list().map(async p => ({
			...p,
			hasKey: await this.s.hasStoredKey(p.id),
			envKey: !(await this.s.hasStoredKey(p.id)) && !!(await this.s.getApiKey(p.id)),
			error: this.s.modelErrors.get(p.id),
			models: this.s.cachedModels(p.id).map(m => ({ id: m.id, label: m.label, contextWindow: m.contextWindow, caps: m.capabilities ?? [], inputPrice: m.inputPrice, outputPrice: m.outputPrice })),
		})));
		const c = vscode.workspace.getConfiguration('aide');
		this.post({
			type: 'data',
			providers,
			templates: PROVIDER_TEMPLATES,
			models: this.s.allModelRefs().map(m => ({ ref: m.ref, label: m.info.label ?? m.info.id, local: m.local })),
			routing: { ...config.routingConfig(), autoProviders: config.get<string[]>('routing.autoProviders', []) },
			tasks: TASKS,
			autoPreview: Object.fromEntries(TASKS.map(t => [t, this.s.autoPick(t)])),
			recommendations: recommendations(this.s.autoCandidates()),
			limits: {
				dailyTokens: c.get('limits.dailyTokens') ?? null,
				dailyCost: c.get('limits.dailyCost') ?? null,
				monthlyTokens: c.get('limits.monthlyTokens') ?? null,
				monthlyCost: c.get('limits.monthlyCost') ?? null,
				perRequestTokens: c.get('limits.perRequestTokens') ?? null,
				warnAt: c.get('limits.warnAt'),
				onLimit: c.get('limits.onLimit'),
				providers: c.get('limits.providers', {}),
			},
			permissions: config.permissionPolicy(),
			categories: PERMISSION_CATEGORIES,
			grants: this.s.permissions.grants(),
			context: {
				strategy: config.contextStrategy(),
				historyBudget: c.get('context.historyBudget'),
				maxOutputTokens: c.get('ai.maxOutputTokens'),
				inlineEnabled: c.get('inlineCompletion.enabled'),
				revealTerminal: c.get('agents.revealTerminal'),
			},
			mcp: this.s.mcp.list().map(m => ({ name: m.name, scope: m.scope, status: m.status, tools: m.tools.length, error: m.error })),
		});
	}

	private async onMessage(m: any): Promise<void> {
		switch (m.type) {
			case 'ready':
				await this.sendData();
				void this.s.refreshModels();
				break;
			case 'saveProvider': {
				const p = m.provider as ProviderConfig;
				if (!/^[\w-]{1,40}$/.test(p.id)) throw new Error('Provider id must be letters, digits, - or _');
				const list = config.providersConfig().filter(x => x.id !== (m.originalId ?? p.id));
				const clean: ProviderConfig = { id: p.id, kind: p.kind, label: p.label || undefined, baseUrl: p.baseUrl || undefined, enabled: p.enabled !== false, local: p.local || undefined, models: p.models?.length ? p.models : undefined, options: p.options && Object.keys(p.options).length ? p.options : undefined };
				list.push(clean);
				if (typeof m.apiKey === 'string' && m.apiKey.trim()) await this.s.setApiKey(p.id, m.apiKey.trim());
				await config.update('providers', list);
				this.s.providers.setConfigs(config.providersConfig());
				this.s.providers.reset(p.id);
				await this.s.refreshModels();
				const err = this.s.modelErrors.get(p.id);
				this.post({ type: 'toast', level: err ? 'error' : 'info', text: err ? `Saved, but connection failed: ${err}` : `Saved ${p.label ?? p.id}: ${this.s.cachedModels(p.id).length} model(s) available.` });
				await this.maybeSeedRouting(p.id);
				break;
			}
			case 'deleteProvider': {
				const ok = await vscode.window.showWarningMessage(`Remove provider "${m.id}" and its stored API key?`, { modal: true }, 'Remove');
				if (!ok) return;
				await config.update('providers', config.providersConfig().filter(x => x.id !== m.id));
				await this.s.setApiKey(m.id, undefined);
				break;
			}
			case 'clearKey':
				await this.s.setApiKey(m.id, undefined);
				await this.sendData();
				break;
			case 'testProvider':
				this.s.providers.reset(m.id);
				await this.s.refreshModels();
				this.post({ type: 'toast', level: this.s.modelErrors.get(m.id) ? 'error' : 'info', text: this.s.modelErrors.get(m.id) ?? `${m.id}: connected, ${this.s.cachedModels(m.id).length} model(s).` });
				break;
			case 'refreshModels':
				await this.s.refreshModels();
				break;
			case 'saveRouting':
				await config.update('routing.strategy', m.routing.strategy);
				await config.update('routing.rules', m.routing.rules);
				await config.update('routing.default', m.routing.default);
				await config.update('routing.aliases', m.routing.aliases);
				await config.update('routing.autoFallback', m.routing.autoFallback);
				await config.update('routing.autoProviders', Array.isArray(m.routing.autoProviders) ? m.routing.autoProviders : []);
				this.post({ type: 'toast', level: 'info', text: 'Routing saved.' });
				break;
			case 'saveLimits': {
				const L = m.limits;
				for (const k of ['dailyTokens', 'dailyCost', 'monthlyTokens', 'monthlyCost', 'perRequestTokens']) await config.update(`limits.${k}`, L[k] === '' || L[k] === null ? undefined : Number(L[k]));
				await config.update('limits.onLimit', L.onLimit);
				await config.update('limits.warnAt', L.warnAt);
				await config.update('limits.providers', L.providers);
				this.post({ type: 'toast', level: 'info', text: 'Limits saved.' });
				break;
			}
			case 'savePermissions':
				for (const [k, v] of Object.entries(m.policy)) await config.update(`permissions.${k}`, v);
				this.post({ type: 'toast', level: 'info', text: 'Permissions saved.' });
				break;
			case 'revokeGrant':
				this.s.permissions.revoke(m.scope, m.key);
				await this.sendData();
				break;
			case 'saveContext':
				await config.update('context.strategy', m.context.strategy);
				await config.update('context.historyBudget', Number(m.context.historyBudget));
				await config.update('ai.maxOutputTokens', Number(m.context.maxOutputTokens));
				await config.update('inlineCompletion.enabled', !!m.context.inlineEnabled);
				await config.update('agents.revealTerminal', !!m.context.revealTerminal);
				this.post({ type: 'toast', level: 'info', text: 'Saved.' });
				break;
			case 'command':
				if (typeof m.command === 'string' && (m.command.startsWith('aide.') || m.command === 'workbench.action.openSettingsJson')) await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
				break;
			case 'copy':
				await vscode.env.clipboard.writeText(String(m.text ?? ''));
				this.post({ type: 'toast', level: 'info', text: 'Copied.' });
				break;
			case 'pasteCommand': {
				// Typed, not executed: the user reviews the command and presses Enter.
				const t = vscode.window.createTerminal({ name: 'AIDE' });
				t.show();
				t.sendText(String(m.command ?? ''), false);
				break;
			}
		}
	}

	/** First provider configured and no routing yet: point the default route at its best model. */
	private async maybeSeedRouting(providerId: string): Promise<void> {
		const r = config.routingConfig();
		const def = Array.isArray(r.default) ? r.default : [r.default];
		if (def.filter(Boolean).length) return;
		const models = this.s.cachedModels(providerId);
		const pick = models.find(m => m.id === 'claude-opus-5-5') ?? models.find(m => m.capabilities?.includes('tools')) ?? models[0];
		if (!pick) return;
		await config.update('routing.default', [`${providerId}/${pick.id}`]);
		this.post({ type: 'toast', level: 'info', text: `Default route set to ${providerId}/${pick.id}. Adjust it on the Routing tab.` });
	}

	private dispose(): void {
		SettingsPanel.current = undefined;
		for (const d of this.disposables) d.dispose();
	}
}
