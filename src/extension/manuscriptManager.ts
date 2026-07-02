import * as vscode from "vscode";
import { randomUUID } from "crypto";
import * as path from "path";
import {
  parseDoc,
  serializeDoc,
  toSlug,
} from "./frontmatter";
import { buildDiagramState, deriveSceneNumbers } from "./graph";
import type {
  FlowDocument,
  FlowNode,
  FlowEdge,
  Act,
  NodeKind,
  EdgeKind,
  ManuscriptMeta,
  DiagramState,
} from "../shared/types";

const FLOW_FILE = "outline.flow.json";
const EMPTY_FLOW: FlowDocument = { version: 2, acts: [], nodes: [], edges: [] };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Read a bundled template shipped inside the extension. */
async function readTemplate(
  extensionUri: vscode.Uri,
  name: string
): Promise<string> {
  const uri = vscode.Uri.joinPath(extensionUri, "templates", name);
  return dec.decode(await vscode.workspace.fs.readFile(uri));
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export class ManuscriptManager {
  private flow: FlowDocument = EMPTY_FLOW;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly root: vscode.Uri,
    private readonly extensionUri: vscode.Uri
  ) {}

  get rootUri() {
    return this.root;
  }

  // -- flow persistence ------------------------------------------------------

  private flowUri() {
    return vscode.Uri.joinPath(this.root, FLOW_FILE);
  }

  async load(): Promise<void> {
    try {
      const raw = dec.decode(await vscode.workspace.fs.readFile(this.flowUri()));
      const parsed = JSON.parse(raw) as Partial<FlowDocument> & {
        nodes?: FlowNode[];
        edges?: FlowEdge[];
      };
      this.flow = this.migrate(parsed);
    } catch {
      this.flow = { version: 2, acts: [], nodes: [], edges: [] };
      await this.persist();
    }
  }

  /**
   * Normalize any older flow document to the current v2 shape. A v1 file has
   * nodes/edges but no `acts`; we wrap all existing scenes into a single
   * "Act 1", preserving their current chain order. Scene .md files are never
   * touched by this.
   */
  private migrate(
    parsed: Partial<FlowDocument> & { nodes?: FlowNode[]; edges?: FlowEdge[] }
  ): FlowDocument {
    const nodes = parsed.nodes ?? [];
    const edges = parsed.edges ?? [];

    if (Array.isArray(parsed.acts)) {
      // Already v2 (or close enough) — ensure required fields exist.
      return {
        version: 2,
        acts: parsed.acts.map((a, i) => ({
          id: a.id ?? randomUUID(),
          name: a.name ?? `Act ${i + 1}`,
          order: typeof a.order === "number" ? a.order : i + 1,
          sceneIds: Array.isArray(a.sceneIds) ? a.sceneIds : [],
          collapsed: a.collapsed ?? false,
          position: a.position,
        })),
        nodes,
        edges,
      };
    }

    // v1 -> v2 migration. Order the existing scenes by walking the old global
    // chain so "Act 1" preserves the sequence the author already had.
    const legacyDoc: FlowDocument = { version: 2, acts: [], nodes, edges };
    const sceneIds = this.legacyOrderedSceneIds(legacyDoc);

    const migrated: FlowDocument = {
      version: 2,
      nodes,
      edges,
      acts:
        sceneIds.length > 0
          ? [
              {
                id: randomUUID(),
                name: "Act 1",
                order: 1,
                sceneIds,
                collapsed: false,
              },
            ]
          : [],
    };
    return migrated;
  }

  /**
   * v1 ordering helper: walk order edges globally (single-root assumption of
   * the old model) to produce a stable scene sequence for migration.
   */
  private legacyOrderedSceneIds(doc: FlowDocument): string[] {
    const scenes = doc.nodes.filter((n) => n.kind === "scene");
    const sceneSet = new Set(scenes.map((s) => s.id));
    const nextOf = new Map<string, string>();
    const hasIncoming = new Set<string>();
    for (const e of doc.edges) {
      if (e.kind !== "order") continue;
      if (!nextOf.has(e.source)) nextOf.set(e.source, e.target);
      if (sceneSet.has(e.target)) hasIncoming.add(e.target);
    }
    const roots = scenes.map((s) => s.id).filter((id) => !hasIncoming.has(id));
    const visited = new Set<string>();
    const out: string[] = [];
    const walk = (start: string) => {
      let cur: string | undefined = start;
      while (cur && !visited.has(cur)) {
        visited.add(cur);
        out.push(cur);
        cur = nextOf.get(cur);
      }
    };
    for (const r of [...roots].sort((a, b) => (a < b ? -1 : 1))) walk(r);
    for (const s of scenes) if (!visited.has(s.id)) walk(s.id);
    return out;
  }

  private async persist(): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this.flowUri(),
      enc.encode(JSON.stringify(this.flow, null, 2) + "\n")
    );
  }

  // -- scaffolding a new manuscript -----------------------------------------

  /**
   * Reproduces the `new-manuscript` skill structure natively.
   * `target` is the folder that will BECOME the manuscript root.
   */
  static async scaffold(
    extensionUri: vscode.Uri,
    target: vscode.Uri,
    meta: ManuscriptMeta
  ): Promise<void> {
    const vars: Record<string, string> = {
      title: meta.title,
      slug: meta.slug,
      genre: meta.genre,
      pov: meta.pov,
      tense: meta.tense,
      logline: meta.logline,
    };

    const write = async (rel: string, contents: string) => {
      const uri = vscode.Uri.joinPath(target, ...rel.split("/"));
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(uri, "..")
      );
      await vscode.workspace.fs.writeFile(uri, enc.encode(contents));
    };

    const tpl = (name: string) => readTemplate(extensionUri, name);

    // Files that take placeholder substitution.
    await write("CLAUDE.md", fill(await tpl("CLAUDE.md.template"), vars));
    await write("README.md", fill(await tpl("README.md.template"), vars));
    await write("overview.md", fill(await tpl("overview.md.template"), vars));
    // Files with no placeholders.
    await write(".claude/README.md", await tpl("claude-folder-README.md.template"));
    await write("scenes/README.md", await tpl("scenes-README.md.template"));
    await write("scenes/_template.md", await tpl("scene.md.template"));
    await write("characters/README.md", await tpl("characters-README.md.template"));
    await write("characters/_template.md", await tpl("character.md.template"));
    await write("places/README.md", await tpl("places-README.md.template"));
    await write("places/_template.md", await tpl("place.md.template"));

    // Author name + language go into overview frontmatter.
    {
      const ovUri = vscode.Uri.joinPath(target, "overview.md");
      const ov = dec.decode(await vscode.workspace.fs.readFile(ovUri));
      const parsed = parseDoc<Record<string, unknown>>(ov);
      if (meta.author) parsed.frontmatter.author = meta.author;
      parsed.frontmatter.language = meta.language;
      await vscode.workspace.fs.writeFile(
        ovUri,
        enc.encode(serializeDoc(parsed.frontmatter, parsed.body))
      );
    }

    // Seed an empty per-manuscript custom words list for the spellchecker.
    await write(".claude/custom-words.txt", "");

    // Seed an empty flow doc so the diagram opens cleanly.
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(target, FLOW_FILE),
      enc.encode(JSON.stringify(EMPTY_FLOW, null, 2) + "\n")
    );
  }

  // -- importing an existing (skill-created) manuscript ---------------------

  /**
   * Build an outline.flow.json for an existing manuscript folder that already
   * has overview.md + scenes/ + characters/ + places/ but no flow file.
   *
   * - Every .md in each folder (except _template.md and README.md) becomes a node.
   * - Scene order: the leading NNN- filename prefix wins; if absent, the
   *   frontmatter `scene:` number is used; scenes with neither are left
   *   unconnected. Ordered scenes are chained with solid "order" edges.
   * - Characters and places are always unconnected nodes.
   * - Existing filenames are never changed.
   *
   * Returns a summary, or throws if a flow file already exists (caller warns).
   */
  static async importFromFolder(
    root: vscode.Uri
  ): Promise<{ scenes: number; characters: number; places: number; ordered: number }> {
    const flowUri = vscode.Uri.joinPath(root, FLOW_FILE);
    // Refuse if a flow file already exists.
    try {
      await vscode.workspace.fs.stat(flowUri);
      throw new Error("exists");
    } catch (e: any) {
      if (e && e.message === "exists") throw e;
      // otherwise: not found, good to proceed
    }

    const isSkippable = (name: string) =>
      name === "_template.md" ||
      name.toLowerCase() === "readme.md" ||
      !name.toLowerCase().endsWith(".md");

    const listMd = async (folder: string): Promise<string[]> => {
      try {
        const entries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.joinPath(root, folder)
        );
        return entries
          .filter(([, type]) => type === vscode.FileType.File)
          .map(([name]) => name)
          .filter((name) => !isSkippable(name));
      } catch {
        return []; // folder may not exist
      }
    };

    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];

    // Helper: read a file's frontmatter name, tolerating read errors.
    const readName = async (rel: string, fallback: string): Promise<{ name: string; scene?: number }> => {
      try {
        const raw = dec.decode(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...rel.split("/")))
        );
        const { frontmatter } = parseDoc<Record<string, unknown>>(raw);
        const name =
          typeof frontmatter.name === "string" && frontmatter.name.trim()
            ? (frontmatter.name as string)
            : fallback;
        const scene =
          typeof frontmatter.scene === "number" ? (frontmatter.scene as number) : undefined;
        return { name, scene };
      } catch {
        return { name: fallback };
      }
    };

    const stemOf = (file: string) => file.replace(/\.md$/i, "");
    const prefixNum = (file: string): number | undefined => {
      const m = /^(\d{1,})[-_]/.exec(file);
      return m ? parseInt(m[1], 10) : undefined;
    };

    // --- scenes ---
    const sceneFiles = await listMd("scenes");
    interface SceneImp {
      node: FlowNode;
      order?: number; // resolved ordering key, if any
    }
    const scenes: SceneImp[] = [];
    for (const file of sceneFiles) {
      const rel = `scenes/${file}`;
      const { name, scene } = await readName(rel, stemOf(file));
      // Order key: filename prefix wins, else frontmatter scene:.
      const order = prefixNum(file) ?? scene;
      scenes.push({
        node: {
          id: randomUUID(),
          kind: "scene",
          file: rel,
          name,
          position: { x: 0, y: 0 },
        },
        order,
      });
    }

    // Split ordered vs unordered; chain the ordered ones. All scenes go into a
    // single "Act 1" (membership), preserving the resolved order.
    const ordered = scenes
      .filter((s) => s.order !== undefined)
      .sort((a, b) => (a.order! - b.order!) || a.node.file.localeCompare(b.node.file));
    const unordered = scenes.filter((s) => s.order === undefined);

    const actSceneIds: string[] = [];
    ordered.forEach((s, i) => {
      s.node.position = { x: 80 + i * 220, y: 80 };
      nodes.push(s.node);
      actSceneIds.push(s.node.id);
      if (i > 0) {
        edges.push({
          id: randomUUID(),
          kind: "order",
          source: ordered[i - 1].node.id,
          target: s.node.id,
        });
      }
    });
    unordered.forEach((s, i) => {
      s.node.position = { x: 80 + i * 220, y: 200 };
      nodes.push(s.node);
      actSceneIds.push(s.node.id);
    });

    // --- characters ---
    const charFiles = await listMd("characters");
    let ci = 0;
    for (const file of charFiles) {
      const rel = `characters/${file}`;
      const { name } = await readName(rel, stemOf(file));
      nodes.push({
        id: randomUUID(),
        kind: "character",
        file: rel,
        name,
        position: { x: 80 + ci++ * 200, y: 340 },
      });
    }

    // --- places ---
    const placeFiles = await listMd("places");
    let pi = 0;
    for (const file of placeFiles) {
      const rel = `places/${file}`;
      const { name } = await readName(rel, stemOf(file));
      nodes.push({
        id: randomUUID(),
        kind: "place",
        file: rel,
        name,
        position: { x: 80 + pi++ * 200, y: 460 },
      });
    }

    const acts: Act[] =
      actSceneIds.length > 0
        ? [
            {
              id: randomUUID(),
              name: "Act 1",
              order: 1,
              sceneIds: actSceneIds,
              collapsed: false,
            },
          ]
        : [];

    const doc: FlowDocument = { version: 2, acts, nodes, edges };
    await vscode.workspace.fs.writeFile(
      flowUri,
      enc.encode(JSON.stringify(doc, null, 2) + "\n")
    );

    return {
      scenes: scenes.length,
      characters: charFiles.length,
      places: placeFiles.length,
      ordered: ordered.length,
    };
  }

  // -- node lookups ----------------------------------------------------------

  getNode(id: string): FlowNode | undefined {
    return this.flow.nodes.find((n) => n.id === id);
  }

  // -- acts ------------------------------------------------------------------

  getActs(): Act[] {
    return [...this.flow.acts].sort((a, b) => a.order - b.order);
  }

  getAct(id: string): Act | undefined {
    return this.flow.acts.find((a) => a.id === id);
  }

  /** The act a scene belongs to, if any. */
  actOfScene(sceneId: string): Act | undefined {
    return this.flow.acts.find((a) => a.sceneIds.includes(sceneId));
  }

  private renumberActs() {
    this.getActs().forEach((a, i) => (a.order = i + 1));
  }

  /** Create a new act at the end. Returns it. */
  async createAct(name: string): Promise<Act> {
    const act: Act = {
      id: randomUUID(),
      name: name.trim() || `Act ${this.flow.acts.length + 1}`,
      order: this.flow.acts.length + 1,
      sceneIds: [],
      collapsed: false,
    };
    this.flow.acts.push(act);
    this.renumberActs();
    await this.persist();
    this._onDidChange.fire();
    return act;
  }

  async renameAct(id: string, name: string) {
    const act = this.getAct(id);
    if (!act || !name.trim()) return;
    act.name = name.trim();
    await this.persist();
    this._onDidChange.fire();
  }

  /** Move an act up or down in the ordering. */
  async moveAct(id: string, direction: "up" | "down") {
    const ordered = this.getActs();
    const idx = ordered.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= ordered.length) return;
    const a = ordered[idx];
    const b = ordered[swapWith];
    const tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    this.renumberActs();
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  /** Reorder acts by connecting one act to another (source comes before target). */
  async connectActs(sourceActId: string, targetActId: string) {
    if (sourceActId === targetActId) return;
    const ordered = this.getActs();
    const src = ordered.find((a) => a.id === sourceActId);
    const tgt = ordered.find((a) => a.id === targetActId);
    if (!src || !tgt) return;
    // Place source immediately before target in the ordering.
    const without = ordered.filter((a) => a.id !== sourceActId);
    const tgtIdx = without.findIndex((a) => a.id === targetActId);
    without.splice(tgtIdx, 0, src);
    without.forEach((a, i) => (a.order = i + 1));
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  async setActCollapsed(id: string, collapsed: boolean) {
    const act = this.getAct(id);
    if (!act) return;
    act.collapsed = collapsed;
    await this.persist();
    this._onDidChange.fire();
  }

  async moveActPosition(id: string, position: { x: number; y: number }) {
    const act = this.getAct(id);
    if (!act) return;
    act.position = position;
    await this.persist();
    // cosmetic; no event
  }

  /**
   * Delete an act and ALL its scenes (files included). Returns the number of
   * scenes removed so the caller can report it. The caller is responsible for
   * confirming with the user first.
   */
  async deleteAct(id: string): Promise<number> {
    const act = this.getAct(id);
    if (!act) return 0;
    const sceneIds = [...act.sceneIds];
    // Remove the scenes (and their files) first.
    for (const sid of sceneIds) {
      const node = this.getNode(sid);
      if (!node) continue;
      this.flow.nodes = this.flow.nodes.filter((n) => n.id !== sid);
      this.flow.edges = this.flow.edges.filter(
        (e) => e.source !== sid && e.target !== sid
      );
      try {
        await vscode.workspace.fs.delete(this.nodeUri(node), { useTrash: true });
      } catch {
        /* already gone */
      }
    }
    this.flow.acts = this.flow.acts.filter((a) => a.id !== id);
    this.renumberActs();
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
    return sceneIds.length;
  }

  /** Move a scene from its current act into another act (appended to its chain). */
  async moveSceneToAct(sceneId: string, actId: string) {
    const node = this.getNode(sceneId);
    const target = this.getAct(actId);
    if (!node || node.kind !== "scene" || !target) return;
    const current = this.actOfScene(sceneId);
    if (current?.id === actId) return;

    // Remove any order edges that crossed the old act boundary (all its edges,
    // since edges are intra-act only). Detach cleanly.
    this.flow.edges = this.flow.edges.filter(
      (e) =>
        !(
          (e.source === sceneId || e.target === sceneId) && e.kind === "order"
        )
    );
    if (current) {
      current.sceneIds = current.sceneIds.filter((s) => s !== sceneId);
    }
    // Append to the target act, chaining after its current last scene.
    const lastId = this.lastSceneOfAct(target);
    target.sceneIds.push(sceneId);
    if (lastId) {
      this.flow.edges.push({
        id: randomUUID(),
        kind: "order",
        source: lastId,
        target: sceneId,
      });
    }
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  /** The last scene in an act's chain (or undefined if empty). */
  private lastSceneOfAct(act: Act): string | undefined {
    if (act.sceneIds.length === 0) return undefined;
    const members = new Set(act.sceneIds);
    const hasOutgoing = new Set<string>();
    for (const e of this.flow.edges) {
      if (e.kind === "order" && members.has(e.source) && members.has(e.target)) {
        hasOutgoing.add(e.source);
      }
    }
    // The tail is a member with no outgoing intra-act order edge. Prefer one
    // that is reachable; fall back to the last in the list.
    const tail = act.sceneIds.find((s) => !hasOutgoing.has(s));
    return tail ?? act.sceneIds[act.sceneIds.length - 1];
  }

  nodeUri(node: FlowNode): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...node.file.split("/"));
  }

  private folderFor(kind: NodeKind): string {
    return kind === "scene" ? "scenes" : kind === "character" ? "characters" : "places";
  }

  private templateFor(kind: NodeKind): string {
    return kind === "scene"
      ? "scene.md.template"
      : kind === "character"
      ? "character.md.template"
      : "place.md.template";
  }

  // -- creating a node -------------------------------------------------------

  /**
   * Create a new node of `kind`, backed by a fresh .md file from template.
   * For scenes: `name` and `pov` are supplied by the caller (prompted in UI);
   * the scene number is derived, not asked for.
   */
  async createNode(
    kind: NodeKind,
    name: string,
    extra: { pov?: string; afterNodeId?: string; actId?: string } = {}
  ): Promise<FlowNode> {
    // Scenes must belong to an act. Resolve the target act up front.
    let targetAct: Act | undefined;
    if (kind === "scene") {
      targetAct = extra.actId ? this.getAct(extra.actId) : undefined;
      // If created after an existing scene, inherit that scene's act.
      if (!targetAct && extra.afterNodeId) {
        targetAct = this.actOfScene(extra.afterNodeId);
      }
      if (!targetAct) {
        throw new Error("no-act");
      }
    }

    const folder = this.folderFor(kind);
    const stem = await this.uniqueStem(folder, toSlug(name));
    const rel = `${folder}/${stem}.md`;

    // Materialize the file from its template, patching frontmatter.
    const template = await readTemplate(this.extensionUri, this.templateFor(kind));
    const parsed = parseDoc<Record<string, unknown>>(template);
    parsed.frontmatter.name = name;
    if (kind === "scene") {
      parsed.frontmatter.pov = extra.pov ?? "";
      // scene/chapter numbers are patched by syncSceneNumbers after wiring edges
    }
    // Replace the leading "# <Name>" heading placeholder if present.
    const body = parsed.body.replace(/^#\s+<[^>]+>/m, `# ${name}`);

    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.root, ...rel.split("/")),
      enc.encode(serializeDoc(parsed.frontmatter, body))
    );

    const node: FlowNode = {
      id: randomUUID(),
      kind,
      file: rel,
      name,
      position: this.suggestPosition(kind),
    };
    this.flow.nodes.push(node);

    if (kind === "scene" && targetAct) {
      // Determine which scene to chain after: explicit afterNodeId (if it's in
      // this act), else the act's current last scene.
      let afterId = extra.afterNodeId;
      if (!afterId || !targetAct.sceneIds.includes(afterId)) {
        afterId = this.lastSceneOfAct(targetAct);
      }
      targetAct.sceneIds.push(node.id);
      if (afterId) this.insertAfter(afterId, node.id);
    }

    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
    return node;
  }

  /**
   * Duplicate an existing node: byte-for-byte copy of its .md into a new file,
   * with "copy" appended to the display name (and "-copy" to the filename).
   * The new node is placed offset from the original and has NO edges.
   */
  async duplicateNode(id: string): Promise<FlowNode | undefined> {
    const src = this.getNode(id);
    if (!src) return undefined;

    const newName = `${src.name} copy`;
    const folder = this.folderFor(src.kind);
    const stem = await this.uniqueStem(folder, toSlug(newName));
    const rel = `${folder}/${stem}.md`;

    // Full copy of the source document, with the name updated in frontmatter
    // and the leading heading so the copy is self-consistent.
    const { frontmatter, body } = await this.readDoc(src);
    frontmatter.name = newName;
    const newBody = body.replace(/^#\s+.+$/m, `# ${newName}`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.root, ...rel.split("/")),
      enc.encode(serializeDoc(frontmatter, newBody))
    );

    const node: FlowNode = {
      id: randomUUID(),
      kind: src.kind,
      file: rel,
      name: newName,
      position: { x: src.position.x + 40, y: src.position.y + 40 },
    };
    this.flow.nodes.push(node);

    // A duplicated scene joins the same act as its source (unconnected within
    // it), preserving the "every scene is in an act" invariant.
    if (src.kind === "scene") {
      const act = this.actOfScene(src.id);
      if (act) act.sceneIds.push(node.id);
    }

    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
    return node;
  }

  /** Insert `newId` immediately after `afterId` in the order chain. */
  private insertAfter(afterId: string, newId: string) {
    const existing = this.flow.edges.find(
      (e) => e.kind === "order" && e.source === afterId
    );
    if (existing) {
      // afterId -> X  becomes  afterId -> new -> X
      this.flow.edges.push({
        id: randomUUID(),
        kind: "order",
        source: newId,
        target: existing.target,
      });
      existing.target = newId;
    } else {
      this.flow.edges.push({
        id: randomUUID(),
        kind: "order",
        source: afterId,
        target: newId,
      });
    }
  }

  private suggestPosition(kind: NodeKind): { x: number; y: number } {
    const sameKind = this.flow.nodes.filter((n) => n.kind === kind);
    const lane = kind === "scene" ? 0 : kind === "character" ? 220 : 360;
    return { x: 80 + sameKind.length * 200, y: 80 + lane };
  }

  private async uniqueStem(folder: string, base: string): Promise<string> {
    let stem = base;
    let i = 2;
    const exists = async (s: string) => {
      try {
        await vscode.workspace.fs.stat(
          vscode.Uri.joinPath(this.root, folder, `${s}.md`)
        );
        return true;
      } catch {
        return false;
      }
    };
    while (await exists(stem) || stem === "_template") {
      stem = `${base}-${i++}`;
    }
    return stem;
  }

  // -- editing -------------------------------------------------------------

  async readDoc(node: FlowNode) {
    const raw = dec.decode(await vscode.workspace.fs.readFile(this.nodeUri(node)));
    return parseDoc<Record<string, unknown>>(raw);
  }

  // -- overview.md (manuscript-level document) ------------------------------

  private overviewUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, "overview.md");
  }

  async readOverview() {
    const raw = dec.decode(
      await vscode.workspace.fs.readFile(this.overviewUri())
    );
    return parseDoc<Record<string, unknown>>(raw);
  }

  async saveOverviewBody(body: string) {
    const { frontmatter } = await this.readOverview();
    await vscode.workspace.fs.writeFile(
      this.overviewUri(),
      enc.encode(serializeDoc(frontmatter, body))
    );
  }

  async saveOverviewFrontmatter(patch: Record<string, unknown>) {
    const { frontmatter, body } = await this.readOverview();
    const merged = { ...frontmatter, ...patch };
    await vscode.workspace.fs.writeFile(
      this.overviewUri(),
      enc.encode(serializeDoc(merged, body))
    );
  }

  async saveBody(id: string, body: string) {
    const node = this.getNode(id);
    if (!node) return;
    const { frontmatter } = await this.readDoc(node);
    await vscode.workspace.fs.writeFile(
      this.nodeUri(node),
      enc.encode(serializeDoc(frontmatter, body))
    );
  }

  async saveFrontmatter(id: string, patch: Record<string, unknown>) {
    const node = this.getNode(id);
    if (!node) return;
    const { frontmatter, body } = await this.readDoc(node);
    const merged = { ...frontmatter, ...patch };
    await vscode.workspace.fs.writeFile(
      this.nodeUri(node),
      enc.encode(serializeDoc(merged, body))
    );
    // A name change in frontmatter should rename the node + file.
    if (typeof patch.name === "string" && patch.name !== node.name) {
      await this.renameNode(id, patch.name);
    }
  }

  /** Rename a node: update display name AND rename the backing file. */
  async renameNode(id: string, newName: string) {
    const node = this.getNode(id);
    if (!node) return;
    const folder = this.folderFor(node.kind);
    const newStem = await this.uniqueStem(folder, toSlug(newName));
    const newRel = `${folder}/${newStem}.md`;
    const oldUri = this.nodeUri(node);
    const newUri = vscode.Uri.joinPath(this.root, ...newRel.split("/"));

    // Update frontmatter name inside the file too.
    const { frontmatter, body } = await this.readDoc(node);
    frontmatter.name = newName;
    await vscode.workspace.fs.writeFile(
      oldUri,
      enc.encode(serializeDoc(frontmatter, body))
    );
    if (oldUri.path !== newUri.path) {
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    }
    node.name = newName;
    node.file = newRel;
    await this.persist();
    this._onDidChange.fire();
  }

  // -- graph mutations -------------------------------------------------------

  async moveNode(id: string, position: { x: number; y: number }) {
    const node = this.getNode(id);
    if (!node) return;
    node.position = position;
    await this.persist();
    // No event fire: position changes are cosmetic and already reflected client-side.
  }

  async connect(source: string, target: string, kind: EdgeKind) {
    const s = this.getNode(source);
    const t = this.getNode(target);
    // Only scenes participate in edges.
    if (!s || !t || s.kind !== "scene" || t.kind !== "scene") return;
    if (source === target) return;
    // Scenes may only connect within the same act (no cross-act edges).
    const sa = this.actOfScene(source);
    const ta = this.actOfScene(target);
    if (!sa || !ta || sa.id !== ta.id) return;
    // Prevent duplicate identical edges.
    const dup = this.flow.edges.some(
      (e) => e.kind === kind && e.source === source && e.target === target
    );
    if (dup) return;
    // A scene may only have one outgoing order edge (linear spine).
    if (kind === "order") {
      const existing = this.flow.edges.find(
        (e) => e.kind === "order" && e.source === source
      );
      if (existing) existing.target = target;
      else
        this.flow.edges.push({ id: randomUUID(), kind, source, target });
    } else {
      this.flow.edges.push({ id: randomUUID(), kind, source, target });
    }
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  async setEdgeKind(edgeId: string, kind: EdgeKind) {
    const e = this.flow.edges.find((x) => x.id === edgeId);
    if (!e) return;
    e.kind = kind;
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  async deleteEdge(edgeId: string) {
    this.flow.edges = this.flow.edges.filter((e) => e.id !== edgeId);
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  async deleteNode(id: string, opts: { deleteFile?: boolean } = {}) {
    const node = this.getNode(id);
    if (!node) return;
    this.flow.nodes = this.flow.nodes.filter((n) => n.id !== id);
    this.flow.edges = this.flow.edges.filter(
      (e) => e.source !== id && e.target !== id
    );
    // Remove from any act membership.
    for (const act of this.flow.acts) {
      const before = act.sceneIds.length;
      act.sceneIds = act.sceneIds.filter((s) => s !== id);
      if (act.sceneIds.length !== before) break;
    }
    if (opts.deleteFile) {
      try {
        await vscode.workspace.fs.delete(this.nodeUri(node), { useTrash: true });
      } catch {
        // file may already be gone; ignore
      }
    }
    await this.syncSceneNumbers();
    await this.persist();
    this._onDidChange.fire();
  }

  // -- derived scene numbers written back to frontmatter --------------------

  private async syncSceneNumbers() {
    const numbers = deriveSceneNumbers(this.flow);
    for (const node of this.flow.nodes) {
      if (node.kind !== "scene") continue;
      const n = numbers.get(node.id);
      if (!n) continue;
      try {
        const { frontmatter, body } = await this.readDoc(node);
        if (frontmatter.scene !== n || frontmatter.chapter !== n) {
          frontmatter.scene = n;
          frontmatter.chapter = n; // default one-scene-per-chapter convention
          await vscode.workspace.fs.writeFile(
            this.nodeUri(node),
            enc.encode(serializeDoc(frontmatter, body))
          );
        }
      } catch {
        // file may have been removed out from under us; skip
      }
    }
  }

  // -- spellcheck dictionary support ----------------------------------------

  /** Read the manuscript's chosen language from overview.md (default en_US). */
  async readLanguage(): Promise<string> {
    try {
      const ovUri = vscode.Uri.joinPath(this.root, "overview.md");
      const ov = dec.decode(await vscode.workspace.fs.readFile(ovUri));
      const { frontmatter } = parseDoc<Record<string, unknown>>(ov);
      const lang = frontmatter.language;
      if (lang === "en_GB" || lang === "en_US") return lang;
    } catch {
      /* fall through */
    }
    return "en_US";
  }

  private customWordsUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ".claude", "custom-words.txt");
  }

  async readCustomWords(): Promise<string[]> {
    try {
      const raw = dec.decode(
        await vscode.workspace.fs.readFile(this.customWordsUri())
      );
      return raw
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async addCustomWord(word: string): Promise<void> {
    const w = word.trim();
    if (!w) return;
    const existing = await this.readCustomWords();
    if (existing.includes(w)) return;
    existing.push(w);
    // Ensure the .claude folder exists, then write the sorted list.
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(this.root, ".claude")
    );
    await vscode.workspace.fs.writeFile(
      this.customWordsUri(),
      enc.encode(existing.sort((a, b) => a.localeCompare(b)).join("\n") + "\n")
    );
  }

  /**
   * Read the .aff/.dic for the manuscript's language from the bundled
   * dictionary npm packages, which live in the extension's own node_modules.
   * We read the files directly via the extension URI rather than
   * require.resolve, because these packages are ESM-only with a strict
   * `exports` map that blocks resolving subpaths like package.json.
   */
  async loadDictionary(): Promise<{
    language: string;
    aff: string;
    dic: string;
    customWords: string[];
  }> {
    const language = await this.readLanguage();
    const pkg = language === "en_GB" ? "dictionary-en-gb" : "dictionary-en";

    // Dictionaries are copied into a bundled `dictionaries/<pkg>/` folder at
    // build time (see scripts/copy-dictionaries), so they ship inside the
    // .vsix. Fall back to node_modules when running from source without that
    // copy step having run.
    const bundled = vscode.Uri.joinPath(
      this.extensionUri,
      "dictionaries",
      pkg
    );
    const fromNodeModules = vscode.Uri.joinPath(
      this.extensionUri,
      "node_modules",
      pkg
    );

    const readPair = async (base: vscode.Uri) => {
      const aff = dec.decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(base, "index.aff"))
      );
      const dic = dec.decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(base, "index.dic"))
      );
      return { aff, dic };
    };

    let pair: { aff: string; dic: string };
    try {
      pair = await readPair(bundled);
    } catch {
      pair = await readPair(fromNodeModules);
    }

    const customWords = await this.readCustomWords();
    return { language, aff: pair.aff, dic: pair.dic, customWords };
  }

  // -- diagram state assembly ------------------------------------------------

  async diagramState(): Promise<DiagramState> {
    const frontmatterByFile = new Map<string, { status?: string; pov?: string }>();
    for (const node of this.flow.nodes) {
      try {
        const { frontmatter } = await this.readDoc(node);
        frontmatterByFile.set(node.file, {
          status: frontmatter.status as string | undefined,
          pov: frontmatter.pov as string | undefined,
        });
      } catch {
        /* ignore */
      }
    }
    return buildDiagramState(this.flow, { frontmatterByFile });
  }
}
