/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AgentGroupManager, AgentGroup } from '../agents/group-manager';

export class AgentGroupPanel implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _groupManager: AgentGroupManager
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'saveGroup':
                    await this._groupManager.createGroup(data.group);
                    this._updateWebview();
                    break;
                case 'deleteGroup':
                    await this._groupManager.deleteGroup(data.name);
                    this._updateWebview();
                    break;
                case 'setActive':
                    await this._groupManager.setActiveGroup(data.name);
                    this._updateWebview();
                    break;
                case 'ready':
                    this._updateWebview();
                    break;
            }
        });

        this._updateWebview();
    }

    private _updateWebview() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'update',
                groups: this._groupManager.getGroups(),
                active: this._groupManager.getActiveGroup()?.name
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    :root {
                        --accent: var(--vscode-button-background);
                        --accent-hover: var(--vscode-button-hoverBackground);
                        --card-bg: var(--vscode-sideBar-background);
                        --border: var(--vscode-panel-border);
                    }
                    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
                    .header { font-size: 11px; font-weight: bold; text-transform: uppercase; margin-bottom: 15px; opacity: 0.7; letter-spacing: 0.5px; }
                    .group-card {
                        background: var(--card-bg);
                        border: 1px solid var(--border);
                        border-radius: 6px; padding: 12px; margin-bottom: 12px;
                        transition: all 0.2s ease;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .group-card:hover { border-color: var(--accent); transform: translateY(-1px); }
                    .active { border-left: 4px solid var(--accent); border-color: var(--border); }
                    .group-name { font-weight: 600; margin-bottom: 4px; font-size: 14px; color: var(--vscode-settings-headerForeground); }
                    .group-desc { font-size: 11px; opacity: 0.7; margin-bottom: 8px; font-style: italic; }
                    .agent-tag {
                        display: inline-block; padding: 2px 6px; background: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground); border-radius: 10px; font-size: 9px; margin-right: 4px;
                    }
                    .controls { display: flex; gap: 8px; margin-top: 12px; }
                    button {
                        background: var(--accent); color: var(--vscode-button-foreground);
                        border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;
                        font-size: 12px; font-weight: 500; flex: 1; transition: opacity 0.2s;
                    }
                    button:hover { background: var(--accent-hover); }
                    .delete-btn { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
                    .delete-btn:hover { background: var(--vscode-errorForeground); color: white; }
                    .add-btn { width: 100%; margin-top: 5px; padding: 10px; font-weight: bold; background: var(--vscode-statusBarItem-remoteBackground); }
                </style>
            </head>
            <body>
                <div class="header">Your Agent Teams</div>
                <div id="groups-list"></div>
                <button class="add-btn" onclick="showAddModal()">+ Create New Team</button>

                <div id="modal" class="modal">
                    <div class="modal-content">
                        <h3>Create Group</h3>
                        <input id="name-input" placeholder="Group Name">
                        <div id="agents-config">
                            <div class="agent-entry">
                                <input placeholder="Agent Name (e.g. Coder)">
                                <input placeholder="Role (e.g. Logic implementation)">
                                <select>
                                    <option value="openai">OpenAI</option>
                                    <option value="ollama">Ollama</option>
                                    <option value="anthropic">Anthropic</option>
                                </select>
                            </div>
                        </div>
                        <div class="controls">
                            <button onclick="saveGroup()">Save</button>
                            <button onclick="closeModal()">Cancel</button>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'update') {
                            renderGroups(message.groups, message.active);
                        }
                    });

                    // Signal that the webview is ready
                    vscode.postMessage({ type: 'ready' });

                    function renderGroups(groups, active) {
                        const list = document.getElementById('groups-list');
                        list.innerHTML = groups.map(g => \`
                            <div class="group-card \${g.name === active ? 'active' : ''}">
                                <div class="group-name">\${g.name}</div>
                                <div class="agent-count">\${g.agents.length} Agents</div>
                                <div class="controls">
                                    <button onclick="setActive('\${g.name}')">Activate</button>
                                    <button class="delete-btn" onclick="deleteGroup('\${g.name}')">Delete</button>
                                </div>
                            </div>
                        \`).join('');
                    }

                    function showAddModal() { document.getElementById('modal').style.display = 'block'; }
                    function closeModal() { document.getElementById('modal').style.display = 'none'; }

                    function setActive(name) { vscode.postMessage({ type: 'setActive', name }); }
                    function deleteGroup(name) { vscode.postMessage({ type: 'deleteGroup', name }); }

                    function saveGroup() {
                        const name = document.getElementById('name-input').value;
                        // Simplified for now, just creating a basic group
                        vscode.postMessage({
                            type: 'saveGroup',
                            group: {
                                name,
                                agents: [{ name: 'Coder', role: 'Coding', provider: 'openai', model: 'gpt-4' }]
                            }
                        });
                        closeModal();
                    }
                </script>
            </body>
            </html>`;
    }
}
