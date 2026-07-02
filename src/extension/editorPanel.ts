import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { webviewHtml } from "./webviewHtml";
import { OVERVIEW_ID, type EditorToHost, type HostToEditor } from "../shared/types";

/** One editor panel per node id; reused if already open. */
export class EditorPanel {
  private static panels = new Map<string, EditorPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    manager: ManuscriptManager,
    nodeId: string
  ) {
    const existing = EditorPanel.panels.get(nodeId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    let title: string;
    if (nodeId === OVERVIEW_ID) {
      title = "Overview";
    } else {
      const node = manager.getNode(nodeId);
      if (!node) {
        vscode.window.showErrorMessage("That node no longer exists.");
        return;
      }
      title = node.name;
    }
    const panel = vscode.window.createWebviewPanel(
      "flowManuscript.editor",
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist-editor"),
        ],
      }
    );
    EditorPanel.panels.set(
      nodeId,
      new EditorPanel(panel, extensionUri, manager, nodeId)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly manager: ManuscriptManager,
    private readonly nodeId: string
  ) {
    this.panel = panel;
    panel.webview.html = webviewHtml(
      panel.webview,
      extensionUri,
      "dist-editor",
      "Scene Editor"
    );
    panel.webview.onDidReceiveMessage(
      (m: EditorToHost) => this.onMessage(m),
      null,
      this.disposables
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(msg: HostToEditor) {
    this.panel.webview.postMessage(msg);
  }

  private async sendDoc() {
    if (this.nodeId === OVERVIEW_ID) {
      const { frontmatter, body } = await this.manager.readOverview();
      this.panel.title = "Overview";
      this.post({
        type: "doc",
        nodeId: OVERVIEW_ID,
        kind: "overview",
        frontmatter,
        body,
      });
      return;
    }
    const node = this.manager.getNode(this.nodeId);
    if (!node) return;
    const { frontmatter, body } = await this.manager.readDoc(node);
    this.panel.title = node.name;
    // For scenes, include act context so the editor can show/change the act.
    let actId: string | undefined;
    let acts:
      | { id: string; name: string; order: number }[]
      | undefined;
    if (node.kind === "scene") {
      actId = this.manager.actOfScene(node.id)?.id;
      acts = this.manager
        .getActs()
        .map((a) => ({ id: a.id, name: a.name, order: a.order }));
    }
    this.post({
      type: "doc",
      nodeId: this.nodeId,
      kind: node.kind,
      frontmatter,
      body,
      actId,
      acts,
    });
  }

  private async sendDictionary() {
    try {
      const { language, aff, dic, customWords } =
        await this.manager.loadDictionary();
      this.post({ type: "dictionary", language, aff, dic, customWords });
    } catch (err) {
      // Dictionary packages missing or unreadable; spellcheck stays off.
      console.error("flow-manuscript: failed to load dictionary", err);
    }
  }

  private async onMessage(m: EditorToHost) {
    switch (m.type) {
      case "ready":
      case "requestDoc":
        await this.sendDoc();
        break;
      case "requestDictionary":
        await this.sendDictionary();
        break;
      case "addCustomWord":
        await this.manager.addCustomWord(m.word);
        break;
      case "saveBody":
        if (m.nodeId === OVERVIEW_ID) {
          await this.manager.saveOverviewBody(m.body);
        } else {
          await this.manager.saveBody(m.nodeId, m.body);
        }
        break;
      case "saveFrontmatter":
        if (m.nodeId === OVERVIEW_ID) {
          await this.manager.saveOverviewFrontmatter(m.frontmatter);
        } else {
          await this.manager.saveFrontmatter(m.nodeId, m.frontmatter);
          // Title may have changed.
          const node = this.manager.getNode(m.nodeId);
          if (node) this.panel.title = node.name;
        }
        break;
      case "renameNode":
        await this.manager.renameNode(m.nodeId, m.newName);
        await this.sendDoc();
        break;
      case "moveSceneToAct":
        await this.manager.moveSceneToAct(m.sceneId, m.actId);
        await this.sendDoc();
        break;
    }
  }

  dispose() {
    EditorPanel.panels.delete(this.nodeId);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
