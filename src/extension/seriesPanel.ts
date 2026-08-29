import * as vscode from "vscode";
import { SeriesManager } from "./seriesManager";
import { webviewHtml } from "./webviewHtml";
import type { DiagramToHost, HostToDiagram } from "../shared/types";

/**
 * The series canvas: one book node per entry in the series outline.flow.json,
 * joined by order arrows.
 *
 * It reuses the DIAGRAM webview bundle rather than shipping a second one — the
 * webview picks its mode from the first message it receives ("seriesState" vs
 * "state"), so both panels share one React app and one build step. Only the
 * series subset of DiagramToHost is handled here; anything else is a scene
 * message that can't originate from a series canvas and is ignored.
 *
 * One panel per series root, keyed the same way DiagramPanel keys manuscripts.
 */
export class SeriesPanel {
  private static panels = new Map<string, SeriesPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    manager: SeriesManager,
    rootKey: string,
    openBookDiagram: (bookName: string, column: vscode.ViewColumn) => void,
    addBook: () => Promise<void>
  ) {
    const existing = SeriesPanel.panels.get(rootKey);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "flowManuscript.series",
      `Series: ${manager.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist-diagram")],
      }
    );
    SeriesPanel.panels.set(
      rootKey,
      new SeriesPanel(
        panel,
        extensionUri,
        manager,
        rootKey,
        openBookDiagram,
        addBook
      )
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly manager: SeriesManager,
    private readonly rootKey: string,
    private readonly openBookDiagram: (
      bookName: string,
      column: vscode.ViewColumn
    ) => void,
    private readonly addBook: () => Promise<void>
  ) {
    this.panel = panel;
    panel.webview.html = webviewHtml(
      panel.webview,
      extensionUri,
      "dist-diagram",
      "Series Flow"
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
    this.post({ type: "seriesState", state: await this.manager.seriesState() });
  }

  /**
   * The column a book diagram should open in: the one immediately to the right
   * of this series panel, so the book lands "next to" it rather than replacing
   * it. Falls back to Beside if the panel has no column (it's not visible).
   */
  private besideColumn(): vscode.ViewColumn {
    const col = this.panel.viewColumn;
    return col ? col + 1 : vscode.ViewColumn.Beside;
  }

  private async onMessage(m: DiagramToHost) {
    switch (m.type) {
      case "ready":
        await this.pushState();
        break;
      case "addBook":
        await this.addBook();
        break;
      case "openBookDiagram": {
        const book = this.manager.getBook(m.bookId);
        if (!book) break;
        this.openBookDiagram(book.name, this.besideColumn());
        break;
      }
      case "moveBook":
        await this.manager.moveBook(m.bookId, m.position);
        break;
      case "resizeBook":
        await this.manager.resizeBook(m.bookId, m.size);
        break;
      case "connectBooks":
        await this.manager.connectBooks(m.source, m.target);
        break;
      case "deleteBookEdge":
        await this.manager.deleteEdge(m.edgeId);
        break;
      default:
        // Scene/act messages can't come from a series canvas — ignore.
        break;
    }
  }

  dispose() {
    SeriesPanel.panels.delete(this.rootKey);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
