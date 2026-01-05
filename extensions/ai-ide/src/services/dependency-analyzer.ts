/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export interface DependencyInfo {
    [packageName: string]: {
        version: string;
        type: 'production' | 'development';
    };
}

export class DependencyAnalyzer {
    async analyzeDependencies(): Promise<DependencyInfo> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return {};
        }

        // Try different dependency file formats
        const deps: DependencyInfo = {};

        // Node.js - package.json
        await this.analyzePackageJson(workspaceFolder.uri, deps);

        // Python - requirements.txt
        await this.analyzeRequirementsTxt(workspaceFolder.uri, deps);

        // Python - pyproject.toml
        await this.analyzePyprojectToml(workspaceFolder.uri, deps);

        // Java - pom.xml
        await this.analyzePomXml(workspaceFolder.uri, deps);

        // .NET - *.csproj
        await this.analyzeCsproj(workspaceFolder.uri, deps);

        // Go - go.mod
        await this.analyzeGoMod(workspaceFolder.uri, deps);

        // Rust - Cargo.toml
        await this.analyzeCargoToml(workspaceFolder.uri, deps);

        return deps;
    }

    private async analyzePackageJson(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const packageJsonUri = vscode.Uri.joinPath(workspaceUri, 'package.json');
            const content = await vscode.workspace.fs.readFile(packageJsonUri);
            const packageJson = JSON.parse(content.toString());

            if (packageJson.dependencies) {
                for (const [name, version] of Object.entries(packageJson.dependencies)) {
                    deps[name] = { version: version as string, type: 'production' };
                }
            }

            if (packageJson.devDependencies) {
                for (const [name, version] of Object.entries(packageJson.devDependencies)) {
                    deps[name] = { version: version as string, type: 'development' };
                }
            }
        } catch {
            // File doesn't exist or invalid JSON
        }
    }

    private async analyzeRequirementsTxt(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const reqUri = vscode.Uri.joinPath(workspaceUri, 'requirements.txt');
            const content = await vscode.workspace.fs.readFile(reqUri);
            const lines = content.toString().split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    continue;
                }

                // Parse package==version or package>=version
                const match = trimmed.match(/^([a-zA-Z0-9_-]+)([><=!]+)(.+)$/);
                if (match) {
                    deps[match[1]] = { version: match[3], type: 'production' };
                } else {
                    deps[trimmed] = { version: '*', type: 'production' };
                }
            }
        } catch {
            // File doesn't exist
        }
    }

    private async analyzePyprojectToml(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const tomlUri = vscode.Uri.joinPath(workspaceUri, 'pyproject.toml');
            const content = await vscode.workspace.fs.readFile(tomlUri);
            const text = content.toString();

            // Simple TOML parsing for dependencies section
            const depsMatch = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\[|$)/);
            if (depsMatch) {
                const depsSection = depsMatch[1];
                const lines = depsSection.split('\n');

                for (const line of lines) {
                    const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"(.+)"/);
                    if (match) {
                        deps[match[1]] = { version: match[2], type: 'production' };
                    }
                }
            }
        } catch {
            // File doesn't exist
        }
    }

    private async analyzePomXml(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const pomUri = vscode.Uri.joinPath(workspaceUri, 'pom.xml');
            const content = await vscode.workspace.fs.readFile(pomUri);
            const text = content.toString();

            // Simple XML parsing for dependencies
            const depMatches = text.matchAll(/<dependency>[\s\S]*?<\/dependency>/g);
            for (const match of depMatches) {
                const depXml = match[0];
                const groupId = depXml.match(/<groupId>(.*?)<\/groupId>/)?.[1];
                const artifactId = depXml.match(/<artifactId>(.*?)<\/artifactId>/)?.[1];
                const version = depXml.match(/<version>(.*?)<\/version>/)?.[1];

                if (groupId && artifactId) {
                    deps[`${groupId}:${artifactId}`] = {
                        version: version || '*',
                        type: 'production'
                    };
                }
            }
        } catch {
            // File doesn't exist
        }
    }

    private async analyzeCsproj(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const csprojFiles = await vscode.workspace.findFiles('*.csproj', '**/node_modules/**', 1);
            if (csprojFiles.length === 0) {
                return;
            }

            const content = await vscode.workspace.fs.readFile(csprojFiles[0]);
            const text = content.toString();

            // Parse PackageReference elements
            const pkgMatches = text.matchAll(/<PackageReference\s+Include="(.*?)"\s+Version="(.*?)"/g);
            for (const match of pkgMatches) {
                deps[match[1]] = { version: match[2], type: 'production' };
            }
        } catch {
            // File doesn't exist
        }
    }

    private async analyzeGoMod(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const goModUri = vscode.Uri.joinPath(workspaceUri, 'go.mod');
            const content = await vscode.workspace.fs.readFile(goModUri);
            const lines = content.toString().split('\n');

            let inRequireBlock = false;
            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed.startsWith('require (')) {
                    inRequireBlock = true;
                    continue;
                }

                if (inRequireBlock && trimmed === ')') {
                    inRequireBlock = false;
                    continue;
                }

                if (inRequireBlock || trimmed.startsWith('require ')) {
                    const match = trimmed.match(/([^\s]+)\s+v([^\s]+)/);
                    if (match) {
                        deps[match[1]] = { version: match[2], type: 'production' };
                    }
                }
            }
        } catch {
            // File doesn't exist
        }
    }

    private async analyzeCargoToml(workspaceUri: vscode.Uri, deps: DependencyInfo): Promise<void> {
        try {
            const cargoUri = vscode.Uri.joinPath(workspaceUri, 'Cargo.toml');
            const content = await vscode.workspace.fs.readFile(cargoUri);
            const text = content.toString();

            // Parse [dependencies] section
            const depsMatch = text.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
            if (depsMatch) {
                const depsSection = depsMatch[1];
                const lines = depsSection.split('\n');

                for (const line of lines) {
                    const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"(.+)"/);
                    if (match) {
                        deps[match[1]] = { version: match[2], type: 'production' };
                    }
                }
            }
        } catch {
            // File doesn't exist
        }
    }
}
