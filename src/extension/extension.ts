import * as vscode from "vscode";
import { ManuscriptManager } from "./manuscriptManager";
import { ManuscriptTreeProvider, FlowTreeItem } from "./treeProvider";
import { DiagramPanel } from "./diagramPanel";
import { EditorPanel } from "./editorPanel";
import { toSlug } from "./frontmatter";
import { AiAssist } from "./aiAssist";
import type { ManuscriptMeta } from "../shared/types";

const FLOW_FILE = "outline.flow.json";

let tree: ManuscriptTreeProvider | undefined;

// ManuscriptManagers, cached per manuscript root folder. Multiple manuscripts
// can be active at once — e.g. a "books" repo with one subfolder per book —
// so there is no single global `manager` any more; every command/panel is
// parameterized by which manuscript root it applies to.
const managers = new Map<string, ManuscriptManager>();

export async function activate(context: vscode.ExtensionContext) {
  const ext = context.extensionUri;

  const getManager = async (rootKey: string): Promise<ManuscriptManager> => {
    const existing = managers.get(rootKey);
    if (existing) return existing;
    const m = new ManuscriptManager(vscode.Uri.parse(rootKey), ext);
    await m.load();
    managers.set(rootKey, m);
    return m;
  };

  /** A folder is a manuscript root iff it directly contains outline.flow.json. */
  const isManuscriptRoot = async (uri: vscode.Uri): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, FLOW_FILE));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Finds every manuscript in the open workspace: each workspace folder
   * itself (covers "I opened a single book's folder", the original
   * behavior), plus each of its immediate subfolders (covers "I opened my
   * `books` repo, which has one folder per book"). Not recursive beyond one
   * level — that matches a flat `books/<book>/outline.flow.json` layout.
   */
  const discoverManuscriptRoots = async (): Promise<vscode.Uri[]> => {
    const roots: vscode.Uri[] = [];
    const seen = new Set<string>();
    const add = (uri: vscode.Uri) => {
      const key = uri.toString();
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(uri);
      }
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (await isManuscriptRoot(folder.uri)) add(folder.uri);
      try {
        const entries = await vscode.workspace.fs.readDirectory(folder.uri);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.Directory) continue;
          if (name.startsWith(".") || name === "node_modules") continue;
          const sub = vscode.Uri.joinPath(folder.uri, name);
          if (await isManuscriptRoot(sub)) add(sub);
        }
      } catch {
        // Folder listing not available (e.g. an unusual virtual FS) — skip.
      }
    }
    return roots;
  };

  // Single process-wide AI assist singleton (not per-manuscript) — see
  // aiAssist.ts's class doc comment and the plan (tender-rolling-ullman.md).
  // Takes the extension context so it can target context.globalStorageUri
  // for the one-time model download.
  const aiAssist = new AiAssist(context);
  context.subscriptions.push(aiAssist);
  context.subscriptions.push(
    vscode.commands.registerCommand("flowManuscript.showAiOutput", () =>
      aiAssist.showOutput()
    )
  );

  // Register the tree view provider immediately and unconditionally, so the
  // view always has a data provider (otherwise VS Code shows "no data
  // provider registered"). It discovers manuscripts lazily on first render.
  // Uses createTreeView (not the plain registerTreeDataProvider) specifically
  // to get onDidChangeVisibility — that's the actual trigger for loading the
  // AI model: only when the Flow Manuscript tree becomes visible, not merely
  // on activate() and not merely because the ai.enabled setting is on (see
  // AiAssist.ensureReady(), which itself no-ops unless the setting is on).
  tree = new ManuscriptTreeProvider(getManager, discoverManuscriptRoots);
  const treeView = vscode.window.createTreeView("flowManuscript.tree", {
    treeDataProvider: tree,
  });
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) aiAssist.ensureReady();
    })
  );

  const openNode = async (rootKey: string, nodeId: string) => {
    const m = await getManager(rootKey);
    EditorPanel.show(ext, m, rootKey, nodeId, aiAssist);
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
      tree?.refresh();
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
          tree?.refresh();
          vscode.window.showInformationMessage(
            `Imported ${summary.scenes} scene(s) (${summary.ordered} ordered), ` +
              `${summary.characters} character(s), ${summary.places} place(s). ` +
              `It now shows in the Flow Manuscript view.`
          );
        } catch (e: any) {
          if (e && e.message === "exists") {
            vscode.window.showWarningMessage(
              "This manuscript already has an outline.flow.json — import skipped so your existing diagram isn't overwritten."
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

  // --- command: open the diagram for a manuscript ---------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.openDiagram",
      async (arg?: string | FlowTreeItem) => {
        const rootKey = typeof arg === "string" ? arg : arg?.manuscriptRoot;
        if (!rootKey) {
          vscode.window.showErrorMessage(
            "Select a manuscript in the Flow Manuscript view first."
          );
          return;
        }
        const m = await getManager(rootKey);
        DiagramPanel.show(ext, m, rootKey, (nodeId) => openNode(rootKey, nodeId));
      }
    )
  );

  // --- command: create/open a manuscript's voiceprint file -----------------
  // The per-manuscript .claude/voiceprint.md that manuscriptManager.ts's
  // loadVoiceprint() reads (see resolveVoiceprint() in editorPanel.ts). This
  // is the only way to create that file from the UI — seeds it with a short
  // explanatory template on first use, then just opens it on every use after.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.editVoiceprint",
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot) return;
        const m = await getManager(item.manuscriptRoot);
        const claudeDir = vscode.Uri.joinPath(m.rootUri, ".claude");
        const uri = vscode.Uri.joinPath(claudeDir, "voiceprint.md");
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          await vscode.workspace.fs.createDirectory(claudeDir);
          const seed =
            "# Voiceprint\n\n" +
            "Describe your voice and style preferences here — tone, sentence " +
            "rhythm, words or phrasing you want to avoid, anything AI Grammar " +
            "and AI Editor should weigh their suggestions against.\n\n" +
            "This file is optional. If you delete it, Flow Manuscript falls " +
            "back to the global `flowManuscript.ai.voiceprintPath` setting, " +
            "if any.\n";
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(seed));
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    )
  );

  // --- command: open a node in the editor ----------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.openNode",
      async (rootKey: string, nodeId: string) => {
        await openNode(rootKey, nodeId);
      }
    )
  );

  // --- commands: add nodes from the tree context menu ----------------------
  const promptName = async (label: string) =>
    vscode.window.showInputBox({
      prompt: `${label} name`,
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });

  const addEntity = async (
    kind: "character" | "place",
    item?: FlowTreeItem
  ) => {
    if (!item?.manuscriptRoot) return;
    const m = await getManager(item.manuscriptRoot);
    const name = await promptName(kind[0].toUpperCase() + kind.slice(1));
    if (!name) return;
    await m.createNode(kind, name.trim(), {});
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.addCharacter",
      (item?: FlowTreeItem) => addEntity("character", item)
    ),
    vscode.commands.registerCommand(
      "flowManuscript.addPlace",
      (item?: FlowTreeItem) => addEntity("place", item)
    )
  );

  // --- command: delete a scene/character/place from the tree ---------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.deleteNode",
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.nodeId) return;
        const m = await getManager(item.manuscriptRoot);
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
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.nodeId) return;
        const m = await getManager(item.manuscriptRoot);
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
    vscode.commands.registerCommand(
      "flowManuscript.addAct",
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot) return;
        const m = await getManager(item.manuscriptRoot);
        const name = await vscode.window.showInputBox({
          prompt: "Act name",
          placeHolder: "e.g. Setup, Confrontation, Resolution",
          validateInput: (v) => (v.trim() ? undefined : "Name is required"),
        });
        if (!name) return;
        await m.createAct(name.trim());
      }
    )
  );

  /** Hovering an act shows '+' to add a scene into it. */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "flowManuscript.addSceneToAct",
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.actId) return;
        const m = await getManager(item.manuscriptRoot);
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
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.actId) return;
        const m = await getManager(item.manuscriptRoot);
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
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.actId) return;
        const m = await getManager(item.manuscriptRoot);
        await m.moveAct(item.actId, "up");
      }
    ),
    vscode.commands.registerCommand(
      "flowManuscript.moveActDown",
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.actId) return;
        const m = await getManager(item.manuscriptRoot);
        await m.moveAct(item.actId, "down");
      }
    ),
    vscode.commands.registerCommand(
      "flowManuscript.deleteAct",
      async (item?: FlowTreeItem) => {
        if (!item?.manuscriptRoot || !item?.actId) return;
        const m = await getManager(item.manuscriptRoot);
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
}

export function deactivate() {
  managers.clear();
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
