import * as path from 'path';
import * as vscode from 'vscode';
import { truncateMiddle } from '../ai/context/compress';
import type { Services } from '../services';
import { git } from '../tools/builtin';
import type { Tool } from '../tools/types';

const API = 'https://api.github.com';
const SCOPES = ['repo', 'workflow', 'read:user'];

export interface RepoRef { owner: string; repo: string }

export function parseRemote(url: string): RepoRef | undefined {
	const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return m ? { owner: m[1], repo: m[2] } : undefined;
}

export class GitHubClient {
	private token: string | undefined;

	constructor(private readonly s: Services) {}

	/** Built-in GitHub sign-in first; a personal access token (stored in SecretStorage) as fallback. */
	async getToken(interactive: boolean): Promise<string | undefined> {
		if (this.token) return this.token;
		const pat = await this.s.getSecret('github.pat');
		if (pat) return (this.token = pat);
		try {
			const session = await vscode.authentication.getSession('github', SCOPES, interactive ? { createIfNone: true } : { silent: true });
			if (session) return (this.token = session.accessToken);
		} catch (e) {
			this.s.log.warn(`GitHub sign-in failed: ${(e as Error).message}`);
			if (interactive) {
				const pick = await vscode.window.showWarningMessage('GitHub sign-in is unavailable. Use a personal access token instead?', 'Enter token');
				if (pick) return this.setPat();
			}
		}
		return undefined;
	}

	async setPat(): Promise<string | undefined> {
		const t = await vscode.window.showInputBox({ prompt: 'GitHub personal access token (scopes: repo, workflow). Stored in the OS keychain.', password: true, ignoreFocusOut: true });
		if (!t) return undefined;
		await this.s.setSecret('github.pat', t.trim());
		this.token = t.trim();
		return this.token;
	}

	async signOut(): Promise<void> {
		this.token = undefined;
		await this.s.setSecret('github.pat', undefined);
	}

	async signedIn(): Promise<boolean> {
		return !!(await this.getToken(false));
	}

