/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'path';

export interface ProjectInfo {
    type: string;
    framework?: string;
    language: string;
    structure: {
        hasTests: boolean;
        hasConfig: boolean;
        hasDocs: boolean;
    };
    entryPoints: string[];
    configFiles: string[];
}

export class ProjectAnalyzer {
    async analyze(workspaceUri: vscode.Uri): Promise<ProjectInfo> {
        const info: ProjectInfo = {
            type: 'unknown',
            language: 'unknown',
            structure: {
                hasTests: false,
                hasConfig: false,
                hasDocs: false
            },
            entryPoints: [],
            configFiles: []
        };

        // Detect project type and language
        await this.detectProjectType(workspaceUri, info);

        // Analyze structure
        await this.analyzeStructure(workspaceUri, info);

        // Find entry points
        await this.findEntryPoints(workspaceUri, info);

        return info;
    }

    private async detectProjectType(workspaceUri: vscode.Uri, info: ProjectInfo): Promise<void> {
        // Check for Node.js/JavaScript/TypeScript
        if (await this.fileExists(workspaceUri, 'package.json')) {
            info.type = 'node';
            info.language = 'javascript';

            const packageJson = await this.readJsonFile(workspaceUri, 'package.json');
            if (packageJson) {
                // Detect framework
                const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

                if (deps['react']) {
                    info.framework = 'react';
                } else if (deps['@angular/core']) {
                    info.framework = 'angular';
                } else if (deps['vue']) {
                    info.framework = 'vue';
                } else if (deps['next']) {
                    info.framework = 'next.js';
                } else if (deps['express']) {
                    info.framework = 'express';
                } else if (deps['nest']) {
                    info.framework = 'nestjs';
                }
            }

            // Check for TypeScript
            if (await this.fileExists(workspaceUri, 'tsconfig.json')) {
                info.language = 'typescript';
            }
        }

        // Check for Python
        else if (await this.fileExists(workspaceUri, 'requirements.txt') ||
            await this.fileExists(workspaceUri, 'setup.py') ||
            await this.fileExists(workspaceUri, 'pyproject.toml')) {
            info.type = 'python';
            info.language = 'python';

            // Detect Python framework
            const requirements = await this.readTextFile(workspaceUri, 'requirements.txt');
            if (requirements) {
                if (requirements.includes('django')) {
                    info.framework = 'django';
                } else if (requirements.includes('flask')) {
                    info.framework = 'flask';
                } else if (requirements.includes('fastapi')) {
                    info.framework = 'fastapi';
                }
            }
        }

        // Check for Java
        else if (await this.fileExists(workspaceUri, 'pom.xml') ||
            await this.fileExists(workspaceUri, 'build.gradle')) {
            info.type = 'java';
            info.language = 'java';

            if (await this.fileExists(workspaceUri, 'pom.xml')) {
                info.framework = 'maven';
            } else {
                info.framework = 'gradle';
            }
        }

        // Check for .NET
        else if (await this.fileExists(workspaceUri, '*.csproj')) {
            info.type = 'dotnet';
            info.language = 'csharp';
        }

        // Check for Go
        else if (await this.fileExists(workspaceUri, 'go.mod')) {
            info.type = 'go';
            info.language = 'go';
        }

        // Check for Rust
        else if (await this.fileExists(workspaceUri, 'Cargo.toml')) {
            info.type = 'rust';
            info.language = 'rust';
        }
    }

    private async analyzeStructure(workspaceUri: vscode.Uri, info: ProjectInfo): Promise<void> {
        // Check for tests
        const testDirs = ['test', 'tests', '__tests__', 'spec'];
        for (const dir of testDirs) {
            if (await this.directoryExists(workspaceUri, dir)) {
                info.structure.hasTests = true;
                break;
            }
        }

        // Check for config files
        const configFiles = [
            '.eslintrc', '.prettierrc', 'tsconfig.json', 'jest.config.js',
            'webpack.config.js', 'vite.config.js', '.env'
        ];
        for (const file of configFiles) {
            if (await this.fileExists(workspaceUri, file)) {
                info.structure.hasConfig = true;
                info.configFiles.push(file);
            }
        }

        // Check for documentation
        const docFiles = ['README.md', 'CONTRIBUTING.md', 'docs'];
        for (const file of docFiles) {
            if (await this.fileExists(workspaceUri, file)) {
                info.structure.hasDocs = true;
                break;
            }
        }
    }

