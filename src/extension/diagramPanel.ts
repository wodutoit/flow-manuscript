import * as vscode from "vscode";
import * as path from "path";
import { ManuscriptManager } from "./manuscriptManager";
import { webviewHtml } from "./webviewHtml";
import type { DiagramToHost, HostToDiagram, NodeKind } from "../shared/types";

/** One diagram panel per manuscript root; multiple can be open at once. */
export class DiagramPanel {
  private static panels = new Map<string, DiagramPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    manager: ManuscriptManager,
    rootKey: string,
    openEditor: (nodeId: string) => void,
    /** Where to open it. Defaults to column one; the series canvas passes the
     * column beside itself so a book opens next to the series, not over it. */
    column: vscode.ViewColumn = vscode.ViewColumn.One
  ) {
    const existing = DiagramPanel.panels.get(rootKey);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }
    const title = `Flow: ${path.basename(manager.rootUri.fsPath)}`;
    const panel = vscode.window.createWebviewPanel(
      "flowManuscript.diagram",
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist-diagram"),
        ],
      }
    );
    DiagramPanel.panels.set(
      rootKey,
      new DiagramPanel(panel, extensionUri, manager, rootKey, openEditor)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly manager: ManuscriptManager,
    private readonly rootKey: string,
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
        await this.promptAndAddNode(m.kind, m.afterNodeId, m.actId);
        break;

      // ---- acts ----
      case "addAct":
        await this.promptAndAddAct();
        break;
      case "renameAct": {
        const act = this.manager.getAct(m.actId);
        if (!act) break;
        const name = await vscode.window.showInputBox({
          prompt: "Act name",
          value: act.name,
          validateInput: (v) => (v.trim() ? undefined : "Name is required"),
        });
        if (name) await this.manager.renameAct(m.actId, name.trim());
        break;
      }
      case "moveAct":
        await this.manager.moveAct(m.actId, m.direction);
        break;
      case "connectActs":
        await this.manager.connectActs(m.sourceActId, m.targetActId);
        break;
      case "setActCollapsed":
        await this.manager.setActCollapsed(m.actId, m.collapsed);
        break;
      case "moveActPosition":
        await this.manager.moveActPosition(m.actId, m.position);
        break;
      case "resizeAct":
        await this.manager.resizeAct(m.actId, m.size);
        break;
      case "arrangeAct":
        await this.manager.arrangeAct(m.actId);
        break;
      case "moveSceneToAct":
        await this.manager.moveSceneToAct(m.sceneId, m.actId);
        break;
      case "addSceneToAct":
        await this.promptAndAddNode("scene", undefined, m.actId);
        break;
      case "deleteAct": {
        const act = this.manager.getAct(m.actId);
        if (!act) break;
        const count = act.sceneIds.length;
        const detail =
          count > 0
            ? `This will also delete all ${count} scene${
                count === 1 ? "" : "s"
              } in this act and their files. This cannot be undone.`
            : "This act has no scenes. This cannot be undone.";
        const choice = await vscode.window.showWarningMessage(
          `Delete act "${act.name}"?`,
          { modal: true, detail },
          "Delete"
        );
        if (choice === "Delete") await this.manager.deleteAct(m.actId);
        break;
      }
    }
  }

  /** Prompt for an act name and create it. */
  private async promptAndAddAct() {
    const name = await vscode.window.showInputBox({
      prompt: "Act name",
      placeHolder: "e.g. Setup, Confrontation, Resolution",
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) return;
    await this.manager.createAct(name.trim());
  }

  /** Prompt for the fields required to create a node, then create it. */
  private async promptAndAddNode(
    kind: NodeKind,
    afterNodeId?: string,
    actId?: string
  ) {
    // Scenes must land in an act. If none was supplied and there's no act to
    // infer, guide the user to create one first rather than failing silently.
    if (kind === "scene" && !actId && !afterNodeId) {
      if (this.manager.getActs().length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "Scenes must belong to an act. Create an act first.",
          "Create Act"
        );
        if (choice === "Create Act") await this.promptAndAddAct();
        return;
      }
    }

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

    try {
      await this.manager.createNode(kind, name.trim(), {
        pov: pov?.trim(),
        afterNodeId,
        actId,
      });
    } catch (e: any) {
      if (e && e.message === "no-act") {
        vscode.window.showErrorMessage(
          "Couldn't add the scene: no act to place it in. Create an act first."
        );
      } else {
        throw e;
      }
    }
  }

  dispose() {
    DiagramPanel.panels.delete(this.rootKey);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