	async request<T = any>(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json', interactive = true): Promise<T> {
		const token = await this.getToken(interactive);
		if (!token) throw new Error('Not signed in to GitHub. Run "GitHub: Sign In".');
		const res = await fetch(path.startsWith('http') ? path : API + path, {
			method,
			headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'AIDE/2.0', ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (res.status === 401) {
			this.token = undefined;
			throw new Error('GitHub rejected the credentials (401). Sign in again.');
		}
		if (!res.ok) {
			const text = await res.text();
			let msg = text;
			try {
				const j = JSON.parse(text);
				msg = j.message + (j.errors ? `: ${JSON.stringify(j.errors)}` : '');
			} catch {
				/* plain text */
			}
			throw new Error(`GitHub ${method} ${path}: ${res.status} ${msg}`);
		}
		if (accept.includes('diff') || accept.includes('raw')) return (await res.text()) as unknown as T;
		return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
	}

	async currentRepo(): Promise<RepoRef | undefined> {
		const root = this.s.root;
		if (!root) return undefined;
		const r = await git(root, ['remote', 'get-url', 'origin']);
		return r.code === 0 ? parseRemote(r.stdout) : undefined;
	}

	async requireRepo(): Promise<RepoRef> {
		const r = await this.currentRepo();
		if (!r) throw new Error('This workspace has no GitHub "origin" remote.');
		return r;
	}
}

// ------------------------------------------------------------------ agent tools

export function githubTools(gh: GitHubClient): Tool[] {
	const repoPath = async () => {
		const r = await gh.requireRepo();
		return `/repos/${r.owner}/${r.repo}`;
	};
	return [
		{
			name: 'github_get_issue',
			toolset: 'github',
			category: 'read',
			readOnly: true,
			description: 'Get a GitHub issue or pull request (title, body, labels, comments) from the workspace\'s origin repository.',
			inputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
			describe: i => `GitHub issue #${i.number}`,
			async run(i) {
				const base = await repoPath();
				const issue = await gh.request(`GET`, `${base}/issues/${i.number}`);
				const comments = await gh.request<any[]>('GET', `${base}/issues/${i.number}/comments?per_page=30`);
				const text = `#${issue.number} ${issue.title} [${issue.state}]${issue.pull_request ? ' (pull request)' : ''}\nAuthor: ${issue.user?.login}  Labels: ${(issue.labels ?? []).map((l: any) => l.name).join(', ')}\n\n${issue.body ?? ''}\n\n${comments.map(c => `--- ${c.user?.login}:\n${c.body}`).join('\n\n')}`;
				return { content: truncateMiddle(text, 8000).text };
			},
		},
		{
			name: 'github_list_issues',
			toolset: 'github',
			category: 'read',
			readOnly: true,
			description: 'List issues in the origin repository (state: open|closed|all).',
			inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'string' } } },
			describe: () => 'List GitHub issues',
			async run(i) {
				const base = await repoPath();
				const items = await gh.request<any[]>('GET', `${base}/issues?state=${i.state ?? 'open'}&per_page=40${i.labels ? `&labels=${encodeURIComponent(String(i.labels))}` : ''}`);
				return { content: items.map(x => `#${x.number} ${x.title}${x.pull_request ? ' (PR)' : ''} [${x.state}]`).join('\n') || 'No issues.' };
			},
		},
		{
			name: 'github_comment',
			toolset: 'github',
			category: 'github',
			description: 'Post a comment on an issue or pull request.',
			inputSchema: { type: 'object', properties: { number: { type: 'integer' }, body: { type: 'string' } }, required: ['number', 'body'] },
			describe: i => `Comment on #${i.number}`,
			async preview(i) {
				return { title: `Comment on #${i.number}`, detail: String(i.body) };
			},
			async run(i) {
				const base = await repoPath();
				const c = await gh.request('POST', `${base}/issues/${i.number}/comments`, { body: i.body });
				return { content: `Commented: ${c.html_url}` };
			},
		},
		{
			name: 'github_create_pull_request',
			toolset: 'github',
			category: 'github',
			description: 'Open a pull request from a pushed branch (head, default: current branch) into base (default: the repository default branch).',
			inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' } }, required: ['title'] },
			describe: i => `Create PR "${i.title}"`,
			async preview(i) {
				return { title: `Create pull request`, detail: `${i.title}\n\n${i.body ?? ''}` };
			},
			async run(i, ctx) {
				const r = await gh.requireRepo();
				const head = String(i.head ?? (await git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim());
				const repo = await gh.request('GET', `/repos/${r.owner}/${r.repo}`);
				const pr = await gh.request('POST', `/repos/${r.owner}/${r.repo}/pulls`, { title: i.title, body: i.body ?? '', head, base: i.base ?? repo.default_branch, draft: !!i.draft });
				return { content: `Created PR #${pr.number}: ${pr.html_url}` };
			},
		},
		{
			name: 'github_list_workflow_runs',
			toolset: 'github',
			category: 'read',
			readOnly: true,
			description: 'List recent GitHub Actions workflow runs and their status for the origin repository.',
			inputSchema: { type: 'object', properties: { branch: { type: 'string' } } },
			describe: () => 'GitHub Actions runs',
			async run(i) {
				const base = await repoPath();
				const runs = await gh.request('GET', `${base}/actions/runs?per_page=15${i.branch ? `&branch=${encodeURIComponent(String(i.branch))}` : ''}`);
				return { content: (runs.workflow_runs ?? []).map((w: any) => `${w.name} #${w.run_number} ${w.head_branch} ${w.status}/${w.conclusion ?? '-'} ${w.html_url}`).join('\n') || 'No runs.' };
			},
		},
	];
}

// ------------------------------------------------------------------ tree view

type GhNode = { kind: 'section'; id: 'issues' | 'pulls' | 'actions'; label: string } | { kind: 'item'; section: string; data: any } | { kind: 'info'; label: string; command?: vscode.Command };

