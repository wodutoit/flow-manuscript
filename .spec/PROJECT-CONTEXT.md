# Flow Manuscript — Project Context

This file is the standing context for the **flow-manuscript** VS Code extension.
Read it at the start of a session before making changes. It records the
architecture, the decisions already made (and why), and the current state of
work so a future session doesn't re-litigate settled choices or miss invariants.

---

## What the extension is

A VS Code extension for planning and writing novels as a **scene-flow diagram**
plus a **rich Markdown editor**. It natively reproduces the folder structure of
the older `new-manuscript` authoring skill:

```
<manuscript-root>/
  overview.md
  outline.flow.json      <- the extension's graph sidecar (source of truth)
  scenes/    NNN-*.md (skill-created) or kebab-name.md (extension-created)
  characters/ *.md
  places/    *.md
  .claude/   custom-words.txt, context files
```

Three surfaces:
- **Tree (hierarchy)**: root level lists every **manuscript** found in the
  workspace (folder name = label); expanding one shows its Overview row +
  Scenes / Characters / Places groups. Scenes are grouped under **Acts**.
- **Diagram** (React Flow webview): scene/character/place nodes; solid "order"
  edges define story sequence, dashed "logical" edges mark POV/links.
- **Editor** (TipTap webview): per-kind frontmatter fields + WYSIWYG Markdown
  body + section-insert buttons + spellcheck.

### Multi-manuscript support (this session)
The extension is no longer pinned to a single "workspace root = the
manuscript" assumption. A folder is a **manuscript root** iff it directly
contains `outline.flow.json`. `extension.ts`'s `discoverManuscriptRoots()`
checks each open workspace folder itself, plus its immediate (one-level)
subfolders — so opening a `books/` repo with `books/<book>/outline.flow.json`
per book, or opening a single book's folder directly (the old behavior),
both work unchanged. The tree's root level lists one row per discovered
manuscript (folder basename as label); clicking the row (or its inline
"open diagram" icon) opens that manuscript's diagram — the disclosure arrow
still expands the row to Overview/Scenes/Characters/Places underneath.

There is no more single module-level `manager` — `extension.ts` keeps a
`Map<string, ManuscriptManager>` keyed by the manuscript root's
`Uri.toString()` (`getManager(rootKey)`, created + `load()`ed lazily on
first use, then cached/shared by the tree, diagram panels, and editor
panels). `DiagramPanel` and `EditorPanel` are keyed the same way so **you
can have diagrams for two different books open in separate panel tabs at
once** (`DiagramPanel` keys by root; `EditorPanel` keys by
`${root}::${nodeId}` — the root has to be part of the key because
`OVERVIEW_ID` is the same sentinel value in every book, so without it,
opening "Overview" in book B would just reveal book A's already-open
Overview panel). Editor tab titles are suffixed `— <book folder name>` so
same-named rows (e.g. two "Overview" tabs) stay distinguishable.

Every tree row (`FlowTreeItem` in `treeProvider.ts`) carries a
`manuscriptRoot` string field alongside the existing `nodeId`/`actId`/etc.,
and command handlers in `extension.ts` (`addCharacter`, `addAct`,
`deleteNode`, `openNode`, ...) all take the clicked tree item and read
`item.manuscriptRoot` to resolve the right `ManuscriptManager` — there's no
"current manuscript" global any more. `package.json`'s
`activationEvents` uses the glob `workspaceContains:**/outline.flow.json`
(was the bare filename) so the extension activates when the *books* folder
is opened, not just a single book folder. The old always-visible
`view/title` "Open Diagram" toolbar button was removed (it had no manuscript
to target) in favor of the inline icon on each manuscript row.

---

## Access / environment

- Project lives on a Windows share: `\\WDUTOITLT01\dev\github_projects\flow-manuscript`
  (also reachable as `z:\github_projects\flow-manuscript`).
