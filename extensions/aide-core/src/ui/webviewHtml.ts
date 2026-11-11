import * as vscode from 'vscode';

/** Standard HTML shell for AIDE webviews: strict CSP, nonce'd bundle, shared stylesheet. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: string, title: string, initialState?: unknown): string {
	const nonce = Array.from({ length: 24 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', `${bundle}.js`));
	const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'aide.css'));
	const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'codicon.css'));
	const state = initialState === undefined ? '' : `<script nonce="${nonce}">window.__AIDE_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};</script>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codicons}" rel="stylesheet">
<link href="${css}" rel="stylesheet">
<title>${title}</title>
</head>
<body class="aide-${bundle}">
<div id="app"></div>
${state}
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
