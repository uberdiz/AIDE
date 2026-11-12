// Which AIDE build: win32-x64 (AIDE.exe, a portable zip) or linux-x64 (bin "aide", a tar.gz for HalOS).
//   --platform linux-x64 | win32-x64     (default: the machine running the script)
export function target(args = process.argv.slice(2)) {
	const i = args.indexOf('--platform');
	const name = i >= 0 ? args[i + 1] : process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
	if (name !== 'win32-x64' && name !== 'linux-x64') throw new Error(`Unknown platform "${name}" (win32-x64 or linux-x64)`);
	const linux = name === 'linux-x64';
	return {
		name,
		linux,
		exe: linux ? 'aide' : 'AIDE.exe',
		upstreamExes: linux ? ['aide', 'codium', 'vscodium', 'code'] : ['AIDE.exe', 'VSCodium.exe', 'Code.exe', 'codium.exe'],
		asset: linux ? /^VSCodium-linux-x64-[\d.]+\.tar\.gz$/ : /^VSCodium-win32-x64-[\d.]+\.zip$/,
		archive: linux ? 'tar.gz' : 'zip',
	};
}
