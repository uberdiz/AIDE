import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import YAML from 'yaml';
import { compressOutput, truncateMiddle } from '../ai/context/compress';
import { dangerousCommand } from '../agents/permissions';
import type { ChatController } from '../chat/controller';
import * as config from '../core/config';
import { AIDE_HOME, type Services } from '../services';
import { git } from '../tools/builtin';

export type WorkflowStep =
	| { run: string; continueOnError?: boolean; timeout?: number }
	| { command: string; args?: unknown[] }
	| { agent: string; prompt: string }
	| { ai: 'commit-message' | 'pr-description' | 'review'; into?: string }
	| { confirm: string }
	| { git: 'commit' | 'push' | 'branch'; message?: string; name?: string }
	| { github: 'create-pr'; title?: string; body?: string; draft?: boolean }
	| { workflow: string };

export interface WorkflowDefinition {
	name: string;
	description?: string;
	steps: WorkflowStep[];
	source?: 'builtin' | 'user' | 'workspace' | 'settings' | 'extension';
	file?: string;
}

const BUILTIN: WorkflowDefinition[] = [
	{
		name: 'Prepare Pull Request',
		description: 'Test, review, commit, push and open a PR - asking before each outward step',
		source: 'builtin',
		steps: [
			{ command: 'workbench.action.files.saveAll' },
			{ run: '${verifyCommand}' },
			{ agent: 'reviewer', prompt: 'Review my uncommitted changes. @git' },
			{ confirm: 'Continue to commit and push?' },
			{ ai: 'commit-message' },
			{ confirm: 'Commit with message:\n\n${commitMessage}' },
			{ git: 'commit', message: '${commitMessage}' },
			{ git: 'push' },
			{ ai: 'pr-description' },
			{ github: 'create-pr' },
		],
	},
	{
		name: 'Run Tests and Fix',
		description: 'Run the project\'s tests; on failure hand the output to the Debugger agent',
		source: 'builtin',
		steps: [{ command: 'workbench.action.files.saveAll' }, { run: '${verifyCommand}', continueOnError: true }, { agent: 'debugger', prompt: 'If the test run below failed, find the root cause and fix it, then re-run the tests. If it passed, just say so.\n\n${lastOutput}' }],
	},
	{
		name: 'Refresh Project Context',
		description: 'Rebuild the project map in .aide/context/project-map.md',
		source: 'builtin',
		steps: [{ command: 'aide.project.analyze' }],
	},
];

/** Runs multi-step workflows with visible progress in the "AIDE Workflows" output channel. */
export class Workflows {
	private extension = new Map<string, WorkflowDefinition>();
	private output = vscode.window.createOutputChannel('AIDE Workflows');

	constructor(private readonly s: Services, private readonly chat: ChatController, private readonly createPr: () => Promise<unknown>) {}

	register(w: WorkflowDefinition): vscode.Disposable {
		this.extension.set(w.name, { ...w, source: 'extension' });
		return new vscode.Disposable(() => this.extension.delete(w.name));
	}

