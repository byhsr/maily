import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { CampaignNodeData } from "./graph";

export function NodeCard({ data, selected }: NodeProps<Node<CampaignNodeData>>) {
  const isStart = data.nodeType === "start";
  return (
    <div className={`cfnode${selected ? " sel" : ""}${data.invalid ? " bad" : ""}`} data-kind={data.nodeType}>
      {!isStart && <Handle type="target" position={Position.Top} />}
      <span className="cfkind">{data.label}</span>
      <b className="cfsummary">{data.summary}</b>
      {data.count > 0 && <i className="cfcount">{data.count}</i>}
      {data.invalid && <em className="cfflag" title="This node makes the graph invalid">!</em>}
      {data.branches ? (
        <>
          <Handle id="yes" type="source" position={Position.Bottom} className="h-yes" />
          <Handle id="no" type="source" position={Position.Bottom} className="h-no" />
        </>
      ) : (
        data.nodeType !== "end" && <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}
