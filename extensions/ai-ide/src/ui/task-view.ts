/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export interface TaskItem {
    id: string;
    label: string;
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
    description?: string;
    priority?: number;
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TaskNode | undefined | null | void> = new vscode.EventEmitter<TaskNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TaskNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private tasks: TaskItem[] = [];

    constructor(private context: vscode.ExtensionContext) {
        // Load initial tasks from workspace state
        this.tasks = this.context.workspaceState.get<TaskItem[]>('ai-ide.activeTasks', []);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TaskNode): Thenable<TaskNode[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            return Promise.resolve(this.tasks.map(t => new TaskNode(
                t.label,
                t.status,
                t.id,
                t.description,
                vscode.TreeItemCollapsibleState.None
            )));
        }
    }

    async addTask(label: string, description?: string): Promise<void> {
        const newTask: TaskItem = {
            id: Date.now().toString(),
            label,
            status: 'pending',
            description
        };
        this.tasks.push(newTask);
        await this.saveTasks();
        this.refresh();
    }

    async updateTask(id: string, updates: Partial<TaskItem>): Promise<void> {
        const index = this.tasks.findIndex(t => t.id === id);
        if (index !== -1) {
            this.tasks[index] = { ...this.tasks[index], ...updates };
            await this.saveTasks();
            this.refresh();
        }
    }

    async removeTask(id: string): Promise<void> {
        const index = this.tasks.findIndex(t => t.id === id);
        if (index !== -1) {
            this.tasks.splice(index, 1);
            await this.saveTasks();
            this.refresh();
        }
    }

    async clearTasks(): Promise<void> {
        this.tasks = [];
        await this.saveTasks();
        this.refresh();
    }

    private async saveTasks(): Promise<void> {
        await this.context.workspaceState.update('ai-ide.activeTasks', this.tasks);
    }
}

class TaskNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly status: string,
        public readonly taskId: string,
        public readonly description: string | undefined,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = this.description || label;
        this.description = status;
        this.contextValue = 'task-node';

        // Pick icon based on status
        let icon = 'circle-outline';
        if (status === 'completed') {icon = 'check';}
        if (status === 'in-progress') {icon = 'sync~spin';}
        if (status === 'failed') {icon = 'error';}

        this.iconPath = new vscode.ThemeIcon(icon);
    }
}
