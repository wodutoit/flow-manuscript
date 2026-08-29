import * as vscode from "vscode";
import { randomUUID } from "crypto";
import * as path from "path";
import { buildSeriesState, orderedBookIds } from "./graph";
import type {
  FlowEdge,
  SeriesBook,
  SeriesDocument,
  SeriesState,
} from "../shared/types";

const FLOW_FILE = "outline.flow.json";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Defaults for a newly added book node; the user can move/resize from there.
const BOOK_W = 260;
const BOOK_H = 132;
const BOOK_GAP_X = 80;

/**
 * Owns one series folder: a folder whose `outline.flow.json` carries a `books`
 * array instead of the acts/nodes of a manuscript. The series file is the only
 * state — each `books[].name` is an immediate subfolder that is itself an
 * ordinary manuscript root, loaded by its own `ManuscriptManager` exactly as a
 * standalone book would be.
 *
 * Mirrors ManuscriptManager's shape on purpose (rootUri, load, onDidChange,
 * persist-then-fire) so the tree and panels treat the two the same way.
 */
export class SeriesManager {
  private doc: SeriesDocument = { version: 2, books: [], edges: [] };
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly root: vscode.Uri) {}

  get rootUri() {
    return this.root;
  }

  /** Folder name of the series, used as the tree label / panel title. */
  get name() {
    return path.basename(this.root.fsPath);
  }

  private flowUri() {
    return vscode.Uri.joinPath(this.root, FLOW_FILE);
  }

  /**
   * True when this folder's outline.flow.json is a SERIES file rather than a
   * manuscript one. Detection is the presence of a `books` array — that key
   * never appears in a manuscript document (which has acts/nodes/edges).
   */
  static async isSeriesRoot(root: vscode.Uri): Promise<boolean> {
    try {
      const raw = dec.decode(
        await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(root, FLOW_FILE)
        )
      );
      const parsed = JSON.parse(raw) as { books?: unknown };
      return Array.isArray(parsed.books);
    } catch {
      return false;
    }
  }

  async load(): Promise<void> {
    try {
      const raw = dec.decode(await vscode.workspace.fs.readFile(this.flowUri()));
      this.doc = this.normalize(JSON.parse(raw) as Partial<SeriesDocument>);
    } catch {
      this.doc = { version: 2, books: [], edges: [] };
    }
  }

  /**
   * Fill in anything a hand-written series file may omit (ids, order,
   * positions) and drop entries that carry no folder name. Books with a
   * duplicate id get a fresh one so edges never bind to two nodes. Nothing is
   * written back here — `persist()` only runs when the user changes something.
   */
  private normalize(parsed: Partial<SeriesDocument>): SeriesDocument {
    const seenIds = new Set<string>();
    const books: SeriesBook[] = (parsed.books ?? [])
      .filter((b) => typeof b?.name === "string" && b.name.trim().length > 0)
      .map((b, i) => {
        let id = typeof b.id === "string" && b.id ? b.id : randomUUID();
        if (seenIds.has(id)) id = randomUUID();
        seenIds.add(id);
        return {
          id,
          name: b.name.trim(),
          title: typeof b.title === "string" ? b.title : undefined,
          order: typeof b.order === "number" ? b.order : i + 1,
          position: b.position ?? { x: 0, y: 0 },
          size: b.size,
        };
      });

    const ids = new Set(books.map((b) => b.id));
    const edges: FlowEdge[] = (parsed.edges ?? [])
      .filter((e) => e && ids.has(e.source) && ids.has(e.target))
      .map((e, i) => ({
        id: typeof e.id === "string" && e.id ? e.id : `se-${i + 1}`,
        kind: e.kind === "logical" ? "logical" : "order",
        source: e.source,
        target: e.target,
      }));

    return { version: 2, books, edges };
  }

  private async persist(): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this.flowUri(),
      enc.encode(JSON.stringify(this.doc, null, 2) + "\n")
    );
    this._onDidChange.fire();
  }

  // -- reads -----------------------------------------------------------------

  getBooks(): SeriesBook[] {
    return this.doc.books.slice();
  }

  getBook(id: string): SeriesBook | undefined {
    return this.doc.books.find((b) => b.id === id);
  }

  /** The book folder's URI (may not exist on disk — see `bookRoots`). */
  bookUri(book: SeriesBook): vscode.Uri {
    return vscode.Uri.joinPath(this.root, book.name);
  }

  /**
   * Books in reading order (the order-edge chain, falling back to stored
   * `order`), each paired with its folder URI and whether that folder is
   * actually a manuscript root. The tree uses this to nest books under the
   * series; missing folders still show, flagged, rather than vanishing.
   */
  async bookRoots(): Promise<
    Array<{ book: SeriesBook; uri: vscode.Uri; exists: boolean; index: number }>
  > {
    const byId = new Map(this.doc.books.map((b) => [b.id, b]));
    const ordered = orderedBookIds(this.doc)
      .map((id) => byId.get(id))
      .filter((b): b is SeriesBook => !!b);

    const out: Array<{
      book: SeriesBook;
      uri: vscode.Uri;
      exists: boolean;
      index: number;
    }> = [];
    for (let i = 0; i < ordered.length; i++) {
      const book = ordered[i];
      const uri = this.bookUri(book);
      out.push({ book, uri, exists: await isManuscriptRoot(uri), index: i + 1 });
    }
    return out;
  }

  async seriesState(): Promise<SeriesState> {
    const existing = new Set<string>();
    for (const b of this.doc.books) {
      if (await isManuscriptRoot(this.bookUri(b))) existing.add(b.name);
    }
    return buildSeriesState(this.doc, {
      name: this.name,
      existingFolders: existing,
    });
  }

  // -- writes ----------------------------------------------------------------

  /**
   * Record a folder as the next book in the series. The folder itself is
   * scaffolded by the caller (extension.ts, via ManuscriptManager.scaffold) —
   * this only owns the series file. The new book is appended to the end of the
   * chain with an order edge from the current last book, and placed to the
   * right of the rightmost existing node so it never lands on top of one.
   */
  async addBook(folderName: string, title?: string): Promise<SeriesBook> {
    const name = folderName.trim();
    const existing = this.doc.books.find((b) => b.name === name);
    if (existing) return existing;

    const ordered = orderedBookIds(this.doc);
    const last = ordered.length ? ordered[ordered.length - 1] : undefined;

    let x = 40;
    let y = 40;
    for (const b of this.doc.books) {
      const w = b.size?.width ?? BOOK_W;
      x = Math.max(x, b.position.x + w + BOOK_GAP_X);
      y = Math.min(y, b.position.y);
    }

    const book: SeriesBook = {
      id: randomUUID(),
      name,
      title: title?.trim() || undefined,
      order: this.doc.books.length + 1,
      position: { x, y },
      size: { width: BOOK_W, height: BOOK_H },
    };
    this.doc.books.push(book);
    if (last) {
      this.doc.edges.push({
        id: `se-${randomUUID()}`,
        kind: "order",
        source: last,
        target: book.id,
      });
    }
    this.renumber();
    await this.persist();
    return book;
  }

  async moveBook(id: string, position: { x: number; y: number }) {
    const b = this.getBook(id);
    if (!b) return;
    b.position = position;
    await this.persist();
  }

  async resizeBook(id: string, size: { width: number; height: number }) {
    const b = this.getBook(id);
    if (!b) return;
    b.size = size;
    await this.persist();
  }

  /**
   * Add an order edge between two books. A book has at most one outgoing and
   * one incoming order edge, so any existing edge on either end is replaced —
   * that keeps the chain a chain (same rule the scene chain follows). Self
   * links and links that would close a cycle are refused.
   */
  async connectBooks(source: string, target: string) {
    if (source === target) return;
    if (!this.getBook(source) || !this.getBook(target)) return;
    if (this.wouldCycle(source, target)) {
      vscode.window.showWarningMessage(
        "That would make the book order loop back on itself."
      );
      return;
    }
    this.doc.edges = this.doc.edges.filter(
      (e) => e.source !== source && e.target !== target
    );
    this.doc.edges.push({
      id: `se-${randomUUID()}`,
      kind: "order",
      source,
      target,
    });
    this.renumber();
    await this.persist();
  }

  /** True when adding source->target would create a loop. */
  private wouldCycle(source: string, target: string): boolean {
    const nextOf = new Map<string, string>();
    for (const e of this.doc.edges) {
      if (e.kind === "order" && !nextOf.has(e.source)) {
        nextOf.set(e.source, e.target);
      }
    }
    const seen = new Set<string>([target]);
    let cur = nextOf.get(target);
    while (cur) {
      if (cur === source) return true;
      if (seen.has(cur)) return false; // pre-existing loop; not ours to judge
      seen.add(cur);
      cur = nextOf.get(cur);
    }
    return false;
  }

  async deleteEdge(edgeId: string) {
    const before = this.doc.edges.length;
    this.doc.edges = this.doc.edges.filter((e) => e.id !== edgeId);
    if (this.doc.edges.length === before) return;
    this.renumber();
    await this.persist();
  }

  /** Rewrite stored `order` from the current chain so the file stays readable. */
  private renumber() {
    const byId = new Map(this.doc.books.map((b) => [b.id, b]));
    orderedBookIds(this.doc).forEach((id, i) => {
      const b = byId.get(id);
      if (b) b.order = i + 1;
    });
  }

  dispose() {
    this._onDidChange.dispose();
  }
}

/** A folder is a manuscript root iff it directly contains outline.flow.json. */
async function isManuscriptRoot(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, FLOW_FILE));
    return !(await SeriesManager.isSeriesRoot(uri));
  } catch {
    return false;
  }
}
