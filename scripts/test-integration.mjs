// Runs the integration suite inside the real AIDE application (runtime/AIDE.exe), twice:
// phase 1 exercises everything, phase 2 restarts the app with the same profile to check persistence.
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extensions', 'aide-core');
const exe = path.join(root, 'runtime', 'AIDE.exe');
if (!fs.existsSync(exe)) throw new Error('runtime/AIDE.exe missing - run "npm run setup"');

const outfile = path.join(ext, 'dist-test', 'integration.js');
await esbuild.build({ entryPoints: [path.join(ext, 'test', 'integration', 'index.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: 'inline', logLevel: 'warning' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-it-'));
const dirs = Object.fromEntries(['workspace', 'portable', 'aide-home', 'state'].map(d => [d, path.join(tmp, d)]));
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
dirs['user-data'] = path.join(dirs.portable, 'user-data');
dirs.extensions = path.join(dirs.portable, 'extensions');
// runtime/ is a portable install: VSCODE_PORTABLE redirects ALL app data (settings, state,
// extensions) into the sandbox so tests never touch the real runtime/data profile.
process.env.VSCODE_PORTABLE = dirs.portable;
console.log(`Integration sandbox: ${tmp}`);

const common = {
	vscodeExecutablePath: exe,
	extensionDevelopmentPath: [ext, path.join(ext, 'test', 'fixtures', 'broken-ext')],
	extensionTestsPath: outfile,
	// test-electron defaults --extensions-dir to .vscode-test/; keep extensions in the sandbox too.
	launchArgs: [dirs.workspace, '--extensions-dir', dirs.extensions, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
};
const env = (phase) => ({ AIDE_TEST: '1', AIDE_TEST_PHASE: phase, AIDE_HOME: dirs['aide-home'], AIDE_TEST_STATE: dirs.state, AIDE_TEST_EXT_DIR: dirs.extensions });

let failed = false;
for (const phase of ['1', '2']) {
	console.log(`\n=== Phase ${phase}${phase === '2' ? ' (restart, persistence)' : ''} ===`);
	try {
		await runTests({ ...common, extensionTestsEnv: env(phase) });
	} catch (e) {
		failed = true;
		console.error(`Phase ${phase} failed: ${e?.message ?? e}`);
	}
	const f = path.join(dirs.state, `results-phase${phase}.json`);
	if (fs.existsSync(f)) {
		const results = JSON.parse(fs.readFileSync(f, 'utf8'));
		const count = s => results.filter(r => r.status === s).length;
		console.log(`Phase ${phase}: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
		for (const r of results.filter(r => r.status !== 'PASS')) console.log(`  ${r.status} ${r.name}${r.error ? `\n    ${r.error.split('\n').slice(0, 4).join('\n    ')}` : ''}`);
	}
}
// Guard: the real portable profile must be untouched.
const realData = path.join(root, 'runtime', 'data');
const leaked = fs.existsSync(realData) ? fs.readdirSync(realData).filter(f => f !== 'argv.json') : [];
if (leaked.length && !process.env.AIDE_ALLOW_PROFILE) {
	console.error(`WARNING: runtime/data contains ${leaked.join(', ')} - if you have not used this runtime yourself, the test sandbox leaked.`);
}
process.exit(failed ? 1 : 0);
