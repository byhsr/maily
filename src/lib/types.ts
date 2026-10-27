export type Campaign = {
  id: string;
  name: string;
  status: string;
  mode: string;
  approved_at?: string;
  leads: number;
};

export type Lead = {
  id: string;
  email: string;
  first_name?: string;
  company?: string;
  title?: string;
  status: string;
};

export type Template = {
  id: string;
  name: string;
  subject: string;
  body: string;
  purpose: string;
  variants: unknown[];
};

export type DashboardData = {
  campaigns?: number;
  queued?: number;
  sent?: number;
  failed?: number;
  replies?: number;
  interested?: number;
  accounts?: unknown[];
  events?: unknown[];
};

export type StatsPoint = {
  key: string;
  label: string;
  sent: number;
  replied: number;
  positive: number;
  failed: number;
};

export type StatsTotals = {
  sent: number;
  replied: number;
  positive: number;
  failed: number;
};

export type DashboardStats = {
  range: string;
  series: StatsPoint[];
  totals: StatsTotals;
  previous: StatsTotals;
  needsAttention: number;
  activeCampaigns: number;
};

export type NodeType = "start" | "email" | "delay" | "condition" | "action" | "end";
export type EdgeLabel = "next" | "yes" | "no";

export type GraphNode = {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
  x: number;
  y: number;
};

export type GraphEdge = {
  id: string;
  from_node: string;
  to_node: string;
  label: EdgeLabel;
};

export type CampaignGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: Record<string, number>;
};

export type GraphValidation = {
  valid: boolean;
  issues: string[];
  node_ids: string[];
};

export type PathStep = {
  id: string;
  type: NodeType;
  detail: string;
};
