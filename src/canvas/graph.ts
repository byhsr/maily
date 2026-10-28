import type { Edge, Node } from "@xyflow/react";
import type { EdgeLabel, GraphEdge, GraphNode, NodeType, Template } from "../lib/types";

export type CampaignNodeData = {
  nodeType: NodeType;
  /** Muted type label shown above the card ("Email", "Model"). */
  kind: string;
  /** Instance title inside the card ("Email 1"). */
  label: string;
  summary: string;
  count: number;
  invalid: boolean;
  branches: boolean;
  config: Record<string, unknown>;
};

export const NODE_META: Record<NodeType, { label: string; branches?: boolean }> = {
  audience: { label: "Audience" },
  start: { label: "Start" },
  email: { label: "Email" },
  delay: { label: "Delay" },
  condition: { label: "Condition", branches: true },
  classifier: { label: "Reply Classifier" },
  action: { label: "Action" },
  end: { label: "End" },
};

export const PALETTE: NodeType[] = ["audience", "email", "delay", "condition", "classifier", "action", "end"];

/** The five labels a Reply Classifier judges a reply into, each its own port. */
export const CLASSIFIER_PORTS = [
  { id: "positive", label: "Positive" },
  { id: "negative", label: "Negative" },
  { id: "question", label: "Question" },
  { id: "ooo", label: "Out of office" },
  { id: "unsubscribe", label: "Unsubscribe" },
] as const;

const ONE_OUT = [{ id: "out", label: "" }];

/**
 * Output ports per node type. The handle id becomes the edge label, which is how
 * the runner knows which branch to take.
 */
export const NODE_PORTS: Record<NodeType, { target: boolean; out: { id: string; label: string }[] }> = {
  audience: { target: false, out: ONE_OUT },
  start: { target: false, out: ONE_OUT },
  email: { target: true, out: ONE_OUT },
  delay: { target: true, out: ONE_OUT },
  condition: { target: true, out: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  classifier: { target: true, out: CLASSIFIER_PORTS.map((port) => ({ ...port })) },
  action: { target: true, out: ONE_OUT },
  end: { target: false, out: [] },
};

export const CONDITION_KINDS = [
  ["replied", "Replied"],
  ["interested", "Reply was positive"],
] as const;

export const ACTION_KINDS = [
  ["tag", "Tag the lead"],
  ["notify", "Notify me"],
  ["pause", "Pause the lead"],
  ["suppress", "Suppress the lead"],
] as const;

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

export function summarize(nodeType: NodeType, config: Record<string, unknown>, templates: Template[]): string {
  switch (nodeType) {
    case "audience": {
      const list = String(config.list_name ?? "").trim();
      return list ? `List: ${list}` : "All active leads";
    }
    case "email": {
      if (config.personalize) return "Agent-written, reviewed before sending";
      const template = templates.find((t) => t.id === config.template_id);
      return template ? template.name : "Campaign's template";
    }
    case "delay":
      return `Wait ${formatMinutes(Number(config.minutes ?? 0))}`;
    case "condition":
      return config.kind === "interested" ? "Reply was positive?" : "Replied?";
    case "classifier": {
      const model = String(config.model ?? "").trim();
      return model ? model : "Uses the classification model";
    }
    case "action":
      return String(config.tag ?? config.kind ?? "notify");
    case "end":
      return String(config.outcome ?? "completed");
    default:
      return "Every active lead";
  }
}

export function toFlow(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  counts: Record<string, number>,
  templates: Template[],
  invalidIds: string[]
): Node<CampaignNodeData>[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: "campaign",
    position: { x: node.x, y: node.y },
    data: {
      nodeType: node.type,
      kind: NODE_META[node.type].label,
      label: NODE_META[node.type].label,
      summary: summarize(node.type, node.config, templates),
      count: counts[node.id] ?? 0,
      invalid: invalidIds.includes(node.id),
      branches: Boolean(NODE_META[node.type].branches),
      config: node.config,
    },
  }));
}

export function toEdges(edges: GraphEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.from_node,
    sourceHandle: edge.label === "next" ? undefined : edge.label,
    target: edge.to_node,
    label: edge.label === "next" ? undefined : edge.label,
    data: { label: edge.label },
    animated: edge.label !== "next",
  }));
}

export function fromFlow(nodes: Node<CampaignNodeData>[], edges: Edge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      config: node.data.config,
      x: node.position.x,
      y: node.position.y,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      from_node: edge.source,
      to_node: edge.target,
      label: ((edge.data?.label as EdgeLabel) ?? "next") as EdgeLabel,
    })),
  };
}

export function defaultConfig(nodeType: NodeType): Record<string, unknown> {
  switch (nodeType) {
    case "audience":
      return { list_name: "" };
    case "delay":
      return { minutes: 1440 };
    case "condition":
      return { kind: "replied" };
    case "classifier":
      return { model: "", instruction: "", knowledge: [], min_confidence: 0.6 };
    case "action":
      return { kind: "notify" };
    case "end":
      return { outcome: "completed" };
    case "email":
      return { variant: "a", personalize: false };
    default:
      return {};
  }
}
