import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { ManuscriptTreeProvider } from "./treeProvider";
import { DiagramPanel } from "./diagramPanel";
import { EditorPanel } from "./editorPanel";
import { toSlug } from "./frontmatter";
import type { ManuscriptMeta, NodeKind } from "../shared/types";

let manager: ManuscriptManager | undefined;
let tree: ManuscriptTreeProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const ext = context.extensionUri;

  const ensureManager = async (): Promise<ManuscriptManager | undefined> => {
    if (manager) return manager;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage(
        "Open a manuscript folder first (File \u2192 Open Folder)."
      );
      return undefined;
    }
    // Heuristic: a manuscript has an outline.flow.json or scenes/ folder.
    manager = new ManuscriptManager(folder.uri, ext);
    await manager.load();
    tree = new ManuscriptTreeProvider(manager);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider("flowManuscript.tree", tree)
    );
    return manager;
  };

  const openNode = (nodeId: string) => {
    if (!manager) return;
    EditorPanel.show(ext, manager, nodeId);
  };

  // --- command: create a new manuscript ------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("flowManuscript.newManuscript", async () => {
      const meta = await gatherMeta();
      if (!meta) return;

      const parent = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Create manuscript here",
      });
      if (!parent?.[0]) return;

      const target = vscode.Uri.joinPath(parent[0], meta.slug);
      try {
        await vscode.workspace.fs.stat(target);
        vscode.window.showErrorMessage(
          `A folder named "${meta.slug}" already exists here.`
        );
        return;
      } catch {
        /* good: does not exist */
      }

      await ManuscriptManager.scaffold(ext, target, meta);
      const choice = await vscode.window.showInformationMessage(
        `Created manuscript "${meta.title}".`,
        "Open Folder"
      );
      if (choice === "Open Folder") {
        await vscode.commands.executeCommand("vscode.openFolder", target, {
          forceNewWindow: false,
        });
      }
    })
  );

  // --- command: open the diagram -------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("flowManuscript.openDiagram", async () => {
      const m = await ensureManager();
      if (!m) return;
      DiagramPanel.show(ext, m, openNode);
    })
  );

  // --- command: open a node in the editor ----------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.openNode",
      async (nodeId: string) => {
        await ensureManager();
        openNode(nodeId);
      }
    )
  );

  // --- commands: add nodes from the tree context menu ----------------------
  const addFrom = async (kind: NodeKind) => {
    const m = await ensureManager();
    if (!m) return;
    // Reuse the diagram panel's prompt path by opening the diagram if needed,
    // but we can also prompt directly here for tree-initiated adds.
    const name = await vscode.window.showInputBox({
      prompt: `${kind[0].toUpperCase() + kind.slice(1)} name`,
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) return;
    let pov: string | undefined;
    if (kind === "scene") {
      pov = await vscode.window.showInputBox({ prompt: "POV character (optional)" });
      if (pov === undefined) return;
    }
    await m.createNode(kind, name.trim(), { pov: pov?.trim() });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("flowManuscript.addScene", () => addFrom("scene")),
    vscode.commands.registerCommand("flowManuscript.addCharacter", () =>
      addFrom("character")
    ),
    vscode.commands.registerCommand("flowManuscript.addPlace", () => addFrom("place"))
  );

  // Auto-init the tree if a manuscript is already open.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    try {
      await vscode.workspace.fs.stat(
        vscode.Uri.joinPath(folder.uri, "outline.flow.json")
      );
      await ensureManager();
    } catch {
      // Not a manuscript workspace yet; commands will lazily init.
    }
  }
}

export function deactivate() {
  manager = undefined;
  tree = undefined;
}

/** Sequential prompts mirroring the skill's two AskUserQuestion calls. */
async function gatherMeta(): Promise<ManuscriptMeta | undefined> {
  const title = await vscode.window.showInputBox({
    prompt: "Working title",
    validateInput: (v) => (v.trim() ? undefined : "Title is required"),
  });
  if (!title) return undefined;

  const slugDefault = toSlug(title);
  const slug = await vscode.window.showInputBox({
    prompt: "Folder slug (kebab-case)",
    value: slugDefault,
    validateInput: (v) =>
      /^[a-z0-9-]+$/.test(v) ? undefined : "Use lowercase letters, numbers, dashes",
  });
  if (!slug) return undefined;

  const author = await vscode.window.showInputBox({ prompt: "Author name" });
  if (author === undefined) return undefined;

  const genre = await vscode.window.showInputBox({
    prompt: "Genre (e.g. literary fiction, fantasy, thriller)",
  });
  if (genre === undefined) return undefined;

  const pov = await vscode.window.showInputBox({
    prompt: "POV (e.g. first person past, third close past)",
  });
  if (pov === undefined) return undefined;

  const langPick = await vscode.window.showQuickPick(
    [
      { label: "English (US)", value: "en_US" },
      { label: "English (UK)", value: "en_GB" },
    ],
    { placeHolder: "Spellcheck language" }
  );
  if (langPick === undefined) return undefined;
  const language = langPick.value;

  const tense = await vscode.window.showQuickPick(["past", "present", "mixed"], {
    placeHolder: "Tense",
  });
  if (tense === undefined) return undefined;

  const logline = await vscode.window.showInputBox({
    prompt: "Logline (one-sentence pitch)",
  });
  if (logline === undefined) return undefined;

  return { title, slug, author, genre, pov, tense, logline, language };
}
