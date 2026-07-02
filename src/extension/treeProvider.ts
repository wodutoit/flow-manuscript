import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { OVERVIEW_ID, type NodeKind, type DiagramState } from "../shared/types";

type TreeItemKind = "group" | "node" | "act";

class FlowTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly itemKind: TreeItemKind,
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

  private manager?: ManuscriptManager;
  private changeSub?: vscode.Disposable;
  // Cache the last diagram state per refresh so children lookups are cheap.
  private stateCache?: Promise<DiagramState>;

  constructor(manager?: ManuscriptManager) {
    if (manager) this.attach(manager);
  }

  attach(manager: ManuscriptManager) {
    this.manager = manager;
    this.changeSub?.dispose();
    this.changeSub = manager.onDidChange(() => {
      this.stateCache = undefined;
      this._onDidChangeTreeData.fire();
    });
    this.stateCache = undefined;
    this._onDidChangeTreeData.fire();
  }

  refresh() {
    this.stateCache = undefined;
    this._onDidChangeTreeData.fire();
  }

  private state(): Promise<DiagramState> {
    if (!this.stateCache) this.stateCache = this.manager!.diagramState();
    return this.stateCache;
  }

  getTreeItem(element: FlowTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FlowTreeItem): Promise<FlowTreeItem[]> {
    if (!this.manager) {
      if (element) return [];
      const hint = new FlowTreeItem(
        "No manuscript loaded \u2014 open a manuscript folder",
        vscode.TreeItemCollapsibleState.None,
        "node"
      );
      hint.iconPath = new vscode.ThemeIcon("info");
      hint.contextValue = "hint";
      return [hint];
    }

    // Root: Overview + the three groups.
    if (!element) {
      const overview = new FlowTreeItem(
        "Overview",
        vscode.TreeItemCollapsibleState.None,
        "node",
        undefined,
        OVERVIEW_ID
      );
      overview.iconPath = new vscode.ThemeIcon("book");
      overview.command = {
        command: "flowManuscript.openNode",
        title: "Open",
        arguments: [OVERVIEW_ID],
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
      const acts = this.manager.getActs();
      if (acts.length === 0) {
        const empty = new FlowTreeItem(
          "No acts yet \u2014 use + to add one",
          vscode.TreeItemCollapsibleState.None,
          "node"
        );
        empty.iconPath = new vscode.ThemeIcon("info");
        empty.contextValue = "hint";
        return [empty];
      }
      const invalid = new Set((await this.state()).invalidActIds);
      return acts.map((act) => {
        const item = new FlowTreeItem(
          `${act.order}. ${act.name}`,
          act.collapsed
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
          "act",
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
          item.description += " \u2014 multiple starts";
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
      const st = await this.state();
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
          "scene",
          n.id
        );
        item.command = {
          command: "flowManuscript.openNode",
          title: "Open",
          arguments: [n.id],
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
      const st = await this.state();
      const nodes = st.nodes
        .filter((n) => n.kind === element.nodeKind)
        .sort((a, b) => a.name.localeCompare(b.name));
      return nodes.map((n) => {
        const item = new FlowTreeItem(
          n.name,
          vscode.TreeItemCollapsibleState.None,
          "node",
          n.kind,
          n.id
        );
        item.command = {
          command: "flowManuscript.openNode",
          title: "Open",
          arguments: [n.id],
        };
        item.description = n.pov ?? undefined;
        item.contextValue = `node:${n.kind}`;
        return item;
      });
    }

    return [];
  }
}
