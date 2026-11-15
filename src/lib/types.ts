export type Campaign = {
  id: string;
  name: string;
  status: string;
  /** `campaign` for a list send, `single` for one email that carries follow-ups. A
   *  single is a campaign to the scheduler and is hidden from the Campaigns list. */
  kind?: string;
  mode: string;
  approved_at?: string;
  template_id?: string;
  /** The first touch, held by the campaign itself: the copy taken when its template was
   *  picked. Sending reads this, never the template. */
  subject?: string | null;
  body?: string | null;
  list_name?: string;
  interval_minutes: number;
  account_id?: string;
  /** The zone the schedule was set in, as an IANA name. A label: the sender never reads it. */
  timezone?: string | null;
  /** When the campaign may start, as an instant. Null means as soon as it is launched. */
  scheduled_at?: string | null;
  /** This campaign's own daily ceiling, on top of the account limits. */
  daily_cap?: number | null;
  last_sent_at?: string;
  leads: number;
  sent: number;
  followups?: number;
};

/** One enrolled lead on the campaign page, with the state it is in. */
export type CampaignLeadRow = {
  lead_id: string;
  state: string;
  outcome?: string | null;
  /** Index of the step this lead is waiting on; 0 is the first email. */
  step_position?: number;
  /** When the next step falls due; null means it may send on the next tick. */
  next_due_at?: string | null;
  email: string;
  first_name?: string | null;
  company?: string | null;
  sent_at?: string | null;
  /** How many messages this lead has had. What "current step" is measured against. */
  sent_steps?: number;
  thread_id?: string | null;
  /** The newest message in this lead's conversation, for opening it in the Inbox. */
  last_message_id?: string | null;
  /** An answer came back on this lead's thread. */
  replied?: boolean;
  /** On the suppression list, which is why nothing more will go out. */
  suppressed?: boolean;
};

/** One answer a campaign received, or one message it sent. */
export type CampaignEvent = {
  lead_id: string;
  name: string;
  kind: "sent" | "replied" | "bounced";
  step?: number | null;
  /** The subject, for an answer. Empty for a send. */
  detail: string;
  at: string;
  message_id?: string | null;
};

/** One row of the step funnel: what each step sent, earned, and still has waiting. */
export type CampaignFunnelRow = {
  position: number;
  sent: number;
  replied: number;
  pending: number;
};

/** A campaign's tally. The reply rate is derived, so it cannot disagree with its parts. */
export type CampaignStats = {
  sent: number;
  replied: number;
  positive: number;
  bounced: number;
};

/** One follow-up in a campaign's sequence. Position 1 is the first follow-up; the first
 *  touch is step 0 and lives on the campaign. Each step carries its own message. */
export type CampaignStep = {
  position: number;
  /** Where the copy came from. A label only — nothing reads it to send. */
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
  delay_minutes: number;
  /** 'YYYY-MM-DD'; when set it overrides the delay. */
  send_date?: string | null;
};

/** The campaign page's payload: settings, sequence, per-state counts, and every enrolment. */
export type CampaignDetail = {
  campaign: Campaign;
  counts: Record<string, number>;
  leads: CampaignLeadRow[];
  steps: CampaignStep[];
  sent: number;
  /** Which stop rules this campaign obeys; every one is on unless turned off. */
  stop_rules?: StopRules;
  stats?: CampaignStats;
  funnel?: CampaignFunnelRow[];
  recent?: CampaignEvent[];
  /** Lead ids whose mailbox answer was a bounce rather than a reply. */
  bounced?: string[];
};

/** A connected sending account. Its OAuth token lives in the OS keyring, not here. */
export type Account = {
  id: string;
  provider: string;
  email: string;
  health: string;
  daily_limit: number;
  hourly_limit: number;
  sent_today: number;
  last_health_at?: string;
  /** When this account's position in its mailbox was last read. */
  last_synced_at?: string | null;
  /** True once a position is stored, so reads are incremental instead of windowed. */
  incremental?: boolean;
  /** Unread replies sitting in this mailbox, for the Inbox's account switcher. */
  unread?: number;
};

/** What a message may interpolate, as the one place that resolves it defines it. */
export type MessageVariables = {
  /** The lead's own columns, which always resolve. */
  standard: string[];
  /** Headers the lead import kept, so any imported column becomes usable. */
  custom: string[];
};

export type Lead = {
  id: string;
  email: string;
  first_name?: string;
  company?: string;
  title?: string;
  list_name?: string;
  status: string;
  /** The raw imported row, keyed by the CSV/XLSX header; any header is a `{{variable}}`. */
  custom_fields?: Record<string, unknown>;
};

/** A named group of saved leads; a campaign sends to one such list. */
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

export type KnowledgeCategory = "offer" | "icp" | "style" | "proof" | "objection" | "product" | "other";

/** A configured agent: instructions, model, and which knowledge it may read. */
export type AgentDef = {
  id: string;
  name: string;
  kind: string;
  model: string;
  system_prompt: string;
  knowledge_categories: string[];
  enabled: boolean;
  cost?: number;
  runs?: number;
  updated_at?: string;
};

export type AgentRun = {
  id: string;
  kind: string;
  state: string;
  model: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: string | null;
  agent_id?: string | null;
  lead_id?: string | null;
  campaign_id?: string | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  created_at: string;
  finished_at?: string | null;
};

