/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export class MentionProvider implements vscode.CompletionItemProvider {
    constructor(private context: vscode.ExtensionContext) { }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.CompletionItem[]> {
        const linePrefix = document.lineAt(position).text.substr(0, position.character);

        if (!linePrefix.endsWith('#')) {
            return [];
        }

        const items: vscode.CompletionItem[] = [];

        // Add file completions
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
        for (const file of files) {
            const item = new vscode.CompletionItem(
                vscode.workspace.asRelativePath(file),
                vscode.CompletionItemKind.File
            );
            item.insertText = `file:${vscode.workspace.asRelativePath(file)}`;
            items.push(item);
        }

        // Add terminal completion
        const terminalItem = new vscode.CompletionItem(
            'Terminal Output',
            vscode.CompletionItemKind.Snippet
        );
        terminalItem.insertText = 'terminal:last';
        terminalItem.documentation = 'Reference recent terminal output';
        items.push(terminalItem);

        return items;
    }
}
