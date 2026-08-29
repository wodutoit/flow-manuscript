// Shared types used by both the extension host (Node) and the webviews (browser).
// Keep this file free of any Node or DOM specific imports.

export type NodeKind = "scene" | "character" | "place";

/** Sentinel id used by the editor to target the manuscript's overview.md. */
export const OVERVIEW_ID = "__overview__";

/** Editor target kind: node kinds plus the special overview document. */
export type EditorKind = NodeKind | "overview";

/** Edge semantics on the diagram canvas. */
export type EdgeKind =
  | "order" // solid arrow: defines story order between two scenes
  | "logical"; // dashed arrow: POV / logical link between two scenes

/** Scene lifecycle status (from the scene template frontmatter). */
export type SceneStatus = "outline" | "drafted" | "revised" | "final";

/** Character / place authoring status (from those templates). */
export type EntityStatus = "sketch" | "developed" | "locked";

/** A node as stored in outline.flow.json. */
export interface FlowNode {
  id: string; // stable uuid, never changes even when the file is renamed
  kind: NodeKind;
  /** Relative path (from manuscript root) to the backing .md file, e.g. "scenes/the-long-road.md". */
  file: string;
  /** Display name; also the source for the kebab-case filename. */
  name: string;
  /** Canvas position. */
  position: { x: number; y: number };
}

/** An edge as stored in outline.flow.json. Only ever connects two scene nodes
 * that belong to the same act. */
export interface FlowEdge {
  id: string;
  kind: EdgeKind;
  source: string; // FlowNode.id
  target: string; // FlowNode.id
}

/**
 * An act (a.k.a. part) groups scenes and defines story structure. Acts live
 * only in the flow file — they have no backing .md file. Scene membership is
 * the `sceneIds` list; order within the act is defined by the scene order
 * edges among those scenes. Overall story order is acts by `order`, then the
 * scene chain within each act.
 */
export interface Act {
  id: string; // stable uuid
  name: string; // display name, e.g. "Setup"
  order: number; // 1-based; managed automatically
  sceneIds: string[]; // FlowNode ids of scenes in this act (membership only)
  collapsed?: boolean; // diagram/tree collapsed state
  /** Canvas position of the act container node. */
  position?: { x: number; y: number };
  /** Manual container size on the diagram (defaults applied if absent). */
  size?: { width: number; height: number };
}

