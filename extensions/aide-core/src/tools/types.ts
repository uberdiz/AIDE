import type { ImagePart, JsonSchema } from '../ai/types';
import type { ChangeTracker } from '../changes/tracker';

export type PermissionCategory = 'read' | 'write' | 'delete' | 'command' | 'network' | 'git' | 'github' | 'external' | 'mcp';

export const PERMISSION_CATEGORIES: PermissionCategory[] = ['read', 'write', 'delete', 'command', 'network', 'git', 'github', 'external', 'mcp'];

export interface ToolResult {
	content: string;
	isError?: boolean;
	images?: ImagePart[];
}

export interface ToolPreview {
	title: string;
	/** for file edits: path plus before/after text so the UI can show a diff */
	path?: string;
	before?: string;
	after?: string;
	/** free-form detail (command line, request body, ...) */
	detail?: string;
}

export interface ToolContext {
	root: string;
	signal: AbortSignal;
	runId: string;
	agentId: string;
	changes: ChangeTracker;
	/** IDE services available to tools (diagnostics, terminal display...). */
	ide: IdeServices;
	log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
	/** Live output of a running tool (e.g. command output streamed into the chat). */
	progress?(text: string): void;
}

/** Implemented by the extension layer; stubbed in tests. */
export interface IdeServices {
	diagnostics(pathFilter?: string): Promise<string>;
	/** Run a shell command with visible output; resolves with combined output and exit code. */
	runCommand(command: string, opts: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: Record<string, string>; onData?: (s: string) => void }): Promise<{ output: string; exitCode: number | null; timedOut: boolean; killed: boolean }>;
	openFile?(absPath: string, line?: number): Promise<void>;
	ripgrepPath?(): string | undefined;
	/** Notify editors that a file changed on disk (refresh open buffers). */
	fileChanged?(absPath: string): void;
}

export interface Tool {
	name: string;
	description: string;
	/** Tool group used by agent definitions, e.g. "filesystem", "terminal", "mcp:github" */
	toolset: string;
	category: PermissionCategory;
	inputSchema: JsonSchema;
	readOnly?: boolean;
	source?: 'builtin' | 'mcp' | 'extension';
	/** One-line human description of a concrete call, for approvals and the activity log. */
	describe?(input: Record<string, unknown>): string;
	preview?(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolPreview | undefined>;
	run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolInputError extends Error {}
