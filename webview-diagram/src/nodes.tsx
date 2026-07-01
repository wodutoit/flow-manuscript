import { Handle, Position, type NodeProps } from "reactflow";
import type { DiagramNodeVM } from "../../src/shared/types";
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

export const nodeTypes = {
  scene: SceneNode,
  character: CharacterNode,
  place: PlaceNode,
};
