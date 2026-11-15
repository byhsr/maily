import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AgentDef,
  AgentRun,
  Campaign,
  CampaignDetail,
  Channel,
  DashboardData,
  DashboardStats,
  Draft,
  DomainPosture,
  FollowupDraft,
  InboxMessage,
  InboxThread,
  KnowledgeEntry,
  Lead,
  LeadList,
  LlmModel,
  MessageVariables,
  OllamaModel,
  PostmasterReport,
  ScheduledItem,
  SentMessage,
  StopRules,
  Template,
  ThreadFollowups,
  WorkspaceList,
} from "./types";

export const api = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);

export const getDashboard = () => api<DashboardData>("dashboard");
export const dashboardStats = (range: string) => api<DashboardStats>("dashboard_stats", { range });
export const listCampaigns = () => api<Campaign[]>("list_campaigns");
export const campaignDetail = (campaignId: string) => api<CampaignDetail>("campaign_detail", { campaignId });
export const listLeads = () => api<Lead[]>("list_leads");
export const listLeadLists = () => api<LeadList[]>("list_lead_lists");
export const deleteLead = (id: string) => api<void>("delete_lead", { id });
export const deleteLeadList = (name: string) => api<number>("delete_lead_list", { name });
export const updateLead = (input: Record<string, unknown>) => api<void>("update_lead", { input });
export const listTemplates = () => api<Template[]>("list_templates");
export const seedTemplates = () => api<number>("seed_templates");
export const upsertLeads = (leads: Record<string, unknown>[]) =>
  api<number>("upsert_leads", { leads });
export const saveCampaign = (input: Record<string, unknown>) =>
  api<string>("save_campaign", { input });

/** One follow-up, carrying its own message: the copy taken when a template was picked. */
export type CampaignStepInput = {
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
  delay_minutes?: number | null;
  send_date?: string | null;
};
/** Replaces a campaign's follow-up sequence. The first touch — step 0 — belongs to the
 *  campaign itself and is saved with `saveCampaign`. */
export const saveSteps = (campaignId: string, steps: CampaignStepInput[]) =>
  api<void>("save_steps", { campaignId, steps });
/** Saves one reusable message. A campaign copies it when it picks it, so editing this
 *  later never changes a campaign already built from it. */
export const saveTemplate = (input: Record<string, unknown>) =>
  api<string>("save_template", { input });
export const deleteTemplate = (id: string) => api<void>("delete_template", { id });
export const runAgent = (input: Record<string, unknown>) =>
  api<string>("run_agent", { input });
export const testOllama = (url: string) => api<OllamaModel[]>("test_ollama", { url });

/** Installed Ollama models via the saved server URL; empty when Ollama is not running. */
export const localOllamaModels = async (): Promise<OllamaModel[]> => {
  const settings = await getSettings().catch(() => ({}) as Record<string, unknown>);
  const url =
    typeof settings.ollama_url === "string" && settings.ollama_url
      ? settings.ollama_url
      : "http://127.0.0.1:11434";
  return testOllama(url).catch(() => []);
};
export const saveSetting = (input: { key: string; value: unknown }) =>
  api<void>("save_setting", { input });
export const getSettings = () => api<Record<string, unknown>>("get_settings");

export const saveOpenrouterKey = (key: string) => api<void>("save_openrouter_key", { key });
export const openrouterKeyStatus = () => api<{ stored: boolean }>("openrouter_key_status");
export const revealOpenrouterKey = () => api<string>("reveal_openrouter_key");
export const clearOpenrouterKey = () => api<void>("clear_openrouter_key");
export const listOpenrouterModels = (refresh = false) => api<LlmModel[]>("list_openrouter_models", { refresh });
export const testLlm = (model: string) =>
  api<{ model: string; latency_ms: number; sample: unknown; cost: number }>("test_llm", { model });

/** Connected sending accounts and the OAuth flow that creates them. */
export const listAccounts = () => api<Account[]>("list_accounts");
/** What an account's token may actually do — a token can be granted less than it asked. */
export type AccountPermissions = { email: string; provider: string; scopes: string[]; can_send: boolean };
export const accountPermissions = (id: string) => api<AccountPermissions>("account_permissions", { id });
export const disconnectAccount = (id: string) => api<void>("disconnect_account", { id });
export const setAccountLimits = (id: string, daily_limit: number, hourly_limit: number) =>
  api<void>("set_account_limits", { id, dailyLimit: daily_limit, hourlyLimit: hourly_limit });
