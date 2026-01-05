/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AIChatPanel } from './chat-panel';

export class SelectionContextProvider {
    private disposables: vscode.Disposable[] = [];

    constructor(
        private context: vscode.ExtensionContext,
        private chatPanel: AIChatPanel
    ) { }

    activate(): void {
        // Selection context provider activated
    }

    async addCurrentSelectionToChat(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
        // 1. Check if called from Explorer (Uri/Uris provided)
        if (uri || (uris && uris.length > 0)) {
            const targets = uris && uris.length > 0 ? uris : [uri!];
            let contextText = '\n\n**Added from Explorer:**\n';
            
            for (const target of targets) {
                try {
                    const stats = await vscode.workspace.fs.stat(target);
                    const isDirectory = stats.type === vscode.FileType.Directory;
                    const relativePath = vscode.workspace.asRelativePath(target);
                    
                    if (isDirectory) {
                        contextText += `- Directory: \`${relativePath}/\`\n`;
                    } else {
                        const doc = await vscode.workspace.openTextDocument(target);
                        const text = doc.getText();
                        const lang = doc.languageId;
                        contextText += `\nFile: \`${relativePath}\`\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
                    }
                } catch (err) {
                    console.error(`Failed to add ${target.fsPath} to chat:`, err);
                }
            }
            
            this.chatPanel.appendToInput(contextText);
            this.chatPanel.focus();
            return;
        }

        // 2. Check for Terminal selection
        const activeTerminal = vscode.window.activeTerminal;
        if (activeTerminal) {
            // We can't directly get selection, but we can try to copy it
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            const clipboardText = await vscode.env.clipboard.readText();
            if (clipboardText) {
                // Heuristic: check if this clipboard text was likely from terminal
                // (VS Code doesn't tell us if copySelection succeeded or if the text is from terminal)
                // For now, we'll assume if there's an active terminal and we just ran copySelection,
                // the user might want that. But we should probably only do this if there's NO editor selection.
            }
        }

        // 3. Check for Editor selection
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            const language = editor.document.languageId;
            const file = vscode.workspace.asRelativePath(editor.document.uri);

            const formatted = `\n\n\`\`\`${language}\n${text}\n\`\`\`\n*From: ${file}*\n\n`;

            this.chatPanel.appendToInput(formatted);
            this.chatPanel.focus();
            return;
        }

        // 4. Fallback: If terminal had something, use it
        const clipboardText = await vscode.env.clipboard.readText();
        if (clipboardText) {
            const formatted = `\n\n**From Terminal/Selection:**\n\`\`\`text\n${clipboardText}\n\`\`\`\n\n`;
            this.chatPanel.appendToInput(formatted);
            this.chatPanel.focus();
            return;
        }

        vscode.window.showInformationMessage('No selection or file found to add to chat');
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
