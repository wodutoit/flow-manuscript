import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "reactflow";
import { post } from "./bridge";
import type { EdgeKind } from "../../src/shared/types";

/**
 * Custom edge with an always-available delete button at its midpoint, plus
 * click-to-cycle-kind (order <-> logical). We render our own so deletion has an
 * explicit affordance rather than depending on keyboard selection.
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
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="edge-tools"
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
            {kind === "order" ? "→" : "⇢"}
          </button>
          <button
            className="edge-tools__del"
            title="Delete this connection"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "deleteEdge", edgeId: id });
            }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = {
  flow: FlowEdge,
};
