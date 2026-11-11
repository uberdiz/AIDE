import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AiClient, type AiClientHooks, type RequestRecord } from '../../src/ai/client';
import { ProviderRegistry } from '../../src/ai/providers/registry';
import { Router, type RoutingConfig } from '../../src/ai/router';
import type { ChatMessage, ChatRequest, Provider, StreamEvent } from '../../src/ai/types';
import { UsageStore } from '../../src/ai/usage';
import { AgentRunner } from '../../src/agents/runtime';
import { DEFAULT_POLICY, PermissionService, type PermissionAnswer, type PermissionRequest, type Policy } from '../../src/agents/permissions';
import { ChangeTracker } from '../../src/changes/tracker';
import { BUILTIN_TOOLS, spawnCommand } from '../../src/tools/builtin';
import { ToolRegistry } from '../../src/tools/registry';
import type { IdeServices, PermissionCategory } from '../../src/tools/types';

export type Turn = { text?: string; calls?: { name: string; input: Record<string, unknown> }[]; stop?: 'end' | 'refusal' | 'max_tokens'; fail?: string };

/** Scripted provider: each chat() call consumes the next turn. Records requests. */
export class ScriptedProvider implements Provider {
	requests: ChatRequest[] = [];
	constructor(readonly config: { id: string; kind: 'openai-compatible' }, private turns: Turn[], private delayMs = 0) {}
	async listModels() {
		return [{ id: 'm1', capabilities: ['chat', 'tools'] as const }] as any;
	}
	async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
		this.requests.push(JSON.parse(JSON.stringify(req)));
		const t = this.turns.shift();
		if (!t) throw new Error('script exhausted');
		if (this.delayMs) await new Promise((r, j) => {
			const h = setTimeout(r, this.delayMs);
			signal.addEventListener('abort', () => { clearTimeout(h); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
		});
		if (t.fail) throw new Error(t.fail);
		if (t.text) for (const w of t.text.split(/(?<= )/)) yield { type: 'text', text: w };
		const calls = (t.calls ?? []).map((c, i) => ({ id: `c${this.requests.length}_${i}`, ...c }));
		for (const call of calls) yield { type: 'tool_call', call };
		yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, exact: true } };
		const msg: ChatMessage = { role: 'assistant', content: t.text ?? '', toolCalls: calls.length ? calls : undefined };
		yield { type: 'done', stopReason: calls.length ? 'tool_use' : t.stop ?? 'end', message: msg };
	}
}

export interface HarnessOptions {
	turns: Turn[];
	policy?: Partial<Record<PermissionCategory, Policy>>;
	answer?: (r: PermissionRequest) => PermissionAnswer;
	delayMs?: number;
	routing?: Partial<RoutingConfig>;
}

export function makeHarness(o: HarnessOptions) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-ws-'));
	const store = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-store-'));
	const provider = new ScriptedProvider({ id: 'fake', kind: 'openai-compatible' }, o.turns, o.delayMs);
	const providers = new ProviderRegistry(async () => undefined);
	providers.registerInstance(provider);
	const router = new Router(
		{ strategy: 'rules', rules: {}, default: ['fake/m1'], aliases: {}, autoFallback: false, ...o.routing },
		{
			providerExists: id => !!providers.getConfig(id),
			isLocal: () => false,
			modelInfo: r => ({ id: r.modelId, inputPrice: 1, outputPrice: 2, capabilities: ['chat', 'tools'] }),
			knownModels: () => [],
		},
	);
	const usage = new UsageStore();
	const records: RequestRecord[] = [];
	const hooks: AiClientHooks = {
		project: () => 'test',
		askLimit: async () => 'stop',
		warn: () => undefined,
		onRecord: r => records.push({ ...r }),
		onUsageChanged: () => undefined,
		log: () => undefined,
		defaultMaxTokens: () => 4096,
	};
	const client = new AiClient(providers, router, usage, hooks);
	const tools = new ToolRegistry();
	for (const t of BUILTIN_TOOLS) tools.register(t);
	const asked: PermissionRequest[] = [];
	const grants: Record<string, Record<string, 'allow' | 'deny'>> = { workspace: {}, always: {} };
	const permissions = new PermissionService(
		() => ({ ...DEFAULT_POLICY, ...o.policy }),
		{ read: s => grants[s], write: (s, g) => (grants[s] = g) },
		async r => {
			asked.push(r);
			return o.answer ? o.answer(r) : { allow: true, scope: 'once' };
		},
	);
	const changes = new ChangeTracker(store);
	const ide: IdeServices = {
		diagnostics: async () => '',
		runCommand: (cmd, opts) => spawnCommand(cmd, opts),
	};
	const runner = new AgentRunner(client, tools, permissions, changes, ide, () => undefined);
	return { root, provider, providers, router, usage, client, tools, permissions, changes, runner, asked, records, grants };
}
