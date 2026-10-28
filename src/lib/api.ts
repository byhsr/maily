import { invoke } from "@tauri-apps/api/core";
import type {
  Campaign,
  CampaignGraph,
  Channel,
  DashboardData,
  DashboardStats,
  GraphEdge,
  GraphNode,
  GraphValidation,
  InboxMessage,
  InboxThread,
  Lead,
  LeadList,
  PathStep,
  Template,
} from "./types";

export const api = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);

export const getDashboard = () => api<DashboardData>("dashboard");
export const dashboardStats = (range: string) => api<DashboardStats>("dashboard_stats", { range });
export const listCampaigns = () => api<Campaign[]>("list_campaigns");
export const listLeads = () => api<Lead[]>("list_leads");
export const listLeadLists = () => api<LeadList[]>("list_lead_lists");
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
export const deleteCampaign = (campaignId: string) => api<void>("delete_campaign", { campaignId });
export const previewPath = (campaignId: string, leadId: string) => api<PathStep[]>("preview_path", { campaignId, leadId });

export const syncInbox = (accountId?: string) => api<number>("sync_inbox", { accountId: accountId ?? null });
export const classifyInbox = (useAgent: boolean) => api<number>("classify_inbox", { useAgent });
export const listChannels = () => api<Channel[]>("list_channels");
export const listInbox = (channelId?: string, unreadOnly = false) =>
  api<InboxMessage[]>("list_inbox", { channelId: channelId ?? null, unreadOnly });
export const setInboxChannel = (messageId: string, channelId: string) =>
  api<void>("set_inbox_channel", { messageId, channelId });
export const markInboxRead = (messageId: string, read: boolean) => api<void>("mark_inbox_read", { messageId, read });
export const snoozeInbox = (messageId: string, until: string) => api<void>("snooze_inbox", { messageId, until });
export const inboxThread = (messageId: string) => api<InboxThread>("inbox_thread", { messageId });
export const suppressLead = (email: string, reason: string) => api<void>("suppress_lead", { email, reason });
