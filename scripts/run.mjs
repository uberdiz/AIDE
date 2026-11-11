// Launch AIDE.
//   node scripts/run.mjs [folder]          run the installed build (runtime/ with the built-in aide-core)
//   node scripts/run.mjs --dev [folder]    run with extensions/aide-core loaded from source (isolated dev profile)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'runtime', 'AIDE.exe');
if (!fs.existsSync(exe)) {
	console.error('runtime/AIDE.exe not found. Run "npm run setup" first.');
	process.exit(1);
}
const dev = process.argv.includes('--dev');
const folder = process.argv.slice(2).find(a => !a.startsWith('--'));
const args = [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (dev) {
	// runtime/ is portable: VSCODE_PORTABLE points all app data at an isolated dev profile.
	env.VSCODE_PORTABLE = path.join(root, '.dev');
	fs.mkdirSync(env.VSCODE_PORTABLE, { recursive: true });
	args.push(`--extensionDevelopmentPath=${path.join(root, 'extensions', 'aide-core')}`);
} else if (!fs.existsSync(path.join(root, 'runtime', 'resources', 'app', 'extensions', 'aide-core', 'dist', 'extension.js'))) {
	console.error('aide-core is not installed into runtime/. Run "npm run package" (or use "npm run dev").');
	process.exit(1);
}
if (folder) args.push(path.resolve(folder));
const child = spawn(exe, args, { detached: true, stdio: 'ignore', env });
child.unref();
console.log(`Started AIDE${dev ? ' (dev)' : ''}: ${exe} ${args.join(' ')}`);
