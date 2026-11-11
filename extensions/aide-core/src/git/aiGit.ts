import * as vscode from 'vscode';
import { truncateMiddle } from '../ai/context/compress';
import type { Services } from '../services';
import { git } from '../tools/builtin';

interface GitRepository {
	rootUri: vscode.Uri;
	inputBox: { value: string };
}

function gitApi(): { repositories: GitRepository[] } | undefined {
	const ext = vscode.extensions.getExtension('vscode.git');
	try {
		return ext?.isActive ? ext.exports.getAPI(1) : undefined;
	} catch {
		return undefined;
	}
}

/** AI helpers on top of the built-in Git support (the SCM view itself is the IDE's). */
export function registerAiGit(ctx: vscode.ExtensionContext, s: Services, sendToChat: (agentId: string, prompt: string) => void): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand('aide.git.commitMessage', async (scm?: { rootUri?: vscode.Uri }) => {
			const api = gitApi();
			const repo = api?.repositories.find(r => !scm?.rootUri || r.rootUri.fsPath === scm.rootUri.fsPath) ?? api?.repositories[0];
			const root = repo?.rootUri.fsPath ?? s.root;
			if (!root) return void vscode.window.showWarningMessage('No git repository found.');
			let diff = (await git(root, ['diff', '--staged', '--no-color'])).stdout;
			const staged = !!diff.trim();
			if (!staged) diff = (await git(root, ['diff', '--no-color'])).stdout;
			if (!diff.trim()) return void vscode.window.showInformationMessage('No changes to describe.');
			const recent = (await git(root, ['log', '-10', '--pretty=format:%s'])).stdout;
			const msg = await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message' }, async () => {
				try {
					return await s.client.complete(
						'commit_message',
						'Write a git commit message for this diff. First line: imperative summary, max 72 characters. Then a blank line and a short body (bullets) only if the change is non-trivial. Match the style of the recent commit subjects. Output only the message.',
						`Recent commit subjects:\n${recent}\n\n${staged ? 'Staged' : 'Unstaged'} diff:\n${truncateMiddle(diff, 12_000).text}`,
						new AbortController().signal,
						'git:commit-message',
					);
				} catch (e) {
					void vscode.window.showErrorMessage(`AIDE: ${(e as Error).message}`);
					return undefined;
				}
			});
			if (!msg) return;
			const clean = msg.replace(/^```\w*\n?|```$/g, '').trim();
			if (repo) repo.inputBox.value = clean;
			else {
				await vscode.env.clipboard.writeText(clean);
				void vscode.window.showInformationMessage('Commit message copied to the clipboard.');
			}
		}),
		vscode.commands.registerCommand('aide.git.explainChanges', () => sendToChat('chat', 'Explain my uncommitted changes: what they do, why they might have been made, and any risks. @git')),
		vscode.commands.registerCommand('aide.git.reviewChanges', () => sendToChat('reviewer', 'Review my uncommitted changes for bugs, security issues, performance, maintainability, missing tests and style. @git')),
		vscode.commands.registerCommand('aide.git.prDescription', async () => {
			const root = s.root;
			if (!root) return;
			const base = (await vscode.window.showInputBox({ prompt: 'Base branch', value: 'main' })) ?? 'main';
			const log = (await git(root, ['log', `${base}..HEAD`, '--pretty=format:%s%n%b'])).stdout;
			const diff = (await git(root, ['diff', `${base}...HEAD`, '--no-color'])).stdout;
			if (!diff.trim()) return void vscode.window.showInformationMessage(`No changes between ${base} and HEAD.`);
			const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AIDE: writing PR description...' }, () =>
				s.client.complete('commit_message', 'Write a pull request title and description in Markdown with sections Summary, Changes, Testing. Be factual.', `Commits:\n${log}\n\nDiff:\n${truncateMiddle(diff, 20_000).text}`, new AbortController().signal, 'git:pr-description'),
			);
			const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
			await vscode.window.showTextDocument(doc);
		}),
	);
}
