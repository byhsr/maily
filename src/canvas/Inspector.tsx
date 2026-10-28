import type { Node } from "@xyflow/react";
import type { LeadList, Template } from "../lib/types";
import { ACTION_KINDS, CONDITION_KINDS, type CampaignNodeData } from "./graph";

type InspectorProps = {
  node: Node<CampaignNodeData>;
  templates: Template[];
  lists: LeadList[];
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
};

export function Inspector({ node, templates, lists, onChange, onDelete }: InspectorProps) {
  const { nodeType, config, label } = node.data;

  return (
    <div className="cv-panel">
      <h4>Inspector · {label}</h4>
      {nodeType === "audience" && (
        <>
          <label>
            Lead list
            <select value={String(config.list_name ?? "")} onChange={(e) => onChange({ list_name: e.target.value })}>
              <option value="">All active leads</option>
              {lists.map((list) => (
                <option key={list.name} value={list.name}>
                  {list.name} ({list.count})
                </option>
              ))}
            </select>
          </label>
          <p>The campaign only enrolls leads saved in the selected list.</p>
        </>
      )}
      {nodeType === "email" && (
        <>
          <label>
            Template
            <select value={String(config.template_id ?? "")} onChange={(e) => onChange({ template_id: e.target.value })}>
              <option value="">Use the campaign's template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="cv-toggle">
            <input
              type="checkbox"
              checked={Boolean(config.personalize)}
              onChange={(e) => onChange({ personalize: e.target.checked })}
            />
            <span>
              Write each email with an agent
              <small>Every lead gets an LLM draft you approve before it can send.</small>
            </span>
          </label>
        </>
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
      {nodeType === "start" && <p>Legacy entry node. Add an Audience node to choose leads.</p>}
      {nodeType !== "start" && (
        <button className="cv-danger" onClick={onDelete}>
          Delete node
        </button>
      )}
    </div>
  );
}
