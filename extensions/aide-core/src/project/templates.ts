import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIDE_HOME } from '../services';

interface ProjectTemplate {
	id: string;
	label: string;
	description: string;
	/** static files, or a scaffolder command run in the new folder's parent */
	files?: (name: string) => Record<string, string>;
	command?: (name: string) => string;
}

const gitignore = (extra: string[]) => ['.aide/plans/', ...extra].join('\n') + '\n';
const instructions = (lines: string[]) => `# Project instructions for AI\n\n${lines.map(l => `- ${l}`).join('\n')}\n`;

const TEMPLATES: ProjectTemplate[] = [
	{
		id: 'python', label: 'Python', description: 'Package + pytest',
		files: n => ({
			'pyproject.toml': `[project]\nname = "${n}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n\n[project.optional-dependencies]\ndev = ["pytest"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
			[`src/${n.replace(/-/g, '_')}/__init__.py`]: `def greet(name: str) -> str:\n    return f"Hello, {name}!"\n`,
			'tests/test_greet.py': `from ${n.replace(/-/g, '_')} import greet\n\n\ndef test_greet():\n    assert greet("AIDE") == "Hello, AIDE!"\n`,
			'.gitignore': gitignore(['__pycache__/', '.venv/', '*.egg-info/', '.pytest_cache/']),
			'.aide/instructions.md': instructions(['Python 3.10+, type hints everywhere.', 'Test: python -m pytest -q', 'Create a venv: python -m venv .venv']),
			'README.md': `# ${n}\n\n\`\`\`\npython -m venv .venv\n.venv\\Scripts\\activate\npip install -e .[dev]\npython -m pytest\n\`\`\`\n`,
		}),
	},
	{
		id: 'node', label: 'Node.js (TypeScript)', description: 'TypeScript + node:test',
		files: n => ({
			'package.json': JSON.stringify({ name: n, version: '0.1.0', type: 'module', scripts: { build: 'tsc', start: 'node dist/index.js', test: 'tsc && node --test dist/' }, devDependencies: { typescript: '^5.6.0', '@types/node': '^22.0.0' } }, null, 2) + '\n',
			'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src', strict: true }, include: ['src'] }, null, 2) + '\n',
			'src/index.ts': `export function greet(name: string): string {\n\treturn \`Hello, \${name}!\`;\n}\n\nconsole.log(greet('AIDE'));\n`,
			'src/index.test.ts': `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './index.js';\n\ntest('greet', () => assert.equal(greet('x'), 'Hello, x!'));\n`,
			'.gitignore': gitignore(['node_modules/', 'dist/']),
			'.aide/instructions.md': instructions(['TypeScript strict mode.', 'Build: npm run build; Test: npm test']),
		}),
	},
	{
		id: 'fastapi', label: 'FastAPI', description: 'Python web API',
		files: n => ({
			'requirements.txt': 'fastapi\nuvicorn[standard]\npytest\nhttpx\n',
			'app/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="${n}")\n\n\n@app.get("/health")\ndef health() -> dict:\n    return {"status": "ok"}\n`,
			'app/__init__.py': '',
			'tests/test_health.py': `from fastapi.testclient import TestClient\nfrom app.main import app\n\n\ndef test_health():\n    assert TestClient(app).get("/health").json() == {"status": "ok"}\n`,
			'.gitignore': gitignore(['__pycache__/', '.venv/']),
			'.aide/instructions.md': instructions(['Run: uvicorn app.main:app --reload', 'Test: python -m pytest -q']),
		}),
	},
	{
		id: 'electron', label: 'Electron', description: 'Minimal desktop app',
		files: n => ({
			'package.json': JSON.stringify({ name: n, version: '0.1.0', main: 'main.js', scripts: { start: 'electron .' }, devDependencies: { electron: '^33.0.0' } }, null, 2) + '\n',
			'main.js': `const { app, BrowserWindow } = require('electron');\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ width: 900, height: 600 });\n  win.loadFile('index.html');\n});\napp.on('window-all-closed', () => app.quit());\n`,
			'index.html': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${n}</title></head><body><h1>${n}</h1></body></html>\n`,
			'.gitignore': gitignore(['node_modules/', 'out/']),
		}),
	},
	{
		id: 'go', label: 'Go', description: 'Go module + test',
		files: n => ({ 'go.mod': `module ${n}\n\ngo 1.22\n`, 'main.go': `package main\n\nimport "fmt"\n\nfunc Greet(name string) string { return "Hello, " + name + "!" }\n\nfunc main() { fmt.Println(Greet("AIDE")) }\n`, 'main_test.go': `package main\n\nimport "testing"\n\nfunc TestGreet(t *testing.T) {\n\tif Greet("x") != "Hello, x!" {\n\t\tt.Fatal("unexpected")\n\t}\n}\n`, '.gitignore': gitignore([]) }),
	},
	{
		id: 'cpp', label: 'C++ (CMake)', description: 'CMake project',
		files: n => ({ 'CMakeLists.txt': `cmake_minimum_required(VERSION 3.20)\nproject(${n.replace(/-/g, '_')} CXX)\nset(CMAKE_CXX_STANDARD 20)\nadd_executable(app src/main.cpp)\n`, 'src/main.cpp': `#include <iostream>\n\nint main() {\n    std::cout << "Hello from ${n}" << std::endl;\n    return 0;\n}\n`, '.gitignore': gitignore(['build/']) }),
	},
	{ id: 'react', label: 'React (Vite)', description: 'Runs: npm create vite@latest', command: n => `npm create vite@latest ${n} -- --template react-ts` },
	{ id: 'next', label: 'Next.js', description: 'Runs: npx create-next-app@latest', command: n => `npx create-next-app@latest ${n}` },
	{ id: 'rust', label: 'Rust', description: 'Runs: cargo new', command: n => `cargo new ${n}` },
	{ id: 'csharp', label: 'C# console', description: 'Runs: dotnet new console', command: n => `dotnet new console -o ${n}` },
	{
		id: 'ml', label: 'AI / ML (Python)', description: 'Notebook-ready Python project',
		files: n => ({ 'requirements.txt': 'numpy\npandas\nscikit-learn\nmatplotlib\njupyter\n', 'notebooks/.gitkeep': '', 'src/train.py': `"""Training entry point for ${n}."""\n\n\ndef main() -> None:\n    print("train")\n\n\nif __name__ == "__main__":\n    main()\n`, '.gitignore': gitignore(['__pycache__/', '.venv/', 'data/', '*.ckpt']), '.aide/instructions.md': instructions(['Never commit datasets or model weights.', 'Keep experiments reproducible (seed everything).']) }),
	},
];

export function registerTemplates(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(vscode.commands.registerCommand('aide.project.new', async () => {
		const userDir = path.join(AIDE_HOME, 'templates');
		const userTemplates = fs.existsSync(userDir) ? fs.readdirSync(userDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
		const pick = await vscode.window.showQuickPick([
			...TEMPLATES.map(t => ({ label: t.label, description: t.description, id: t.id })),
			...userTemplates.map(t => ({ label: t, description: `custom template (~/.aide/templates/${t})`, id: `user:${t}` })),
		], { placeHolder: 'New project from template' });
		if (!pick) return;
		const name = await vscode.window.showInputBox({ prompt: 'Project name', validateInput: v => (/^[a-zA-Z0-9][\w.-]*$/.test(v) ? undefined : 'Letters, digits, ., -, _') });
		if (!name) return;
		const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create project here', defaultUri: vscode.Uri.file(os.homedir()) });
		if (!parent?.[0]) return;
		const dest = path.join(parent[0].fsPath, name);
		const t = TEMPLATES.find(x => x.id === pick.id);
		if (t?.command) {
			const term = vscode.window.createTerminal({ name: `New ${t.label}`, cwd: parent[0].fsPath });
			term.show();
			term.sendText(t.command(name));
			const open = await vscode.window.showInformationMessage(`Scaffolding ${t.label} in the terminal. Open ${name} when it finishes.`, 'Open project');
			if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest));
			return;
		}
		if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty.`);
		if (pick.id.startsWith('user:')) fs.cpSync(path.join(userDir, pick.id.slice(5)), dest, { recursive: true });
		else for (const [rel, content] of Object.entries(t!.files!(name))) {
			fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
			fs.writeFileSync(path.join(dest, rel), content);
		}
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
	}));
}
