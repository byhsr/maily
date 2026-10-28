import { Fragment } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { nodeAccent } from "./theme";
import { NODE_PORTS, type CampaignNodeData } from "./graph";

/** Shared card chrome: muted type label above, dot + title row inside, named ports. */
export function NodeCard({ data, selected }: NodeProps<Node<CampaignNodeData>>) {
  const ports = NODE_PORTS[data.nodeType] ?? NODE_PORTS.action;

  return (
    <div className={`cv-node kind-${data.nodeType}${selected ? " sel" : ""}${data.invalid ? " bad" : ""}`}>
      <span className="cv-node-kind">{data.kind}</span>
      <div className="cv-card">
        {ports.target && <Handle type="target" position={Position.Left} className="port-neutral" />}
        <header className="cv-head">
          <i className="cv-dot" style={{ background: nodeAccent(data.nodeType) }} />
          <b>{data.label}</b>
          {data.count > 0 && <span className="cv-badge">{data.count}</span>}
          {data.invalid && <span className="cv-badge">!</span>}
        </header>
        {data.summary && <p className="cv-sub">{data.summary}</p>}
        {ports.out.map((port, index) => {
          const top = `${((index + 1) / (ports.out.length + 1)) * 100}%`;
          return (
            <Fragment key={port.id}>
              <Handle id={port.id} type="source" position={Position.Right} className="port-out" style={{ top }} />
              {port.label && (
                <span className="cv-port-label" style={{ top }}>
                  {port.label}
                </span>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