    private async findEntryPoints(workspaceUri: vscode.Uri, info: ProjectInfo): Promise<void> {
        const entryPoints: string[] = [];

        switch (info.type) {
            case 'node':
                // Check package.json main field
                const packageJson = await this.readJsonFile(workspaceUri, 'package.json');
                if (packageJson?.main) {
                    entryPoints.push(packageJson.main);
                }

                // Common entry points
                const nodeEntries = ['index.js', 'index.ts', 'src/index.ts', 'src/main.ts', 'app.js', 'server.js'];
                for (const entry of nodeEntries) {
                    if (await this.fileExists(workspaceUri, entry)) {
                        entryPoints.push(entry);
                    }
                }
                break;

            case 'python':
                const pythonEntries = ['main.py', 'app.py', '__main__.py', 'manage.py'];
                for (const entry of pythonEntries) {
                    if (await this.fileExists(workspaceUri, entry)) {
                        entryPoints.push(entry);
                    }
                }
                break;

            case 'java':
                // Find Main classes
                const javaFiles = await vscode.workspace.findFiles('**/Main.java', '**/node_modules/**', 5);
                entryPoints.push(...javaFiles.map(f => vscode.workspace.asRelativePath(f)));
                break;
        }

        info.entryPoints = entryPoints;
    }

    async getRepositoryMap(workspaceUri: vscode.Uri): Promise<string> {
        let map = "Project Structure (Limited to 200 files):\n";
        const files = (await vscode.workspace.findFiles('**/*', '**/node_modules/**')).slice(0, 200);

        const structure: any = {};
        for (const file of files) {
            const relPath = vscode.workspace.asRelativePath(file);
            const segments = relPath.split('/');
            let curr = structure;
            for (const segment of segments) {
                if (!curr[segment]) {curr[segment] = {};}
                curr = curr[segment];
            }
        }

        const renderTree = (node: any, indent: string = ''): string => {
            let res = '';
            for (const key in node) {
                res += `${indent}- ${key}\n`;
                res += renderTree(node[key], indent + '  ');
            }
            return res;
        };

        map += renderTree(structure);
        return map;
    }

    private async fileExists(workspaceUri: vscode.Uri, relativePath: string): Promise<boolean> {
        try {
            const fileUri = vscode.Uri.joinPath(workspaceUri, relativePath);
            await vscode.workspace.fs.stat(fileUri);
            return true;
        } catch {
            return false;
        }
    }

    private async directoryExists(workspaceUri: vscode.Uri, relativePath: string): Promise<boolean> {
        try {
            const dirUri = vscode.Uri.joinPath(workspaceUri, relativePath);
            const stat = await vscode.workspace.fs.stat(dirUri);
            return stat.type === vscode.FileType.Directory;
        } catch {
            return false;
        }
    }

    private async readJsonFile(workspaceUri: vscode.Uri, relativePath: string): Promise<any> {
        try {
            const fileUri = vscode.Uri.joinPath(workspaceUri, relativePath);
            const content = await vscode.workspace.fs.readFile(fileUri);
            return JSON.parse(content.toString());
        } catch {
            return null;
        }
    }

    private async readTextFile(workspaceUri: vscode.Uri, relativePath: string): Promise<string | null> {
        try {
            const fileUri = vscode.Uri.joinPath(workspaceUri, relativePath);
            const content = await vscode.workspace.fs.readFile(fileUri);
            return content.toString();
        } catch {
            return null;
        }
    }
}
