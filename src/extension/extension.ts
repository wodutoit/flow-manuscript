import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { ManuscriptTreeProvider } from "./treeProvider";
import { DiagramPanel } from "./diagramPanel";
import { EditorPanel } from "./editorPanel";
import { toSlug } from "./frontmatter";
import type { ManuscriptMeta } from "../shared/types";

let manager: ManuscriptManager | undefined;
let tree: ManuscriptTreeProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const ext = context.extensionUri;

  // Register the tree view provider immediately and unconditionally, so the
  // view always has a data provider (otherwise VS Code shows "no data provider
  // registered"). It starts empty and gains data once a manager is attached.
  tree = new ManuscriptTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("flowManuscript.tree", tree)
  );

  const ensureManager = async (): Promise<ManuscriptManager | undefined> => {
    if (manager) return manager;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage(
        "Open a manuscript folder first (File \u2192 Open Folder)."
      );
      return undefined;
    }
    manager = new ManuscriptManager(folder.uri, ext);
    await manager.load();
    tree?.attach(manager);
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

  // --- command: import an existing skill-created manuscript ----------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.importManuscript",
      async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: false,
          canSelectFiles: true,
          canSelectMany: false,
          openLabel: "Select overview.md",
          filters: { Markdown: ["md"] },
        });
        if (!picked?.[0]) return;
        const overviewUri = picked[0];
        // The manuscript root is the folder containing the chosen overview.md.
        const root = vscode.Uri.joinPath(overviewUri, "..");

        try {
          const summary = await ManuscriptManager.importFromFolder(root);
          vscode.window.showInformationMessage(
            `Imported ${summary.scenes} scene(s) (${summary.ordered} ordered), ` +
              `${summary.characters} character(s), ${summary.places} place(s). ` +
              `Open this folder to view the diagram.`
          );
        } catch (e: any) {
          if (e && e.message === "exists") {
            vscode.window.showWarningMessage(
              "This manuscript already has an outline.flow.json \u2014 import skipped so your existing diagram isn't overwritten."
            );
          } else {
            vscode.window.showErrorMessage(
              `Import failed: ${e?.message ?? String(e)}`
            );
          }
        }
      }
    )
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
  const promptName = async (label: string) =>
    vscode.window.showInputBox({
      prompt: `${label} name`,
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });

  const addEntity = async (kind: "character" | "place") => {
    const m = await ensureManager();
    if (!m) return;
    const name = await promptName(kind[0].toUpperCase() + kind.slice(1));
    if (!name) return;
    await m.createNode(kind, name.trim(), {});
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("flowManuscript.addCharacter", () =>
      addEntity("character")
    ),
    vscode.commands.registerCommand("flowManuscript.addPlace", () =>
      addEntity("place")
    )
  );

  // --- command: delete a scene/character/place from the tree ---------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.deleteNode",
      async (item?: { nodeId?: string; nodeKind?: string }) => {
        const m = await ensureManager();
        if (!m || !item?.nodeId) return;
        const node = m.getNode(item.nodeId);
        if (!node) return;
        const label =
          node.kind === "scene"
            ? "Scene"
            : node.kind === "character"
            ? "Character"
            : "Place";
        const choice = await vscode.window.showWarningMessage(
          `Delete this ${label} "${node.name}"?`,
          {
            modal: true,
            detail:
              "The underlying file will be deleted and this cannot be undone.",
          },
          "Delete"
        );
        if (choice === "Delete") {
          await m.deleteNode(item.nodeId, { deleteFile: true });
        }
      }
    )
  );

  // --- command: move a scene to another act (from the tree) ----------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.moveSceneToAct",
      async (item?: { nodeId?: string; nodeKind?: string }) => {
        const m = await ensureManager();
        if (!m || !item?.nodeId) return;
        const node = m.getNode(item.nodeId);
        if (!node || node.kind !== "scene") return;
        const current = m.actOfScene(item.nodeId);
        const targets = m
          .getActs()
          .filter((a) => a.id !== current?.id);
        if (targets.length === 0) {
          vscode.window.showInformationMessage(
            "There's no other act to move this scene to. Create another act first."
          );
          return;
        }
        const picked = await vscode.window.showQuickPick(
          targets.map((a) => ({
            label: `${a.order}. ${a.name}`,
            actId: a.id,
          })),
          {
            placeHolder: current
              ? `Move "${node.name}" from “${current.name}” to…`
              : `Move "${node.name}" to…`,
          }
        );
        if (!picked) return;
        await m.moveSceneToAct(item.nodeId, picked.actId);
      }
    )
  );

  // --- commands: acts (invoked from the tree) ------------------------------

  /** The Scenes group '+' creates an act. */
  context.subscriptions.push(
    vscode.commands.registerCommand("flowManuscript.addAct", async () => {
      const m = await ensureManager();
      if (!m) return;
      const name = await vscode.window.showInputBox({
        prompt: "Act name",
        placeHolder: "e.g. Setup, Confrontation, Resolution",
        validateInput: (v) => (v.trim() ? undefined : "Name is required"),
      });
      if (!name) return;
      await m.createAct(name.trim());
    })
  );

  /** Hovering an act shows '+' to add a scene into it. */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.addSceneToAct",
      async (item?: { actId?: string }) => {
        const m = await ensureManager();
        if (!m || !item?.actId) return;
        const name = await promptName("Scene");
        if (!name) return;
        const pov = await vscode.window.showInputBox({
          prompt: "POV character (optional)",
        });
        if (pov === undefined) return;
        try {
          await m.createNode("scene", name.trim(), {
            pov: pov.trim(),
            actId: item.actId,
          });
        } catch (e: any) {
          if (e?.message === "no-act") {
            vscode.window.showErrorMessage(
              "That act no longer exists. Try again."
            );
          } else throw e;
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.renameAct",
      async (item?: { actId?: string }) => {
        const m = await ensureManager();
        if (!m || !item?.actId) return;
        const act = m.getAct(item.actId);
        if (!act) return;
        const name = await vscode.window.showInputBox({
          prompt: "Act name",
          value: act.name,
          validateInput: (v) => (v.trim() ? undefined : "Name is required"),
        });
        if (name) await m.renameAct(item.actId, name.trim());
      }
    ),
    vscode.commands.registerCommand(
      "flowManuscript.moveActUp",
      async (item?: { actId?: string }) => {
        const m = await ensureManager();
        if (m && item?.actId) await m.moveAct(item.actId, "up");
      }
    ),
    vscode.commands.registerCommand(
      "flowManuscript.moveActDown",
      async (item?: { actId?: string }) => {
        const m = await ensureManager();
        if (m && item?.actId) await m.moveAct(item.actId, "down");
      }
    ),
    vscode.commands.registerCommand(
      "flowManuscript.deleteAct",
      async (item?: { actId?: string }) => {
        const m = await ensureManager();
        if (!m || !item?.actId) return;
        const act = m.getAct(item.actId);
        if (!act) return;
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
        if (choice === "Delete") await m.deleteAct(item.actId);
      }
    )
  );

  // Auto-init the tree if the open folder looks like a manuscript. We treat a
  // folder as a manuscript if it has an outline.flow.json OR an overview.md
  // (the latter covers skill-created books not yet imported; load() will seed
  // an empty flow file so the tree still renders).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const has = async (name: string) => {
      try {
        await vscode.workspace.fs.stat(
          vscode.Uri.joinPath(folder.uri, name)
        );
        return true;
      } catch {
        return false;
      }
    };
    if ((await has("outline.flow.json")) || (await has("overview.md"))) {
      await ensureManager();
    }
    // Otherwise: not a manuscript workspace; the tree shows its hint row and
    // commands will lazily init when invoked.
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
