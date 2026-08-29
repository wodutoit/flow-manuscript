# Flow Manuscript

A VS Code extension for planning and writing novels as a **scene flow diagram** backed by plain Markdown files.

- **Diagram canvas** (React Flow) — scene, character, and place nodes on one canvas. Solid arrows set story order; dashed arrows mark POV / logical links between scenes. Characters and places are free-standing nodes (never connected).
- **Left hierarchy** — the *Manuscript* view lists Scenes (in story order), Characters, and Places.
- **Rich Markdown editor** (TipTap) — double-click a node to edit. A frontmatter header (name, POV, goal, status, etc.) sits above a WYSIWYG body with bold/italic/underline, H1–H6, lists, quotes, and one-click section inserts. Everything saves straight to the node's `.md` file.
- **Single-start rule** — if two scenes both lack an incoming order arrow, they render **red**: there must be exactly one Scene 1.
- **Spell check** — the editor surface uses the native spell checker.

It reproduces the `new-manuscript` skill's folder structure natively, so manuscripts created here are identical to skill-scaffolded ones.

## Folder layout of a manuscript

```
<slug>/
  CLAUDE.md  README.md  overview.md  outline.md
  outline.flow.json        ← graph: nodes, positions, edges (managed by the extension)
  .claude/README.md
  scenes/       _template.md + <scene-name>.md
  characters/   _template.md + <character-name>.md
  places/       _template.md + <place-name>.md
```

Scene `.md` files are named from the scene name (kebab-case). The **scene number is not in the filename** — it lives in the frontmatter (`scene:` / `chapter:`) and is derived from the solid-edge chain, then written back automatically. Renaming a scene renames its file.

> Note: this drops the skill's `NNN-` filename prefix in favour of graph-driven ordering. On-disk files no longer sort in story order; the manifest and frontmatter carry order instead. The `scene:` number is still written to frontmatter so `compile-manuscript` keeps working.

## Series of books

A folder whose `outline.flow.json` contains a **`books`** array (instead of the
`acts`/`nodes`/`edges` of a manuscript) is a **series**. Each entry names an
immediate subfolder that is an ordinary manuscript:

```
society-series/
  outline.flow.json        <- books[] + order edges between them
  society-1-unbound-union/     outline.flow.json, scenes/, characters/, ...
  society-2-leading-chaos/     outline.flow.json, ...
```

```json
{
  "version": 2,
  "books": [
    { "id": "b1", "name": "society-1-unbound-union", "order": 1,
      "position": { "x": 40, "y": 80 }, "size": { "width": 260, "height": 132 } }
  ],
  "edges": [{ "id": "e1", "kind": "order", "source": "b1", "target": "b2" }]
}
```

`name` is the folder name; the optional `title` is what the UI shows when set.
Missing `id`, `order`, `position` and `size` are filled in on load, so a
hand-written file only really needs `name` per book.

- **Tree** — the series is one top-level row (library icon). Expanding it lists
  its books in reading order; expanding a book gives the usual Overview /
  Scenes / Characters / Places. Books in a series are not also listed at the top
  level, so a book appears exactly once.
- **Series diagram** — click the series row (or its diagram icon) for a canvas
  of book nodes joined by order arrows. Drag to arrange, connect two books to
  set reading order, select an arrow to delete it. Every book-level control
  (acts, scenes, characters, places, duplicate, edge kinds) is absent here —
  none of it means anything at the series level.
- **Open a book's diagram** — each book node has a ⎇ icon; clicking it (or
  double-clicking the node) opens that book's own diagram in the editor column
  **beside** the series canvas, so both stay visible.
- **Add a book** — the `+` on the series row, or **+ Book** on the series
  canvas. It runs the same prompts as New Manuscript, scaffolds the full
  manuscript inside the series folder, and appends it to the end of the chain.

Like an act, a series should have exactly one starting book: if two books both
lack an incoming arrow, they render red.

## Requirements

- Node.js 18+ and npm
- VS Code 1.90+

## Build

```bash
npm install
npm run build      # builds extension host + both webview bundles
```

```bash
npm install
npm run build
npm run package
code --install-extension flow-manuscript-0.2.1.vsix --force
```

This produces:
- `dist-extension/` — compiled extension host (CommonJS)
- `dist-diagram/index.js` + `index.css` — the diagram webview
- `dist-editor/index.js` + `index.css` — the editor webview

## Run it locally

1. Open this folder in VS Code.
2. Press **F5** (Run Extension). A second VS Code window opens with the extension loaded.
3. In that window: **Cmd/Ctrl-Shift-P → “Flow Manuscript: New Manuscript…”**, answer the prompts, and open the created folder.
4. Click the **Flow Manuscript** icon in the activity bar, then the diagram icon in the view title to open the canvas.

To create a `.vsix` you can install elsewhere: `npm run package`.

## How it fits together

```
Extension host (Node)                     Webviews (React)
─────────────────────                     ────────────────
extension.ts        commands, tree wiring
manuscriptManager   files, flow.json,     ⇄  diagram  (React Flow)
                    scene numbering            App.tsx / nodes.tsx
graph.ts            order + root rules
treeProvider.ts     left hierarchy        ⇄  editor   (TipTap)
diagramPanel.ts     ⇄ diagram bridge          App.tsx / Toolbar.tsx
editorPanel.ts      ⇄ editor bridge
frontmatter.ts      md parse/serialize
```

The host owns all disk I/O; webviews communicate only via `postMessage`. Types for the bridge live in `src/shared/types.ts` and are imported by both sides.

## Known enhancements (not yet built)

- Title the tree view with the manuscript name (currently a static “Manuscript”).
- Live-reload the editor if the `.md` is edited outside the extension.
- Drag-to-reorder in the tree.
- Configurable spell-check dictionary / custom words.
- Compile integration (`compiled/` output).

## License

MIT
