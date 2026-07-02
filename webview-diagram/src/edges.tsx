import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "reactflow";
import { post } from "./bridge";
import type { EdgeKind } from "../../src/shared/types";

/**
 * Custom scene edge. Click the edge to select it; when selected, a kind-toggle
 * and a delete button appear at its midpoint. Selection-driven (rather than
 * hover-driven) so the tools are reliably clickable even when the edge runs
 * across an act container.
 */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
  selected,
}: EdgeProps<{ kind: EdgeKind }>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const kind = (data?.kind ?? "order") as EdgeKind;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          // Emphasize the selected edge so it's clear which one the tools act on.
          ...(selected
            ? { stroke: "var(--vscode-focusBorder)", strokeWidth: 3 }
            : null),
        }}
      />
      {selected ? (
        <EdgeLabelRenderer>
          <div
            className="edge-tools edge-tools--visible"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <button
              className="edge-tools__kind"
              title={
                kind === "order"
                  ? "Story order (solid). Click to make logical (dashed)."
                  : "Logical link (dashed). Click to make order (solid)."
              }
              onClick={(e) => {
                e.stopPropagation();
                post({
                  type: "setEdgeKind",
                  edgeId: id,
                  kind: kind === "order" ? "logical" : "order",
                });
              }}
            >
              {kind === "order" ? "\u2192" : "\u21E2"}
            </button>
            <button
              className="edge-tools__del"
              title="Delete this connection"
              onClick={(e) => {
                e.stopPropagation();
                post({ type: "deleteEdge", edgeId: id });
              }}
            >
              {"\u00D7"}
            </button>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const edgeTypes = {
  flow: FlowEdge,
};
