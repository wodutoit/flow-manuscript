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
code --install-extension flow-manuscript-0.1.0.vsix --force
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
