import { useCallback, useEffect, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type Connection,
  type NodeMouseHandler,
  type NodeChange,
  MarkerType,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { post, onHostMessage } from "./bridge";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./edges";
import type {
  DiagramState,
  DiagramNodeVM,
  DiagramActVM,
  SeriesState,
  EdgeKind,
} from "../../src/shared/types";

// ---- layout constants ------------------------------------------------------
// Acts are containers the user can position and resize freely; scenes are child
// nodes the user can drag anywhere inside (or into another act). We honor stored
// act size + stored scene positions, only falling back to a default layout when
// nothing has been placed yet.

const ACT_GAP_X = 80; // horizontal gap when auto-placing acts in a row
const ACT_HEADER_H = 44; // height reserved for the act header
const ACT_PAD = 16; // inner padding used for default scene placement
const ACT_WIDTH = 260; // default act container width
const SCENE_H = 66; // default vertical slot per scene
const SCENE_GAP = 12; // default gap between stacked scenes
const COLLAPSED_H = 60; // height of a collapsed act
const ENTITY_LANE_GAP = 160; // gap below acts before character/place lanes
const ENTITY_W = 200;

interface LayoutResult {
  nodes: Node[];
  actRects: Map<string, { x: number; y: number; w: number; h: number }>;
}

/**
 * Build React Flow nodes from diagram state. Acts become container nodes; their
 * scenes are child nodes (parentNode). Collapsed acts omit their scenes.
 * Characters/places sit in lanes below the acts.
 *
 * IMPORTANT: React Flow requires a parent node to appear BEFORE its children in
 * the array, so we push each act then its scenes.
 */
function layout(state: DiagramState): LayoutResult {
  const invalid = new Set(state.invalidActIds);
  const nodes: Node[] = [];
  const actRects = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();

  const acts = [...state.acts].sort((a, b) => a.order - b.order);

  // Scenes grouped by act, in per-act chain order (used only for defaults).
  const scenesByAct = new Map<string, DiagramNodeVM[]>();
  for (const n of state.nodes) {
    if (n.kind !== "scene" || !n.actId) continue;
    const arr = scenesByAct.get(n.actId) ?? [];
    arr.push(n);
    scenesByAct.set(n.actId, arr);
  }
  for (const arr of scenesByAct.values()) {
    arr.sort((a, b) => (a.actSceneNumber ?? 1e9) - (b.actSceneNumber ?? 1e9));
  }

  // Running cursor for auto-placing acts with no stored position. Seed it past
  // any acts that DO have a stored position so a new act never overlaps one.
  const actY = 40;
  let cursorX = 40;
  for (const act of acts) {
    if (act.position) {
      const w = act.size?.width ?? ACT_WIDTH;
      cursorX = Math.max(cursorX, act.position.x + w + ACT_GAP_X);
    }
  }

  let maxActBottom = actY;

  for (const act of acts) {
    const scenes = scenesByAct.get(act.id) ?? [];
    const defaultBodyH = Math.max(
      SCENE_H,
      scenes.length * (SCENE_H + SCENE_GAP)
    );
    const w = act.size?.width ?? ACT_WIDTH;
    const h = act.collapsed
      ? COLLAPSED_H
      : act.size?.height ?? ACT_HEADER_H + ACT_PAD * 2 + defaultBodyH;

    let x: number;
    let y: number;
    if (act.position) {
      x = act.position.x;
      y = act.position.y;
    } else {
      x = cursorX;
      y = actY;
      cursorX += w + ACT_GAP_X;
    }

    nodes.push({
      id: act.id,
      type: "act",
      position: { x, y },
      data: { ...act, invalid: invalid.has(act.id) },
      style: { width: w, height: h },
      draggable: true,
      selectable: true,
    });
    actRects.set(act.id, { x, y, w, h });

    if (!act.collapsed) {
      scenes.forEach((s, i) => {
        // Honor a stored (non-origin) position; else stack by default. Scene
        // positions are RELATIVE to the parent act container.
        const stored = s.position;
        const hasStored = !!stored && (stored.x !== 0 || stored.y !== 0);
        const rel = hasStored
          ? stored
          : {
              x: ACT_PAD,
              y: ACT_HEADER_H + ACT_PAD + i * (SCENE_H + SCENE_GAP),
            };
        nodes.push({
          id: s.id,
          type: "scene",
          position: rel,
          data: s,
          parentNode: act.id,
          // Not extent:"parent" — we allow dragging a scene out to another act.
          draggable: true,
        });
      });
    }

    maxActBottom = Math.max(maxActBottom, y + h);
  }

  // Characters and places in lanes below the acts.
  const laneY = maxActBottom + ENTITY_LANE_GAP;
  const chars = state.nodes.filter((n) => n.kind === "character");
  const places = state.nodes.filter((n) => n.kind === "place");
  chars.forEach((n, i) => {
    nodes.push({
      id: n.id,
      type: "character",
      position: { x: 40 + i * ENTITY_W, y: laneY },
      data: n,
    });
  });
  places.forEach((n, i) => {
    nodes.push({
      id: n.id,
      type: "place",
      position: { x: 40 + i * ENTITY_W, y: laneY + 120 },
      data: n,
    });
  });

  return { nodes, actRects };
}

/** Scene-chain (intra-act) edges + act-order edges between act containers. */
function layoutEdges(state: DiagramState): Edge[] {
  const edges: Edge[] = [];

  for (const e of state.edges) {
    edges.push({
      id: e.id,
      type: "flow",
      source: e.source,
      target: e.target,
      sourceHandle: "out",
      targetHandle: "in",
      animated: e.kind === "logical",
      style:
        e.kind === "logical"
          ? { strokeDasharray: "6 4", strokeWidth: 1.5 }
          : { strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { kind: e.kind },
      // A wide invisible interaction band makes the thin edge easy to click to
      // select (which reveals its delete/kind tools).
      interactionWidth: 24,
      selectable: true,
      // paint scene edges above the act container backdrop
      zIndex: 5,
    });
  }

  // Act-order edges between consecutive acts (structural, not user-editable).
  const acts = [...state.acts].sort((a, b) => a.order - b.order);
  for (let i = 1; i < acts.length; i++) {
    edges.push({
      id: `act-order-${acts[i - 1].id}-${acts[i].id}`,
      source: acts[i - 1].id,
      target: acts[i].id,
      sourceHandle: "act-out",
      targetHandle: "act-in",
      type: "smoothstep",
      animated: false,
      style: { strokeWidth: 3, stroke: "var(--vscode-focusBorder)" },
      markerEnd: { type: MarkerType.ArrowClosed },
      deletable: false,
      selectable: false,
      zIndex: 0,
    });
  }

  return edges;
}

// ---- series layout ---------------------------------------------------------
// A series canvas is one flat row of book nodes joined by order arrows. Stored
// positions win, but a position of {0,0} — or one that duplicates a position
// already taken, which is what a hand-written series file tends to have — falls
// back to the next slot in the row so books never stack on top of each other.

const BOOK_W = 260;
const BOOK_H = 132;
const BOOK_GAP_X = 80;

function layoutSeries(state: SeriesState): Node[] {
  const used = new Set<string>();
  let cursorX = 40;
  const rowY = 80;

  return state.books.map((b) => {
    const w = b.size?.width ?? BOOK_W;
    const h = b.size?.height ?? BOOK_H;
    const key = `${Math.round(b.position.x)},${Math.round(b.position.y)}`;
    const placed =
      (b.position.x !== 0 || b.position.y !== 0) && !used.has(key);

    let position: { x: number; y: number };
    if (placed) {
      position = b.position;
      used.add(key);
      cursorX = Math.max(cursorX, b.position.x + w + BOOK_GAP_X);
    } else {
      position = { x: cursorX, y: rowY };
      used.add(`${Math.round(cursorX)},${rowY}`);
      cursorX += w + BOOK_GAP_X;
    }

    return {
      id: b.id,
      type: "book",
      position,
      data: b,
      style: { width: w, height: h },
      draggable: true,
      selectable: true,
    } as Node;
  });
}

function layoutSeriesEdges(state: SeriesState): Edge[] {
  return state.edges.map((e) => ({
    id: e.id,
    type: "series",
    source: e.source,
    target: e.target,
    sourceHandle: "out",
    targetHandle: "in",
    style: { strokeWidth: 3 },
    markerEnd: { type: MarkerType.ArrowClosed },
    // Wide invisible hit band so the thin arrow is easy to click (selecting it
    // is what reveals its delete button).
    interactionWidth: 24,
  }));
}

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [drawKind, setDrawKind] = useState<EdgeKind>("order");
  const [invalidActCount, setInvalidActCount] = useState(0);
  // The panel decides which canvas this is by the first message it sends:
  // "state" (a manuscript) or "seriesState" (a series). Until then we render
  // an empty canvas with no toolbar, so no book-level control ever flashes on
  // a series canvas.
  const [mode, setMode] = useState<"loading" | "manuscript" | "series">(
    "loading"
  );
  const [series, setSeries] = useState<SeriesState | null>(null);
  const modeRef = useRef<"loading" | "manuscript" | "series">("loading");

  const actRectsRef = useRef<
    Map<string, { x: number; y: number; w: number; h: number }>
  >(new Map());
  const sceneActRef = useRef<Map<string, string>>(new Map());
  const copiedIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  // Full current selection (ids), for multi-node drag persistence.
  const selectedIdsRef = useRef<Set<string>>(new Set());
  // Live view of nodes so drag-stop can read every selected node's position.
  const nodesRef = useRef<Node[]>([]);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "seriesState") {
        setMode("series");
        modeRef.current = "series";
        setSeries(msg.state);
        const laidOut = layoutSeries(msg.state);
        setNodes(laidOut);
        nodesRef.current = laidOut;
        setEdges(layoutSeriesEdges(msg.state));
        return;
      }
      if (msg.type === "state") {
        setMode("manuscript");
        modeRef.current = "manuscript";
        const { nodes: laidOut, actRects } = layout(msg.state);
        actRectsRef.current = actRects;
        const map = new Map<string, string>();
        for (const n of msg.state.nodes) {
          if (n.kind === "scene" && n.actId) map.set(n.id, n.actId);
        }
        sceneActRef.current = map;
        setNodes(laidOut);
        nodesRef.current = laidOut;
        setEdges(layoutEdges(msg.state));
        setInvalidActCount(msg.state.invalidActIds.length);
      }
    });
    post({ type: "ready" });
    return off;
  }, [setNodes, setEdges]);

  // Copy/paste a scene node (duplicate, unconnected, same act).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (modeRef.current === "series") return; // no scene duplication here
      if (e.key === "c" || e.key === "C") {
        if (selectedIdRef.current) copiedIdRef.current = selectedIdRef.current;
      } else if (e.key === "v" || e.key === "V") {
        if (copiedIdRef.current) {
          post({ type: "duplicateNode", nodeId: copiedIdRef.current });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Suppress the native right-click menu.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };
    document.addEventListener("contextmenu", onCtx, { capture: true });
    return () =>
      document.removeEventListener("contextmenu", onCtx, { capture: true });
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChange(changes),
    [onNodesChange]
  );

  // Mirror the latest nodes into a ref so drag-stop can read every selected
  // node's current position for multi-node drag persistence.
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Drawing a connection. Act handles -> reorder acts; scene handles -> a scene
  // order/logical edge in the currently selected draw kind.
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      if (modeRef.current === "series") {
        post({ type: "connectBooks", source: c.source, target: c.target });
        return;
      }
      if (c.sourceHandle === "act-out" || c.targetHandle === "act-in") {
        post({ type: "connectActs", sourceActId: c.source, targetActId: c.target });
        return;
      }
      post({ type: "connect", source: c.source, target: c.target, kind: drawKind });
    },
    [drawKind]
  );

  // Track selection: remember all selected ids (for multi-drag) and the single
  // scene id used for copy/duplicate.
  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: Node[] }) => {
      selectedIdsRef.current = new Set(sel.map((n) => n.id));
      const scene = sel.find((n) => n.type === "scene");
      selectedIdRef.current = sel.length === 1 && scene ? scene.id : null;
    },
    []
  );

  // Double-click: open a scene in the editor; toggle collapse on an act.
  const onNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    if (node.type === "book") {
      post({ type: "openBookDiagram", bookId: node.id });
    } else if (node.type === "act") {
      const collapsed = !!(node.data as DiagramActVM).collapsed;
      post({ type: "setActCollapsed", actId: node.id, collapsed: !collapsed });
    } else if (node.type === "scene") {
      post({ type: "openNode", nodeId: node.id });
    }
  }, []);

  // On drag stop:
  //  - Multiple nodes selected: persist each one's position (no cross-act move;
  //    that's reserved for dragging a single scene, to keep it predictable).
  //  - Single act: persist its position.
  //  - Single scene: if dropped over a DIFFERENT act, move it there; otherwise
  //    persist its new position within its current act (free layout).
  const persistNodePosition = useCallback((node: Node) => {
    if (node.type === "act") {
      post({ type: "moveActPosition", actId: node.id, position: node.position });
    } else if (node.type === "scene") {
      post({ type: "moveNode", nodeId: node.id, position: node.position });
    }
  }, []);

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_e, node) => {
      if (modeRef.current === "series") {
        // Books have no container to fall into — just persist where they land
        // (every selected one, so a multi-drag sticks too).
        const sel = selectedIdsRef.current;
        const moved =
          sel.size > 1
            ? nodesRef.current.filter((n) => sel.has(n.id) && n.type === "book")
            : [node];
        for (const n of moved) {
          post({ type: "moveBook", bookId: n.id, position: n.position });
        }
        return;
      }

      const selected = selectedIdsRef.current;

      // Multi-node drag: persist positions for all selected act/scene nodes.
      if (selected.size > 1) {
        for (const n of nodesRef.current) {
          if (!selected.has(n.id)) continue;
          persistNodePosition(n);
        }
        return;
      }

      if (node.type === "act") {
        post({
          type: "moveActPosition",
          actId: node.id,
          position: node.position,
        });
        return;
      }

      if (node.type === "scene") {
        const currentActId = sceneActRef.current.get(node.id);
        const parentRect = currentActId
          ? actRectsRef.current.get(currentActId)
          : undefined;
        const abs =
          node.positionAbsolute ?? {
            x: (parentRect?.x ?? 0) + node.position.x,
            y: (parentRect?.y ?? 0) + node.position.y,
          };

        // Which act does the drop point fall inside?
        let targetActId: string | undefined;
        for (const [actId, r] of actRectsRef.current) {
          if (
            abs.x >= r.x &&
            abs.x <= r.x + r.w &&
            abs.y >= r.y &&
            abs.y <= r.y + r.h
          ) {
            targetActId = actId;
            break;
          }
        }

        if (targetActId && targetActId !== currentActId) {
          post({ type: "moveSceneToAct", sceneId: node.id, actId: targetActId });
        } else {
          // Same act (or outside any act): persist the new position so the
          // user's free layout sticks. node.position is relative to the parent.
          post({ type: "moveNode", nodeId: node.id, position: node.position });
        }
      }
    },
    [persistNodePosition]
  );

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    for (const e of deleted) {
      if (e.type === "flow") post({ type: "deleteEdge", edgeId: e.id });
      else if (e.type === "series") post({ type: "deleteBookEdge", edgeId: e.id });
    }
  }, []);

  return (
    <div className="canvas">
      {mode === "series" ? (
        // Series toolbar. Everything book-level (acts, scenes, characters,
        // places, duplicate, edge-kind) is absent by construction, not hidden
        // with CSS — none of it means anything at the series level.
        <div className="toolbar">
          <div className="toolbar__group">
            <button onClick={() => post({ type: "addBook" })}>+ Book</button>
          </div>
          {series?.invalid ? (
            <div className="toolbar__warn">
              This series doesn't have exactly one starting book — connect the
              books into a single chain.
            </div>
          ) : (
            <div className="toolbar__hint">
              {series ? `${series.name} — ` : ""}drag to arrange; connect books
              to set reading order; click a book's ⎇ icon to open its diagram
              beside this one
            </div>
          )}
        </div>
      ) : mode === "manuscript" ? (
        <div className="toolbar">
          <div className="toolbar__group">
            <button onClick={() => post({ type: "addAct" })}>+ Act</button>
            <button onClick={() => post({ type: "addNode", kind: "character" })}>
              + Character
            </button>
            <button onClick={() => post({ type: "addNode", kind: "place" })}>
              + Place
            </button>
            <button
              onClick={() => {
                if (selectedIdRef.current)
                  post({ type: "duplicateNode", nodeId: selectedIdRef.current });
              }}
              title="Duplicate the selected scene (or Ctrl/Cmd+C then Ctrl/Cmd+V)"
            >
              Duplicate
            </button>
          </div>
          <div className="toolbar__group">
            <span className="toolbar__label">New connection:</span>
            <button
              className={drawKind === "order" ? "active" : ""}
              onClick={() => setDrawKind("order")}
              title="Solid arrow — story order within an act"
            >
              Order (solid)
            </button>
            <button
              className={drawKind === "logical" ? "active" : ""}
              onClick={() => setDrawKind("logical")}
              title="Dashed arrow — POV / logical link"
            >
              Logical (dashed)
            </button>
          </div>
          {invalidActCount > 0 ? (
            <div className="toolbar__warn">
              {invalidActCount} act{invalidActCount === 1 ? "" : "s"} have more
              than one starting scene — each act should have exactly one.
            </div>
          ) : (
            <div className="toolbar__hint">
              Shift+drag to select multiple; drag to move them together
            </div>
          )}
        </div>
      ) : null}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDragStop={onNodeDragStop}
        onEdgesDelete={onEdgesDelete}
        // Multi-select: Shift+drag on empty canvas rubber-band selects; Shift+
        // click adds/removes individual nodes. Plain left-drag still pans.
        selectionOnDrag={false}
        selectionKeyCode={"Shift"}
        multiSelectionKeyCode={"Shift"}
        selectNodesOnDrag={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(n) =>
            n.type === "book"
              ? (n.data as { isInvalidRoot?: boolean }).isInvalidRoot
                ? "var(--vscode-errorForeground)"
                : "#b197fc"
              : n.type === "act"
              ? "var(--vscode-editorWidget-border, #888)"
              : n.type === "scene"
              ? (n.data as DiagramNodeVM).isInvalidRoot
                ? "var(--vscode-errorForeground)"
                : "#6ea8fe"
              : n.type === "character"
              ? "#63e6be"
              : "#ffd43b"
          }
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
