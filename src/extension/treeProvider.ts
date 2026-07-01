import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { deriveSceneNumbers } from "./graph";
import { OVERVIEW_ID, type NodeKind } from "../shared/types";

type TreeItemKind = "group" | "node";

class FlowTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly itemKind: TreeItemKind,
    public readonly nodeKind?: NodeKind,
    public readonly nodeId?: string
  ) {
    super(label, collapsible);
  }
}

export class ManuscriptTreeProvider
  implements vscode.TreeDataProvider<FlowTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: ManuscriptManager) {
    manager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FlowTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FlowTreeItem): Promise<FlowTreeItem[]> {
    if (!element) {
      // Overview document sits at the top, then the three node groups.
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

    if (element.itemKind === "group" && element.nodeKind) {
      const state = await this.manager.diagramState();
      let nodes = state.nodes.filter((n) => n.kind === element.nodeKind);
      if (element.nodeKind === "scene") {
        nodes = nodes.sort(
          (a, b) => (a.sceneNumber ?? 1e9) - (b.sceneNumber ?? 1e9)
        );
      } else {
        nodes = nodes.sort((a, b) => a.name.localeCompare(b.name));
      }
      return nodes.map((n) => {
        const label =
          n.kind === "scene" && n.sceneNumber
            ? `${n.sceneNumber}. ${n.name}`
            : n.name;
        const item = new FlowTreeItem(
          label,
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
        if (n.kind === "scene" && n.isInvalidRoot) {
          item.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("errorForeground")
          );
          item.description = "duplicate start";
        } else {
          item.description = n.pov ?? undefined;
        }
        item.contextValue = `node:${n.kind}`;
        return item;
      });
    }

    return [];
  }
}
