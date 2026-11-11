import type { JsonSchema, ToolSpec } from '../ai/types';
import type { Tool } from './types';

/** Central registry of AI tools: built-in, MCP-provided and extension-provided. */
export class ToolRegistry {
	private tools = new Map<string, Tool>();
	private listeners = new Set<() => void>();

	register(tool: Tool): () => void {
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`Invalid tool name "${tool.name}" (use [a-zA-Z0-9_-], max 64 chars)`);
		this.tools.set(tool.name, tool);
		this.emit();
		return () => {
			if (this.tools.get(tool.name) === tool) {
				this.tools.delete(tool.name);
				this.emit();
			}
		};
	}

	unregisterToolset(toolset: string): void {
		let changed = false;
		for (const [n, t] of this.tools) if (t.toolset === toolset) {
			this.tools.delete(n);
			changed = true;
		}
		if (changed) this.emit();
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	all(): Tool[] {
		return [...this.tools.values()];
	}

	toolsets(): string[] {
		return [...new Set(this.all().map(t => t.toolset))].sort();
	}

	/**
	 * Resolve an agent's tool selection. Entries may be toolset names
	 * ("filesystem", "mcp:github", "mcp:*"), exact tool names, "*" for all, or
	 * "!name" to exclude.
	 */
	select(selectors: string[]): Tool[] {
		const include = new Set<Tool>();
		const excluded = new Set(selectors.filter(s => s.startsWith('!')).map(s => s.slice(1)));
		for (const s of selectors) {
			if (s.startsWith('!')) continue;
			for (const t of this.tools.values()) {
				if (s === '*' || t.name === s || t.toolset === s || (s.endsWith(':*') && t.toolset.startsWith(s.slice(0, -1)))) include.add(t);
			}
		}
		return [...include].filter(t => !excluded.has(t.name) && !excluded.has(t.toolset));
	}

	specs(tools: Tool[]): ToolSpec[] {
		return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
	}

	onDidChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

/** Lightweight JSON-schema validation of model-produced tool input. Returns error messages. */
export function validateInput(input: unknown, schema: JsonSchema, path = 'input'): string[] {
	const errs: string[] = [];
	if (input && typeof input === 'object' && '__invalid_json__' in (input as object)) return [`${path} was not valid JSON`];
	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.length && !types.some(t => matchesType(input, t))) {
		errs.push(`${path} should be ${types.join(' | ')}, got ${Array.isArray(input) ? 'array' : input === null ? 'null' : typeof input}`);
		return errs;
	}
	if (schema.enum && !schema.enum.includes(input)) errs.push(`${path} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		const obj = input as Record<string, unknown>;
		for (const r of schema.required ?? []) if (obj[r] === undefined || obj[r] === null) errs.push(`${path}.${r} is required`);
		for (const [k, sub] of Object.entries(schema.properties ?? {})) if (obj[k] !== undefined) errs.push(...validateInput(obj[k], sub, `${path}.${k}`));
	}
	if (Array.isArray(input) && schema.items) input.forEach((v, i) => errs.push(...validateInput(v, schema.items!, `${path}[${i}]`)));
	return errs;
}

function matchesType(v: unknown, t: string): boolean {
	switch (t) {
		case 'string': return typeof v === 'string';
		case 'number': return typeof v === 'number' && Number.isFinite(v);
		case 'integer': return typeof v === 'number' && Number.isInteger(v);
		case 'boolean': return typeof v === 'boolean';
		case 'array': return Array.isArray(v);
		case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
		case 'null': return v === null;
		default: return true;
	}
}

/** Coerce common model mistakes (numbers/booleans as strings) before validation. */
export function coerceInput(input: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
	const out: Record<string, unknown> = { ...input };
	for (const [k, sub] of Object.entries(schema.properties ?? {})) {
		const v = out[k];
		if (typeof v !== 'string') continue;
		if ((sub.type === 'integer' || sub.type === 'number') && /^-?\d+(\.\d+)?$/.test(v.trim())) out[k] = Number(v);
		else if (sub.type === 'boolean' && /^(true|false)$/i.test(v.trim())) out[k] = v.trim().toLowerCase() === 'true';
		else if ((sub.type === 'array' || sub.type === 'object') && /^[[{]/.test(v.trim())) {
			try {
				out[k] = JSON.parse(v);
			} catch {
				/* leave as-is; validation reports it */
			}
		}
	}
	return out;
}
