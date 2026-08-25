import * as vscode from "vscode";
import * as path from "path";
import { ManuscriptManager } from "./manuscriptManager";
import { webviewHtml } from "./webviewHtml";
import { OVERVIEW_ID, type EditorToHost, type HostToEditor } from "../shared/types";
import type { AiAssist } from "./aiAssist";

const dec = new TextDecoder();

/** Cap on the resolved voiceprint text (whichever source it came from)
 * before it ever reaches AiAssist — protects the small model's limited
 * context window from an oversized style-guide file crowding out the
 * actual paragraph being reviewed. */
const VOICEPRINT_MAX_CHARS = 2000;

/**
 * One editor panel per (manuscript root, node id); reused if already open.
 * Keying on the manuscript root too (not just node id) matters because
 * OVERVIEW_ID is the same sentinel across every manuscript — without the
 * root in the key, opening "Overview" for a second book would just reveal
 * the first book's already-open Overview panel.
 *
 * All editors share one fixed column (`EDITOR_COLUMN`, below) so they stack
 * as tabs there instead of cascading a new column per click. An earlier
 * version used `ViewColumn.Beside` and tried to remember whatever column
 * that resolved to (via `panel.viewColumn`) for reuse — that didn't work
 * reliably because `viewColumn` isn't guaranteed to be populated immediately
 * after `createWebviewPanel` returns, so the cached value stayed `undefined`
 * and every open kept re-triggering `Beside` (a fresh column each time). A
 * fixed column sidesteps that: it's deterministic and doesn't depend on
 * reading anything back from the panel.
 */
// Every node/character/place/overview editor opens into this fixed column,
// beside DiagramPanel's fixed ViewColumn.One — see the class doc comment.
const EDITOR_COLUMN = vscode.ViewColumn.Two;

export class EditorPanel {
  private static panels = new Map<string, EditorPanel>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    manager: ManuscriptManager,
    rootKey: string,
    nodeId: string,
    aiAssist: AiAssist
  ) {
    const key = `${rootKey}::${nodeId}`;
    const existing = EditorPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(EDITOR_COLUMN);
      return;
    }
    const bookName = path.basename(manager.rootUri.fsPath);
    let title: string;
    if (nodeId === OVERVIEW_ID) {
      title = `Overview — ${bookName}`;
    } else {
      const node = manager.getNode(nodeId);
      if (!node) {
        vscode.window.showErrorMessage("That node no longer exists.");
        return;
      }
      title = `${node.name} — ${bookName}`;
    }
    const panel = vscode.window.createWebviewPanel(
      "flowManuscript.editor",
      title,
      EDITOR_COLUMN,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist-editor"),
        ],
      }
    );
    EditorPanel.panels.set(
      key,
      new EditorPanel(panel, extensionUri, manager, key, nodeId, bookName, aiAssist)
    );
  }

  private disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly manager: ManuscriptManager,
    private readonly key: string,
    private readonly nodeId: string,
    private readonly bookName: string,
    private readonly aiAssist: AiAssist
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
    this.disposables.push(
      aiAssist.onDidChangeStatus(() => {
        if (this.disposed) return;
        this.post({ type: "aiStatus", status: aiAssist.status });
      })
    );
  }

  private post(msg: HostToEditor) {
    this.panel.webview.postMessage(msg);
  }

  private async sendDoc() {
    if (this.nodeId === OVERVIEW_ID) {
      const { frontmatter, body } = await this.manager.readOverview();
      this.panel.title = `Overview — ${this.bookName}`;
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
    this.panel.title = `${node.name} — ${this.bookName}`;
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

  /**
   * Resolves the effective voiceprint for this manuscript: its own
   * `.claude/voiceprint.md` if present, else the global
   * `flowManuscript.ai.voiceprintPath` setting's file, else `undefined`.
   * Truncated to `VOICEPRINT_MAX_CHARS` regardless of source before it's
   * ever passed to AiAssist.
   */
  private async resolveVoiceprint(): Promise<string | undefined> {
    let text = await this.manager.loadVoiceprint();
    if (!text) {
      const configuredPath = vscode.workspace
        .getConfiguration("flowManuscript")
        .get<string>("ai.voiceprintPath", "")
        .trim();
      if (configuredPath) {
        try {
          const raw = await vscode.workspace.fs.readFile(
            vscode.Uri.file(configuredPath)
          );
          const trimmed = dec.decode(raw).trim();
          text = trimmed || undefined;
        } catch (err) {
          console.error(
            "flow-manuscript: failed to read global voiceprint file",
            err
          );
        }
      }
    }
    if (!text) return undefined;
    return text.length > VOICEPRINT_MAX_CHARS
      ? text.slice(0, VOICEPRINT_MAX_CHARS)
      : text;
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
        this.post({ type: "aiStatus", status: this.aiAssist.status });
        await this.sendDoc();
        break;
      case "requestDoc":
        await this.sendDoc();
        break;
      case "requestDictionary":
        await this.sendDictionary();
        break;
      case "addCustomWord":
        await this.manager.addCustomWord(m.word);
        break;
      case "requestAiReview": {
        const voiceprint = await this.resolveVoiceprint();
        if (this.disposed) break;
        if (m.mode === "grammar") {
          const suggestions = await this.aiAssist.checkGrammar(
            m.text,
            voiceprint
          );
          if (this.disposed) break;
          this.post({ type: "aiGrammarSuggestions", suggestions });
        } else {
          const notes = await this.aiAssist.reviewAsEditor(m.text, voiceprint);
          if (this.disposed) break;
          this.post({ type: "aiEditorNotes", notes });
        }
        break;
      }
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
          if (node) this.panel.title = `${node.name} — ${this.bookName}`;
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
    this.disposed = true;
    EditorPanel.panels.delete(this.key);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
