/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export class SessionManager {
    constructor(private context: vscode.ExtensionContext) { }

    async saveSession(): Promise<void> {
        const session = {
            openFiles: this.getOpenFiles(),
            timestamp: Date.now()
        };

        await this.context.workspaceState.update('ai-ide.session', session);
    }

    async restoreSession(): Promise<void> {
        // Restore workspace folder if needed
        const lastFolder = this.context.globalState.get<string>('lastWorkspaceFolder');
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const isIdeRoot = currentFolder &&
            vscode.workspace.asRelativePath('product.json') === 'product.json' &&
            vscode.workspace.asRelativePath('START_HERE.md') === 'START_HERE.md';

        if (lastFolder && (!currentFolder || isIdeRoot) && lastFolder !== currentFolder) {
            const uri = vscode.Uri.file(lastFolder);
            await vscode.commands.executeCommand('vscode.openFolder', uri);
            return; // Extension will restart in the new folder
        }

        const session = this.context.globalState.get<any>('ai-ide.session');
        if (!session) {
            return;
        }

        // Restore open files
        for (const filePath of session.openFiles || []) {
            try {
                const uri = vscode.Uri.file(filePath);
                await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
            } catch {
                // File might not exist anymore
            }
        }
    }

    private getOpenFiles(): string[] {
        return vscode.window.visibleTextEditors
            .map(editor => editor.document.uri.fsPath)
            .filter(path => !path.startsWith('ai-')); // Exclude virtual docs
    }
}
