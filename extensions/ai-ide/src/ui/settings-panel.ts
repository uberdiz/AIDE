/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AgentGroupManager, AgentGroup } from '../agents/group-manager';
import axios from 'axios';

export class AISettingsPanel implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
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
                case 'saveKey':
                    await this._context.secrets.store(data.provider, data.key);
                    vscode.window.showInformationMessage(`API Key for ${data.provider} saved securely.`);
                    break;
                case 'updateSetting':
                    const config = vscode.workspace.getConfiguration('ai-ide');
                    await config.update(data.key, data.value, vscode.ConfigurationTarget.Global);
                    break;
                case 'saveGroup':
                    await this._groupManager.createGroup(data.group);
                    vscode.window.showInformationMessage(`Agent group "${data.group.name}" saved.`);
                    this._syncGroups();
                    vscode.commands.executeCommand('ai-ide.groupsUpdated');
                    break;
                case 'deleteGroup':
                    await this._groupManager.deleteGroup(data.name);
                    vscode.window.showInformationMessage(`Agent group "${data.name}" deleted.`);
                    this._syncGroups();
                    vscode.commands.executeCommand('ai-ide.groupsUpdated');
                    break;
                case 'getOllamaModels':
                    this._fetchOllamaModels();
                    break;
                case 'pullOllamaModel':
                    this._pullOllamaModel(data.model);
                    break;
                case 'deleteOllamaModel':
                    this._deleteOllamaModel(data.model);
                    break;
                case 'optimizePrompt':
                    this._optimizeAgentPrompt(data.prompt, data.agentId);
                    break;
                case 'ready':
                    this._syncGroups();
                    break;
            }
        });

        // Initial sync
        this._syncGroups();
    }

    private async _optimizeAgentPrompt(prompt: string, agentId: string) {
        try {
            const orchestrator = (this._context as any).orchestrator; // We need to expose orchestrator or use a specific agent
            if (!prompt) {return;}

            const optimizationPrompt = `REWRITE THIS SYSTEM PROMPT TO BE CLEAR, CONCISE, AND HIGHLY EFFECTIVE FOR AN AI AGENT.
Your goal is to ensure the agent understands its specific role, constraints, and output format perfectly.
Output ONLY the optimized prompt.

Original Prompt:
${prompt}`;

            // Find a suitable agent for optimization (prefer coder or planner)
            const activeGroup = this._groupManager.getActiveGroup();
            const optimizerAgentConfig = activeGroup?.agents.find(a => a.name.toLowerCase().includes('coder') || a.name.toLowerCase().includes('planner')) || activeGroup?.agents[0];

            if (!optimizerAgentConfig) {
                vscode.window.showErrorMessage("No active agent available to optimize prompt.");
                return;
            }

            // We need an agent instance. Since we don't have direct access to the Agent class here easily,
            // we'll send a message to the orchestrator via a command or internal event.
            // For now, let's assume we can trigger a command that returns the result.
            vscode.commands.executeCommand('ai-ide.optimizeSystemPrompt', optimizationPrompt).then((optimized: any) => {
                if (optimized) {
                    this._view?.webview.postMessage({ type: 'optimizedPrompt', prompt: optimized, agentId });
                }
            });

        } catch (error) {
            console.error('Prompt optimization failed:', error);
        }
    }

    private async _syncGroups() {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('ai-ide');

            // Check for saved API keys
            const customProviders = config.get<any[]>('customProviders', []);
            const providers = ['openai', 'anthropic', 'google', 'huggingface', ...customProviders.map(p => p.name)];
            const savedKeys: { [key: string]: boolean } = {};

            for (const p of providers) {
                const key = await this._context.secrets.get(p);
                savedKeys[p] = !!key;
            }

            this._view.webview.postMessage({
                type: 'syncGroups',
                groups: this._groupManager.getGroups(),
                customProviders,
                savedKeys
            });
        }
    }

    private async _fetchOllamaModels() {
        try {
            const response = await axios.get('http://localhost:11434/api/tags');
            const models = response.data.models.map((m: any) => m.name);
            this._view?.webview.postMessage({ type: 'ollamaModels', models });
        } catch (e) {
            console.error('Ollama not running or unreachable');
            this._view?.webview.postMessage({ type: 'ollamaModels', models: [], error: 'Ollama unreachable' });
        }
    }

    private async _pullOllamaModel(model: string) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Pulling Ollama model: ${model}`,
            cancellable: false
        }, async (progress) => {
            try {
                await axios.post('http://localhost:11434/api/pull', { name: model });
                vscode.window.showInformationMessage(`Model ${model} pulled successfully.`);
                this._fetchOllamaModels();
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to pull model ${model}.`);
            }
        });
    }

    private async _deleteOllamaModel(model: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete local model "${model}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            try {
                await axios.delete('http://localhost:11434/api/delete', { data: { name: model } });
                vscode.window.showInformationMessage(`Model ${model} deleted.`);
                this._fetchOllamaModels();
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to delete model ${model}.`);
            }
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
            --border: var(--vscode-panel-border);
            --bg: var(--vscode-editor-background);
            --card-bg: var(--vscode-sideBar-background);
        }
        body { font-family: var(--vscode-font-family); padding: 15px; color: var(--vscode-foreground); background: var(--bg); font-size: 13px; }
        .section { margin-bottom: 25px; background: var(--card-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 4px 10px rgba(0,0,0,0.2); }
        .section-title {
            font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
            margin-bottom: 20px; display: flex; align-items: center; gap: 8px;
            color: var(--vscode-descriptionForeground);
        }
        .field { margin-bottom: 15px; }
        label { display: block; font-size: 11px; margin-bottom: 6px; opacity: 0.7; font-weight: 600; }
        input, select {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            width: 100%; padding: 8px; border-radius: 4px; box-sizing: border-box;
        }
        .scroll-window {
            max-height: 120px; overflow-y: auto; border: 1px solid var(--border);
            padding: 5px; border-radius: 4px; background: rgba(0,0,0,0.1); margin-top: 5px;
        }
        .model-tag {
            padding: 4px 8px; margin: 2px; background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground); border-radius: 10px; display: inline-block;
            font-size: 10px; cursor: pointer;
        }
        .model-tag:hover { opacity: 0.8; }
        button {
            background: var(--accent); color: var(--vscode-button-foreground);
            border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer;
            font-weight: 600; transition: filter 0.2s;
        }
        button:hover { filter: brightness(1.2); }
        .secondary-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .agent-card {
            border: 1px solid var(--border); padding: 12px; margin-top: 10px;
            border-radius: 6px; position: relative; background: rgba(255,255,255,0.02);
        }
        .remove-agent {
            position: absolute; top: 5px; right: 5px;
            width: 24px; height: 24px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; opacity: 0.5; border-radius: 50%;
            transition: all 0.2s;
        }
        .remove-agent:hover {
            opacity: 1;
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-errorForeground);
        }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .full-span { grid-column: span 2; }
        .provider-entry { display: flex; gap: 5px; margin-bottom: 5px; align-items: center; }
        .api-key-item { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; }
        .api-key-status { font-size: 10px; padding: 2px 6px; border-radius: 10px; }
        .status-saved { background: #28a745; color: white; }
        .status-missing { background: #dc3545; color: white; }
        .input-with-icon { position: relative; flex: 1; display: flex; align-items: center; }
        .input-with-icon input { padding-right: 30px; }
        .input-icon { position: absolute; right: 8px; cursor: pointer; opacity: 0.6; font-size: 14px; user-select: none; }
        .input-icon:hover { opacity: 1; }
        .model-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; margin: 2px 0; background: rgba(255,255,255,0.05); border-radius: 4px; }
        .model-name { font-size: 11px; }
        .model-actions { display: flex; gap: 8px; }
        .delete-icon { cursor: pointer; opacity: 0.5; transition: opacity 0.2s; }
        .delete-icon:hover { opacity: 1; color: var(--vscode-errorForeground); }
    </style>
</head>
<body>
    <div class="section">
        <div class="section-title">🔌 Provider Manager</div>
        <div id="provider-list">
            <div class="field">
                <label>Cloud API Keys</label>
                <div id="api-keys-list">
                    <!-- API keys will be listed here -->
                </div>
            </div>
            <div class="field">
                <label>Ollama (Local Models)</label>
                <div class="scroll-window" id="ollama-models-container" style="max-height: 200px;">
                    <div id="ollama-models">Loading local models...</div>
                </div>
                <div class="grid" style="margin-top:10px">
                    <input id="pull-model" placeholder="Model name (e.g. qwen2.5)">
                    <button onclick="pullModel()">Pull Model</button>
                </div>
            </div>
            <div class="field">
                <label>Custom Providers</label>
                <div id="custom-providers-list"></div>
                <div class="provider-entry" style="margin-top:10px">
                    <input id="new-provider-name" placeholder="Name (e.g. LocalLLM)" style="flex:1">
                    <input id="new-provider-url" placeholder="API URL" style="flex:2">
                    <button onclick="addCustomProvider()">Add</button>
                </div>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">👥 Agent Group Builder</div>
        <div class="field">
            <label>Edit Existing Group</label>
            <select id="groups-dropdown" onchange="loadGroupToEdit(this.value)">
                <option value="">-- New Group --</option>
            </select>
        </div>
        <div class="field">
            <label>Group Name</label>
            <input id="group-name" placeholder="e.g. Turbo Team">
        </div>

        <div id="agents-container">
            <!-- Agent cards will be added here -->
        </div>

        <button class="secondary-btn" style="width:100%; margin-top:10px;" onclick="addAgentRow()">+ Add Agent to Team</button>
        <button style="width:100%; margin-top:10px;" onclick="saveFinalGroup()">Save Agent Group</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let savedGroups = [];
        let customProviders = [];
        let savedKeys = {};

        function saveKey(provider) {
            const inputId = \`key-\${provider}\`;
            const key = document.getElementById(inputId).value;
            if (key) {
                vscode.postMessage({ type: 'saveKey', provider, key });
                document.getElementById(inputId).value = '';
            }
        }

        function toggleVisibility(provider) {
            const input = document.getElementById(\`key-\${provider}\`);
            const icon = input.nextElementSibling;
            if (input.type === 'password') {
                input.type = 'text';
                icon.innerText = '👁️‍🗨️';
            } else {
                input.type = 'password';
                icon.innerText = '👁️';
            }
        }

        function deleteModel(model) {
            vscode.postMessage({ type: 'deleteOllamaModel', model });
        }

        function renderApiKeys() {
            const container = document.getElementById('api-keys-list');
            const standardProviders = [
                { id: 'openai', name: 'OpenAI' },
                { id: 'anthropic', name: 'Anthropic' },
                { id: 'google', name: 'Google (Gemini)' },
                { id: 'huggingface', name: 'HuggingFace' }
            ];

            const allProviders = [
                ...standardProviders,
                ...customProviders.map(p => ({ id: p.name, name: p.name }))
            ];

            container.innerHTML = allProviders.map(p => \`
                <div class="api-key-item">
                    <div style="flex:1">
                        <div style="display:flex; align-items:center; gap:8px">
                            <span style="font-weight:600">\${p.name}</span>
                            <span class="api-key-status \${savedKeys[p.id] ? 'status-saved' : 'status-missing'}">
                                \${savedKeys[p.id] ? '✓ Saved' : '✗ Missing'}
                            </span>
                        </div>
                    </div>
                    <div class="input-with-icon">
                        <input type="password" id="key-\${p.id}" placeholder="\${savedKeys[p.id] ? '••••••••••••' : 'Enter API Key...'}">
                        <span class="input-icon" onclick="toggleVisibility('\${p.id}')">👁️</span>
                    </div>
                    <button style="padding: 4px 8px; font-size: 11px;" onclick="saveKey('\${p.id}')">Update</button>
                </div>
            \`).join('');
        }

        function addCustomProvider() {
            const name = document.getElementById('new-provider-name').value;
            const url = document.getElementById('new-provider-url').value;
            if (name && url) {
                const updated = [...customProviders, { name, url }];
                vscode.postMessage({ type: 'updateSetting', key: 'customProviders', value: updated });
                document.getElementById('new-provider-name').value = '';
                document.getElementById('new-provider-url').value = '';
            }
        }

        function deleteCustomProvider(name) {
            const updated = customProviders.filter(p => p.name !== name);
            vscode.postMessage({ type: 'updateSetting', key: 'customProviders', value: updated });
        }

        function pullModel() {
            const model = document.getElementById('pull-model').value;
            if (model) vscode.postMessage({ type: 'pullOllamaModel', model });
        }

        function addAgentRow(data = null) {
            const container = document.getElementById('agents-container');
            const div = document.createElement('div');
            div.className = 'agent-card';

            let providerOptions = \`
            <option value="openai" \${data?.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
            <option value="ollama" \${data?.provider === 'ollama' ? 'selected' : ''}>Ollama</option>
            <option value="anthropic" \${data?.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
            <option value="google" \${data?.provider === 'google' ? 'selected' : ''}>Google</option>\`;

            customProviders.forEach(p => {
                const isSelected = (data?.provider === 'custom' && data?.settings?.apiUrl === p.url) ? 'selected' : '';
                providerOptions += \`<option value="\${p.name}" \${isSelected}>\${p.name}</option>\`;
            });

            div.innerHTML = \`
                <div class="remove-agent" title="Remove Agent" onclick="this.parentElement.remove()">×</div>
                <div class="grid">
                    <div>
                        <label>Role</label>
                        <input class="a-role" value="\${data?.role || 'Coder'}">
                    </div>
                    <div>
                        <label>Provider</label>
                        <select class="a-provider" onchange="const gpuField = this.parentElement.parentElement.querySelector('.gpu-field'); gpuField.style.display = this.value === 'ollama' ? 'block' : 'none';">\${providerOptions}</select>
                    </div>
                    <div class="full-span gpu-field" style="display: \${data?.provider === 'ollama' ? 'block' : 'none'}">
                        <label style="display:flex; align-items:center; gap:5px; cursor:pointer">
                            <input type="checkbox" class="a-gpu" \${data?.settings?.useGpu ? 'checked' : ''} style="width:auto; margin:0">
                            Enable GPU Acceleration (CUDA)
                        </label>
                    </div>
                    <div class="full-span">
                        <label>Model Name (Recommended or Custom)</label>
                        <input class="a-model" value="\${data?.model || 'gpt-4o'}" placeholder="e.g. gpt-4o or llama3">
                    </div>
                    <div class="full-span" style="margin-top:8px;">
                        <div style="display:flex; gap:5px;">
                            <button class="secondary-btn" style="flex:1; font-size:10px; padding:4px;" onclick="togglePrompt(this)">📝 Edit System Prompt</button>
                            <button class="secondary-btn" style="flex:1; font-size:10px; padding:4px;" onclick="optimizeAgentPrompt(this)">✨ Optimize Prompt</button>
                        </div>
                        <textarea class="a-system-prompt" style="display:none; width:100%; margin-top:5px; height:80px; font-size:11px;" placeholder="Enter system prompt for this agent...">\${data?.settings?.systemPrompt || ''}</textarea>
                    </div>
                </div>\`;
            container.appendChild(div);
        }

        function togglePrompt(btn) {
            const textarea = btn.parentElement.nextElementSibling;
            textarea.style.display = textarea.style.display === 'none' ? 'block' : 'none';
            btn.innerText = textarea.style.display === 'none' ? '📝 Edit System Prompt' : '✅ Close Prompt Editor';
        }

        function optimizeAgentPrompt(btn) {
            const card = btn.closest('.agent-card');
            const textarea = card.querySelector('.a-system-prompt');
            const prompt = textarea.value;
            const agentId = Math.random().toString(36).substring(7);
            card.dataset.agentId = agentId;

            if (!prompt) {
                alert("Please enter a prompt to optimize.");
                return;
            }

            btn.innerText = "✨ Optimizing...";
            btn.disabled = true;
            vscode.postMessage({ type: 'optimizePrompt', prompt, agentId });
        }

        function saveFinalGroup() {
            const name = document.getElementById('group-name').value;
            const agentDivs = document.querySelectorAll('.agent-card');
            const agents = [];
            agentDivs.forEach(div => {
                const providerVal = div.querySelector('.a-provider').value;
                const custom = customProviders.find(p => p.name === providerVal);
                const systemPrompt = div.querySelector('.a-system-prompt').value;

                agents.push({
                    name: div.querySelector('.a-role').value,
                    role: div.querySelector('.a-role').value,
                    provider: custom ? 'custom' : providerVal,
                    model: div.querySelector('.a-model').value,
                    settings: {
                        ...(custom ? { apiUrl: custom.url } : {}),
                        useGpu: div.querySelector('.a-gpu')?.checked || false,
                        systemPrompt: systemPrompt
                    }
                });
            });
            if (name && agents.length > 0) {
                vscode.postMessage({ type: 'saveGroup', group: { name, agents } });
            }
        }

        function loadGroupToEdit(name) {
            const group = savedGroups.find(g => g.name === name);
            document.getElementById('group-name').value = name || '';
            const container = document.getElementById('agents-container');
            container.innerHTML = '';
            if (group && group.agents && group.agents.length > 0) {
                group.agents.forEach(a => addAgentRow(a));
            } else {
                addAgentRow();
            }
        }

        function renderCustomProviders() {
            const list = document.getElementById('custom-providers-list');
            let html = '';
            customProviders.forEach(p => {
                html += \`
                <div class="provider-entry">
                    <span style="flex:1; font-weight:600">\${p.name}</span>
                    <span style="flex:2; opacity:0.6; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">\${p.url}</span>
                    <span style="cursor:pointer; padding: 0 5px" onclick="deleteCustomProvider('\${p.name}')">🗑️</span>
                </div>\`;
            });
            list.innerHTML = html;
        }

        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.type === 'syncGroups') {
                savedGroups = msg.groups;
                customProviders = msg.customProviders || [];
                savedKeys = msg.savedKeys || {};
                renderCustomProviders();
                renderApiKeys();

                const dp = document.getElementById('groups-dropdown');
                const prevVal = dp.value;
                let options = '<option value="">-- New Group --</option>';
                msg.groups.forEach(g => {
                    options += \`<option value="\${g.name}" \${g.name === prevVal ? 'selected' : ''}>\${g.name}</option>\`;
                });
                dp.innerHTML = options;
            } else if (msg.type === 'ollamaModels') {
                const container = document.getElementById('ollama-models');
                if (msg.error) {
                    container.innerHTML = \`<span style="color:var(--vscode-errorForeground)">\${msg.error}</span>\`;
                    return;
                }
                if (msg.models.length === 0) {
                    container.innerHTML = 'No local models found.';
                    return;
                }
                container.innerHTML = msg.models.map(m => \`
                    <div class="model-item">
                        <span class="model-name" onclick="document.getElementById('pull-model').value='\${m}'" style="cursor:pointer">\${m}</span>
                        <div class="model-actions">
                            <span class="delete-icon" title="Delete Model" onclick="deleteModel('\${m}')">🗑️</span>
                        </div>
                    </div>
                \`).join('');
            } else if (msg.type === 'optimizedPrompt') {
                const card = document.querySelector(\`.agent-card[data-agent-id="\${msg.agentId}"]\`);
                if (card) {
                    const textarea = card.querySelector('.a-system-prompt');
                    textarea.value = msg.prompt;
                    textarea.style.display = 'block';
                    const optBtn = card.querySelectorAll('.secondary-btn')[1];
                    optBtn.innerText = "✨ Optimize Prompt";
                    optBtn.disabled = false;
                    const editBtn = card.querySelectorAll('.secondary-btn')[0];
                    editBtn.innerText = "✅ Close Prompt Editor";
                }
            }
        });

        // Request initial data
        vscode.postMessage({ type: 'ready' });
        vscode.postMessage({ type: 'getOllamaModels' });

        // Initial empty row if nothing exists
        setTimeout(() => {
            if (document.querySelectorAll('.agent-card').length === 0) {
                addAgentRow();
            }
        }, 500);

        setInterval(() => vscode.postMessage({ type: 'getOllamaModels' }), 10000);
    </script>
</body>
</html>`;
    }
}
