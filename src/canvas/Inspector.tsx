import type { Node } from "@xyflow/react";
import type { Template } from "../lib/types";
import { ACTION_KINDS, CONDITION_KINDS, type CampaignNodeData } from "./graph";

type InspectorProps = {
  node: Node<CampaignNodeData> | undefined;
  templates: Template[];
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
};

export function Inspector({ node, templates, onChange, onDelete }: InspectorProps) {
  if (!node) {
    return (
      <aside className="inspector">
        <span className="raillabel">Inspector</span>
        <p className="muted">Select a node to configure it.</p>
      </aside>
    );
  }
  const { nodeType, config, label } = node.data;

  return (
    <aside className="inspector">
      <span className="raillabel">Inspector · {label}</span>
      {nodeType === "email" && (
        <label>
          Template
          <select value={String(config.template_id ?? "")} onChange={(e) => onChange({ template_id: e.target.value })}>
            <option value="">Pick a template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {nodeType === "delay" && (
        <label>
          Wait (minutes)
          <input
            type="number"
            min={0}
            value={Number(config.minutes ?? 0)}
            onChange={(e) => onChange({ minutes: Number(e.target.value) })}
          />
        </label>
      )}
      {nodeType === "condition" && (
        <label>
          Branch on
          <select value={String(config.kind ?? "replied")} onChange={(e) => onChange({ kind: e.target.value })}>
            {CONDITION_KINDS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
      )}
      {nodeType === "action" && (
        <>
          <label>
            Action
            <select value={String(config.kind ?? "notify")} onChange={(e) => onChange({ kind: e.target.value })}>
              {ACTION_KINDS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          {config.kind === "tag" && (
            <label>
              Tag
              <input value={String(config.tag ?? "")} onChange={(e) => onChange({ tag: e.target.value })} />
            </label>
          )}
        </>
      )}
      {nodeType === "end" && (
        <label>
          Outcome
          <select value={String(config.outcome ?? "completed")} onChange={(e) => onChange({ outcome: e.target.value })}>
            <option value="completed">Completed</option>
            <option value="replied">Replied</option>
            <option value="unsubscribed">Unsubscribed</option>
          </select>
        </label>
      )}
      {nodeType === "start" && <p className="muted">Leads enter here and move down the graph.</p>}
      {nodeType !== "start" && (
        <button className="chip" onClick={onDelete}>
          Delete node
        </button>
      )}
    </aside>
  );
}
