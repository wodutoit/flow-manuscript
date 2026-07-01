import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { webviewHtml } from "./webviewHtml";
import type { DiagramToHost, HostToDiagram, NodeKind } from "../shared/types";

export class DiagramPanel {
  static current: DiagramPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    manager: ManuscriptManager,
    openEditor: (nodeId: string) => void
  ) {
    if (DiagramPanel.current) {
      DiagramPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "flowManuscript.diagram",
      "Manuscript Flow",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist-diagram"),
        ],
      }
    );
    DiagramPanel.current = new DiagramPanel(
      panel,
      extensionUri,
      manager,
      openEditor
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly manager: ManuscriptManager,
    private readonly openEditor: (nodeId: string) => void
  ) {
    this.panel = panel;
    panel.webview.html = webviewHtml(
      panel.webview,
      extensionUri,
      "dist-diagram",
      "Manuscript Flow"
    );

    panel.webview.onDidReceiveMessage(
      (m: DiagramToHost) => this.onMessage(m),
      null,
      this.disposables
    );
    manager.onDidChange(() => this.pushState(), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(msg: HostToDiagram) {
    this.panel.webview.postMessage(msg);
  }

  async pushState() {
    this.post({ type: "state", state: await this.manager.diagramState() });
  }

  private async onMessage(m: DiagramToHost) {
    switch (m.type) {
      case "ready":
        await this.pushState();
        break;
      case "openNode":
        this.openEditor(m.nodeId);
        break;
      case "moveNode":
        await this.manager.moveNode(m.nodeId, m.position);
        break;
      case "connect":
        await this.manager.connect(m.source, m.target, m.kind);
        break;
      case "setEdgeKind":
        await this.manager.setEdgeKind(m.edgeId, m.kind);
        break;
      case "deleteEdge":
        await this.manager.deleteEdge(m.edgeId);
        break;
      case "deleteNode": {
        const node = this.manager.getNode(m.nodeId);
        if (!node) break;
        const label =
          node.kind === "scene"
            ? "Scene"
            : node.kind === "character"
            ? "Character"
            : "Place";
        const choice = await vscode.window.showWarningMessage(
          `Are you sure you want to delete this ${label}? The underlying file will be deleted and this cannot be undone.`,
          { modal: true },
          "Delete"
        );
        if (choice === "Delete") {
          await this.manager.deleteNode(m.nodeId, { deleteFile: true });
        }
        break;
      }
      case "duplicateNode":
        await this.manager.duplicateNode(m.nodeId);
        break;
      case "addNode":
        await this.promptAndAddNode(m.kind, m.afterNodeId);
        break;
    }
  }

  /** Prompt for the fields required to create a node, then create it. */
  private async promptAndAddNode(kind: NodeKind, afterNodeId?: string) {
    const label =
      kind === "scene" ? "Scene" : kind === "character" ? "Character" : "Place";
    const name = await vscode.window.showInputBox({
      prompt: `${label} name`,
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) return;

    let pov: string | undefined;
    if (kind === "scene") {
      pov = await vscode.window.showInputBox({
        prompt: "POV character (optional)",
      });
      if (pov === undefined) return; // user cancelled
    }

    await this.manager.createNode(kind, name.trim(), {
      pov: pov?.trim(),
      afterNodeId,
    });
  }

  dispose() {
    DiagramPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
