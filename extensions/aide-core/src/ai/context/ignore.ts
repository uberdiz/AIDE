/**
 * Decides which paths are never sent to a model automatically: VCS metadata,
 * dependency folders, build output, virtualenvs, binaries, lockfiles, secrets.
 * Explicit user mentions may still read lockfiles, but never secrets.
 */

export const DEFAULT_IGNORED_DIRS = [
	'.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', 'env', '__pycache__',
	'.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
	'.svelte-kit', '.turbo', '.parcel-cache', '.cache', 'coverage', '.nyc_output', '.idea', '.vs', 'obj',
	'.gradle', '.terraform', 'Pods', 'DerivedData', 'vendor', '.dart_tool', '.expo', 'Library', 'Temp',
];

const BINARY_EXT = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'psd', 'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov',
	'avi', 'mkv', 'webm', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'exe', 'dll', 'so',
	'dylib', 'bin', 'obj', 'o', 'a', 'lib', 'pdb', 'class', 'pyc', 'pyo', 'wasm', 'ttf', 'otf', 'woff', 'woff2',
	'eot', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'sqlite', 'db', 'pak', 'asar', 'node', 'blend',
	'fbx', 'glb', 'gltf', 'unitypackage', 'rbxl', 'rbxm', 'safetensors', 'gguf', 'onnx', 'pt', 'ckpt', 'npy', 'npz',
]);

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'bun.lockb', 'uv.lock', 'Pipfile.lock']);

/** Files whose content must never reach a model. */
const SECRET_PATTERNS = [/(^|\/)\.env(\.[\w-]+)?$/i, /\.(pem|key|p12|pfx|keystore|jks)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.pypirc$/i, /(^|\/)credentials(\.json)?$/i, /secrets?\.(json|ya?ml|toml)$/i];

export function isBinaryPath(p: string): boolean {
	const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
	return BINARY_EXT.has(ext);
}

export function isLockfile(p: string): boolean {
	return LOCKFILES.has(p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1));
}

export function isSecretPath(p: string): boolean {
	const n = p.replace(/\\/g, '/');
	if (/\.env\.(example|sample|template)$/i.test(n)) return false;
	return SECRET_PATTERNS.some(r => r.test(n));
}

interface Rule { re: RegExp; negate: boolean; dirOnly: boolean }

/** Minimal gitignore-style matcher (supports *, **, ?, !, leading and trailing /). */
export class IgnoreMatcher {
	private rules: Rule[] = [];
	private dirs: Set<string>;

	constructor(extraDirs: string[] = DEFAULT_IGNORED_DIRS) {
		this.dirs = new Set(extraDirs);
	}

	add(patterns: string): this {
		for (let line of patterns.split(/\r?\n/)) {
			line = line.trim();
			if (!line || line.startsWith('#')) continue;
			let negate = false;
			if (line.startsWith('!')) {
				negate = true;
				line = line.slice(1);
			}
			const dirOnly = line.endsWith('/');
			if (dirOnly) line = line.slice(0, -1);
			const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
			if (line.startsWith('/')) line = line.slice(1);
			const body = globToRegex(line);
			const re = new RegExp(anchored ? `^${body}(?<rest>/.*)?$` : `(?:^|/)${body}(?<rest>/.*)?$`);
			this.rules.push({ re, negate, dirOnly });
		}
		return this;
	}

	/** `rel` is a workspace-relative path using forward slashes. */
	ignores(rel: string, isDir = false): boolean {
		const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
		const segs = p.split('/');
		for (let i = 0; i < segs.length - (isDir ? 0 : 1); i++) if (this.dirs.has(segs[i])) return true;
		let ignored = false;
		for (const r of this.rules) {
			const m = r.re.exec(p);
			if (!m) continue;
			// dir-only rules ("build/") match a file only through a parent directory
			if (r.dirOnly && !isDir && !m.groups?.rest) continue;
			ignored = !r.negate;
		}
		return ignored;
	}
}

export function globToRegex(glob: string): string {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const slash = glob[i + 2] === '/';
				out += slash ? '(?:.*/)?' : '.*';
				i += slash ? 2 : 1;
			} else out += '[^/]*';
		} else if (c === '?') out += '[^/]';
		else if ('\\^$+.()|{}[]'.includes(c)) out += '\\' + c;
		else out += c;
	}
	return out;
}

/** Should a file be included in automatic (non-explicit) context? */
export function autoContextAllowed(rel: string, matcher: IgnoreMatcher): boolean {
	return !matcher.ignores(rel) && !isBinaryPath(rel) && !isLockfile(rel) && !isSecretPath(rel) && !/\.min\.(js|css)$/.test(rel) && !/\.map$/.test(rel);
}
