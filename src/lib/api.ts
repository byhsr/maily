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
  KnowledgeEntry,
  Lead,
  LeadList,
  LlmModel,
  OllamaModel,
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
export const testOllama = (url: string) => api<OllamaModel[]>("test_ollama", { url });
export const saveSetting = (input: { key: string; value: unknown }) =>
  api<void>("save_setting", { input });
export const getSettings = () => api<Record<string, unknown>>("get_settings");

export const saveOpenrouterKey = (key: string) => api<void>("save_openrouter_key", { key });
export const openrouterKeyStatus = () => api<{ stored: boolean }>("openrouter_key_status");
export const clearOpenrouterKey = () => api<void>("clear_openrouter_key");
export const listOpenrouterModels = (refresh = false) => api<LlmModel[]>("list_openrouter_models", { refresh });
export const testLlm = (model: string) =>
  api<{ model: string; latency_ms: number; sample: unknown; cost: number }>("test_llm", { model });

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

export const listKnowledge = (category?: string, approvedOnly = false) =>
  api<KnowledgeEntry[]>("list_knowledge", { category: category ?? null, approvedOnly });
export const saveKnowledge = (input: Record<string, unknown>) => api<string>("save_knowledge", { input });
export const deleteKnowledge = (id: string) => api<void>("delete_knowledge", { id });
export const previewKnowledge = (categories?: string[]) =>
  api<string>("preview_knowledge", { categories: categories ?? null });
