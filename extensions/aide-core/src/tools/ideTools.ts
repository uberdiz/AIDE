import * as vscode from 'vscode';
import type { Tool } from './types';

/** Language extension (Open VSX id) that gives run/debug/IntelliSense support per file extension. */
export const LANGUAGE_EXTENSIONS: Record<string, { id: string; name: string }> = {
	'.py': { id: 'ms-python.python', name: 'Python' },
	'.pyw': { id: 'ms-python.python', name: 'Python' },
	'.ipynb': { id: 'ms-toolsai.jupyter', name: 'Jupyter' },
	'.go': { id: 'golang.go', name: 'Go' },
	'.rs': { id: 'rust-lang.rust-analyzer', name: 'Rust' },
	'.java': { id: 'redhat.java', name: 'Java' },
	'.cs': { id: 'muhammad-sammy.csharp', name: 'C#' },
	'.c': { id: 'llvm-vs-code-extensions.vscode-clangd', name: 'C/C++ (clangd)' },
	'.cpp': { id: 'llvm-vs-code-extensions.vscode-clangd', name: 'C/C++ (clangd)' },
	'.h': { id: 'llvm-vs-code-extensions.vscode-clangd', name: 'C/C++ (clangd)' },
	'.hpp': { id: 'llvm-vs-code-extensions.vscode-clangd', name: 'C/C++ (clangd)' },
	'.php': { id: 'bmewburn.vscode-intelephense-client', name: 'PHP' },
	'.rb': { id: 'Shopify.ruby-lsp', name: 'Ruby' },
	'.lua': { id: 'sumneko.lua', name: 'Lua' },
	'.luau': { id: 'JohnnyMorganz.luau-lsp', name: 'Luau' },
	'.dart': { id: 'Dart-Code.dart-code', name: 'Dart' },
	'.kt': { id: 'fwcd.kotlin', name: 'Kotlin' },
	'.toml': { id: 'tamasfe.even-better-toml', name: 'TOML' },
	'.yaml': { id: 'redhat.vscode-yaml', name: 'YAML' },
	'.yml': { id: 'redhat.vscode-yaml', name: 'YAML' },
	'.vue': { id: 'Vue.volar', name: 'Vue' },
	'.svelte': { id: 'svelte.svelte-vscode', name: 'Svelte' },
};

export function isExtensionInstalled(id: string): boolean {
	return vscode.extensions.all.some(e => e.id.toLowerCase() === id.toLowerCase());
}

export function ideTools(): Tool[] {
	return [
		{
			name: 'install_extension',
			toolset: 'extensions',
			category: 'command',
			description: `Install an IDE extension from the Open VSX marketplace when the project needs language support to run or debug, e.g. "ms-python.python" for Python, "golang.go" for Go, "rust-lang.rust-analyzer" for Rust. Asks the user first. This installs editor support only; language runtimes (python.exe, node) are installed separately.`,
			inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Extension id, publisher.name' } }, required: ['id'] },
			describe: i => `Install extension ${i.id}`,
			async run(input) {
				const id = String(input.id ?? '').trim();
				if (!/^[\w-]+\.[\w.-]+$/.test(id)) return { content: `"${id}" is not an extension id (publisher.name).`, isError: true };
				if (isExtensionInstalled(id)) return { content: `${id} is already installed.` };
				try {
					await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
					return { content: `Installed ${id}. Language features activate for newly opened files.` };
				} catch (e) {
					return { content: `Could not install ${id}: ${(e as Error).message}. Check the id on open-vsx.org.`, isError: true };
				}
			},
		},
	];
}