- Edited via the **`filesystem-github-wdt`** MCP connector. If its tools aren't
  loaded, run a tool search first. Do NOT claim the files are unreachable.
- Stay strictly inside the flow-manuscript folder (see Claude.md).
- The author's actual manuscripts live elsewhere, e.g.
  `c:\Dev\github_projects\test\fm-one`.
- The connector occasionally times out on a **read** and surfaces a toast; this
  is usually not a failed write. When in doubt, read the file back to verify.
- Author name: **Wayne Du Toit** (used in LICENSE).

---

## Architecture

Extension host (Node, CommonJS) <-> two React webviews (Vite-bundled, single-file
for CSP) via `postMessage`. Shared types in `src/shared/types.ts` are the
contract between them.

### Key files
- `src/shared/types.ts` — all message + data types. `NodeKind`,
  `EditorKind` (= NodeKind | "overview"), `OVERVIEW_ID` sentinel, `FlowNode`,
  `FlowEdge`, `Act`, `FlowDocument` (v2), `DiagramNodeVM`, `DiagramActVM`,
  `DiagramState`, and the `DiagramToHost` / `HostToDiagram` / `EditorToHost` /
  `HostToEditor` message unions.
- `src/extension/graph.ts` — PURE graph logic (no I/O). Act-aware numbering and
  validation. Exports `deriveSceneNumbers`, `deriveActSceneNumbers`,
  `actRoots`, `invalidActIds`, `orderedScenesInAct`, `buildDiagramState`, etc.
- `src/extension/manuscriptManager.ts` — the core. Flow persistence + v1->v2
  migration, scaffold (new manuscript), importFromFolder (adopt existing),
  node CRUD, act CRUD, spellcheck dictionary loading, overview read/save,
  diagram-state assembly.
- `src/extension/extension.ts` — activation, command registration, tree wiring.
- `src/extension/diagramPanel.ts` — diagram webview controller + message router.
- `src/extension/editorPanel.ts` — editor webview controller (handles OVERVIEW_ID).
- `src/extension/treeProvider.ts` — the hierarchy tree.
- `src/extension/webviewHtml.ts` — CSP/nonce HTML shell.
- `src/extension/frontmatter.ts` — gray-matter wrapper (parseDoc/serializeDoc/toSlug).
- `webview-diagram/src/` — App.tsx (React Flow), nodes.tsx, edges.tsx, bridge.ts,
  styles.css, main.tsx.
- `webview-editor/src/` — App.tsx (TipTap + spellcheck), Toolbar.tsx, bridge.ts,
  spellchecker.ts, spellcheckPlugin.ts, styles.css, main.tsx.
- `scripts/build-extension.js` — esbuild bundler for the host (see Build).
- `scripts/copy-dictionaries.js` — copies dict files into `dictionaries/` for packaging.
- `templates/` — 11 bundled `*.md.template` files from the skill.

---

## Build / run / package  (IMPORTANT — non-obvious)

- `npm install` then `npm run build`. F5 launches the Extension Development Host
  (`.vscode/launch.json` runs `npm: build` first).
- **The host is BUNDLED with esbuild**, not plain tsc. This is critical: the
  `.vsix` excludes `node_modules/**`, so any runtime `require` of an npm package
  (e.g. `gray-matter`) would fail in a packaged install. esbuild inlines all host
  deps into a single `dist-extension/extension/extension.js`; `vscode` is the only
  external. `scripts/build-extension.js` cleans `dist-extension/` then bundles.
- esbuild does NOT type-check. Run `npm run typecheck:extension`
  (`tsc -p tsconfig.extension.json --noEmit`) after big changes to catch type errors.
- `package.json` `main` = `./dist-extension/extension/extension.js`.
- **Dictionaries** (spellcheck) are read from a bundled `dictionaries/<pkg>/`
  folder (created at build time by `copy-dict`, wired into `build` and
  `vscode:prepublish`), falling back to `node_modules` for source runs. This is
  because `.vscodeignore` excludes `node_modules/**` from the `.vsix`.
