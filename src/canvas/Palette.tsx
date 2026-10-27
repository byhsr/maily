import type { NodeType } from "../lib/types";
import { NODE_META, PALETTE } from "./graph";

export function Palette({ onAdd }: { onAdd: (type: NodeType) => void }) {
  return (
    <aside className="palette">
      <span className="raillabel">Node palette</span>
      {PALETTE.map((type) => (
        <button className="paletteitem" key={type} onClick={() => onAdd(type)}>
          {NODE_META[type].label}
        </button>
      ))}
      <p className="muted">Click a node to add it, then connect the handles.</p>
    </aside>
  );
}
