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
  NodeKind,
  EdgeKind,
  ManuscriptMeta,
  DiagramState,
} from "../shared/types";

const FLOW_FILE = "outline.flow.json";
const EMPTY_FLOW: FlowDocument = { version: 1, nodes: [], edges: [] };

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
      this.flow = JSON.parse(raw) as FlowDocument;
      if (!this.flow.version) this.flow = { ...EMPTY_FLOW, ...this.flow };
    } catch {
      this.flow = { version: 1, nodes: [], edges: [] };
      await this.persist();
    }
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

  // -- node lookups ----------------------------------------------------------

  getNode(id: string): FlowNode | undefined {
    return this.flow.nodes.find((n) => n.id === id);
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
    extra: { pov?: string; afterNodeId?: string } = {}
  ): Promise<FlowNode> {
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

    // If created after another scene, insert an order edge and rewire.
    if (kind === "scene" && extra.afterNodeId) {
      this.insertAfter(extra.afterNodeId, node.id);
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

    const affUri = vscode.Uri.joinPath(
      this.extensionUri,
      "node_modules",
      pkg,
      "index.aff"
    );
    const dicUri = vscode.Uri.joinPath(
      this.extensionUri,
      "node_modules",
      pkg,
      "index.dic"
    );
    const aff = dec.decode(await vscode.workspace.fs.readFile(affUri));
    const dic = dec.decode(await vscode.workspace.fs.readFile(dicUri));

    const customWords = await this.readCustomWords();
    return { language, aff, dic, customWords };
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