/** Which providers already have an app-level OAuth client, plus the redirect Maily uses. */
export const oauthStatus = () =>
  api<{ redirect_uri: string; providers: Record<string, boolean> }>("oauth_status");

/** Saves the app's OAuth client so connecting becomes a single click from then on. */
export const saveOauthClient = (provider: string, client_id: string, client_secret?: string | null) =>
  api<void>("save_oauth_client", { provider, clientId: client_id, clientSecret: client_secret ?? null });

/** Omit client_id/redirect_uri to use the app's saved OAuth client (the one-click flow). */
export const startOauth = (config: { provider: string; client_id?: string | null; redirect_uri?: string | null }) =>
  api<string>("start_oauth", { config });
export const finishOauth = (data: {
  provider: string;
  code: string;
  state: string;
  client_id?: string | null;
  client_secret?: string | null;
  redirect_uri?: string | null;
}) => api<{ email: string; provider: string }>("finish_oauth", { data });
export const awaitOauthRedirect = (port: number, expectedState: string, timeoutSeconds = 300) =>
  api<{ code: string; state: string }>("await_oauth_redirect", { port, expectedState, timeoutSeconds });

export const launchCampaign = (campaignId: string) => api<number>("launch_campaign", { campaignId });
export const pauseCampaign = (campaignId: string) => api<void>("pause_campaign", { campaignId });
export const deleteCampaign = (campaignId: string) => api<void>("delete_campaign", { campaignId });
/** Copies a campaign and its sequence into a fresh draft with an empty audience. */
export const duplicateCampaign = (campaignId: string) => api<string>("duplicate_campaign", { campaignId });
/** What a message may interpolate, asked for rather than kept in the editor. */
export const messageVariables = () => api<MessageVariables>("message_variables");
/** Writes the campaign's results as a CSV and returns where it was written. */
export const exportCampaignCsv = (campaignId: string) => api<string>("export_campaign_csv", { campaignId });
/** Stops one lead inside one campaign; the shared step is left alone. */
export const campaignLeadAction = (campaignId: string, leadId: string, action: "skip" | "pause") =>
  api<void>("campaign_lead_action", { campaignId, leadId, action });

export const syncInbox = (accountId?: string) => api<number>("sync_inbox", { accountId: accountId ?? null });
export const classifyInbox = (useAgent: boolean) => api<number>("classify_inbox", { useAgent });
export const listChannels = (accountId?: string | null) =>
  api<Channel[]>("list_channels", { accountId: accountId ?? null });
/** The three views that live in `inbox_messages`; Sent and Drafts have their own calls. */
export type InboxView = "inbox" | "new" | "archived";
/** Every list narrows to one mailbox when `accountId` is set — that is the account switch. */
export const listInbox = (
  view: InboxView = "inbox",
  channelId?: string,
  unreadOnly = false,
  sort = "newest",
  accountId?: string | null
) =>
  api<InboxMessage[]>("list_inbox", {
    view,
    channelId: channelId ?? null,
    unreadOnly,
    sort,
    accountId: accountId ?? null,
  });
export const setInboxChannel = (messageId: string, channelId: string) =>
  api<void>("set_inbox_channel", { messageId, channelId });
export const markInboxRead = (messageId: string, read: boolean) => api<void>("mark_inbox_read", { messageId, read });
export const snoozeInbox = (messageId: string, until: string) => api<void>("snooze_inbox", { messageId, until });
export const inboxThread = (messageId: string) => api<InboxThread>("inbox_thread", { messageId });
export const suppressLead = (email: string, reason: string) => api<void>("suppress_lead", { email, reason });

/** One hand-written email, either a new message or a reply to an inbox thread. */
export const sendMessage = (input: {
  account_id?: string | null;
  lead_id?: string | null;
  to?: string | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  subject?: string | null;
  /** The message as written; the server stores it alongside what it sent. */
  markdown: string;
  /** Rendered by `renderEmailMarkdown`, so Preview and delivery cannot differ. */
  html: string;
  text: string;
  reply_to?: string | null;
  /** An autosaved draft to clear once the message is away. */
  draft_id?: string | null;
  /** Follow-ups to schedule after this message. A single email that carries them is
   *  stored as a hidden campaign, and the one scheduler walks it. */
  followups?: FollowupDraft[];
  /** Which stop rules those follow-ups obey; every rule is on unless said otherwise. */
  stop_rules?: StopRules;
}) => api<{ to: string; subject: string; from: string; lead_id: string | null; followups: number }>("send_message", { input });

