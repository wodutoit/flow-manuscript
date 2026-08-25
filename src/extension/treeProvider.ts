import * as vscode from "vscode";
import * as path from "path";
import { ManuscriptManager } from "./manuscriptManager";
import { OVERVIEW_ID, type NodeKind, type DiagramState } from "../shared/types";

type TreeItemKind = "manuscript" | "group" | "node" | "act";

/**
 * A tree row. `manuscriptRoot` (the manuscript folder's URI, stringified) is
 * carried on every row so command handlers know which manuscript's
 * ManuscriptManager to act on — the tree can show more than one manuscript
 * at once (see ManuscriptTreeProvider).
 */
export class FlowTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly itemKind: TreeItemKind,
    public readonly manuscriptRoot: string,
    public readonly nodeKind?: NodeKind,
    public readonly nodeId?: string,
    public readonly actId?: string
  ) {
    super(label, collapsible);
  }
}

export class ManuscriptTreeProvider
  implements vscode.TreeDataProvider<FlowTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Diagram-state cache, keyed by manuscript root, so children lookups are
  // cheap. `subscribed` tracks which roots we've already hooked onDidChange
  // for (the manager itself is owned/cached by extension.ts's `getManager`
  // and shared with the diagram/editor panels).
  private stateCache = new Map<string, Promise<DiagramState>>();
  private subscribed = new Set<string>();

  constructor(
    private readonly getManager: (rootKey: string) => Promise<ManuscriptManager>,
    private readonly discoverRoots: () => Promise<vscode.Uri[]>
  ) {}

  /** Force a full re-render (used e.g. after New/Import Manuscript). */
  refresh() {
    this.stateCache.clear();
    this._onDidChangeTreeData.fire();
  }

  private async manager(rootKey: string): Promise<ManuscriptManager> {
    const m = await this.getManager(rootKey);
    if (!this.subscribed.has(rootKey)) {
      this.subscribed.add(rootKey);
      m.onDidChange(() => {
        this.stateCache.delete(rootKey);
        this._onDidChangeTreeData.fire();
      });
    }
    return m;
  }

  private state(rootKey: string): Promise<DiagramState> {
    let cached = this.stateCache.get(rootKey);
    if (!cached) {
      cached = this.manager(rootKey).then((m) => m.diagramState());
      this.stateCache.set(rootKey, cached);
    }
    return cached;
  }

  getTreeItem(element: FlowTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FlowTreeItem): Promise<FlowTreeItem[]> {
    // Root: one node per manuscript folder found in the workspace (the
    // workspace folder itself, and/or any of its immediate subfolders, that
    // directly contain an outline.flow.json).
    if (!element) {
      const roots = await this.discoverRoots();
      if (roots.length === 0) {
        const hint = new FlowTreeItem(
          "No manuscripts found — open a folder containing outline.flow.json, or a folder of manuscript folders",
          vscode.TreeItemCollapsibleState.None,
          "node",
          ""
        );
        hint.iconPath = new vscode.ThemeIcon("info");
        hint.contextValue = "hint";
        return [hint];
      }
      return roots
        .slice()
        .sort((a, b) =>
          path.basename(a.fsPath).localeCompare(path.basename(b.fsPath))
        )
        .map((root) => {
          const key = root.toString();
          const item = new FlowTreeItem(
            path.basename(root.fsPath),
            vscode.TreeItemCollapsibleState.Collapsed,
            "manuscript",
            key
          );
          item.iconPath = new vscode.ThemeIcon("book");
          item.contextValue = "manuscript";
          item.tooltip = root.fsPath;
          // Clicking the row opens that manuscript's diagram; the disclosure
          // arrow still expands it to the hierarchy below.
          item.command = {
            command: "flowManuscript.openDiagram",
            title: "Open Diagram",
            arguments: [key],
          };
          return item;
        });
    }

    // Manuscript -> Overview + the three groups.
    if (element.itemKind === "manuscript") {
      const root = element.manuscriptRoot;
      const overview = new FlowTreeItem(
        "Overview",
        vscode.TreeItemCollapsibleState.None,
        "node",
        root,
        undefined,
        OVERVIEW_ID
      );
      overview.iconPath = new vscode.ThemeIcon("book");
      overview.command = {
        command: "flowManuscript.openNode",
        title: "Open",
        arguments: [root, OVERVIEW_ID],
      };
      overview.contextValue = "overview";

      const groups: Array<[string, NodeKind, string]> = [
        ["Scenes", "scene", "list-ordered"],
        ["Characters", "character", "person"],
        ["Places", "place", "location"],
      ];
      const groupItems = groups.map(([label, kind, icon]) => {
        const item = new FlowTreeItem(
          label,
          vscode.TreeItemCollapsibleState.Expanded,
          "group",
          root,
          kind
        );
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = `group:${kind}`;
        return item;
      });
      return [overview, ...groupItems];
    }

    // Scenes group -> acts.
    if (element.itemKind === "group" && element.nodeKind === "scene") {
      const root = element.manuscriptRoot;
      const manager = await this.manager(root);
      const acts = manager.getActs();
      if (acts.length === 0) {
        const empty = new FlowTreeItem(
          "No acts yet — use + to add one",
          vscode.TreeItemCollapsibleState.None,
          "node",
          root
        );
        empty.iconPath = new vscode.ThemeIcon("info");
        empty.contextValue = "hint";
        return [empty];
      }
      const invalid = new Set((await this.state(root)).invalidActIds);
      return acts.map((act) => {
        const item = new FlowTreeItem(
          `${act.order}. ${act.name}`,
          act.collapsed
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
          "act",
          root,
          "scene",
          undefined,
          act.id
        );
        const count = act.sceneIds.length;
        item.description = `${count} scene${count === 1 ? "" : "s"}`;
        if (invalid.has(act.id)) {
          item.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("errorForeground")
          );
          item.description += " — multiple starts";
        } else {
          item.iconPath = new vscode.ThemeIcon("layers");
        }
        // contextValue drives which inline buttons show (see package.json menus).
        item.contextValue = "act";
        return item;
      });
    }

    // Act -> its scenes, in chain order.
    if (element.itemKind === "act" && element.actId) {
      const root = element.manuscriptRoot;
      const st = await this.state(root);
      const scenes = st.nodes
        .filter((n) => n.kind === "scene" && n.actId === element.actId)
        .sort(
          (a, b) => (a.actSceneNumber ?? 1e9) - (b.actSceneNumber ?? 1e9)
        );
      return scenes.map((n) => {
        const label =
          n.actSceneNumber != null ? `${n.actSceneNumber}. ${n.name}` : n.name;
        const item = new FlowTreeItem(
          label,
          vscode.TreeItemCollapsibleState.None,
          "node",
          root,
          "scene",
          n.id
        );
        item.command = {
          command: "flowManuscript.openNode",
          title: "Open",
          arguments: [root, n.id],
        };
        if (n.isInvalidRoot) {
          item.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("errorForeground")
          );
          item.description = "duplicate start";
        } else {
          item.description = n.pov ?? undefined;
        }
        item.contextValue = "node:scene";
        return item;
      });
    }

    // Characters / Places groups -> their nodes (unchanged).
    if (element.itemKind === "group" && element.nodeKind) {
      const root = element.manuscriptRoot;
      const st = await this.state(root);
      const nodes = st.nodes
        .filter((n) => n.kind === element.nodeKind)
        .sort((a, b) => a.name.localeCompare(b.name));
      return nodes.map((n) => {
        const item = new FlowTreeItem(
          n.name,
          vscode.TreeItemCollapsibleState.None,
          "node",
          root,
          n.kind,
          n.id
        );
        item.command = {
          command: "flowManuscript.openNode",
          title: "Open",
          arguments: [root, n.id],
        };
        item.description = n.pov ?? undefined;
        item.contextValue = `node:${n.kind}`;
        return item;
      });
    }

    return [];
  }
}