/** The full graph sidecar persisted next to the manuscript. */
export interface FlowDocument {
  version: 2;
  acts: Act[];
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ---------------------------------------------------------------------------
// Series: a folder whose outline.flow.json holds a `books` array instead of
// acts/nodes. Each entry names an immediate subfolder that is itself a normal
// manuscript root (it has its own outline.flow.json). The series file is the
// only place series data lives — books know nothing about the series.
// ---------------------------------------------------------------------------

/** One book in a series, as stored in a series outline.flow.json. */
export interface SeriesBook {
  id: string; // stable id, unique within the series file
  /** Folder name of the book, relative to the series root. */
  name: string;
  /** Optional display title; falls back to `name` when absent. */
  title?: string;
  /** 1-based reading order; kept in sync with the order-edge chain. */
  order: number;
  /** Canvas position on the series diagram. */
  position: { x: number; y: number };
  /** Manual node size on the series diagram (defaults applied if absent). */
  size?: { width: number; height: number };
}

/** The series sidecar: same filename as a manuscript's, different shape. */
export interface SeriesDocument {
  version: 2;
  books: SeriesBook[];
  /** Only "order" edges are meaningful between books. */
  edges: FlowEdge[];
}

/** Book view-model for the series diagram (derived fields are not stored). */
export interface SeriesBookVM extends SeriesBook {
  /** Derived reading number from the order-edge chain (1-based). */
  bookNumber?: number;
  /** True when the book folder exists and contains an outline.flow.json. */
  exists: boolean;
  /** True when this book has no incoming order edge. */
  isRoot: boolean;
  /** True when this book renders red (more than one starting book). */
  isInvalidRoot: boolean;
}

export interface SeriesState {
  /** Series folder name, shown in the diagram toolbar. */
  name: string;
  books: SeriesBookVM[];
  edges: FlowEdge[];
  /** True when the series has more or fewer than one starting book. */
  invalid: boolean;
}

/** Manuscript-level metadata gathered at creation and stored in overview.md frontmatter. */
export interface ManuscriptMeta {
  title: string;
  slug: string;
  author: string;
  genre: string;
  pov: string;
  tense: string;
  logline: string;
  language: string; // e.g. "en_US" | "en_GB"
}

/** Parsed representation of a scene .md file. */
export interface SceneFrontmatter {
  scene: number;
  chapter: number;
  chapter_title?: string;
  name: string;
  pov: string;
  goal: string;
  status: SceneStatus;
}

export interface CharacterFrontmatter {
  name: string;
  role: "protagonist" | "antagonist" | "supporting" | "minor" | string;
  status: EntityStatus;
}

export interface PlaceFrontmatter {
  name: string;
  type: "city" | "building" | "room" | "landscape" | "other" | string;
  status: EntityStatus;
}

export type AnyFrontmatter =
  | SceneFrontmatter
  | CharacterFrontmatter
  | PlaceFrontmatter;

/** A parsed markdown doc: frontmatter object + raw body markdown. */
export interface ParsedDoc<T = Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

// ---------------------------------------------------------------------------
// Messages between the extension host and the webviews.
// Discriminated unions keep the postMessage bridge type-safe.
// ---------------------------------------------------------------------------

/** Node view-model enriched with data the diagram needs to render (derived, not stored). */
export interface DiagramNodeVM extends FlowNode {
  /** Derived story number for scenes (1-based, global across acts). Undefined for non-scenes. */
  sceneNumber?: number;
  /** Scene number within its own act (1-based). */
  actSceneNumber?: number;
  /** The act this scene belongs to, if any. */
  actId?: string;
  /** True when this scene has no incoming "order" edge from within its act. */
  isRoot?: boolean;
  /** True when this node should render red (multiple roots in the same act). */
  isInvalidRoot?: boolean;
  status?: SceneStatus | EntityStatus;
  pov?: string;
}

/** Act view-model for the diagram: the stored act plus derived numbering. */
export interface DiagramActVM {
  id: string;
  name: string;
  order: number;
  sceneIds: string[];
  collapsed: boolean;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  sceneCount: number;
}

export interface DiagramState {
  nodes: DiagramNodeVM[];
  edges: FlowEdge[];
  acts: DiagramActVM[];
  /** Per-act root problems: act ids that have more than one starting scene. */
  invalidActIds: string[];
}

// Diagram webview -> host
export type DiagramToHost =
  | { type: "ready" }
  | { type: "addNode"; kind: NodeKind; afterNodeId?: string; actId?: string }
  | { type: "openNode"; nodeId: string }
  | { type: "moveNode"; nodeId: string; position: { x: number; y: number } }
  | { type: "connect"; source: string; target: string; kind: EdgeKind }
  | { type: "deleteEdge"; edgeId: string }
  | { type: "deleteNode"; nodeId: string }
  | { type: "duplicateNode"; nodeId: string }
  | { type: "setEdgeKind"; edgeId: string; kind: EdgeKind }
  // act operations
  | { type: "addAct" }
  | { type: "renameAct"; actId: string }
  | { type: "deleteAct"; actId: string }
  | { type: "moveAct"; actId: string; direction: "up" | "down" }
  | { type: "connectActs"; sourceActId: string; targetActId: string }
  | { type: "setActCollapsed"; actId: string; collapsed: boolean }
  | { type: "moveActPosition"; actId: string; position: { x: number; y: number } }
  | { type: "resizeAct"; actId: string; size: { width: number; height: number } }
  | { type: "arrangeAct"; actId: string }
  | { type: "moveSceneToAct"; sceneId: string; actId: string }
  | { type: "addSceneToAct"; actId: string }
  // series operations (only ever sent when the panel is in series mode)
  | { type: "addBook" }
  | { type: "openBookDiagram"; bookId: string }
  | { type: "moveBook"; bookId: string; position: { x: number; y: number } }
  | { type: "resizeBook"; bookId: string; size: { width: number; height: number } }
  | { type: "connectBooks"; source: string; target: string }
  | { type: "deleteBookEdge"; edgeId: string };

// host -> Diagram webview
export type HostToDiagram =
  | { type: "state"; state: DiagramState }
  | { type: "seriesState"; state: SeriesState };

// Editor webview -> host
export type EditorToHost =
  | { type: "ready" }
  | { type: "requestDoc"; nodeId: string }
  | { type: "saveBody"; nodeId: string; body: string }
  | { type: "saveFrontmatter"; nodeId: string; frontmatter: Record<string, unknown> }
  | { type: "renameNode"; nodeId: string; newName: string }
  | { type: "moveSceneToAct"; sceneId: string; actId: string }
  | { type: "requestDictionary" }
  | { type: "addCustomWord"; word: string }
  | {
      type: "requestAiReview";
      mode: "grammar" | "editor";
      nodeId: string;
      text: string;
      /** Absolute ProseMirror doc start position of this paragraph; only
       * needed for "grammar" mode's offset mapping back onto the doc. */
      from: number;
    };

/** Minimal act info the editor needs to render its act selector. */
export interface EditorActRef {
  id: string;
  name: string;
  order: number;
}

/**
 * A single AI Grammar suggestion, as emitted by the model. Deliberately no
 * `start`/`end` here — small instruct models are unreliable at emitting
 * correct integer character offsets even under grammar-constrained decoding
 * (the grammar enforces JSON syntax, not correct content). The host resolves
 * the real span itself after parsing, via `paragraphText.indexOf(original)`;
 * see `AiResolvedSuggestion` for the version that carries that resolved span
 * over the wire to the webview.
 */
export interface AiSuggestion {
  original: string;
  suggestion: string;
  reason: string;
  category: "grammar" | "clarity" | "tone" | "wordiness";
}

/**
 * `AiSuggestion` widened with the character span the host resolved via
 * `indexOf` against the paragraph text (relative to the paragraph, not the
 * document — the webview applies `docPos = from + charOffset` using the
 * `from` it sent in `requestAiReview`). Suggestions the host couldn't locate
 * in the paragraph (model paraphrased instead of quoting exactly) are
 * dropped before this type is ever constructed.
 */
export interface AiResolvedSuggestion extends AiSuggestion {
  start: number;
  end: number;
}

/**
 * A single AI Editor (developmental-craft) note. Read-only — never rendered
 * as a decoration or mapped to a doc position. `quote` is illustrative only.
 */
export interface AiEditorNote {
  note: string;
  category: "pacing" | "show-vs-tell" | "sensory" | "tension" | "pov" | "other";
  /** Short excerpt from the paragraph this note refers to, for context only. */
  quote?: string;
  /** Whether this note is praise ("strength") or something to work on
   * ("improvement") — lets the webview group notes so the author can focus
   * on what needs attention rather than scanning a flat mixed list. */
  sentiment: "strength" | "improvement";
}

export type AiStatus = "disabled" | "downloading" | "loading" | "ready" | "error";

// host -> Editor webview
export type HostToEditor =
  | {
      type: "doc";
      nodeId: string;
      kind: EditorKind;
      frontmatter: Record<string, unknown>;
      body: string;
      /** For scenes: the act it belongs to and all acts (for the selector). */
      actId?: string;
      acts?: EditorActRef[];
    }
  | {
      type: "dictionary";
      language: string; // e.g. "en_US" | "en_GB"
      aff: string; // affix file contents (UTF-8)
      dic: string; // dictionary file contents (UTF-8)
      customWords: string[];
    }
  | { type: "aiGrammarSuggestions"; suggestions: AiResolvedSuggestion[] }
  | { type: "aiEditorNotes"; notes: AiEditorNote[] }
  | { type: "aiStatus"; status: AiStatus; progress?: number; message?: string };
