// Builds the aide-core extension: bundles the extension host code and the webviews with esbuild.
//   node scripts/build.mjs [--watch] [--production]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extensions', 'aide-core');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: production ? false : 'linked', minify: production, logLevel: 'info', legalComments: 'none' };

const extensionBuild = {
	...common,
	entryPoints: [path.join(ext, 'src', 'extension.ts')],
	outfile: path.join(ext, 'dist', 'extension.js'),
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	// The MCP SDK and others ship ESM; esbuild converts to CJS for the extension host.
	mainFields: ['module', 'main'],
};

const webviewBuild = {
	...common,
	entryPoints: ['chat', 'settings', 'usage', 'inspector'].map(n => path.join(ext, 'src', 'webview', `${n}.ts`)),
	outdir: path.join(ext, 'dist', 'webview'),
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
};

function copyCodicons() {
	const src = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist');
	const dst = path.join(ext, 'dist', 'webview');
	fs.mkdirSync(dst, { recursive: true });
	for (const f of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
}

fs.rmSync(path.join(ext, 'dist'), { recursive: true, force: true });
copyCodicons();
if (watch) {
	const a = await esbuild.context(extensionBuild);
	const b = await esbuild.context(webviewBuild);
	await Promise.all([a.watch(), b.watch()]);
	console.log('Watching for changes...');
} else {
	await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
	console.log(`Built aide-core${production ? ' (production)' : ''}.`);
}