	all(): { workflows: WorkflowDefinition[]; errors: string[] } {
		const errors: string[] = [];
		const out = new Map<string, WorkflowDefinition>();
		for (const w of BUILTIN) out.set(w.name, w);
		for (const w of config.get<WorkflowDefinition[]>('workflows', [])) if (w?.name && Array.isArray(w.steps)) out.set(w.name, { ...w, source: 'settings' });
		for (const w of this.extension.values()) out.set(w.name, w);
		const dirs: [string, 'user' | 'workspace'][] = [[path.join(AIDE_HOME, 'workflows'), 'user']];
		if (this.s.project) dirs.push([this.s.project.dir('workflows'), 'workspace']);
		for (const [dir, source] of dirs) {
			let files: string[] = [];
			try {
				files = fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f));
			} catch {
				continue;
			}
			for (const f of files) {
				try {
					const w = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as WorkflowDefinition;
					if (!w?.name || !Array.isArray(w.steps)) throw new Error('needs "name" and "steps"');
					out.set(w.name, { ...w, source, file: path.join(dir, f) });
				} catch (e) {
					errors.push(`${f}: ${(e as Error).message}`);
				}
			}
		}
		return { workflows: [...out.values()], errors };
	}

	async pickAndRun(name?: string): Promise<void> {
		const { workflows, errors } = this.all();
		for (const e of errors) this.s.log.warn(`Workflow file error: ${e}`);
		let wf = name ? workflows.find(w => w.name === name) : undefined;
		if (!wf) {
			const pick = await vscode.window.showQuickPick([...workflows.map(w => ({ label: w.name, description: w.source, detail: w.description, wf: w })), { label: '$(add) New workflow...', wf: undefined as WorkflowDefinition | undefined }], { placeHolder: 'Run workflow' });
			if (!pick) return;
			if (!pick.wf) return this.newWorkflow();
			wf = pick.wf;
		}
		await this.run(wf);
	}

	async newWorkflow(): Promise<void> {
		const dir = this.s.project?.dir('workflows') ?? path.join(AIDE_HOME, 'workflows');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'my-workflow.yaml');
		if (!fs.existsSync(file)) {
			fs.writeFileSync(file, `name: My Workflow
description: What it does
steps:
  - command: workbench.action.files.saveAll   # any command id
  - run: npm run lint                         # shell command (asks per the "command" permission)
    continueOnError: true
  - agent: reviewer                           # run an agent in the chat
    prompt: Review the uncommitted changes. @git
  - confirm: Commit now?                      # stop unless the user confirms
  - ai: commit-message                        # sets \${commitMessage}
  - git: commit
    message: \${commitMessage}
`);
		}
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	}

	async run(wf: WorkflowDefinition): Promise<boolean> {
		const vars: Record<string, string> = { verifyCommand: this.s.project?.verifyCommand() ?? '', lastOutput: '', commitMessage: '', prTitle: '', prDescription: '' };
		const expand = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? '');
		this.output.show(true);
		this.output.appendLine(`\n=== Workflow: ${wf.name} (${new Date().toLocaleTimeString()}) ===`);
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Workflow: ${wf.name}`, cancellable: true }, async (progress, token) => {
			for (const [i, step] of wf.steps.entries()) {
				if (token.isCancellationRequested) {
					this.output.appendLine('Cancelled.');
					return false;
				}
				const label = Object.keys(step)[0];
				progress.report({ message: `${i + 1}/${wf.steps.length}: ${label}`, increment: 100 / wf.steps.length });
				this.output.appendLine(`\n[${i + 1}/${wf.steps.length}] ${label}: ${JSON.stringify(step).slice(0, 200)}`);
				try {
					const ok = await this.runStep(step, vars, expand, token);
					if (!ok) {
						this.output.appendLine('Stopped.');
						return false;
					}
				} catch (e) {
					this.output.appendLine(`FAILED: ${(e as Error).message}`);
					void vscode.window.showErrorMessage(`Workflow "${wf.name}" failed at step ${i + 1}: ${(e as Error).message}`, 'Show output').then(p => p && this.output.show());
					return false;
				}
			}
			this.output.appendLine(`\n=== ${wf.name}: done ===`);
			void vscode.window.showInformationMessage(`Workflow "${wf.name}" completed.`);
			return true;
		});
	}

	private async runStep(step: WorkflowStep, vars: Record<string, string>, expand: (s: string) => string, token: vscode.CancellationToken): Promise<boolean> {
		const root = this.s.root;
		if ('run' in step) {
			const cmd = expand(step.run).trim();
			if (!cmd) {
				this.output.appendLine('  (skipped: empty command - no verification command detected)');
				return true;
			}
			if (!root) throw new Error('Open a folder first.');
			const perm = await this.s.permissions.check({ category: 'command', toolName: 'workflow_run', agentId: 'workflow', summary: `Run \`${cmd}\``, preview: { title: 'Run command', detail: cmd }, dangerous: dangerousCommand(cmd) });
			if (!perm.allowed) throw new Error(`Permission denied for \`${cmd}\``);
			const ac = new AbortController();
			token.onCancellationRequested(() => ac.abort());
			const r = await this.s.ide.runCommand(cmd, { cwd: root, timeoutMs: (step.timeout ?? 600) * 1000, signal: ac.signal });
			vars.lastOutput = `$ ${cmd}\n${compressOutput(r.output, 3000)}\n[exit ${r.exitCode}]`;
			this.output.appendLine(truncateMiddle(r.output, 4000).text);
			this.output.appendLine(`  exit code ${r.exitCode}`);
			if (r.exitCode !== 0 && !step.continueOnError) throw new Error(`\`${cmd}\` exited with ${r.exitCode}`);
			return true;
		}
		if ('command' in step) {
			await vscode.commands.executeCommand(step.command, ...(step.args ?? []));
			return true;
		}
		if ('agent' in step) {
			await vscode.commands.executeCommand('aide.chat.focus');
			const r = await this.chat.send({ agentId: step.agent, text: expand(step.prompt), newConversation: true });
			this.output.appendLine(`  agent finished: ${r?.status}`);
			vars.lastAgentOutput = r?.text ?? '';
			return r?.status === 'completed';
		}
		if ('confirm' in step) {
			const ok = await vscode.window.showInformationMessage(expand(step.confirm), { modal: true }, 'Continue');
			return ok === 'Continue';
		}
		if ('ai' in step) {
			if (!root) throw new Error('Open a folder first.');
			if (step.ai === 'commit-message') {
				let diff = (await git(root, ['diff', '--staged'])).stdout;
				if (!diff.trim()) diff = (await git(root, ['diff'])).stdout;
				const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard'])).stdout;
				vars.commitMessage = (await this.s.client.complete('commit_message', 'Write a git commit message: imperative summary line (max 72 chars), blank line, short bullet body if useful. Output only the message.', `Diff:\n${truncateMiddle(diff, 12_000).text}\n\nNew files:\n${untracked}`, new AbortController().signal, 'workflow:commit-message')).trim();
				this.output.appendLine(`  commit message: ${vars.commitMessage.split('\n')[0]}`);
			} else if (step.ai === 'pr-description') {
				const log = (await git(root, ['log', '-20', '--pretty=format:%s'])).stdout;
				const text = await this.s.client.complete('commit_message', 'Write a pull request title on the first line, then a Markdown description with Summary / Changes / Testing sections.', `Recent commits:\n${log}\n\nLast command output:\n${vars.lastOutput}`, new AbortController().signal, 'workflow:pr-description');
				vars.prTitle = text.split('\n')[0].replace(/^#+\s*/, '');
				vars.prDescription = text.split('\n').slice(1).join('\n').trim();
			} else {
				await this.chat.send({ agentId: 'reviewer', text: 'Review my uncommitted changes. @git', newConversation: true });
			}
			if (step.into) vars[step.into] = vars.commitMessage || vars.prDescription;
			return true;
		}
		if ('git' in step) {
			if (!root) throw new Error('Open a folder first.');
			const perm = await this.s.permissions.check({ category: 'git', toolName: `workflow_git_${step.git}`, agentId: 'workflow', summary: `git ${step.git}` });
			if (!perm.allowed) throw new Error(`Permission denied for git ${step.git}`);
			let r;
			if (step.git === 'commit') {
				const msg = expand(step.message ?? '${commitMessage}');
				if (!msg.trim()) throw new Error('empty commit message');
				await git(root, ['add', '-A']);
				r = await git(root, ['commit', '-m', msg]);
			} else if (step.git === 'push') {
				const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
				r = await git(root, ['push', '-u', 'origin', branch]);
			} else {
				r = await git(root, ['switch', '-c', expand(step.name ?? 'aide/work')]);
			}
			this.output.appendLine(`  ${(r.stdout + r.stderr).trim()}`);
			if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${step.git} failed`);
			return true;
		}
		if ('github' in step) {
			await this.createPr();
			return true;
		}
		if ('workflow' in step) {
			const wf = this.all().workflows.find(w => w.name === step.workflow);
			if (!wf) throw new Error(`Unknown workflow "${step.workflow}"`);
			return this.run(wf);
		}
		throw new Error(`Unknown step type: ${JSON.stringify(step)}`);
	}

	dispose(): void {
		this.output.dispose();
	}
}

// ------------------------------------------------------------------ automations

export interface Automation {
	when: 'buildFails' | 'commandFails' | 'projectOpens' | 'fileChanges';
	glob?: string;
	then: { workflow?: string; agent?: string; prompt?: string };
	enabled?: boolean;
}

/** Event-driven automations (aide.automations). Agents they start still ask for permissions. */
export function registerAutomations(ctx: vscode.ExtensionContext, s: Services, wf: Workflows, chat: ChatController): void {
	let disposables: vscode.Disposable[] = [];
	const running = new Set<string>();
	const act = async (a: Automation, detail: string) => {
		const key = JSON.stringify(a);
		if (running.has(key) || chat.isRunning()) return;
		running.add(key);
		try {
			s.log.info(`Automation "${a.when}" triggered: ${detail}`);
			if (a.then.workflow) await wf.pickAndRun(a.then.workflow);
			else if (a.then.agent) {
				await vscode.commands.executeCommand('aide.chat.focus');
				await chat.send({ agentId: a.then.agent, text: `${a.then.prompt ?? 'Investigate this event.'}\n\nEvent: ${detail}`, newConversation: true });
			}
		} catch (e) {
			s.log.error(`Automation failed: ${(e as Error).message}`);
		} finally {
			running.delete(key);
		}
	};
	const setup = () => {
		for (const d of disposables) d.dispose();
		disposables = [];
		const list = config.get<Automation[]>('automations', []).filter(a => a && a.enabled !== false);
		for (const a of list) {
			if (a.when === 'buildFails') {
				disposables.push(vscode.tasks.onDidEndTaskProcess(e => {
					if (e.exitCode && (e.execution.task.group === vscode.TaskGroup.Build || e.execution.task.group === vscode.TaskGroup.Test)) void act(a, `task "${e.execution.task.name}" exited with ${e.exitCode}`);
				}));
			} else if (a.when === 'commandFails') {
				disposables.push(s.capture.onDidFail(i => void act(a, `\`${i.command}\` exited with ${i.exitCode}\n${compressOutput(i.output, 1500)}`)));
			} else if (a.when === 'fileChanges' && a.glob) {
				const w = vscode.workspace.createFileSystemWatcher(a.glob);
				let t: NodeJS.Timeout | undefined;
				const fire = (u: vscode.Uri) => {
					if (t) clearTimeout(t);
					t = setTimeout(() => void act(a, `${vscode.workspace.asRelativePath(u)} changed`), 2000);
				};
				w.onDidChange(fire);
				w.onDidCreate(fire);
				disposables.push(w);
			} else if (a.when === 'projectOpens' && s.root) {
				setTimeout(() => void act(a, `project ${path.basename(s.root!)} opened`), 5000);
			}
		}
	};
	setup();
	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('aide.automations') && setup()),
		new vscode.Disposable(() => disposables.forEach(d => d.dispose())),
	);
}