- Packaging: `npm run package` (vsce) -> `flow-manuscript-<version>.vsix`.
  Install: `code --install-extension flow-manuscript-<version>.vsix --force`,
  then reload window. Bump `version` in package.json for a clean upgrade.
- `publisher` is `"local"` (placeholder; fine for local install, not Marketplace).
- LICENSE (MIT, Wayne Du Toit) and a `repository` field exist to silence vsce warnings.
- Confirmed-good `.vsix` contents include: dist-extension, dist-diagram,
  dist-editor, dictionaries/ (~1MB, 4 files), templates/, media/, LICENSE.txt,
  README.md, CLAUDE.md, package.json.

---

## Data model — outline.flow.json (VERSION 2)

```jsonc
{
  "version": 2,
  "acts": [
    { "id": "uuid", "name": "Setup", "order": 1,
      "sceneIds": ["sceneUuid", ...], "collapsed": false,
      "position": { "x": 0, "y": 0 } }        // position optional (diagram)
  ],
  "nodes": [
    { "id": "uuid", "kind": "scene|character|place",
      "file": "scenes/x.md", "name": "X", "position": {"x":..,"y":..} }
  ],
  "edges": [
    { "id": "uuid", "kind": "order|logical", "source": "uuid", "target": "uuid" }
  ]
}
```

Invariants and rules (DO NOT BREAK):
- **Acts live only in the flow file.** No backing `.md`, no folders on disk.
  Scene `.md` files never move or get renamed because of acts.
