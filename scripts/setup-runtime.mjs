// Prepares runtime/: the VSCodium-based AIDE workbench that hosts aide-core.
//   node scripts/setup-runtime.mjs                 copy from ../AIDE (existing AIDE 1.x build) if runtime/ is missing
//   node scripts/setup-runtime.mjs --from <dir>    copy a VSCodium/AIDE build from <dir>
//   node scripts/setup-runtime.mjs --download      download the latest VSCodium for this platform (or --platform
//                                                  linux-x64 / win32-x64: the HalOS package uses linux-x64)
//   node scripts/setup-runtime.mjs --force         replace an existing runtime/
// Then it rebrands product.json and enables portable mode (runtime/data).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { target } from './platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const T = target(args);

function findExe(dir) {
	for (const n of T.upstreamExes) if (fs.existsSync(path.join(dir, n))) return n;
	return undefined;
}

async function download() {
	const rel = await (await fetch('https://api.github.com/repos/VSCodium/vscodium/releases/latest', { headers: { 'user-agent': 'aide-setup' } })).json();
	const asset = rel.assets.find(a => T.asset.test(a.name));
	if (!asset) throw new Error(`No VSCodium ${T.name} build found in the latest release`);
	console.log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(0)} MB) from GitHub releases...`);
	const zip = path.join(root, '.cache', asset.name);
	fs.mkdirSync(path.dirname(zip), { recursive: true });
	if (!fs.existsSync(zip)) fs.writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
	fs.mkdirSync(runtime, { recursive: true });
	execFileSync('tar', ['-xf', zip, '-C', runtime], { stdio: 'inherit' });
	const exe = findExe(runtime);
	if (exe !== T.exe) fs.renameSync(path.join(runtime, exe), path.join(runtime, T.exe));
}

function copyFrom(src) {
	if (!findExe(src)) throw new Error(`${src} does not look like a VSCodium/AIDE build (no executable found)`);
	console.log(`Copying workbench runtime from ${src} ...`);
	const skip = new Set([path.join(src, 'data'), path.join(src, 'resources', 'app', 'extensions', 'ai-ide'), path.join(src, 'screenshots'), path.join(src, '.agent'), path.join(src, '.vscode')]);
	fs.cpSync(src, runtime, {
		recursive: true,
		filter: s => ![...skip].some(k => s === k || s.startsWith(k + path.sep)) && !(path.dirname(s) === src && /\.(js|py|bat)$/.test(s)),
	});
	const exe = findExe(runtime);
	if (exe !== T.exe) fs.renameSync(path.join(runtime, exe), path.join(runtime, T.exe));
}

function rebrand() {
	const file = path.join(runtime, 'resources', 'app', 'product.json');
	const p = JSON.parse(fs.readFileSync(file, 'utf8'));
	Object.assign(p, {
		nameShort: 'AIDE',
		nameLong: 'AIDE 2.0',
		applicationName: 'aide',
		dataFolderName: '.aide2',
		win32MutexName: 'aide2',
		win32DirName: 'AIDE 2.0',
		win32NameVersion: 'AIDE 2.0',
		win32RegValueName: 'AIDE2',
		win32AppUserModelId: 'AIDE.AIDE2',
		win32ShellNameShort: 'AIDE 2.0',
		urlProtocol: 'aide2',
		serverApplicationName: 'aide2-server',
		serverDataFolderName: '.aide2-server',
		tunnelApplicationName: 'aide2-tunnel',
	});
	// AIDE is self-managed: never "update" into plain VSCodium.
	delete p.updateUrl;
	delete p.downloadUrl;
	fs.writeFileSync(file, JSON.stringify(p, null, '\t'));
	// Portable mode keeps settings, extensions and state next to the app.
	const data = path.join(runtime, 'data');
	fs.mkdirSync(data, { recursive: true });
	const argv = path.join(data, 'argv.json');
	if (!fs.existsSync(argv)) fs.writeFileSync(argv, '{\n\t"enable-crash-reporter": false\n}\n');
	const cli = path.join(runtime, 'bin', T.linux ? 'aide' : 'aide.cmd');
	if (T.linux && fs.existsSync(path.join(runtime, 'bin'))) {
		// VSCodium's bin/codium becomes bin/aide (the command-line launcher).
		const up = ['codium', 'code'].map(n => path.join(runtime, 'bin', n)).find(f => fs.existsSync(f));
		if (up && !fs.existsSync(cli)) {
			fs.writeFileSync(cli, fs.readFileSync(up, 'utf8').replace(/\bcodium\b/g, 'aide'), { mode: 0o755 });
		}
	} else if (fs.existsSync(path.join(runtime, 'bin')) && !fs.existsSync(cli)) {
		fs.writeFileSync(cli, '@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\AIDE.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\nendlocal\r\n');
	}
	console.log('Rebranded product.json (AIDE 2.0), portable mode enabled.');
}

if (fs.existsSync(runtime) && findExe(runtime) && !flag('--force')) {
	console.log('runtime/ already present.');
} else {
	if (flag('--force')) fs.rmSync(runtime, { recursive: true, force: true });
	if (flag('--download')) await download();
	else copyFrom(path.resolve(opt('--from') ?? path.join(root, '..', 'AIDE')));
}
rebrand();
