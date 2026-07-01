import { useCallback, useEffect, useState, useRef } from "react";
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
  EdgeKind,
} from "../../src/shared/types";

function toFlowNodes(vms: DiagramNodeVM[]): Node<DiagramNodeVM>[] {
  return vms.map((vm) => ({
    id: vm.id,
    type: vm.kind,
    position: vm.position,
    data: vm,
    // characters/places are freely placed but not connectable
    connectable: vm.kind === "scene",
  }));
}

function toFlowEdges(state: DiagramState): Edge[] {
  return state.edges.map((e) => ({
    id: e.id,
    type: "flow",
    source: e.source,
    target: e.target,
    animated: e.kind === "logical",
    style:
      e.kind === "logical"
        ? { strokeDasharray: "6 4", strokeWidth: 1.5 }
        : { strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { kind: e.kind },
  }));
}

function Canvas() {
  // React Flow owns node/edge state so dragging, selection, etc. work. We sync
  // this from host state whenever it arrives, and push structural changes back.
  const [nodes, setNodes, onNodesChange] = useNodesState<DiagramNodeVM>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  // The kind of edge the next drawn connection becomes.
  const [drawKind, setDrawKind] = useState<EdgeKind>("order");
  const [rootCount, setRootCount] = useState(0);
  // Id of the node most recently copied (Ctrl/Cmd+C), for paste (Ctrl/Cmd+V).
  const copiedIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "state") {
        setNodes(toFlowNodes(msg.state.nodes));
        setEdges(toFlowEdges(msg.state));
        setRootCount(msg.state.rootCount);
      }
    });
    post({ type: "ready" });
    return off;
  }, [setNodes, setEdges]);

  // Copy (Ctrl/Cmd+C) remembers the selected node; Paste (Ctrl/Cmd+V) asks the
  // host to duplicate it as a new, unconnected node with a full .md copy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
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

  // Suppress the native right-click context menu (cut/copy/paste) — it operates
  // on text, not diagram nodes, so it only confuses. Node actions live on the
  // node itself (delete icon) and in the toolbar (duplicate).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };
    // Capture phase on document so we intercept before anything else, and also
    // bind the non-passive listener explicitly.
    document.addEventListener("contextmenu", onCtx, { capture: true });
    return () =>
      document.removeEventListener("contextmenu", onCtx, { capture: true });
  }, []);

  // Apply drag/selection changes locally; persist final position on drag stop.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChange(changes),
    [onNodesChange]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      post({ type: "connect", source: c.source, target: c.target, kind: drawKind });
    },
    [drawKind]
  );

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    post({ type: "openNode", nodeId: node.id });
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    selectedIdRef.current = node.id;
  }, []);

  const onNodeDragStop: NodeMouseHandler = useCallback((_e, node) => {
    post({ type: "moveNode", nodeId: node.id, position: node.position });
  }, []);

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    for (const e of deleted) post({ type: "deleteEdge", edgeId: e.id });
  }, []);

  const onNodesDelete = useCallback((deleted: Node[]) => {
    for (const n of deleted) post({ type: "deleteNode", nodeId: n.id });
  }, []);

  return (
    <div className="canvas">
      <div className="toolbar">
        <div className="toolbar__group">
          <button onClick={() => post({ type: "addNode", kind: "scene" })}>
            + Scene
          </button>
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
            title="Duplicate the selected node (or use Ctrl/Cmd+C then Ctrl/Cmd+V)"
          >
            Duplicate
          </button>
        </div>
        <div className="toolbar__group">
          <span className="toolbar__label">New connection:</span>
          <button
            className={drawKind === "order" ? "active" : ""}
            onClick={() => setDrawKind("order")}
            title="Solid arrow — story order"
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
        {rootCount > 1 ? (
          <div className="toolbar__warn">
            {rootCount} scenes have no incoming connection — there should
            be exactly one Scene 1.
          </div>
        ) : null}
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDragStop={onNodeDragStop}
        edgeTypes={edgeTypes}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(n) =>
            n.type === "scene"
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