export class GitHubView implements vscode.TreeDataProvider<GhNode> {
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly s: Services, private readonly gh: GitHubClient, private readonly startAgent: (agentId: string, prompt: string) => void) {}

	register(ctx: vscode.ExtensionContext): void {
		const run = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
			try {
				await fn(...a);
			} catch (e) {
				void vscode.window.showErrorMessage((e as Error).message);
			}
		};
		ctx.subscriptions.push(
			vscode.window.createTreeView('aide.github', { treeDataProvider: this }),
			vscode.commands.registerCommand('aide.github.signIn', run(async () => {
				if (await this.gh.getToken(true)) void vscode.window.showInformationMessage('Signed in to GitHub.');
				this.emitter.fire();
			})),
			vscode.commands.registerCommand('aide.github.setToken', run(async () => {
				await this.gh.setPat();
				this.emitter.fire();
			})),
			vscode.commands.registerCommand('aide.github.signOut', run(async () => {
				await this.gh.signOut();
				this.emitter.fire();
			})),
			vscode.commands.registerCommand('aide.github.refresh', () => this.emitter.fire()),
			vscode.commands.registerCommand('aide.github.clone', run(() => this.clone())),
			vscode.commands.registerCommand('aide.github.createRepo', run(() => this.createRepo())),
			vscode.commands.registerCommand('aide.github.createIssue', run(() => this.createIssue())),
			vscode.commands.registerCommand('aide.github.comment', run((n?: GhNode) => this.comment(n))),
			vscode.commands.registerCommand('aide.github.createPR', run(() => this.createPR())),
			vscode.commands.registerCommand('aide.github.openItem', (url: string) => vscode.env.openExternal(vscode.Uri.parse(url))),
			vscode.commands.registerCommand('aide.github.viewIssue', run((n: GhNode) => this.viewIssue(n))),
			vscode.commands.registerCommand('aide.github.fixIssue', run((n?: GhNode | number) => this.fixIssue(n))),
			vscode.commands.registerCommand('aide.github.reviewPR', run((n?: GhNode) => this.reviewPR(n))),
		);
	}

	getTreeItem(n: GhNode): vscode.TreeItem {
		if (n.kind === 'info') {
			const it = new vscode.TreeItem(n.label);
			it.command = n.command;
			it.iconPath = new vscode.ThemeIcon(n.command ? 'sign-in' : 'info');
			return it;
		}
		if (n.kind === 'section') {
			const it = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
			it.iconPath = new vscode.ThemeIcon(n.id === 'issues' ? 'issues' : n.id === 'pulls' ? 'git-pull-request' : 'play-circle');
			return it;
		}
		const d = n.data;
		if (n.section === 'actions') {
			const it = new vscode.TreeItem(`${d.name} #${d.run_number}`);
			it.description = `${d.head_branch} · ${d.conclusion ?? d.status}`;
			const icon = d.conclusion === 'success' ? ['pass', 'testing.iconPassed'] : d.conclusion === 'failure' ? ['error', 'testing.iconFailed'] : ['sync~spin', undefined];
			it.iconPath = new vscode.ThemeIcon(icon[0]!, icon[1] ? new vscode.ThemeColor(icon[1]) : undefined);
			it.command = { command: 'aide.github.openItem', title: 'Open', arguments: [d.html_url] };
			return it;
		}
		const it = new vscode.TreeItem(`#${d.number} ${d.title}`);
		it.description = d.user?.login;
		it.tooltip = d.title;
		it.iconPath = new vscode.ThemeIcon(n.section === 'pulls' ? 'git-pull-request' : 'issue-opened');
		it.contextValue = n.section === 'pulls' ? 'aideGhPull' : 'aideGhIssue';
		it.command = { command: 'aide.github.viewIssue', title: 'View', arguments: [n] };
		return it;
	}

	async getChildren(n?: GhNode): Promise<GhNode[]> {
		try {
			if (!n) {
				if (!(await this.gh.signedIn())) return [{ kind: 'info', label: 'Sign in to GitHub', command: { command: 'aide.github.signIn', title: 'Sign in' } }];
				const repo = await this.gh.currentRepo();
				if (!repo) return [{ kind: 'info', label: 'No GitHub remote in this workspace' }];
				return [
					{ kind: 'info', label: `${repo.owner}/${repo.repo}` },
					{ kind: 'section', id: 'issues', label: 'Issues' },
					{ kind: 'section', id: 'pulls', label: 'Pull requests' },
					{ kind: 'section', id: 'actions', label: 'Actions' },
				];
			}
			if (n.kind !== 'section') return [];
			const r = await this.gh.requireRepo();
			if (n.id === 'actions') {
				const runs = await this.gh.request('GET', `/repos/${r.owner}/${r.repo}/actions/runs?per_page=15`, undefined, undefined, false);
				return (runs.workflow_runs ?? []).map((d: any) => ({ kind: 'item', section: 'actions', data: d }));
			}
			const items = await this.gh.request<any[]>('GET', `/repos/${r.owner}/${r.repo}/${n.id}?state=open&per_page=30`, undefined, undefined, false);
			return items.filter(i => n.id === 'pulls' || !i.pull_request).map(d => ({ kind: 'item', section: n.id, data: d }));
		} catch (e) {
			return [{ kind: 'info', label: `Error: ${(e as Error).message}` }];
		}
	}

	private async clone(): Promise<void> {
		const repos = await this.gh.request<any[]>('GET', '/user/repos?per_page=100&sort=updated');
		const pick = await vscode.window.showQuickPick([...repos.map(r => ({ label: r.full_name, description: r.private ? 'private' : '', detail: r.description ?? '', url: r.clone_url })), { label: '$(link) Enter a repository URL...', url: '' }], { placeHolder: 'Clone a repository', matchOnDetail: true });
		if (!pick) return;
		const url = pick.url || (await vscode.window.showInputBox({ prompt: 'Repository URL' }));
		if (!url) return;
		await vscode.commands.executeCommand('git.clone', url);
	}

	private async createRepo(): Promise<void> {
		const name = await vscode.window.showInputBox({ prompt: 'New repository name', value: this.s.root ? path.basename(this.s.root) : '' });
		if (!name) return;
		const vis = await vscode.window.showQuickPick(['private', 'public'], { placeHolder: 'Visibility' });
		if (!vis) return;
		const ok = await vscode.window.showWarningMessage(`Create ${vis} GitHub repository "${name}"?`, { modal: true }, 'Create');
		if (!ok) return;
		const repo = await this.gh.request('POST', '/user/repos', { name, private: vis === 'private' });
		const root = this.s.root;
		if (root && (await git(root, ['rev-parse', '--is-inside-work-tree'])).code === 0 && (await git(root, ['remote', 'get-url', 'origin'])).code !== 0) {
			const push = await vscode.window.showInformationMessage(`Created ${repo.full_name}. Add it as "origin" and push the current branch?`, 'Add remote & push', 'Just add remote');
			if (push) {
				await git(root, ['remote', 'add', 'origin', repo.clone_url]);
				if (push === 'Add remote & push') {
					const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
					const r = await git(root, ['push', '-u', 'origin', branch]);
					if (r.code !== 0) throw new Error(`push failed: ${r.stderr}`);
				}
			}
		} else void vscode.window.showInformationMessage(`Created ${repo.html_url}`, 'Open').then(p => p && vscode.env.openExternal(vscode.Uri.parse(repo.html_url)));
		this.emitter.fire();
	}

	private async createIssue(): Promise<void> {
		const r = await this.gh.requireRepo();
		const title = await vscode.window.showInputBox({ prompt: `New issue in ${r.owner}/${r.repo}: title` });
		if (!title) return;
		const body = await vscode.window.showInputBox({ prompt: 'Description (optional, Markdown)' });
		const issue = await this.gh.request('POST', `/repos/${r.owner}/${r.repo}/issues`, { title, body: body ?? '' });
		void vscode.window.showInformationMessage(`Created issue #${issue.number}`, 'Open').then(p => p && vscode.env.openExternal(vscode.Uri.parse(issue.html_url)));
		this.emitter.fire();
	}

	private async issueNumber(n?: GhNode | number): Promise<number | undefined> {
		if (typeof n === 'number') return n;
		if (n?.kind === 'item') return n.data.number;
		const v = await vscode.window.showInputBox({ prompt: 'Issue number', validateInput: x => (/^\d+$/.test(x) ? undefined : 'Enter a number') });
		return v ? Number(v) : undefined;
	}

	private async comment(n?: GhNode): Promise<void> {
		const num = await this.issueNumber(n);
		if (!num) return;
		const r = await this.gh.requireRepo();
		const body = await vscode.window.showInputBox({ prompt: `Comment on #${num}` });
		if (!body) return;
		await this.gh.request('POST', `/repos/${r.owner}/${r.repo}/issues/${num}/comments`, { body });
		void vscode.window.showInformationMessage(`Commented on #${num}.`);
	}

	private async viewIssue(n: GhNode): Promise<void> {
		if (n.kind !== 'item') return;
		const d = n.data;
		const pick = await vscode.window.showQuickPick(
			[
				{ label: '$(link-external) Open on GitHub', id: 'open' },
				...(n.section === 'issues' ? [{ label: '$(hubot) Fix this issue with AI', id: 'fix' }] : [{ label: '$(eye) Review this PR with AI', id: 'review' }]),
				{ label: '$(comment) Comment...', id: 'comment' },
			],
			{ placeHolder: `#${d.number} ${d.title}` },
		);
		if (pick?.id === 'open') await vscode.env.openExternal(vscode.Uri.parse(d.html_url));
		if (pick?.id === 'fix') await this.fixIssue(n);
		if (pick?.id === 'review') await this.reviewPR(n);
		if (pick?.id === 'comment') await this.comment(n);
	}

	/** "Fix issue #42": the Coder agent follows the full workflow, asking before git/GitHub actions. */
	private async fixIssue(n?: GhNode | number): Promise<void> {
		const num = await this.issueNumber(n);
		if (!num) return;
		const slug = `fix/issue-${num}`;
		this.startAgent('coder-github', `Fix GitHub issue #${num}. Follow this workflow:
1. Read the issue with github_get_issue.
2. Inspect the relevant code.
3. Create a branch named ${slug} with git_branch.
4. Implement the fix.
5. Run the tests/build and iterate until they pass.
6. Summarize the diff (git_diff) for me.
7. Then commit with a clear message referencing #${num} (git_commit), push (git_push), and open a pull request (github_create_pull_request) whose body explains the change and how it was tested. Each of these steps requires my approval.`);
	}

	private async reviewPR(n?: GhNode): Promise<void> {
		const num = await this.issueNumber(n);
		if (!num) return;
		const r = await this.gh.requireRepo();
		const diff = await this.gh.request<string>('GET', `/repos/${r.owner}/${r.repo}/pulls/${num}`, undefined, 'application/vnd.github.diff');
		const pr = await this.gh.request('GET', `/repos/${r.owner}/${r.repo}/pulls/${num}`);
		this.startAgent('reviewer', `Review pull request #${num} "${pr.title}" by ${pr.user?.login}.\n\nDescription:\n${pr.body ?? '(none)'}\n\nDiff:\n\`\`\`diff\n${truncateMiddle(diff, 30_000).text}\n\`\`\``);
	}

	private async createPR(): Promise<void> {
		const root = this.s.root;
		if (!root) throw new Error('Open a folder first.');
		const r = await this.gh.requireRepo();
		const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
		const repo = await this.gh.request('GET', `/repos/${r.owner}/${r.repo}`);
		if (branch === repo.default_branch) throw new Error(`You are on the default branch (${branch}). Create a feature branch first.`);
		const upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{u}']);
		if (upstream.code !== 0) {
			const ok = await vscode.window.showInformationMessage(`Branch "${branch}" is not on GitHub yet. Push it?`, { modal: true }, 'Push');
			if (!ok) return;
			const p = await git(root, ['push', '-u', 'origin', branch]);
			if (p.code !== 0) throw new Error(`push failed: ${p.stderr}`);
		}
		const log = (await git(root, ['log', `origin/${repo.default_branch}..HEAD`, '--pretty=format:%s%n%b'])).stdout;
		const diff = (await git(root, ['diff', `origin/${repo.default_branch}...HEAD`, '--stat', '--patch'])).stdout;
		let title = log.split('\n')[0] || branch;
		let body = '';
		const useAi = await vscode.window.showQuickPick(['Generate title and description with AI', 'Write it myself'], { placeHolder: 'Pull request description' });
		if (!useAi) return;
		if (useAi.startsWith('Generate')) {
			const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AIDE: writing PR description...' }, () =>
				this.s.client.complete('commit_message', 'You write GitHub pull request descriptions. First line: a concise title (no prefix). Then a blank line, then Markdown with sections "## Summary", "## Changes", "## Testing". Be factual; do not invent tests that were not run.', `Commits:\n${log}\n\nDiff:\n${truncateMiddle(diff, 20_000).text}`, new AbortController().signal, 'github:pr-description'),
			);
			const lines = text.trim().split('\n');
			title = lines[0].replace(/^#+\s*/, '').replace(/^title:\s*/i, '');
			body = lines.slice(1).join('\n').trim();
		}
		title = (await vscode.window.showInputBox({ prompt: 'Pull request title', value: title })) ?? '';
		if (!title) return;
		const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
		await vscode.window.showTextDocument(doc, { preview: false });
		const ok = await vscode.window.showInformationMessage(`Create pull request "${title}" from ${branch} into ${repo.default_branch}? (Edit the description in the open editor first.)`, { modal: true }, 'Create PR', 'Create draft PR');
		if (!ok) return;
		const pr = await this.gh.request('POST', `/repos/${r.owner}/${r.repo}/pulls`, { title, body: doc.getText(), head: branch, base: repo.default_branch, draft: ok === 'Create draft PR' });
		void vscode.window.showInformationMessage(`Created PR #${pr.number}`, 'Open').then(p => p && vscode.env.openExternal(vscode.Uri.parse(pr.html_url)));
		this.emitter.fire();
	}
}
