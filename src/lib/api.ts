import { invoke } from "@tauri-apps/api/core";
import type { Campaign, DashboardData, Lead, Template } from "./types";

export const api = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);

export const getDashboard = () => api<DashboardData>("dashboard");
export const listCampaigns = () => api<Campaign[]>("list_campaigns");
export const listLeads = () => api<Lead[]>("list_leads");
export const listTemplates = () => api<Template[]>("list_templates");
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
