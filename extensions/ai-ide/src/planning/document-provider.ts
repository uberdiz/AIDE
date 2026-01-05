/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export class PlanningDocumentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private plans = new Map<string, string>();

    constructor(private context: vscode.ExtensionContext) { }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.plans.get(uri.path) || '';
    }

    async createPlan(content: string): Promise<vscode.Uri> {
        const planId = `plan-${Date.now()}`;
        const uri = vscode.Uri.parse(`ai-plan:/${planId}.md`);
        this.plans.set(uri.path, content);

        // Open in editor
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });

        return uri;
    }

    async getUserEditedPlan(uri: vscode.Uri): Promise<string> {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        return doc?.getText() || this.plans.get(uri.path) || '';
    }

    updatePlan(uri: vscode.Uri, content: string): void {
        this.plans.set(uri.path, content);
        this._onDidChange.fire(uri);
    }
}
