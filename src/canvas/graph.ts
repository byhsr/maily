import type { Edge, Node } from "@xyflow/react";
import type { EdgeLabel, GraphEdge, GraphNode, NodeType, Template } from "../lib/types";

export type CampaignNodeData = {
  nodeType: NodeType;
  label: string;
  summary: string;
  count: number;
  invalid: boolean;
  branches: boolean;
  config: Record<string, unknown>;
};

export const NODE_META: Record<NodeType, { label: string; branches?: boolean }> = {
  start: { label: "Start" },
  email: { label: "Email" },
  delay: { label: "Delay" },
  condition: { label: "Condition", branches: true },
  action: { label: "Action" },
  end: { label: "End" },
};

export const PALETTE: NodeType[] = ["email", "delay", "condition", "action", "end"];

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
    case "email": {
      const template = templates.find((t) => t.id === config.template_id);
      return template ? template.name : "Pick a template";
    }
    case "delay":
      return `Wait ${formatMinutes(Number(config.minutes ?? 0))}`;
    case "condition":
      return config.kind === "interested" ? "Reply was positive?" : "Replied?";
    case "action":
      return String(config.tag ?? config.kind ?? "notify");
    case "end":
      return String(config.outcome ?? "completed");
    default:
      return "Every active lead";
  }
}

/** The shipped default flow from the build guide. */
export function defaultFlow(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const raw: [NodeType, Record<string, unknown>, number, number][] = [
    ["start", {}, 0, 0],
    ["email", { variant: "a" }, 0, 150],
    ["delay", { minutes: 4320 }, 0, 300],
    ["condition", { kind: "replied" }, 0, 450],
    ["action", { kind: "tag", tag: "Interested" }, 300, 600],
    ["end", { outcome: "replied" }, 300, 750],
    ["email", { subject: "Re: follow-up", variant: "a" }, 0, 600],
    ["delay", { minutes: 5760 }, 0, 750],
    ["condition", { kind: "replied" }, 0, 900],
    ["action", { kind: "tag", tag: "Interested" }, 300, 1050],
    ["end", { outcome: "replied" }, 300, 1200],
    ["email", { variant: "breakup" }, 0, 1050],
    ["delay", { minutes: 7200 }, 0, 1200],
    ["end", { outcome: "completed" }, 0, 1350],
  ];
  const nodes: GraphNode[] = raw.map(([type, config, x, y]) => ({ id: newId(type), type, config, x, y }));
  const link = (from: number, to: number, label: EdgeLabel): GraphEdge => ({
    id: newId("edge"),
    from_node: nodes[from].id,
    to_node: nodes[to].id,
    label,
  });
  const edges: GraphEdge[] = [
    link(0, 1, "next"),
    link(1, 2, "next"),
    link(2, 3, "next"),
    link(3, 4, "yes"),
    link(3, 6, "no"),
    link(4, 5, "next"),
    link(6, 7, "next"),
    link(7, 8, "next"),
    link(8, 9, "yes"),
    link(8, 11, "no"),
    link(9, 10, "next"),
    link(11, 12, "next"),
    link(12, 13, "next"),
  ];
  return { nodes, edges };
}

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.from_node, [...(adjacency.get(edge.from_node) ?? []), edge.to_node]);
  }
  const depth = new Map<string, number>();
  const start = nodes.find((n) => n.type === "start");
  const queue: string[] = [];
  if (start) {
    depth.set(start.id, 0);
    queue.push(start.id);
  }
  while (queue.length) {
    const id = queue.shift() as string;
    const current = depth.get(id) ?? 0;
    for (const next of adjacency.get(id) ?? []) {
      if (!depth.has(next) || (depth.get(next) ?? 0) < current + 1) {
        depth.set(next, current + 1);
        queue.push(next);
      }
    }
  }
  let max = 0;
  depth.forEach((value) => {
    max = Math.max(max, value);
  });
  for (const node of nodes) {
    if (!depth.has(node.id)) depth.set(node.id, max + 1);
  }
  const column = new Map<number, number>();
  return nodes.map((node) => {
    const layer = depth.get(node.id) ?? 0;
    const index = column.get(layer) ?? 0;
    column.set(layer, index + 1);
    return { ...node, x: index * 270, y: layer * 150 };
  });
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
    case "delay":
      return { minutes: 1440 };
    case "condition":
      return { kind: "replied" };
    case "action":
      return { kind: "notify" };
    case "end":
      return { outcome: "completed" };
    case "email":
      return { variant: "a" };
    default:
      return {};
  }
}
