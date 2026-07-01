import * as vscode from "vscode";

export function nonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++)
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/**
 * Build the HTML shell for a webview that loads a Vite-built bundle.
 * `dist` is the folder (relative to extension root) holding index.js/index.css.
 */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  distFolder: string,
  title: string
): string {
  const n = nonce();
  const base = vscode.Uri.joinPath(extensionUri, distFolder);
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "index.js")
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(base, "index.css")
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" type="module" src="${script}"></script>
</body>
</html>`;
}
