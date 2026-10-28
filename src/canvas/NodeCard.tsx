import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { nodeAccent } from "./theme";
import type { CampaignNodeData } from "./graph";

/** Shared card chrome: muted type label above, dot + title row inside, ports. */
export function NodeCard({ data, selected }: NodeProps<Node<CampaignNodeData>>) {
  const kind: string = data.nodeType;
  const hasTarget = kind !== "audience" && kind !== "start";
  const hasSource = kind !== "results" && kind !== "end";

  return (
    <div className={`cv-node${selected ? " sel" : ""}${data.invalid ? " bad" : ""}`}>
      <span className="cv-node-kind">{data.kind}</span>
      <div className="cv-card">
        {hasTarget && <Handle type="target" position={Position.Left} className="port-neutral" />}
        <header className="cv-head">
          <i className="cv-dot" style={{ background: nodeAccent(kind) }} />
          <b>{data.label}</b>
          {data.count > 0 && <span className="cv-badge">{data.count}</span>}
          {data.invalid && <span className="cv-badge">!</span>}
        </header>
        {data.summary && <p className="cv-sub">{data.summary}</p>}
        {hasSource && <Handle type="source" position={Position.Right} className="port-out" />}
      </div>
    </div>
  );
}
