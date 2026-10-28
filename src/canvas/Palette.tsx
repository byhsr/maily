import type { NodeType } from "../lib/types";
import { NODE_META, PALETTE } from "./graph";
import { nodeAccent } from "./theme";

export function Palette({ onAdd }: { onAdd: (type: NodeType) => void }) {
  return (
    <aside className="cv-panel">
      <h4>Add node</h4>
      {PALETTE.map((type) => (
        <button className="cv-add" key={type} onClick={() => onAdd(type)}>
          <i className="cv-dot" style={{ background: nodeAccent(type) }} />
          {NODE_META[type].label}
        </button>
      ))}
      <p>Drop nodes, then drag from a port to connect them.</p>
    </aside>
  );
}
