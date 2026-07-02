import { Handle, Position, NodeResizer, type NodeProps } from "reactflow";
import type { DiagramNodeVM, DiagramActVM } from "../../src/shared/types";
import { post } from "./bridge";

/** Small delete affordance shown on every node. */
function DeleteButton({ id }: { id: string }) {
  return (
    <button
      className="node__del"
      title="Delete"
      onClick={(e) => {
        e.stopPropagation();
        post({ type: "deleteNode", nodeId: id });
      }}
      // prevent the click from starting a node drag
      onMouseDown={(e) => e.stopPropagation()}
    >
      ×
    </button>
  );
}

/** Scene node: numbered, shows POV, turns red when it's an invalid duplicate root. */
export function SceneNode({ id, data }: NodeProps<DiagramNodeVM>) {
  const invalid = data.isInvalidRoot;
  return (
    <div className={`node node--scene${invalid ? " node--invalid" : ""}`}>
      <DeleteButton id={id} />
      <Handle type="target" position={Position.Left} id="in" />
      <div className="node__num">{data.sceneNumber ?? "\u2022"}</div>
      <div className="node__body">
        <div className="node__title">{data.name}</div>
        {data.pov ? <div className="node__meta">POV: {data.pov}</div> : null}
        {data.status ? (
          <span className={`badge badge--${data.status}`}>{data.status}</span>
        ) : null}
      </div>
      {invalid ? (
        <div className="node__warn" title="Multiple starting scenes — there should be exactly one Scene 1">
          !
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

export function CharacterNode({ id, data }: NodeProps<DiagramNodeVM>) {
  return (
    <div className="node node--character">
      <DeleteButton id={id} />
      <div className="node__kind">Character</div>
      <div className="node__title">{data.name}</div>
      {data.status ? (
        <span className={`badge badge--${data.status}`}>{data.status}</span>
      ) : null}
    </div>
  );
}

export function PlaceNode({ id, data }: NodeProps<DiagramNodeVM>) {
  return (
    <div className="node node--place">
      <DeleteButton id={id} />
      <div className="node__kind">Place</div>
      <div className="node__title">{data.name}</div>
      {data.status ? (
        <span className={`badge badge--${data.status}`}>{data.status}</span>
      ) : null}
    </div>
  );
}

/**
 * Act container node. Holds scene child nodes (via React Flow parentNode).
 * Header shows the act number + name and action buttons; when collapsed it
 * shrinks to a compact card showing just the scene count. Double-clicking the
 * act (handled in App via onNodeDoubleClick) toggles collapse.
 */
export function ActNode({
  data,
  selected,
}: NodeProps<DiagramActVM & { invalid: boolean }>) {
  const { id, name, order, sceneCount, collapsed, invalid } = data;
  return (
    <div
      className={`act${collapsed ? " act--collapsed" : ""}${
        invalid ? " act--invalid" : ""
      }${selected ? " act--selected" : ""}`}
    >
      {/* Resize handles (only when not collapsed). */}
      <NodeResizer
        isVisible={selected && !collapsed}
        minWidth={180}
        minHeight={120}
        onResizeEnd={(_e, params) => {
          post({
            type: "resizeAct",
            actId: id,
            size: { width: params.width, height: params.height },
          });
        }}
      />
      {/* Act-order handles: connect one act to another to set act order. */}
      <Handle type="target" position={Position.Left} id="act-in" />
      <Handle type="source" position={Position.Right} id="act-out" />

      <div className="act__header">
        <span className="act__collapse"
          title={collapsed ? "Expand act" : "Collapse act"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            post({ type: "setActCollapsed", actId: id, collapsed: !collapsed });
          }}
        >
          {collapsed ? "\u25B8" : "\u25BE"}
        </span>
        <span className="act__title">
          {order}. {name}
        </span>
        <span className="act__count">
          {sceneCount} scene{sceneCount === 1 ? "" : "s"}
        </span>
        <span className="act__tools" onMouseDown={(e) => e.stopPropagation()}>
          <button
            title="Add scene to this act"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "addSceneToAct", actId: id });
            }}
          >
            +
          </button>
          <button
            title="Arrange scenes: tidy them into a stack and fit the box"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "arrangeAct", actId: id });
            }}
          >
            {"\u2921"}
          </button>
          <button
            title="Rename act"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "renameAct", actId: id });
            }}
          >
            {"\u270E"}
          </button>
          <button
            className="act__del"
            title="Delete act (and all its scenes)"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "deleteAct", actId: id });
            }}
          >
            {"\u00D7"}
          </button>
        </span>
      </div>
      {invalid && !collapsed ? (
        <div className="act__warn">More than one starting scene in this act</div>
      ) : null}
    </div>
  );
}

export const nodeTypes = {
  act: ActNode,
  scene: SceneNode,
  character: CharacterNode,
  place: PlaceNode,
};
