import * as vscode from 'vscode';
import { ContextEngine, type ContextStrategy } from '../ai/context/engine';
import type { ProviderFactory } from '../ai/providers/registry';
import type { ChatMessage, Provider } from '../ai/types';
import { messageText } from '../ai/types';
import type { AgentDefinition } from '../agents/definitions';
import type { ChatController } from '../chat/controller';
import type { Connector, ConnectorRegistry } from '../connectors/connectors';
import type { Services } from '../services';
import type { Tool } from '../tools/types';
import type { WorkflowDefinition, Workflows } from '../workflows/workflows';
import { createContextSources } from '../vscode/contextSources';

/**
 * Public API returned from AIDE's activate(); other extensions get it with
 *   const aide = vscode.extensions.getExtension('aide.aide-core')?.exports as AideApi
 * Everything registered here participates in routing, permissions, usage
 * tracking and the Context Inspector like built-in features.
 */
export interface AideApi {
	readonly version: string;
	/** Add an AI tool agents can call. Category controls permission prompts. */
	registerTool(tool: Omit<Tool, 'toolset' | 'category'> & { toolset?: string; category?: Tool['category'] }): vscode.Disposable;
	/** Add an agent (shows up in the chat agent picker and Agents view). */
	registerAgent(agent: Pick<AgentDefinition, 'id' | 'name' | 'instructions'> & Partial<AgentDefinition>): vscode.Disposable;
	/** Add a provider protocol (e.g. a new API) usable from aide.providers settings. */
	registerProviderKind(kind: string, factory: ProviderFactory): vscode.Disposable;
	/** Add a ready-made provider instance. */
	registerProvider(provider: Provider): vscode.Disposable;
	registerConnector(connector: Connector): vscode.Disposable;
	registerWorkflow(workflow: WorkflowDefinition): vscode.Disposable;
	/** One-shot model call through AIDE's router (respects limits, recorded in usage). */
	chat(opts: { task?: string; system?: string; prompt?: string; messages?: ChatMessage[]; model?: string; maxTokens?: number; signal?: AbortSignal }): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number; cost?: number }>;
	/** Run an agent visibly in the AIDE chat. */
	runAgent(opts: { agentId: string; prompt: string; newConversation?: boolean }): Promise<{ status: string; text: string } | undefined>;
	/** Build the context AIDE would send for a prompt (for custom agents/panels). */
	buildContext(prompt: string, strategy?: ContextStrategy): Promise<{ items: { label: string; kind: string; tokens: number; content: string }[]; totalTokens: number }>;
	/** Available models as provider/model references. */
	models(): { ref: string; label: string; local: boolean }[];
	onDidRecordRequest: vscode.Event<{ id: string; task: string; ref?: string; status: string }>;
}

export function createApi(s: Services, chat: ChatController, connectors: ConnectorRegistry, workflows: Workflows, extId = 'external'): AideApi {
	return {
		version: '1.0.0',
		registerTool(tool) {
			const full: Tool = { toolset: tool.toolset ?? `ext:${extId}`, category: tool.category ?? 'external', source: 'extension', ...tool } as Tool;
			const off = s.tools.register(full);
			s.log.info(`Extension tool registered: ${full.name} (${full.toolset})`);
			return new vscode.Disposable(off);
		},
		registerAgent(agent) {
			return s.registerAgent({ description: '', task: 'coding', tools: ['filesystem', 'search', 'ide'], source: 'extension', ...agent } as AgentDefinition);
		},
		registerProviderKind(kind, factory) {
			return new vscode.Disposable(s.providers.registerKind(kind, factory));
		},
		registerProvider(provider) {
			const off = s.providers.registerInstance(provider);
			void s.refreshModels();
			return new vscode.Disposable(() => {
				off();
				void s.refreshModels();
			});
		},
		registerConnector(c) {
			return connectors.register(c);
		},
		registerWorkflow(w) {
			return workflows.register(w);
		},
		async chat(o) {
			const messages: ChatMessage[] = o.messages ?? [{ role: 'user', content: o.prompt ?? '' }];
			const r = await s.client.run({ task: o.task ?? 'chat', source: `extension:${extId}`, manualModel: o.model, signal: o.signal ?? new AbortController().signal, request: { system: o.system, messages, maxTokens: o.maxTokens } });
			return { text: messageText(r.message), model: `${r.ref.providerId}/${r.ref.modelId}`, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cost: r.cost };
		},
		async runAgent(o) {
			await vscode.commands.executeCommand('aide.chat.focus');
			return chat.send({ text: o.prompt, agentId: o.agentId, newConversation: o.newConversation });
		},
		async buildContext(prompt, strategy = 'balanced') {
			const engine = new ContextEngine(createContextSources({ root: s.root, project: s.project, capture: s.capture, ide: s.ide, allowNetwork: async () => false }));
			const b = await engine.build({ prompt, strategy });
			return { items: b.items.map(i => ({ label: i.label, kind: i.kind, tokens: i.tokens, content: i.content })), totalTokens: b.totalTokens };
		},
		models() {
			return s.allModelRefs().map(m => ({ ref: m.ref, label: m.info.label ?? m.info.id, local: m.local }));
		},
		onDidRecordRequest: (listener, thisArg, disposables) => s.onDidRecordRequest(r => listener.call(thisArg, { id: r.id, task: r.task, ref: r.ref, status: r.status }), undefined, disposables),
	};
}
