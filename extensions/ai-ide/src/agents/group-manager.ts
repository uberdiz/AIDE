/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AgentConfig } from './base-agent';

export interface AgentGroup {
    name: string;
    description?: string;
    agents: AgentConfig[];
    defaultAgent?: string;
}

export class AgentGroupManager {
    private groups: AgentGroup[] = [];
    private activeGroup: AgentGroup | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.loadGroups();
        // Restore active group from workspaceState
        const savedGroupName = this.context.workspaceState.get<string>('activeGroupName');
        if (savedGroupName) {
            const found = this.groups.find(g => g.name === savedGroupName);
            if (found) {
                this.activeGroup = found;
            }
        }

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ai-ide.agentGroups')) {
                this.loadGroups();
                vscode.commands.executeCommand('ai-ide.groupsUpdated');
            }
        });
    }

    private loadGroups(): void {
        const config = vscode.workspace.getConfiguration('ai-ide');
        const inspection = config.inspect<AgentGroup[]>('agentGroups');

        const globalGroups = inspection?.globalValue || [];
        const workspaceGroups = inspection?.workspaceValue || [];

        // Merge groups, workspace groups override global groups with same name
        const mergedGroups = [...globalGroups];
        workspaceGroups.forEach(wg => {
            const index = mergedGroups.findIndex(gg => gg.name === wg.name);
            if (index !== -1) {
                mergedGroups[index] = wg;
            } else {
                mergedGroups.push(wg);
            }
        });

        this.groups = mergedGroups.filter(g => g && g.name && typeof g.name === 'string');

        // If no groups exist in any scope, create default
        if (this.groups.length === 0) {
            this.groups = [this.createDefaultGroup()];
            config.update('agentGroups', this.groups, vscode.ConfigurationTarget.Global);
        }

        // Ensure active group is still valid after reload
        if (this.activeGroup) {
            const found = this.groups.find(g => g.name === this.activeGroup?.name);
            if (found) {
                this.activeGroup = found;
            } else if (this.groups.length > 0) {
                this.activeGroup = this.groups[0];
            } else {
                this.activeGroup = null;
            }
        } else if (this.groups.length > 0) {
            this.activeGroup = this.groups[0];
        }
    }

    private createDefaultGroup(): AgentGroup {
        return {
            name: 'Default',
            description: 'Default agent group with basic agents',
            agents: [
                {
                    name: 'planner',
                    role: 'Planning and task breakdown',
                    provider: 'openai',
                    model: 'gpt-4',
                    settings: {
                        temperature: 0.7,
                        maxTokens: 4000,
                        systemPrompt: 'You are an expert software architect. Your role is to analyze requests, create high-level architectural plans, and summarize technical work. DO NOT write code implementation unless explicitly asked for a brief snippet. Focus on strategy and overview.'
                    }
                },
                {
                    name: 'coder',
                    role: 'Code implementation',
                    provider: 'openai',
                    model: 'gpt-4',
                    settings: {
                        temperature: 0.3,
                        maxTokens: 4000,
                        systemPrompt: 'You are an expert programmer. Your role is strictly to implement code and provide SEARCH/REPLACE patches. Output ONLY code blocks and file paths as requested. Avoid conversational filler and explanations.'
                    }
                },
                {
                    name: 'tester',
                    role: 'Testing and quality assurance',
                    provider: 'openai',
                    model: 'gpt-4',
                    settings: {
                        temperature: 0.2,
                        maxTokens: 2000,
                        systemPrompt: 'You are a QA expert. Write comprehensive tests and identify edge cases.'
                    }
                }
            ]
        };
    }

    async createGroup(group: AgentGroup): Promise<void> {
        const index = this.groups.findIndex(g => g.name === group.name);
        if (index !== -1) {
            this.groups[index] = group;
        } else {
            this.groups.push(group);
        }
        await this.saveGroups();

        if (this.activeGroup?.name === group.name) {
            this.activeGroup = group;
        }
    }

    async updateGroup(name: string, updates: Partial<AgentGroup>): Promise<void> {
        const index = this.groups.findIndex(g => g.name === name);
        if (index === -1) {
            throw new Error(`Group "${name}" not found`);
        }

        this.groups[index] = { ...this.groups[index], ...updates };
        await this.saveGroups();
    }

    async deleteGroup(name: string): Promise<void> {
        const index = this.groups.findIndex(g => g.name === name);
        if (index === -1) {
            throw new Error(`Group "${name}" not found`);
        }

        this.groups.splice(index, 1);
        await this.saveGroups();

        if (this.activeGroup?.name === name) {
            this.activeGroup = null;
        }
    }

    public async setActiveGroup(name: string): Promise<void> {
        const group = this.groups.find(g => g.name === name);
        if (group) {
            this.activeGroup = group;
            await this.context.workspaceState.update('activeGroupName', name);
        }
    }

    async loadOnStartup(): Promise<void> {
        // Ensure groups are loaded first
        this.loadGroups();

        const lastGroupName = this.context.workspaceState.get<string>('lastAgentGroup');
        if (lastGroupName) {
            const group = this.groups.find(g => g.name === lastGroupName);
            if (group) {
                this.activeGroup = group;
            }
        }

        // Default to "Default" group if no active group or last group no longer exists
        if (!this.activeGroup) {
            const defaultGroup = this.groups.find(g => g.name === 'Default');
            if (defaultGroup) {
                this.activeGroup = defaultGroup;
            } else if (this.groups.length > 0) {
                this.activeGroup = this.groups[0];
            }
        }

        console.log(`AgentGroupManager: Startup complete. Active group: ${this.activeGroup?.name || 'None'}`);
        vscode.commands.executeCommand('ai-ide.groupsUpdated');
    }

    private async saveGroups(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-ide');
        await config.update('agentGroups', this.groups, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('ai-ide.groupsUpdated');
    }

    getGroups(): AgentGroup[] {
        return this.groups;
    }

    getActiveGroup(): AgentGroup | null {
        return this.activeGroup;
    }

    showManagementPanel(): void {
        vscode.commands.executeCommand('ai-agent-manager-gui.focus');
    }
}
