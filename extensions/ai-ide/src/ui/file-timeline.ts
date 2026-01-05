/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export interface TimelineItem extends vscode.TreeItem {
    resourceUri?: vscode.Uri;
}

export class FileTimelineProvider implements vscode.TreeDataProvider<TimelineItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TimelineItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private fileHistory = new Map<string, Array<{ timestamp: Date; description: string }>>();

    constructor(private context: vscode.ExtensionContext) { }

    recordFileChange(file: string, description: string): void {
        if (!this.fileHistory.has(file)) {
            this.fileHistory.set(file, []);
        }

        this.fileHistory.get(file)!.push({
            timestamp: new Date(),
            description
        });

        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TimelineItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TimelineItem): TimelineItem[] {
        if (!element) {
            // Root: show all files with changes
            return Array.from(this.fileHistory.keys()).map(file => ({
                label: file,
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                contextValue: 'file',
                resourceUri: vscode.Uri.file(file),
                tooltip: `${this.fileHistory.get(file)!.length} changes`
            }));
        } else if (element.resourceUri) {
            // Show changes for this file
            const file = element.resourceUri.fsPath;
            const changes = this.fileHistory.get(file) || [];

            return changes.map(change => ({
                label: change.timestamp.toLocaleString(),
                description: change.description,
                collapsibleState: vscode.TreeItemCollapsibleState.None,
                contextValue: 'change'
            }));
        }

        return [];
    }
}
