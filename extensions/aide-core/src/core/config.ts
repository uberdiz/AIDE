import * as vscode from 'vscode';
import type { ContextStrategy } from '../ai/context/engine';
import type { RoutingConfig, RoutingStrategy } from '../ai/router';
import type { ProviderConfig } from '../ai/types';
import type { LimitAction, LimitsConfig } from '../ai/usage';
import { DEFAULT_POLICY, type Policy } from '../agents/permissions';
import type { PermissionCategory } from '../tools/types';
import { PERMISSION_CATEGORIES } from '../tools/types';

const cfg = () => vscode.workspace.getConfiguration('aide');

export function providersConfig(): ProviderConfig[] {
	const list = cfg().get<ProviderConfig[]>('providers', []);
	return list.filter(p => p && typeof p.id === 'string' && typeof p.kind === 'string');
}

export function routingConfig(): RoutingConfig {
	const c = cfg();
	return {
		strategy: c.get<RoutingStrategy>('routing.strategy', 'rules'),
		rules: c.get<Record<string, string | string[]>>('routing.rules', {}),
		default: c.get<string[]>('routing.default', []),
		aliases: c.get<Record<string, string>>('routing.aliases', {}),
		autoFallback: c.get<boolean>('routing.autoFallback', true),
	};
}

export function limitsConfig(): LimitsConfig {
	const c = cfg();
	const n = (k: string) => {
		const v = c.get<number | null>(k, null);
		return typeof v === 'number' && v > 0 ? v : undefined;
	};
	return {
		daily: { tokens: n('limits.dailyTokens'), cost: n('limits.dailyCost') },
		monthly: { tokens: n('limits.monthlyTokens'), cost: n('limits.monthlyCost') },
		perRequestTokens: n('limits.perRequestTokens'),
		providers: c.get<LimitsConfig['providers']>('limits.providers', {}),
		warnAt: c.get<number[]>('limits.warnAt', [0.8, 0.95]),
		onLimit: c.get<LimitAction>('limits.onLimit', 'ask'),
	};
}

export function permissionPolicy(): Record<PermissionCategory, Policy> {
	const c = cfg();
	const out = { ...DEFAULT_POLICY };
	for (const cat of PERMISSION_CATEGORIES) out[cat] = c.get<Policy>(`permissions.${cat}`, DEFAULT_POLICY[cat]);
	return out;
}

export function contextStrategy(): ContextStrategy {
	return cfg().get<ContextStrategy>('context.strategy', 'balanced');
}

export function get<T>(key: string, fallback: T): T {
	return cfg().get<T>(key, fallback);
}

export async function update(key: string, value: unknown, target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
	await cfg().update(key, value, target);
}
