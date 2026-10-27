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
