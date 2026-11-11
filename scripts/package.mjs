// Installs the built aide-core into runtime/ as a built-in extension and produces a
// distributable portable build: dist/AIDE-2.0-win32-x64/ and dist/AIDE-2.0-win32-x64.zip
//   node scripts/package.mjs [--no-zip]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
const ext = path.join(root, 'extensions', 'aide-core');
if (!fs.existsSync(path.join(runtime, 'AIDE.exe'))) throw new Error('runtime/ missing - run "npm run setup" first');
if (!fs.existsSync(path.join(ext, 'dist', 'extension.js'))) throw new Error('aide-core not built - run "npm run build"');

// 1. install aide-core as a built-in extension
const target = path.join(runtime, 'resources', 'app', 'extensions', 'aide-core');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const item of ['package.json', 'dist', 'media', 'resources', 'README.md']) {
	const src = path.join(ext, item);
	if (fs.existsSync(src)) fs.cpSync(src, path.join(target, item), { recursive: true, filter: s => !s.endsWith('.map') });
}
console.log(`Installed aide-core into ${path.relative(root, target)}`);

// 2. assemble the portable distribution (without any user data)
const out = path.join(root, 'dist', 'AIDE-2.0-win32-x64');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const dataDir = path.join(runtime, 'data');
fs.cpSync(runtime, out, { recursive: true, filter: s => !(s === dataDir || s.startsWith(dataDir + path.sep)) });
fs.mkdirSync(path.join(out, 'data'), { recursive: true });
fs.writeFileSync(path.join(out, 'data', 'argv.json'), '{\n\t"enable-crash-reporter": false\n}\n');
fs.writeFileSync(path.join(out, 'README.txt'), 'AIDE 2.0 (portable)\r\n\r\nRun AIDE.exe. Settings, extensions and state are stored in the "data" folder next to it.\r\nDelete "data" to reset. Command line: bin\\aide.cmd <folder>\r\n');
console.log(`Portable build: ${path.relative(root, out)}`);

if (!process.argv.includes('--no-zip')) {
	const zip = `${out}.zip`;
	fs.rmSync(zip, { force: true });
	execFileSync('tar', ['-a', '-c', '-f', zip, '-C', path.dirname(out), path.basename(out)], { stdio: 'inherit' });
	console.log(`Archive: ${path.relative(root, zip)} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
}