/** The follow-ups hanging off one conversation, and whether the single is paused. */
export const threadFollowups = (messageId: string) =>
  api<ThreadFollowups>("thread_followups", { messageId });
/** Everything still waiting to go out, for the Scheduled view. */
export const listScheduled = (limit = 200) => api<ScheduledItem[]>("list_scheduled", { limit });

/** Workspaces: everything the app lists is gated by the active one. */
export const listWorkspaces = () => api<WorkspaceList>("list_workspaces");
/** Creates a workspace and switches to it. */
export const createWorkspace = (name: string) => api<string>("create_workspace", { name });
export const renameWorkspace = (id: string, name: string) => api<void>("rename_workspace", { id, name });
export const switchWorkspace = (id: string) => api<void>("switch_workspace", { id });

/** The Postmaster: SPF, DKIM, DMARC and MX for a sending domain, scored as a risk. */
export const domainPosture = (domain: string) => api<DomainPosture>("domain_posture", { domain });

/** Google's own reputation telemetry for a domain; a Gmail account with the Postmaster
 *  permission is needed, and the domain has to be verified in Postmaster Tools. */
export const postmasterReport = (domain: string, accountId?: string | null) =>
  api<PostmasterReport>("postmaster_report", { domain, accountId: accountId ?? null });
/** Bring one follow-up forward so the next tick sends it. */
export const followupSendNow = (stepId: string) => api<void>("followup_send_now", { stepId });
export const followupCancel = (stepId: string) => api<void>("followup_cancel", { stepId });
/** One edited follow-up, re-rendered by the composer through the shared renderer. */
export const followupUpdate = (input: {
  id: string;
  delay_days?: number | null;
  body_md?: string | null;
  body_html?: string | null;
  body_text?: string | null;
  subject_override?: string | null;
}) => api<void>("followup_update", { input });
export const pauseFollowups = (campaignId: string) => api<void>("followups_pause", { campaignId });
export const resumeFollowups = (campaignId: string) => api<void>("followups_resume", { campaignId });
export const cancelAllFollowups = (campaignId: string) => api<void>("followups_cancel_all", { campaignId });

/** The counts the Inbox rail shows. */
export const inboxCounts = (accountId?: string | null) =>
  api<{ inbox: number; unread: number; archived: number; sent: number; drafts: number; scheduled: number }>(
    "inbox_counts",
    { accountId: accountId ?? null }
  );

/** Bulk file actions from the thread list. */
export const inboxBulk = (ids: string[], action: "archive" | "unarchive" | "read" | "unread" | "delete") =>
  api<number>("inbox_bulk", { ids, action });

export const listSent = (limit = 100, accountId?: string | null) =>
  api<SentMessage[]>("list_sent", { limit, accountId: accountId ?? null });
export const listDrafts = (accountId?: string | null) =>
  api<Draft[]>("list_drafts", { accountId: accountId ?? null });
export const saveDraft = (input: Record<string, unknown>) => api<string>("save_draft", { input });
export const deleteDraft = (id: string) => api<void>("delete_draft", { id });

export const listKnowledge = (category?: string, approvedOnly = false) =>
  api<KnowledgeEntry[]>("list_knowledge", { category: category ?? null, approvedOnly });
export const saveKnowledge = (input: Record<string, unknown>) => api<string>("save_knowledge", { input });
export const deleteKnowledge = (id: string) => api<void>("delete_knowledge", { id });
export const previewKnowledge = (categories?: string[]) =>
  api<string>("preview_knowledge", { categories: categories ?? null });

export const listAgents = () => api<AgentDef[]>("list_agents");
export const saveAgent = (input: Record<string, unknown>) => api<string>("save_agent", { input });
export const deleteAgent = (id: string) => api<void>("delete_agent", { id });
export const listAgentRuns = (limit = 50) => api<AgentRun[]>("list_agent_runs", { limit });
export const analyzeStyle = () => api<string>("analyze_style");
