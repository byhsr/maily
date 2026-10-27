import { invoke } from "@tauri-apps/api/core";
import type {
  Campaign,
  CampaignGraph,
  DashboardData,
  DashboardStats,
  GraphEdge,
  GraphNode,
  GraphValidation,
  Lead,
  PathStep,
  Template,
} from "./types";

export const api = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);

export const getDashboard = () => api<DashboardData>("dashboard");
export const dashboardStats = (range: string) => api<DashboardStats>("dashboard_stats", { range });
export const listCampaigns = () => api<Campaign[]>("list_campaigns");
export const listLeads = () => api<Lead[]>("list_leads");
export const listTemplates = () => api<Template[]>("list_templates");
export const seedTemplates = () => api<number>("seed_templates");
export const upsertLeads = (leads: Record<string, unknown>[]) =>
  api<number>("upsert_leads", { leads });
export const saveCampaign = (input: Record<string, unknown>) =>
  api<string>("save_campaign", { input });
export const saveTemplate = (input: Record<string, unknown>) =>
  api<string>("save_template", { input });
export const runAgent = (input: Record<string, unknown>) =>
  api<string>("run_agent", { input });
export const testOllama = (url: string) => api<unknown[]>("test_ollama", { url });
export const saveSetting = (input: { key: string; value: unknown }) =>
  api<void>("save_setting", { input });

export const loadCampaignGraph = (campaignId: string) => api<CampaignGraph>("load_campaign_graph", { campaignId });
export const saveCampaignGraph = (campaignId: string, nodes: GraphNode[], edges: GraphEdge[]) =>
  api<void>("save_campaign_graph", { campaignId, nodes, edges });
export const validateCampaignGraph = (campaignId: string) => api<GraphValidation>("validate_campaign_graph", { campaignId });
export const launchCampaign = (campaignId: string) => api<number>("launch_campaign", { campaignId });
export const pauseCampaign = (campaignId: string) => api<void>("pause_campaign", { campaignId });
export const previewPath = (campaignId: string, leadId: string) => api<PathStep[]>("preview_path", { campaignId, leadId });
