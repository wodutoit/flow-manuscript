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

/** An edge as stored in outline.flow.json. Only ever connects two scene nodes. */
export interface FlowEdge {
  id: string;
  kind: EdgeKind;
  source: string; // FlowNode.id
  target: string; // FlowNode.id
}

/** The full graph sidecar persisted next to the manuscript. */
export interface FlowDocument {
  version: 1;
  nodes: FlowNode[];
  edges: FlowEdge[];
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
  /** Derived story number for scenes (1-based). Undefined for non-scenes. */
  sceneNumber?: number;
  /** True when this scene has no incoming "order" edge. */
  isRoot?: boolean;
  /** True when this node should render red (multiple roots exist). */
  isInvalidRoot?: boolean;
  status?: SceneStatus | EntityStatus;
  pov?: string;
}

export interface DiagramState {
  nodes: DiagramNodeVM[];
  edges: FlowEdge[];
  /** Number of scene roots; when > 1 the graph is in an invalid state. */
  rootCount: number;
}

// Diagram webview -> host
export type DiagramToHost =
  | { type: "ready" }
  | { type: "addNode"; kind: NodeKind; afterNodeId?: string }
  | { type: "openNode"; nodeId: string }
  | { type: "moveNode"; nodeId: string; position: { x: number; y: number } }
  | { type: "connect"; source: string; target: string; kind: EdgeKind }
  | { type: "deleteEdge"; edgeId: string }
  | { type: "deleteNode"; nodeId: string }
  | { type: "duplicateNode"; nodeId: string }
  | { type: "setEdgeKind"; edgeId: string; kind: EdgeKind };

// host -> Diagram webview
export type HostToDiagram = { type: "state"; state: DiagramState };

// Editor webview -> host
export type EditorToHost =
  | { type: "ready" }
  | { type: "requestDoc"; nodeId: string }
  | { type: "saveBody"; nodeId: string; body: string }
  | { type: "saveFrontmatter"; nodeId: string; frontmatter: Record<string, unknown> }
  | { type: "renameNode"; nodeId: string; newName: string }
  | { type: "requestDictionary" }
  | { type: "addCustomWord"; word: string };

// host -> Editor webview
export type HostToEditor =
  | {
      type: "doc";
      nodeId: string;
      kind: EditorKind;
      frontmatter: Record<string, unknown>;
      body: string;
    }
  | {
      type: "dictionary";
      language: string; // e.g. "en_US" | "en_GB"
      aff: string; // affix file contents (UTF-8)
      dic: string; // dictionary file contents (UTF-8)
      customWords: string[];
    };
