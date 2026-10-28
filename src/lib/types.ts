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
  list_name?: string;
  status: string;
};

/** A named group of saved leads; a campaign's Audience node targets one. */
export type LeadList = {
  name: string;
  count: number;
};

/** An entry in the OpenRouter catalog, cached by the backend. */
export type LlmModel = {
  id: string;
  name?: string;
  context_length?: number;
  prompt_price?: string | number;
  completion_price?: string | number;
};

/** Which model each job picks by default. Any slot may be blank. */
export type LlmSettings = {
  default_model?: string;
  drafter_model?: string;
  classifier_model?: string;
  style_model?: string;
};

export type OllamaModel = {
  name: string;
  size?: number;
  modified_at?: string;
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

export type NodeType = "audience" | "start" | "email" | "delay" | "condition" | "action" | "end";
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

export type Channel = {
  id: string;
  name: string;
  color: string;
  unread: number;
  total: number;
};

export type InboxMessage = {
  id: string;
  account_id: string;
  from_email?: string;
  subject?: string;
  received_at?: string;
  raw_excerpt?: string;
  category?: string;
  confidence?: number;
  classified_by?: string;
  channel_id?: string;
  read: boolean;
  snoozed_until?: string;
  lead_name?: string;
  company?: string;
  title?: string;
};

export type InboxThread = {
  id: string;
  from_email?: string;
  subject?: string;
  received_at?: string;
  raw_excerpt?: string;
  category?: string;
  confidence?: number;
  classified_by?: string;
  channel_id?: string;
  read: boolean;
  lead: { id?: string; name?: string; company?: string; title?: string };
  history: { status: string; created_at: string; campaign?: string }[];
};