/** An entry in the knowledge base that models are allowed to read. */
export type KnowledgeEntry = {
  id: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  approved: boolean;
  tags: string[];
  source?: string;
  updated_at?: string;
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
  /** The bare address, with any display name already stripped off. */
  from_email?: string;
  subject?: string;
  received_at?: string;
  raw_excerpt?: string;
  archived: boolean;
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
  /** The account that received this message — the default for a reply. */
  account_id?: string;
  from_email?: string;
  subject?: string;
  received_at?: string;
  raw_excerpt?: string;
  /** The message itself, for the reading pane and for quoting a reply. */
  body_html?: string;
  body_text?: string;
  archived: boolean;
  category?: string;
  confidence?: number;
  classified_by?: string;
  channel_id?: string;
  read: boolean;
  lead: {
    id?: string;
    name?: string;
    last_name?: string;
    email?: string;
    company?: string;
    title?: string;
    website?: string;
  };
  /** The whole exchange with this person, oldest first, each half signed with where it
   *  came from. */
  conversation: ConversationEntry[];
};

/**
 * One message in an exchange, whichever side it came from. `origin` is the sign: `maily`
 * is a message Maily sent, `you` is one that went out from the mailbox another way, and
 * `them` is a reply.
 */
export type ConversationEntry = {
  id: string;
  direction: "in" | "out";
  origin: "maily" | "you" | "them";
  /** The campaign that wrote a message Maily sent, when one did. */
  campaign?: string | null;
  status?: string | null;
  from_email?: string | null;
  at?: string | null;
  subject?: string | null;
  preview: string;
  html?: string | null;
  text?: string | null;
  /** The message the reading pane has open. */
  opened?: boolean;
};

/** A message that has gone out. `html` is absent for campaign templates, which are
 *  sent as plain text and so fall back to `text`. */
export type SentMessage = {
  id: string;
  to_email?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  markdown?: string;
  html?: string;
  status: string;
  created_at: string;
  account_email?: string;
  campaign?: string;
  lead_name?: string;
};

/** A composed message that has not gone out; the composer autosaves into this. */
export type Draft = {
  id: string;
  account_id?: string;
  /** An inbox message id when the draft is an answer. */
  reply_to?: string;
  to_email?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  markdown: string;
  created_at: string;
  updated_at: string;
};

/** One follow-up on a single email, as the composer sends it: the markdown as written
 *  and the html/text the one shared renderer produced from it. */
export type FollowupDraft = {
  delay_days: number;
  body_md: string;
  body_html?: string | null;
  body_text?: string | null;
  subject_override?: string | null;
  /** 'YYYY-MM-DD' pins the step to a day, which overrides `delay_days`. */
  send_date?: string | null;
};

/** Which stop rules a single's follow-ups obey; every one is on by default. */
export type StopRules = {
  reply: boolean;
  bounce: boolean;
  ooo: boolean;
};

/** One scheduled follow-up as the thread view shows it. Step 0 is the original. */
export type FollowupStep = {
  id: string;
  position: number;
  delay_days?: number | null;
  body_md?: string | null;
  subject_override?: string | null;
  status: "pending" | "sent" | "skipped" | "cancelled" | "failed";
  scheduled_at?: string | null;
  sent_at?: string | null;
  due_at?: string | null;
};

/** The follow-ups hanging off one conversation, with whether the single is paused. */
export type ThreadFollowups = {
  paused: boolean;
  pending: number;
  campaign_id?: string | null;
  steps: FollowupStep[];
};

/** A pending step waiting to go out, for the Inbox's Scheduled view. */
export type ScheduledItem = {
  id: string;
  campaign_id: string;
  position: number;
  kind: string;
  campaign?: string | null;
  campaign_status?: string | null;
  lead_email?: string | null;
  lead_name?: string | null;
  company?: string | null;
  due_at?: string | null;
  body_md?: string | null;
};

/** One workspace: a tenant with its own leads, campaigns, templates and mailboxes. */
export type Workspace = {
  id: string;
  name: string;
  leads: number;
  campaigns: number;
  accounts: number;
  templates: number;
};

/** Every workspace, plus the id of the one that is open. */
export type WorkspaceList = {
  active: string;
  workspaces: Workspace[];
};

/** One authentication check the Postmaster runs against a sending domain. */
export type PostureCheck = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  /** The record that was found, or why nothing was. */
  detail: string;
  hint: string;
  weight: number;
  earned: number;
};

/** A domain's deliverability posture: a risk score and the checks behind it. */
export type DomainPosture = {
  domain: string;
  /** 0–100; lower is better. */
  score: number;
  level: "clean" | "watch" | "risky" | "spammy";
  checks: PostureCheck[];
};

/**
 * What Google measured for a domain over the last week (Postmaster Tools API v2).
 * `available` is false when there is nothing to show — no Gmail account, no Postmaster
 * permission, an unverified domain, or a domain with too little volume — and `reason`
 * then says which.
 */
export type PostmasterReport = {
  available: boolean;
  reason?: string | null;
  /** True when the connected Gmail token simply lacks the Postmaster permission. */
  needs_permission?: boolean;
  /** Exactly what Google said the token may do — the fact behind the message. */
  granted?: string[];
  account?: string | null;
  domain?: string | null;
  /** The window the statistics cover, as `YYYY-MM-DD`. */
  start?: string | null;
  end?: string | null;
  spam_rate?: number | null;
  spf_success?: number | null;
  dkim_success?: number | null;
  dmarc_success?: number | null;
  delivery_error_rate?: number | null;
  /** How many metrics Google actually returned. Zero means it had nothing to report. */
  reported?: number;
};