- **Every scene belongs to exactly one act** (membership = the act's `sceneIds`).
  The manager throws `Error("no-act")` if you try to create a scene with no act.
- **Edges are intra-act only.** `connect()` refuses cross-act edges. Scenes only
  ever link to scenes in the same act.
- **Story order = acts by `order`, then the scene chain within each act.**
  Global scene numbers concatenate across acts; per-act numbers restart at 1.
- **Validation is per-act:** each act must have exactly one root scene (no
  incoming order edge from a fellow member). An act with 2+ roots flags those
  scenes red (`isInvalidRoot`) and the act is in `invalidActIds`.
- Filenames = kebab-cased node name (extension-created). Skill/imported scenes
  keep their `NNN-*.md` names untouched.
- `syncSceneNumbers()` writes derived `scene:`/`chapter:` back into each scene's
  frontmatter. Opening a migrated book WILL rewrite frontmatter for renumbered
  scenes (one-time, expected — may show in version control).

### Migration (v1 -> v2)
`ManuscriptManager.migrate()` runs on `load()`. A v1 file (nodes/edges, no
`acts`) is wrapped into a single **"Act 1"** containing all scenes in their old
global chain order. `importFromFolder()` also produces v2 with one "Act 1".
Existing v2 files are normalized (fills missing act fields). This was the chosen
approach because it's the easiest to maintain and makes adopting existing flat
manuscripts trivial (see Decisions).

---

## Feature status

### DONE and working
- New manuscript scaffold; Import existing manuscript (pick its `overview.md`;
  scenes ordered by `NNN-` prefix then frontmatter `scene:`; skips
  `_template.md`/`README.md`; refuses if `outline.flow.json` exists).
- Overview in the tree (opens the editor via `OVERVIEW_ID`); editable
  frontmatter fields incl. Language dropdown (en_US/en_GB) + section inserts;
  saves to `overview.md`.
- Editor: TipTap WYSIWYG, per-kind fields, section-insert buttons.
- **Spellcheck**: engine is **nspell** (pure JS) — NOT hunspell-asm (that was
  abandoned; it fails to bundle under Vite: `nanoid`/Emscripten
  "e is not a function"). nspell reads the same `dictionary-en(-gb)` .aff/.dic.
  US/UK stored in `overview.md` frontmatter `language:`. Custom words persist in
  `.claude/custom-words.txt`. Underlines via a ProseMirror plugin; right-click =
  suggestions + "Add to dictionary". CSP has NO `wasm-unsafe-eval` (not needed).
- Diagram: draggable nodes (useNodesState/useEdgesState); node copy/paste
  (Ctrl/Cmd+C then V duplicates, no edges); per-node delete "x" (hover) with
  modal confirm + file delete; suppressed native context menu; selected-node ring.
- **Edge delete/kind toggle**: custom edge (`edges.tsx`, type `"flow"`) renders
  two midpoint buttons on hover — arrow toggles order<->logical, "x" deletes.
  (Clicking an edge no longer cycles kind; that was the old broken behavior.)
- **Acts in the tree (this session):** Scenes group `+` creates an act (prompts
  name). Acts are collapsible rows "N. Name" with scene count; expand to their
  scenes in per-act chain order. Hover shows inline: `+` add-scene-to-act, up,
  down, trash(delete-act). Right-click also has rename + delete. Delete-act warns
  modally it will delete all N scenes + files.
- **Delete from tree (this session):** scenes/characters/places have an inline
  trash icon (hover) + right-click Delete, with modal confirm + file delete.
- Tree provider always registers a data provider (even with no manuscript — shows
  a hint row) to avoid "no data provider registered". Extension activates and
  registers the provider first thing in `activate`.
- **Multi-manuscript tree + panels:** root of the tree lists every folder in
  the workspace (or its immediate subfolders) containing `outline.flow.json`;
  click a manuscript row (or its inline diagram icon) to open its diagram.
  Diagram and editor panels are keyed per manuscript, so multiple books' work
  can be open side by side. See "Multi-manuscript support" above for the
  mechanics.

### DEFERRED — next major piece: ACTS ON THE DIAGRAM CANVAS
All host methods + message types already exist and are wired in `diagramPanel`:
`addAct`, `renameAct`, `deleteAct`, `moveAct`, `connectActs`, `setActCollapsed`,
`moveActPosition`, `moveSceneToAct`, `addSceneToAct`. What's NOT built yet is the
React Flow UI in `webview-diagram/`:
- Act **container nodes** holding scene nodes (React Flow parent/child).
- Act-to-act connections define act order (call `connectActs`).
- Double-click act = expand/collapse (collapsed = single node w/ scene count;
  persist via `setActCollapsed`).
- **Drag a scene from one act to another** (call `moveSceneToAct`) — the hardest
  part (parent reassignment on drag-in/out).
- Delete act on canvas must warn (all scenes + files) — reuse the panel's
  `deleteAct` confirm.
The diagram currently still renders scenes+edges as before; its warning banner
now reports acts-with-multiple-starts (`invalidActIds.length`) instead of the old
global `rootCount` (which was removed from `DiagramState`).

### Known / deferred smaller items
- Mid-chain scene delete leaves a gap (detached scenes stay in the act, unlinked)
  rather than auto-rejoining. Deliberate; not yet requested to change.
- Editing Language in Overview updates the file but already-open scene editors
  won't reload the dictionary until reopened (no live broadcast).
- Act rows can look crowded with 4 inline icons in a narrow sidebar; VS Code
  collapses overflow to "...". Could move rename/arrows to right-click only if asked.
- `outline.md` is no longer created by scaffold (the diagram replaces it). The
  CLAUDE.md template still references it — harmless.
- A duplicated scene joins the same act as its source (keeps the "every scene in
  an act" invariant).
- **Fixed (this session, two attempts): editor panels cascading new columns.**
  `EditorPanel` originally passed `ViewColumn.Beside` to `createWebviewPanel`
  on every open; VS Code's `Beside` opens a *new* group beside whatever's
  active each time, so clicking through several scenes cascaded a new column
  per click instead of adding tabs.
  - First attempt: cache the column the first editor resolves to
    (`panel.viewColumn` after creation) and reuse that for later opens. This
    did NOT work — `viewColumn` isn't reliably populated synchronously right
    after `createWebviewPanel` returns, so the cached value stayed
    `undefined` and every open kept falling back to `Beside`.
  - Working fix: use a **fixed column constant** (`EDITOR_COLUMN =
    ViewColumn.Two` in `editorPanel.ts`) for every editor open, instead of
    `Beside` at all. Deterministic, no dependency on reading anything back
    from the panel. `DiagramPanel` already did the equivalent thing
    (`ViewColumn.One`, fixed) and was never affected by this bug.
  - If this resurfaces: check whether `vscode.window.tabGroups` shows editors
    landing in a column other than Two, which would mean something upstream
    (e.g. a `"workbench.editor.openSideBySideDirection"` user setting, or
    VS Code changing how a fixed `ViewColumn` resolves when that column
    doesn't already exist) is overriding the explicit column — that's a
    different failure mode than the `Beside` cascade this fixed.

---

## Decisions log (why things are the way they are)

- **Acts as `acts[]` in the flow file** (not folders on disk, not a node kind):
  easiest to maintain, no file moves on reorder, trivial to adopt existing flat
  manuscripts, keeps scene files stable. Chosen over folders (fragile, hard to
  migrate) and over act-as-node (pollutes all node code with a fileless kind).
- **Scene->act by the act's `sceneIds` list** (not a field on the scene).
- **No cross-act scene connections.** Order = act order then intra-act chain.
- **Existing manuscripts auto-migrate** to a single "Act 1" on open.
- **`part:` frontmatter is NOT written back** from acts — acts live only in the
  flow file. (The scene template has a `part:` field; we leave it alone.)
- **Deleting an act deletes its scenes' files too** (with a modal warning).
- **Adding a scene with no act is blocked** (guides user to create an act).
- **nspell over hunspell-asm** for spellcheck (bundling reliability).
- **esbuild-bundled host** so the `.vsix` has no node_modules runtime dependency.
- **Manuscript discovery = workspace folder + its immediate subfolders only**
  (not fully recursive): matches the author's actual layout (a `books/`
  repo with one flat subfolder per book) without the cost/ambiguity of
  scanning arbitrarily deep. Detection rule is strictly "does this folder
  directly contain `outline.flow.json`" — deliberately *not* also
  `overview.md`, so a skill-created-but-not-yet-imported folder doesn't show
  up as a half-working manuscript row; run Import first.
- **Multiple diagram panels allowed, one per manuscript** (not a single
  shared panel): the author wants to compare/reference two books' flows
  side by side. Editor panels follow the same per-manuscript keying for
  consistency (and because `OVERVIEW_ID` collides across books otherwise).

---

## Testing checklist after changes
1. `npm run typecheck:extension` (esbuild won't catch type errors).
2. `npm run build` — watch for esbuild errors (warnings about gray-matter
   dynamic require are OK).
3. F5 or package+install; reload window; confirm version in Extensions panel.
4. Spellcheck: type "recieve" (flags) and "colour" (should NOT flag under en_GB).
5. Migration: open an imported book — expect one "Act 1" with all scenes in
   order; `outline.flow.json` shows `"version": 2` + `acts`.
6. Acts: create a 2nd act, add a scene — global numbering continues across acts,
   per-act numbering restarts; tree shows both.
7. Delete: act (warns re: scenes+files) and individual nodes (warns re: file).
8. Multi-manuscript: open a folder containing 2+ book subfolders (each with
   its own `outline.flow.json`) — tree root should list one row per book by
   folder name. Open both books' diagrams — expect two separate panel tabs,
   each still live (editing one doesn't affect the other). Open "Overview"
   for both — expect two editor tabs titled `Overview — <book>` (distinct
   books, not one tab reused). Still also test opening a single book's
   folder directly (old single-manuscript workflow) — its own folder should
   appear as the one tree row.
