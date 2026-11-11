import type { PermissionCategory, ToolPreview } from '../tools/types';

export type Policy = 'ask' | 'allow' | 'deny';
export type GrantScope = 'once' | 'session' | 'workspace' | 'always';

export const DEFAULT_POLICY: Record<PermissionCategory, Policy> = {
	read: 'allow',
	write: 'ask',
	delete: 'ask',
	command: 'ask',
	network: 'ask',
	git: 'ask',
	github: 'ask',
	external: 'ask',
	mcp: 'ask',
};

export interface PermissionRequest {
	category: PermissionCategory;
	toolName: string;
	agentId: string;
	summary: string;
	preview?: ToolPreview;
	/** set for commands matching the danger list; always prompts */
	dangerous?: string;
}

export interface PermissionAnswer {
	allow: boolean;
	scope: GrantScope;
}

export interface GrantStore {
	read(scope: 'workspace' | 'always'): Record<string, 'allow' | 'deny'>;
	write(scope: 'workspace' | 'always', grants: Record<string, 'allow' | 'deny'>): void;
}

export interface PermissionOutcome {
	allowed: boolean;
	reason: string;
}

const DANGEROUS: [RegExp, string][] = [
	[/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, 'recursive force delete'],
	[/\b(rmdir|rd)\s+\/s\b/i, 'recursive directory delete'],
	[/\bdel\s+(\/[a-z]\s+)*\/s\b/i, 'recursive delete'],
	[/\bRemove-Item\b.*-Recurse/i, 'recursive delete'],
	[/\bformat(\.com)?\s+[a-z]:/i, 'disk format'],
	[/\b(mkfs|diskpart|fdisk)\b/i, 'disk partitioning'],
	[/\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/i, 'force push'],
	[/\bgit\s+reset\s+--hard\b/i, 'hard reset'],
	[/\bgit\s+clean\s+-[a-z]*f/i, 'git clean'],
	[/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, 'discard all changes'],
	[/\b(shutdown|reboot|restart-computer|stop-computer)\b/i, 'power control'],
	[/\breg(\.exe)?\s+(delete|add)\b/i, 'registry change'],
	[/\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|iex|invoke-expression|python|node)\b/i, 'pipe download to shell'],
	[/\bchmod\s+-R\s+777\b/i, 'recursive chmod 777'],
	[/\b(npm|pnpm|yarn)\s+publish\b/i, 'package publish'],
	[/\bsudo\b/i, 'elevated privileges'],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
	[/\bdd\s+if=.*\bof=\/dev\//i, 'raw disk write'],
	[/\bSet-ExecutionPolicy\b/i, 'execution policy change'],
];

export function dangerousCommand(cmd: string): string | undefined {
	for (const [re, why] of DANGEROUS) if (re.test(cmd)) return why;
	return undefined;
}

/**
 * Decides whether an agent may perform an action. Policies come from settings
 * (per category, optionally overridden per agent); grants come from earlier
 * answers at session, workspace or global scope. Dangerous commands always ask.
 */
export class PermissionService {
	private session = new Map<string, 'allow' | 'deny'>();

	constructor(
		private readonly policy: () => Record<PermissionCategory, Policy>,
		private readonly store: GrantStore,
		private readonly ask: (req: PermissionRequest) => Promise<PermissionAnswer>,
	) {}

	async check(req: PermissionRequest, agentOverrides?: Partial<Record<PermissionCategory, Policy>>): Promise<PermissionOutcome> {
		const policy = agentOverrides?.[req.category] ?? this.policy()[req.category] ?? 'ask';
		if (policy === 'deny') return { allowed: false, reason: `"${req.category}" actions are denied by policy` };
		if (req.dangerous) {
			const a = await this.ask(req);
			// dangerous approvals are never remembered
			return a.allow ? { allowed: true, reason: 'approved (dangerous action, one time)' } : { allowed: false, reason: 'denied by user' };
		}
		const grant = this.lookup(req);
		if (grant === 'deny') return { allowed: false, reason: 'denied by a saved rule' };
		if (grant === 'allow') return { allowed: true, reason: 'allowed by a saved rule' };
		if (policy === 'allow') return { allowed: true, reason: 'allowed by policy' };

		const answer = await this.ask(req);
		this.remember(req, answer);
		return answer.allow ? { allowed: true, reason: `approved (${answer.scope})` } : { allowed: false, reason: 'denied by user' };
	}

	private keys(req: PermissionRequest): string[] {
		return [`${req.category}:${req.toolName}`, `${req.category}:*`];
	}

	private lookup(req: PermissionRequest): 'allow' | 'deny' | undefined {
		const ws = this.store.read('workspace');
		const always = this.store.read('always');
		for (const k of this.keys(req)) {
			const v = this.session.get(k) ?? ws[k] ?? always[k];
			if (v) return v;
		}
		return undefined;
	}

	private remember(req: PermissionRequest, a: PermissionAnswer): void {
		if (a.scope === 'once') return;
		const key = `${req.category}:${req.toolName}`;
		const value = a.allow ? 'allow' : 'deny';
		if (a.scope === 'session') this.session.set(key, value);
		else {
			const grants: Record<string, 'allow' | 'deny'> = { ...this.store.read(a.scope), [key]: value };
			this.store.write(a.scope, grants);
		}
	}

	grants(): { scope: 'session' | 'workspace' | 'always'; key: string; value: 'allow' | 'deny' }[] {
		return [
			...[...this.session.entries()].map(([key, value]) => ({ scope: 'session' as const, key, value })),
			...Object.entries(this.store.read('workspace')).map(([key, value]) => ({ scope: 'workspace' as const, key, value })),
			...Object.entries(this.store.read('always')).map(([key, value]) => ({ scope: 'always' as const, key, value })),
		];
	}

	revoke(scope: 'session' | 'workspace' | 'always', key?: string): void {
		if (scope === 'session') {
			if (key) this.session.delete(key);
			else this.session.clear();
			return;
		}
		if (!key) return this.store.write(scope, {});
		const g = { ...this.store.read(scope) };
		delete g[key];
		this.store.write(scope, g);
	}
}
