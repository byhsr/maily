import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Circle,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  campaignDetail,
  campaignFollowupSendNow,
  campaignFollowups,
  campaignLeadAction,
  deleteCampaign,
  duplicateCampaign,
  exportCampaignCsv,
  launchCampaign,
  listAccounts,
  listLeadLists,
  pauseCampaign,
  saveCampaign,
  saveSteps,
} from "../lib/api";
import { previewEmailMarkdown, renderEmailTemplate } from "../lib/email";
import {
  canSend,
  claimRow,
  dueText,
  followupStatus,
  heldWhy,
  leadStatus,
  noFollowupsText,
  progressText,
  sendBlockedReason,
  stepFilters,
  stepLabel,
  visibleFollowups,
  whenAt,
  type LeadStatus,
  type QueuePace,
} from "../lib/followups";
import { detectMapping, importMapped, readSheet, type LeadMapping } from "../lib/leadImport";
import { missingVariables, sendEstimate } from "../lib/logic";
import { inZone, ZONES, zonedInstant, zoneLabel } from "../lib/timezones";
import type {
  Account,
  Campaign as CampaignType,
  CampaignDetail,
  CampaignFollowupRow,
  CampaignFollowups,
  CampaignLeadRow,
  CampaignMetrics,
  Lead,
  LeadList,
  StopRules,
  Template,
} from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { CampaignActivity } from "../ui/CampaignActivity";
import { CampaignAnalytics } from "../ui/CampaignAnalytics";
import { Checkbox } from "../ui/Checkbox";
import { Confirm } from "../ui/Confirm";
import { FilterChip } from "../ui/FilterChip";
import { FollowupCard } from "../ui/FollowupCard";
import { FormatToolbar } from "../ui/FormatToolbar";
import { Input } from "../ui/Input";
import { OverflowMenu } from "../ui/OverflowMenu";
import { PageHeader } from "../ui/PageHeader";
import { Pager } from "../ui/Pager";
import { Select } from "../ui/Select";
import { Tooltip } from "../ui/Tooltip";
import { useVariableSuggest, VariableInput, VariableMenu } from "../ui/VariableTextarea";

type CampaignProps = {
  campaign: CampaignType;
  templates: Template[];
  /** Every saved lead, so the checklist can say how many lack a variable. */
  leads: Lead[];
  reload: () => void;
  tell: (message: string) => void;
  /** Which tab is open, held by the shell so back and forward walk it. */
  tab?: string;
  onTab: (tab: string) => void;
  /** Back to the Campaigns list, which is not the same thing as history: the topbar's back
   *  walks where you actually came from, and this one goes where its label says. */
  onBackToCampaigns: () => void;
  onDeleted: () => void;
  onDuplicated: (id: string) => void;
  onOpenThread: (messageId: string) => void;
};

const TABS = ["sequence", "sending", "leads"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  sequence: "Sequence",
  sending: "Sending",
  leads: "Leads",
};

/** The two panes the sequence editor switches between, the way the composer switches
 *  between a message and its follow-ups. */
type SeqTab = "first" | "followups";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Running",
  paused: "Paused",
  throttled: "Paused",
  done: "Completed",
  failed: "Failed",
};

/** One follow-up as the setup form holds it, before it is written back as a step. */
type DraftStep = {
  template_id: string;
  subject: string;
  body: string;
  delay_minutes: number;
  /** Carried through untouched: the card edits the wait, not a fixed date. */
  send_date: string | null;
};

const DAY_MINUTES = 1440;
const MAX_FOLLOWUPS = 5;
const MAX_SUBJECTS = 5;
const STOP_DEFAULTS: StopRules = { reply: true, bounce: true, ooo: true };

/** How far off a moment is, in the coarsest useful unit — "3m", "2h", "4d". */
function away(iso?: string | null): string {
  if (!iso) return "—";
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (Number.isNaN(minutes)) return "—";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** What an enrolment in the setup tab's audience table is, as one word. Order matters: a
 *  suppression outranks everything. The List tab asks the same question of the same rows and
 *  answers it in its own vocabulary, which is `leadStatus` in the follow-ups module. */
function audienceStatus(row: CampaignLeadRow, bounced: string[], emails: number): string {
  if (row.suppressed) return "Unsubscribed";
  if (bounced.includes(row.lead_id)) return "Bounced";
  if (row.replied) return "Replied";
  if (row.outcome === "skipped") return "Skipped";
  if (row.state === "paused") return "Paused";
  if ((row.sent_steps ?? 0) >= emails) return "Sent";
  return (row.sent_steps ?? 0) > 0 ? "Sent" : "Pending";
}

/** Which subject line a lead was given, as the letter the analytics writes it with. A campaign
 *  that was never split has one line, and one line is not a variant. */
function variantLabel(variant: number | null | undefined, subjects: string[]): string {
  if (variant === null || variant === undefined || subjects.length < 2) return "—";
  const line = subjects[variant];
  return line ? `${String.fromCharCode(65 + variant)} · ${line}` : "—";
}

/** The three views the reading half of the page is made of. Setup is a mode of its own — a
 *  campaign being written rather than read — so these sit beside it rather than among it. */
const ANALYTICS_TABS = ["analytics", "activity", "list"] as const;
type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

const ANALYTICS_LABEL: Record<AnalyticsTab, string> = {
  analytics: "Analytics",
  activity: "Activity",
  list: "List",
};

/** Where a campaign opens when the shell does not say: its setup. Which is where a campaign is
 *  created and where what has just been made gets written, so it is the one view that is never
 *  surprising to land on. The reading half keeps its own default of the numbers, which is
 *  `analyticsTab`'s fallback, and its three views sit together however this got here. */
const DEFAULT_VIEW = "sequence";

/** The view is mirrored into the URL as well as held in the shell's trail, so the tab a campaign
 *  is on can be read off the window and linked to. The trail is what restores it — it is the
 *  app's own history — and this is only ever written, never read back: a campaign that is opened
 *  says which tab it opens on, and filling one in from what was left behind is how a new
 *  campaign came to open on somebody else's numbers. */
function writeTabToUrl(view: string) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", view);
    // Replaced rather than pushed: the app's own back and forward already walk the tabs, and a
    // second history of the same journey would fight with the first.
    window.history.replaceState(null, "", url.toString());
  } catch {
    // A window that will not take a URL still works; it just does not advertise the tab.
  }
}

/** The zeros a campaign with nothing behind it reads as, so every card has a number before the
 *  first fetch has landed and none of them has to guard against a missing one. */
const NO_METRICS: CampaignMetrics = {
  total: 0,
  contacted: 0,
  emails_sent: 0,
  replied: 0,
  reply_rate: 0,
  positive: 0,
  bounced: 0,
  unsubscribed: 0,
  bounce_rate: 0,
  unsubscribe_rate: 0,
  emails_per_reply: null,
  median_reply_minutes: null,
  finished: 0,
  in_sequence: 0,
  completed_sequence: 0,
  steps: 1,
  completion_rate: 0,
  funnel: [],
  subject_stats: [],
};

/** The statuses the list can be filtered to, in the order it shows them. */
const LEAD_STATUSES: LeadStatus[] = [
  "Queued",
  "In sequence",
  "Replied",
  "Bounced",
  "Unsubscribed",
  "Finished",
];

/** How many lead rows one page of the list holds. */
const LEAD_PAGE = 25;

export function Campaign({
  campaign,
  templates,
  leads,
  reload,
  tell,
  tab: wantedTab,
  onTab,
  onBackToCampaigns,
  onDeleted,
  onDuplicated,
  onOpenThread,
}: CampaignProps) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [name, setName] = useState(campaign.name);
  const [listName, setListName] = useState(campaign.list_name ?? "");
  const [templateId, setTemplateId] = useState(campaign.template_id ?? "");
  /** The first-touch subject lines. One is an ordinary subject; more than one and the
   *  audience is split across them, which is the A/B test. */
  const [subjects, setSubjects] = useState<string[]>([campaign.subject ?? ""]);
  const [body, setBody] = useState(campaign.body ?? "");
  const [interval, setIntervalMinutes] = useState(String(campaign.interval_minutes ?? 5));
  const [accountId, setAccountId] = useState(campaign.account_id ?? "");
  const [stopRules, setStopRules] = useState<StopRules>(STOP_DEFAULTS);
  /** The campaign's own daily ceiling, and the start it has been given. */
  const [capText, setCapText] = useState(campaign.daily_cap ? String(campaign.daily_cap) : "");
  const [scheduledAt, setScheduledAt] = useState<string | null>(campaign.scheduled_at ?? null);
  /** The schedule being picked: now, or a date and time in a zone. */
  const [schedMode, setSchedMode] = useState<"now" | "later">("now");
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("09:00");
  const [schedZone, setSchedZone] = useState(campaign.timezone || "");
  /** The machine's own zone is offered first when it is not already in the list, so the
   *  default schedule is the one the person reading it is thinking in. */
  const zoneOptions = useMemo(() => {
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return mine && !ZONES.some((zone) => zone.id === mine)
      ? [{ id: mine, label: "My timezone" }, ...ZONES]
      : ZONES;
  }, []);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  /** Which pane of the sequence is open: the first email, or the follow-ups. */
  const [seqTab, setSeqTab] = useState<SeqTab>("first");
  /** Whether the first email's preview is showing beside the writing. */
  const [firstPreview, setFirstPreview] = useState(true);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [lists, setLists] = useState<LeadList[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<{
    file: string;
    headers: string[];
    records: Record<string, unknown>[];
  } | null>(null);
  const [mapping, setMapping] = useState<LeadMapping>({});
  const [mappingOpen, setMappingOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [picked, setPicked] = useState<string[]>([]);
  /** The follow-ups panel's own read, kept off `detail`: it is the one thing on this page
   *  whose rows change without the campaign's own numbers moving. */
  const [followups, setFollowups] = useState<CampaignFollowups | null>(null);
  /** Which step the panel is narrowed to: "All", or a position as a string. */
  const [stepFilter, setStepFilter] = useState("All");
  /** Whether the panel is also showing the rows that are settled — sent, skipped. */
  const [showSettled, setShowSettled] = useState(false);
  /** What the row a hand-send was just attempted for came back with. */
  const [rowError, setRowError] = useState<{ lead_id: string; message: string } | null>(null);
  /** The row whose Send now confirmation is open. */
  const [confirmingSend, setConfirmingSend] = useState<CampaignFollowupRow | null>(null);
  /** The list's own reading of the audience: by email, by what each lead is doing, a page at
   *  a time. Separate from the setup tab's search, which is there to pick leads to act on. */
  const [listQuery, setListQuery] = useState("");
  const [listStatus, setListStatus] = useState("All");
  const [listPage, setListPage] = useState(0);
  /** The clock the panel reads its times against, so "in 4h" is not frozen at mount. */
  const [clock, setClock] = useState(() => Date.now());

  /** What the campaign's own pace means for the queue, worked out once for every row. A campaign
   *  sends one email at a time, so a row whose moment has passed while the send in front of it is
   *  still being spaced out is waiting its turn rather than late — and a row on a campaign that
   *  is not running at all is held, which is the campaign's doing, not the row's. */
  const lastSend = campaign.last_sent_at ? Date.parse(campaign.last_sent_at) : Number.NaN;
  const pace: QueuePace = {
    // Throttled is the scheduler's own flag for "waiting on capacity", and it keeps looking at
    // the campaign, so a row on one is waiting its turn like any other. Paused is the state a
    // person chose, and that is what holds a queue.
    running: campaign.status === "active" || campaign.status === "throttled",
    heldWhy: heldWhy(campaign.status),
    slotAt: Number.isFinite(lastSend)
      ? lastSend + (campaign.interval_minutes || 0) * 60_000
      : null,
    nextId: followups?.next?.lead_id ?? null,
  };

  /** The line the sequence reads as "email 1's subject": the first that was actually
   *  written, so an empty first slot with a filled second still reads as having one. */
  const subject = subjects.find((line) => line.trim()) ?? "";
  const setSubjectAt = (index: number, value: string) =>
    setSubjects((current) => current.map((line, at) => (at === index ? value : line)));
  const addSubject = () =>
    setSubjects((current) => (current.length >= MAX_SUBJECTS ? current : [...current, ""]));
  const removeSubject = (index: number) =>
    setSubjects((current) => current.filter((_, at) => at !== index));

  const seeded = useRef("");
  const skipSave = useRef(true);
  const dragFrom = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The first email's body, so the toolbar and the picker can act on it. */
  const firstBody = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await campaignDetail(campaign.id));
    } catch (e) {
      tell(String(e));
    }
  }, [campaign.id]);

  /** The panel's own read: a hand-send moves these rows and nothing else on the page. */
  const refreshFollowups = useCallback(async () => {
    try {
      setFollowups(await campaignFollowups(campaign.id));
    } catch (e) {
      tell(String(e));
    }
  }, [campaign.id]);

  /** Both halves of the analytics view, so a poll or an action can never update one of them
   *  and leave the other saying something that has stopped being true. */
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshFollowups()]);
  }, [refresh, refreshFollowups]);

  const loadLists = () => listLeadLists().then(setLists).catch((e) => tell(String(e)));

  useEffect(() => {
    refreshAll();
    loadLists();
    listAccounts().then(setAccounts).catch(() => {});
  }, [campaign.id]);

  const status = detail?.campaign.status ?? campaign.status;
  const running = status === "active" || status === "throttled";
  /** Everything goes read-only once it is sending, except the pace, the account, and the
   *  bodies of steps nothing has been sent to yet. */
  const locked = status !== "draft";

  /** Whether anything in the panel can still move on its own: a row waiting on a tick, one
   *  mid-send, or one the sender failed on and a hand can pick back up. */
  const followupsLive =
    followups?.rows.some((row) => row.state === "sending" || canSend(row)) ?? false;

  // Keep the numbers live while it sends, and the follow-up times live while anything is
  // waiting on one: a campaign that reads as completed can still have a row left to send.
  useEffect(() => {
    if (!running && !followupsLive) return;
    const timer = window.setInterval(refreshAll, 4000);
    return () => window.clearInterval(timer);
  }, [running, followupsLive, refreshAll]);

  // The relative times are read against this clock — "in 3h 12m" in the queue, "17m ago" in the
  // feed — so it has to move on its own while any of them is on screen.
  useEffect(() => {
    if (!ANALYTICS_TABS.includes((wantedTab ?? DEFAULT_VIEW) as AnalyticsTab)) return;
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [wantedTab]);

  // Seed the editors once per campaign: the live refresh must not clobber in-flight edits.
  useEffect(() => {
    if (!detail || seeded.current === campaign.id) return;
    seeded.current = campaign.id;
    skipSave.current = true;
    setSteps(
      (detail.steps ?? []).map((step) => ({
        template_id: step.template_id ?? "",
        subject: step.subject ?? "",
        body: step.body ?? "",
        delay_minutes: step.delay_minutes,
        send_date: step.send_date ?? null,
      }))
    );
    setSubjects(
      detail.subjects && detail.subjects.length ? detail.subjects : [detail.campaign.subject ?? ""]
    );
    setBody(detail.campaign.body ?? "");
    setStopRules(detail.stop_rules ?? STOP_DEFAULTS);
    setCapText(detail.campaign.daily_cap ? String(detail.campaign.daily_cap) : "");
    setScheduledAt(detail.campaign.scheduled_at ?? null);
    if (detail.campaign.timezone) setSchedZone(detail.campaign.timezone);
  }, [detail, campaign.id]);

  const payload = useCallback(
    () => ({
      id: campaign.id,
      name: name.trim() || "Untitled campaign",
      template_id: templateId || null,
      subject: subjects[0]?.trim() || null,
      // Every line, in order. The first is the campaign's own subject; the rest are the A/B
      // challengers the audience is split across.
      subjects: subjects.map((line) => line.trim()).filter(Boolean),
      body: body || null,
      list_name: listName || null,
      interval_minutes: Number(interval) || 5,
      account_id: accountId || null,
      stop_rules: stopRules,
      daily_cap: Number(capText) || null,
      // The start, and the zone it was picked in so it can be read back. Both are saved
      // resolved, so the sender compares against an instant and needs no timezone database.
      scheduled_at: scheduledAt,
      timezone: scheduledAt ? schedZone : null,
    }),
    [campaign.id, name, templateId, subjects, body, listName, interval, accountId, stopRules, capText, scheduledAt, schedZone]
  );

  const persist = useCallback(
    async (extra?: { scheduled_at?: string | null; timezone?: string | null }) => {
      await saveCampaign({ ...payload(), ...extra });
      await saveSteps(
        campaign.id,
        steps.map((step) => {
          // The step is stored as written and as rendered: the markdown is the copy, the
          // pair beside it is what goes out. `renderEmailTemplate` leaves the
          // `{{variables}}` standing, because this one step is sent to every lead.
          const rendered = renderEmailTemplate(step.body || "");
          return {
            template_id: step.template_id || null,
            subject: step.subject || null,
            body: step.body || null,
            body_html: step.body.trim() ? rendered.html : null,
            body_text: step.body.trim() ? rendered.text : null,
            delay_minutes: Math.max(0, Math.round(step.delay_minutes)),
            send_date: step.send_date,
          };
        })
      );
    },
    [campaign.id, payload, steps]
  );

  // Autosave. Every edit lands 600ms after it stops; there is no Save button. The first
  // pass after the editors are seeded is the seed itself, so it is skipped.
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    setSaved(false);
    const timer = window.setTimeout(() => {
      persist()
        .then(() => setSaved(true))
        .catch((e) => tell(String(e)));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [persist, tell]);

  const patchStep = (index: number, patch: Partial<DraftStep>) =>
    setSteps((current) => current.map((step, at) => (at === index ? { ...step, ...patch } : step)));

  // The plus opens the pane it created, which is where the follow-up is written.
  const addStep = () => {
    setSteps((current) => [
      ...current,
      { template_id: "", subject: "", body: "", delay_minutes: 3 * DAY_MINUTES, send_date: null },
    ]);
    setSeqTab("followups");
  };

  const removeStep = (index: number) => setSteps((current) => current.filter((_, at) => at !== index));

  const moveStep = (from: number, to: number) =>
    setSteps((current) => {
      if (from === to || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      await refreshAll();
      reload();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  // ---- The launch checklist, which is also what disables Launch ----------------------

  const audience = useMemo(
    () => (listName ? leads.filter((lead) => lead.list_name === listName) : leads),
    [leads, listName]
  );
  const emails = 1 + steps.length;

  /** What a message may interpolate for the list being written to: exactly the headers the
   *  selected file carried, taken from the leads in the audience rather than a fixed list. */
  const audienceVariables = useMemo(() => {
    const keys = new Set<string>();
    for (const lead of audience) {
      for (const [key, value] of Object.entries(lead.custom_fields ?? {})) {
        if (key.trim() && String(value ?? "").trim()) keys.add(key);
      }
    }
    return [...keys].sort((one, two) => one.localeCompare(two));
  }, [audience]);

  // `{{` opens the picker as it is typed, from the audience's own variables.
  const firstSuggest = useVariableSuggest(audienceVariables, setBody);

  /** One lead's values, so a follow-up's score reads the copy as it will be sent rather
   *  than flagging every {{variable}} in it. Coverage is the checklist's job, not the score's. */
  const sampleValues = useMemo(() => {
    const lead = audience[0] as unknown as Record<string, unknown> | undefined;
    if (!lead) return {};
    const values: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries((lead.custom_fields as Record<string, unknown>) ?? {})) {
      values[key] = value == null ? undefined : String(value);
    }
    for (const [key, value] of Object.entries(lead)) {
      if (typeof value === "string") values[key] ??= value;
    }
    return values;
  }, [audience]);

  /** How many of the audience have no value for a variable, checking the lead's own
   *  columns and then the raw imported row. */
  const lacking = useCallback(
    (key: string) => {
      const wanted = key.toLowerCase();
      return audience.filter((lead) => {
        const own = (lead as unknown as Record<string, unknown>)[wanted];
        if (typeof own === "string" && own.trim()) return false;
        const raw = lead.custom_fields ?? {};
        const hit = Object.entries(raw).find(([header]) => header.trim().toLowerCase() === wanted);
        return !hit || !String(hit[1] ?? "").trim();
      }).length;
    },
    [audience]
  );

  /** The variables a message asks for with no fallback that at least one lead in the
   *  audience cannot supply. A variable every lead has is not a problem, so it is not
   *  listed — only the ones that would actually go out blank for someone. */
  const missing = useMemo(() => {
    const asked = new Set<string>();
    for (const text of [...subjects, body, ...steps.map((step) => `${step.subject}\n${step.body}`)]) {
      for (const key of missingVariables(text, {})) asked.add(key);
    }
    return [...asked].filter((key) => lacking(key) > 0);
  }, [subjects, body, steps, lacking]);

  const checks = [
    {
      id: "audience",
      label: `Audience selected — ${audience.length} lead${audience.length === 1 ? "" : "s"}`,
      ok: audience.length > 0,
    },
    {
      id: "first",
      label:
        subjects.length > 1
          ? `Email 1 has ${subjects.length} subject lines, tested against each other`
          : "Email 1 has a subject and a message",
      ok: subjects.some((line) => line.trim()) && !!body.trim(),
    },
    {
      id: "steps",
      label: steps.length ? `All ${steps.length} follow-up${steps.length === 1 ? "" : "s"} have a message` : "No follow-ups (optional)",
      ok: steps.every((step) => step.body.trim().length > 0),
    },
    { id: "account", label: "A sending account is connected", ok: accounts.length > 0 },
    {
      id: "variables",
      label: missing.length
        ? `Unresolved: ${missing.map((key) => `{{${key}}} (${lacking(key)} leads)`).join(", ")}`
        : "No unresolved {{variables}}",
      ok: missing.length === 0,
    },
  ];
  const ready = checks.every((check) => check.ok);
  const blockers = checks.filter((check) => !check.ok).map((check) => check.label);

  // ---- Pace, cap and start -----------------------------------------------------------

  // There is no daily window any more: a campaign sends at any hour, held back only by its
  // pace, its cap and the start it was given. The pace is one email per interval, and the
  // scheduler holds the whole campaign to it, so this many an hour whatever the audience.
  const perHour = Math.max(1, Math.round(60 / (Number(interval) || 5)));
  const cap = Number(capText) || 0;
  // A campaign sends from one mailbox, so its ceiling is that account's. With no account
  // chosen any of them may send, and the sum stands in.
  const accountCap = (accountId ? accounts.filter((account) => account.id === accountId) : accounts).reduce(
    (total, account) => total + (account.daily_limit || 0),
    0
  );
  const estimate = sendEstimate(audience.length, perHour, cap, accountCap);
  /** A start still ahead of us: the campaign is held until then. */
  const pendingStart = !!scheduledAt && new Date(scheduledAt).getTime() > Date.now();
  /** The zone the schedule reads in — where it was set, or the one being picked. */
  const startZone = scheduledAt ? detail?.campaign.timezone ?? schedZone : null;
  const summary = `${audience.length} leads · ${emails} email${emails === 1 ? "" : "s"} · ~${estimate} to send${
    pendingStart && scheduledAt ? ` · starts ${inZone(scheduledAt, startZone)}` : ""
  }`;

  // ---- Actions ----------------------------------------------------------------------

  /** The schedule the dialog is holding, as an instant. Null is "as soon as it is launched". */
  const pickedStart = () => (schedMode === "later" ? zonedInstant(schedDate, schedTime, schedZone) : null);

  /** Opens the schedule, prefilled with what it holds now — read back in its own zone. */
  const openSchedule = () => {
    const at = scheduledAt ? new Date(scheduledAt) : new Date(Date.now() + 3600_000);
    const zone = schedZone || zoneOptions[0].id;
    setSchedZone(zone);
    setSchedDate(new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at));
    setSchedTime(
      new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at)
    );
    setSchedMode(scheduledAt && at.getTime() > Date.now() ? "later" : "now");
    setLaunching(true);
  };

  const launch = () =>
    run("launch", async () => {
      const at = pickedStart();
      setScheduledAt(at);
      // The start is saved with the campaign before it is started, so the very first tick
      // already knows whether to hold it back.
      await persist({ scheduled_at: at, timezone: at ? schedZone : null });
      const queued = await launchCampaign(campaign.id);
      tell(
        at
          ? `Campaign scheduled for ${inZone(at, schedZone)}`
          : queued
            ? `${queued} leads queued`
            : "Campaign resumed"
      );
      setLaunching(false);
      // Launched: back to the campaigns list, where its card now carries the numbers.
      onBackToCampaigns();
    });

  const pause = () =>
    run("pause", async () => {
      await persist();
      await pauseCampaign(campaign.id);
      tell("Campaign paused");
    });

  const duplicate = () =>
    run("duplicate", async () => {
      const fresh = await duplicateCampaign(campaign.id);
      tell("Campaign duplicated");
      onDuplicated(fresh);
    });

  const exportCsv = () =>
    run("export", async () => {
      const path = await exportCampaignCsv(campaign.id);
      tell(`Exported to ${path}`);
    });

  const remove = () =>
    run("delete", async () => {
      await deleteCampaign(campaign.id);
      tell("Campaign deleted");
      onDeleted();
    });

  const actOn = (lead: CampaignLeadRow, action: "skip" | "pause") =>
    run(`${action}:${lead.lead_id}`, async () => {
      await campaignLeadAction(campaign.id, lead.lead_id, action);
      tell(action === "skip" ? "Lead skipped" : "Lead paused");
      setPicked([]);
    });

  /** Sends one lead's waiting step now, through the sender the scheduler itself uses. The row
   *  is claimed before the request goes out — the same claim the backend makes, made here
   *  first — so a second click in the same breath has nothing to claim and the button is inert
   *  while its own send is in flight. */
  const sendFollowupNow = async (row: CampaignFollowupRow) => {
    const claimed = claimRow(followups?.rows ?? [], row.lead_id);
    if (!claimed) {
      tell("That follow-up is already on its way");
      return;
    }
    setFollowups((current) => (current ? { ...current, rows: claimed } : current));
    setRowError(null);
    setBusy(`send:${row.lead_id}`);
    try {
      await campaignFollowupSendNow(campaign.id, row.lead_id);
      tell(`${stepLabel(row.step_position)} sent to ${row.email}`);
    } catch (e) {
      setRowError({ lead_id: row.lead_id, message: String(e) });
    } finally {
      setBusy("");
      // The row has moved either way: on to its next step, or into the failure it reported.
      await refreshFollowups();
      reload();
    }
  };

  /** Stops one lead's run through the campaign. The step is shared by the whole audience, so
   *  what is given up here is this lead's place in it, not the step. */
  const skipFollowup = (row: CampaignFollowupRow) =>
    run(`skip:${row.lead_id}`, async () => {
      await campaignLeadAction(campaign.id, row.lead_id, "skip");
      tell(`${row.email} skipped`);
    });

  const readFile = async (file: File) => {
    setBusy("read");
    try {
      const { headers, records } = await readSheet(file);
      setPending({ file: file.name, headers, records });
      const found = detectMapping(headers);
      setMapping(found);
      // Without an email column nothing can be addressed, so go straight to the mapping.
      setMappingOpen(!found.email);
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) readFile(file);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const doImport = () =>
    run("import", async () => {
      if (!pending) return;
      const target = listName.trim() || "Imported";
      const count = await importMapped(pending.records, target, mapping);
      setListName(target);
      setPending(null);
      setMappingOpen(false);
      await loadLists();
      tell(`${count} leads imported into “${target}”`);
    });

  // ---- Renders ----------------------------------------------------------------------

  const rows = detail?.leads ?? [];
  const bounced = detail?.bounced ?? [];
  /** Every number the page shows about the campaign. The backend counts them over leads, all
   *  in one place, so the cards, the progress bar, the funnel and the subject lines cannot
   *  disagree about what happened. */
  const metrics = detail?.metrics ?? NO_METRICS;
  const funnel = metrics.funnel ?? [];
  const total = rows.length;
  /** How many leads email 1 has already gone to: every lead written to, since the first
   *  touch is the only step anything can have been sent to a lead by itself. */
  const sentFirst = metrics.contacted;
  /** The campaign's own copy of the template stays editable while there is still something
   *  to send to it, kept or not. It is read at send time, so a correction reaches the leads
   *  still queued and leaves the ones already sent with what they got. A finished campaign
   *  has nothing left for it to change. */
  const firstLocked = status === "done";
  const nextDue = rows
    .map((row) => row.next_due_at)
    .filter((at): at is string => !!at)
    .sort()[0];

  /** The panel's rows as the filters leave them: every step, or just one, and the settled rows
   *  only when they are asked for. The order is the backend's, which is the scheduler's. */
  const visible = visibleFollowups(followups?.rows ?? [], { step: stepFilter, settled: showSettled });
  const stepChoices = stepFilters(followups?.rows ?? []);
  /** Why this campaign will not take a hand-sent follow-up, or null while it will. */
  const sendBlocked = sendBlockedReason(status);

  /** Which view is open. The shell says which one a campaign opens on — its setup when it is
   *  being opened or created, the numbers when the Analytics button asked for them — and a
   *  location that says nothing opens on the setup, like every other way in. */
  const [view, setView] = useState<string>(wantedTab ?? DEFAULT_VIEW);

  // The shell's own navigation wins whenever it says something different: the Analytics button,
  // back and forward, and the setup button all arrive that way.
  useEffect(() => {
    if (wantedTab && wantedTab !== view) setView(wantedTab);
  }, [wantedTab, view]);

  useEffect(() => {
    writeTabToUrl(view);
  }, [view]);

  const goTab = (next: string) => {
    setView(next);
    onTab(next);
  };

  /** The reading half of the page is three views of one campaign; everything else is setup. */
  const analytics = ANALYTICS_TABS.includes(view as AnalyticsTab);
  const analyticsTab: AnalyticsTab = analytics ? (view as AnalyticsTab) : "analytics";
  const tab: Tab = TABS.includes(view as Tab) ? (view as Tab) : "sequence";

  const filtered = rows.filter((row) => {
    const state = audienceStatus(row, bounced, emails);
    if (statusFilter !== "All" && state !== statusFilter) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return [row.first_name, row.email, row.company].some((field) =>
      (field ?? "").toLowerCase().includes(needle)
    );
  });

  /** The list tab's own reading of the same audience: narrowed by email and by what each lead
   *  is doing, then cut to one page. It asks a different question of the rows than the setup
   *  tab's search does, which is why it is a filter of its own rather than the same one. */
  const listMatches = rows.filter((row) => {
    if (listStatus !== "All" && leadStatus(row, bounced) !== listStatus) return false;
    const needle = listQuery.trim().toLowerCase();
    return !needle || row.email.toLowerCase().includes(needle);
  });
  const listRows = listMatches.slice(listPage, listPage + LEAD_PAGE);

  /** The rail both setup tabs share: who the campaign writes to, and what it still needs. */
  const setupAside = (
    <aside className="setupside">
      <section className="sectioncard sideaudience">
        <header>
          <h2>Audience</h2>
          <p>Who this campaign writes to.</p>
        </header>
        <div className="sidefield">
          <label htmlFor="audience-list">Lead list</label>
          <Select
            label="Lead list"
            value={listName}
            options={[
              { value: "", label: `All leads · ${leads.length}` },
              ...lists.map((list) => ({ value: list.name, label: `${list.name} · ${list.count}` })),
            ]}
            onChange={setListName}
          />
        </div>
        {pending ? (
          <div className="filerow">
            <FileUp size={14} />
            <span className="filerowmain">
              <b>{pending.file}</b>
              <small>
                {pending.records.length} rows · email from “{mapping.email ?? "not mapped"}”
              </small>
            </span>
            <button type="button" className="link" onClick={() => setMappingOpen(true)}>
              Map columns
            </button>
            <button type="button" className="btn-icon" aria-label="Remove file" onClick={() => setPending(null)}>
              <X size={14} />
            </button>
          </div>
        ) : (
          <div
            className={`dropzone${dragging ? " over" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <FileUp size={16} />
            <span>Drop CSV or XLSX, or browse</span>
          </div>
        )}
        <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls" hidden onChange={onPick} />
      </section>

      <section className="sectioncard checklist">
        <header>
          <h2>{locked ? "Sending" : "Ready to launch"}</h2>
        </header>
        {checks.map((check) => (
          <div className={`checkrow${check.ok ? " ok" : ""}`} key={check.id}>
            {check.ok ? <Check size={16} /> : <Circle size={16} />}
            <span>{check.label}</span>
          </div>
        ))}
        <p className="checksum">{summary}</p>
        {status === "draft" ? (
          // The header holds the page's one primary button; this one repeats the action, so
          // it stays a ghost rather than competing with it.
          <Button variant="ghost" type="button" disabled={!ready} onClick={openSchedule}>
            <Play />
            Launch campaign
          </Button>
        ) : (
          <p className="muted">
            {STATUS_LABEL[status] ?? status}
            {nextDue ? ` · next send in ${away(nextDue)}` : ""}
          </p>
        )}
      </section>
    </aside>
  );

  return (
    <div className="campaignpage">
      <PageHeader
        back={
          <button className="linkback" type="button" onClick={onBackToCampaigns}>
            <ArrowLeft />
            Campaigns
          </button>
        }
        title={
          <input
            className="titleinput"
            value={name}
            aria-label="Campaign name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
        }
        status={
          <>
            {analytics && <span className="pagestatus">Analytics</span>}
            <Badge className={`statusbadge state-${pendingStart ? "scheduled" : status}`}>
              {pendingStart ? "Scheduled" : STATUS_LABEL[status] ?? status}
            </Badge>
            <span className="pagestatus">{progressText(metrics.contacted, metrics.total)}</span>
            {saved && <span className="savedmark">Saved</span>}
          </>
        }
        tools={
          <>
            {running && (
              <Button variant="secondary" type="button" onClick={pause} disabled={busy === "pause"}>
                <Pause />
                Pause
              </Button>
            )}
            <OverflowMenu
              label="Campaign actions"
              items={[
                { label: "Duplicate", icon: <Copy size={14} />, onSelect: duplicate },
                { label: "Export results (CSV)", icon: <Download size={14} />, onSelect: exportCsv },
                { label: "Delete", icon: <Trash2 size={14} />, onSelect: () => setConfirming(true), danger: true, divider: true },
              ]}
            />
          </>
        }
        tabs={
          analytics ? undefined : (
            <div className="segmented">
              {TABS.map((one) => (
                <button
                  key={one}
                  type="button"
                  className={tab === one ? "on" : undefined}
                  onClick={() => goTab(one)}
                >
                  {TAB_LABEL[one]}
                </button>
              ))}
            </div>
          )
        }
        action={
          analytics ? (
            <Button variant="secondary" type="button" onClick={() => goTab("sequence")}>
              Set up
            </Button>
          ) : status === "draft" ? (
            <Tooltip label={ready ? "Queue every lead" : `Still missing: ${blockers.join("; ")}`}>
              <span className="launchwrap">
                <Button type="button" disabled={!ready} onClick={openSchedule}>
                  <Play />
                  Launch
                </Button>
              </span>
            </Tooltip>
          ) : status === "done" ? (
            <Button type="button" variant="secondary" onClick={duplicate}>
              <Copy />
              Duplicate
            </Button>
          ) : status === "paused" ? (
            <Button type="button" onClick={launch} disabled={busy === "launch"}>
              <Play />
              Resume
            </Button>
          ) : null
        }
      />

      {!analytics && tab === "sequence" && (
        <div className="setupcols">
          <div className="setupmain">
            {running && (
              <p className="locknote">
                This campaign is running. Setup stays editable — the first email, the follow-ups
                nothing has been sent to yet, the pace and the account. Only the steps already sent
                are fixed, so those leads keep what they got.
              </p>
            )}

            <section className="sectioncard sequencecard">
              <header>
                <h2>Sequence</h2>
                <p>What goes out, and how long it waits.</p>
              </header>

              {/* The two panes of the sequence, switched the way the composer switches
                  between a message and its follow-ups. */}
              <div className="composertabs" role="tablist" aria-label="Sequence">
                <button
                  type="button"
                  role="tab"
                  aria-selected={seqTab === "first"}
                  className={`composertab${seqTab === "first" ? " on" : ""}`}
                  onClick={() => setSeqTab("first")}
                >
                  Email 1
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={seqTab === "followups"}
                  className={`composertab${seqTab === "followups" ? " on" : ""}`}
                  onClick={() => setSeqTab("followups")}
                >
                  Follow-ups{steps.length ? ` (${steps.length})` : ""}
                </button>
                {steps.length < MAX_FOLLOWUPS && (
                  <Tooltip label="Add a follow-up">
                    <button type="button" className="composertabadd" aria-label="Add a follow-up" onClick={addStep}>
                      <Plus size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>

              {seqTab === "first" ? (
                <div className="seqpane">
                  <p className="seqhint">
                    The email every lead gets first. Follow-ups answer it in the same thread.
                  </p>
                  <div className="seqfield">
                    <span className="seqlabel">Template</span>
                        <Select
                          className="wide"
                          label="Copy a template into email 1"
                          value={templateId}
                          placeholder="Choose a template…"
                          options={templates.map((t) => ({ value: t.id, label: t.name }))}
                          onChange={(value) => {
                            setTemplateId(value);
                            // The campaign keeps its own copy from here on, so editing the
                            // template later cannot change what this campaign sends.
                            const chosen = templates.find((t) => t.id === value);
                            if (chosen) {
                              // The template supplies the first line; challengers the user
                              // has already added are left in place.
                              setSubjects((current) => [chosen.subject, ...current.slice(1)]);
                              setBody(chosen.body);
                            }
                          }}
                        />
                  </div>
                  <div className="seqfield">
                    <span className="seqlabel">Subject</span>
                        <div className="subjectlines">
                          {subjects.map((line, index) => (
                            <div className="subjectline" key={index}>
                              {subjects.length > 1 && (
                                <span className="subjecttag">{String.fromCharCode(65 + index)}</span>
                              )}
                              <VariableInput
                                variables={audienceVariables}
                                value={line}
                                disabled={firstLocked}
                                aria-label={
                                  index === 0 ? "Email 1 subject" : `Email 1 subject variant ${index + 1}`
                                }
                                placeholder={
                                  index === 0
                                    ? "Subject — a quick idea for {{company}}"
                                    : "Another subject line to test…"
                                }
                                onChange={(next) => setSubjectAt(index, next)}
                              />
                              {subjects.length > 1 && !firstLocked && (
                                <button
                                  type="button"
                                  className="btn-icon"
                                  aria-label={`Remove subject line ${String.fromCharCode(65 + index)}`}
                                  onClick={() => removeSubject(index)}
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </div>
                          ))}
                          {!firstLocked && subjects.length < MAX_SUBJECTS && (
                            <Button variant="ghost" type="button" onClick={addSubject}>
                              <Plus />
                              Add subject line
                            </Button>
                          )}
                          {subjects.length > 1 && (
                            <small className="tnote">
                              A/B test: the audience is split evenly across these {subjects.length} lines
                              and each lead keeps the one it was given. Watch them under Activity once it
                              sends.
                            </small>
                          )}
                        </div>
                  </div>
                  <div className="seqfield">
                    <span className="seqlabel">Message</span>
                        <div className="varfield">
                          <textarea
                            ref={firstBody}
                            className="seqbody"
                            value={body}
                            disabled={firstLocked}
                            aria-label="Email 1 message"
                            placeholder={"Hi {{first_name|there}},\n\nI noticed {{company}}… — type {{ for the variables"}
                            onChange={(event) => {
                              setBody(event.target.value);
                              firstSuggest.sync(event.target);
                            }}
                            onKeyDown={(event) => firstSuggest.onKeyDown(event.currentTarget, event)}
                          />
                          <VariableMenu
                            suggest={firstSuggest}
                            onPick={(key) => firstSuggest.choose(firstBody.current, key)}
                          />
                        </div>
                        <div className="seqtools">
                          <FormatToolbar target={firstBody} value={body} onChange={setBody} disabled={firstLocked} />
                          <Tooltip label={firstPreview ? "Hide the preview" : "See it as one lead will read it"}>
                            <button
                              type="button"
                              className={`composerpreviewtoggle${firstPreview ? " on" : ""}`}
                              aria-pressed={firstPreview}
                              onClick={() => setFirstPreview((shown) => !shown)}
                            >
                              {firstPreview ? <EyeOff size={14} /> : <Eye size={14} />}
                              {firstPreview ? "Hide preview" : "Preview"}
                            </button>
                          </Tooltip>
                        </div>
                        {firstPreview && (
                          <div
                            className="fufpreview mdarticle"
                            aria-label="How the first email will read"
                            dangerouslySetInnerHTML={{ __html: previewEmailMarkdown(body, sampleValues) }}
                          />
                        )}
                        {sentFirst > 0 && !firstLocked && (
                          <small className="tnote">
                            Already sent to {sentFirst} {sentFirst === 1 ? "lead" : "leads"} — every lead still
                            queued gets this version.
                          </small>
                        )}
                  </div>
                </div>
              ) : (
                <div className="seqpane">
                  <div className="timeline">
                    {steps.length === 0 && (
                      <div className="seqempty">
                        <p>
                          No follow-ups yet. One goes out in the first email's thread once the wait is up.
                        </p>
                        <Button variant="ghost" type="button" onClick={addStep}>
                          <Plus />
                          Add follow-up
                        </Button>
                      </div>
                    )}
                    {steps.map((step, index) => {
                      const stepSent = funnel.find((one) => one.position === index + 1)?.sent ?? 0;
                      const stepLocked = locked && stepSent > 0;
                      const days = Math.max(0, Math.round(step.delay_minutes / DAY_MINUTES));
                      return (
                        <div className="tstep" key={index}>
                          <span className="tdot" />
                          {/* A step either waits a number of days or sits on a calendar day. */}
                          <div className="tconnect">
                            {step.send_date
                              ? `sends ${step.send_date}`
                              : `wait ${days} day${days === 1 ? "" : "s"}`}
                          </div>
                          <FollowupCard
                            step={{
                              delay_days: days,
                              body_md: step.body,
                              subject_override: step.subject,
                              send_date: step.send_date,
                            }}
                            label={`Follow-up ${index + 1}`}
                            subject={subject}
                            values={sampleValues}
                            variables={audienceVariables}
                            sent={stepSent}
                            disabled={stepLocked}
                            onChange={(patch) =>
                              patchStep(index, {
                                ...(patch.body_md !== undefined ? { body: patch.body_md } : {}),
                                ...(patch.delay_days !== undefined
                                  ? { delay_minutes: Math.max(0, Math.round(patch.delay_days * DAY_MINUTES)) }
                                  : {}),
                                ...(patch.subject_override !== undefined ? { subject: patch.subject_override } : {}),
                                ...(patch.send_date !== undefined ? { send_date: patch.send_date } : {}),
                              })
                            }
                            onRemove={() => removeStep(index)}
                            onDragStart={() => (dragFrom.current = index)}
                            onDrop={() => {
                              if (dragFrom.current !== null) moveStep(dragFrom.current, index);
                              dragFrom.current = null;
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>

                  <button type="button" className="ruleline" onClick={() => setRulesOpen((open) => !open)}>
                    <span className="raillabel">Stop rules</span>
                    <small>
                      {[
                        stopRules.reply && "reply",
                        stopRules.bounce && "bounce/unsubscribe",
                        stopRules.ooo && "out-of-office",
                      ]
                        .filter(Boolean)
                        .join(" · ") || "none on"}
                    </small>
                  </button>
                  {rulesOpen && (
                    <div className="fufrules">
                      <label className="fufrule">
                        <Checkbox
                          checked={stopRules.reply}
                          onChange={(on) => setStopRules((rules) => ({ ...rules, reply: on }))}
                          label="Stop on reply"
                        />
                        Stop on reply
                      </label>
                      <label className="fufrule">
                        <Checkbox
                          checked={stopRules.bounce}
                          onChange={(on) => setStopRules((rules) => ({ ...rules, bounce: on }))}
                          label="Stop on bounce or unsubscribe"
                        />
                        Stop on bounce / unsubscribe
                      </label>
                      <label className="fufrule">
                        <Checkbox
                          checked={stopRules.ooo}
                          onChange={(on) => setStopRules((rules) => ({ ...rules, ooo: on }))}
                          label="Pause on out-of-office"
                        />
                        Pause on out-of-office
                      </label>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
          {setupAside}
        </div>
      )}

      {!analytics && tab === "sending" && (
        <div className="setupcols">
          <div className="setupmain">
            {running && (
              <p className="locknote">
                This campaign is running. The pace, the cap and the account can still be changed —
                they decide the next send, not the ones already on their way.
              </p>
            )}

            <section className="sectioncard">
              <header>
                <h2>Sending</h2>
                <p>How fast, and from where.</p>
              </header>
              <div className="srow">
                <label htmlFor="send-from">Send from</label>
                <Select
                  className="wide"
                  label="Send from"
                  value={accountId}
                  options={[
                    { value: "", label: "Auto: least busy account" },
                    ...accounts.map((account) => ({
                      value: account.id,
                      label: `${account.email} · ${account.sent_today}/${account.daily_limit} today`,
                      dot: account.health === "healthy" ? "good" : account.health === "error" ? "bad" : undefined,
                    })),
                  ]}
                  onChange={setAccountId}
                />
              </div>
              <div className="srow">
                <label htmlFor="pace">Pace</label>
                <div className="pace">
                  <span>Send one email every</span>
                  <Input
                    id="pace"
                    type="number"
                    min={1}
                    max={10080}
                    value={interval}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                  />
                  <span>minutes</span>
                </div>
                <small className="pacehelp">
                  ~{perHour} per hour · {audience.length} leads finish in about {estimate}
                </small>
              </div>
              <div className="srow">
                <label htmlFor="cap">Daily cap</label>
                <Input
                  id="cap"
                  type="number"
                  min={1}
                  value={capText}
                  placeholder="No cap of its own"
                  onChange={(event) => setCapText(event.target.value)}
                />
                <small className="pacehelp">
                  This campaign sends at most this many a day. Each account's own limit still
                  applies, so whichever is lower decides.
                </small>
              </div>
              <div className="srow">
                <label>Starts</label>
                <div className="startline">
                  <span>
                    {pendingStart && scheduledAt
                      ? `Held until ${inZone(scheduledAt, startZone)}`
                      : "As soon as it is launched"}
                  </span>
                  <button type="button" className="link" onClick={openSchedule}>
                    {pendingStart ? "Change" : "Schedule"}
                  </button>
                </div>
                <small className="pacehelp">
                  A schedule only decides when the campaign may begin. It never narrows the hours
                  it sends in.
                </small>
              </div>
            </section>
          </div>
          {setupAside}
        </div>
      )}

      {analytics && (
        <>
          <div className="tabbar" role="tablist" aria-label="Campaign">
            {ANALYTICS_TABS.map((one) => (
              <button
                key={one}
                type="button"
                role="tab"
                aria-selected={analyticsTab === one}
                className={`tabbaritem${analyticsTab === one ? " on" : ""}`}
                onClick={() => goTab(one)}
              >
                {ANALYTICS_LABEL[one]}
              </button>
            ))}
          </div>

          {analyticsTab === "analytics" && (
            <CampaignAnalytics campaignId={campaign.id} metrics={metrics} />
          )}

          {analyticsTab === "activity" && (
            <CampaignActivity campaignId={campaign.id} onOpenThread={onOpenThread} />
          )}

          {analyticsTab === "list" && (
            <div className="stack">
              {/* What goes out next, in one line. The time is the one stored when the step
                  before it was sent — never worked out from the delay again — so the pace, the
                  start and the daily cap can all push it later than it reads. */}
              <section className="sectioncard nextup">
                {followups?.next ? (
                  <p>
                    Next: <b>{stepLabel(followups.next.step_position)}</b> →{" "}
                    <b>{followups.next.email}</b> · <b>{whenAt(followups.next.scheduled_at)}</b>{" "}
                    <span className="muted">({dueText(followups.next, clock, pace)})</span>
                  </p>
                ) : (
                  <p className="muted">Nothing scheduled.</p>
                )}
              </section>

          <section className="sectioncard">
            <header>
              <h2>Upcoming follow-ups</h2>
              {/* The pace is the answer to "why is the second one still waiting" — the campaign
                  sends one email at a time, so a row behind another waits its turn. */}
              <p>
                Scheduled sends, one every {campaign.interval_minutes || 1}m. Send any of them
                now.
              </p>
            </header>

            <div className="leadfilters">
              {stepChoices.map((choice) => (
                <FilterChip
                  key={choice}
                  label={choice === "All" ? "All steps" : stepLabel(Number(choice))}
                  active={stepFilter === choice}
                  onClick={() => setStepFilter(choice)}
                />
              ))}
              {/* What is still to go out is the point of the panel, so the rows that have
                  settled — sent, skipped — are one chip away rather than in the way. */}
              <FilterChip
                label="Sent & skipped"
                active={showSettled}
                onClick={() => setShowSettled(!showSettled)}
              />
            </div>

            <div className="followtable">
              <div className="followhead">
                <span>Lead email</span>
                <span>Step</span>
                <span>Subject</span>
                <span>Scheduled for</span>
                <span>Status</span>
                <span />
              </div>
              {visible.map((row) => {
                const state = followupStatus(row);
                // The failure the row just came back with outranks the one stored on it.
                const error = rowError?.lead_id === row.lead_id ? rowError.message : row.last_error;
                return (
                  <div className="followrow" key={row.lead_id}>
                    <span className="truncate">{row.email}</span>
                    <span>{stepLabel(row.step_position)}</span>
                    {/* What this step will go out with: a follow-up wears the first email's
                        subject with one `Re:`, which is what puts it in the same conversation
                        at the other end. */}
                    <span className="truncate">{row.subject || "—"}</span>
                    <span className="followdue">
                      {whenAt(row.scheduled_at)}
                      <small>{dueText(row, clock, pace)}</small>
                    </span>
                    <span className="followstate">
                      <span className={`chipstatus ${state.toLowerCase()}`}>{state}</span>
                      {error && <small className="followerror">{error}</small>}
                    </span>
                    <span className="followactions">
                      {canSend(row) && (
                        <>
                          <Tooltip
                            label={sendBlocked ?? "Send this one now, without waiting for its turn"}
                          >
                            <span className="launchwrap">
                              <Button
                                variant="ghost"
                                type="button"
                                disabled={!!sendBlocked || busy === `send:${row.lead_id}`}
                                onClick={() => setConfirmingSend(row)}
                              >
                                Send now
                              </Button>
                            </span>
                          </Tooltip>
                          <Button
                            variant="ghost"
                            type="button"
                            disabled={!!busy}
                            onClick={() => skipFollowup(row)}
                          >
                            Skip
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
              {visible.length === 0 && (
                <p className="muted">
                  {noFollowupsText({ step: stepFilter, settled: showSettled })}
                </p>
              )}
            </div>
          </section>

          <section className="sectioncard">
            <header>
              <h2>Leads</h2>
              <p>Everyone enrolled, and where each of them has got to.</p>
            </header>
            <div className="leadfilters">
              <Input
                placeholder="Search leads…"
                value={listQuery}
                onChange={(event) => {
                  setListQuery(event.target.value);
                  setListPage(0);
                }}
              />
              <Select
                label="Status filter"
                prefix="Status:"
                value={listStatus}
                options={[
                  { value: "All", label: "All" },
                  ...LEAD_STATUSES.map((one) => ({ value: one, label: one })),
                ]}
                onChange={(value) => {
                  setListStatus(value);
                  setListPage(0);
                }}
              />
            </div>
            <div className="leadtable listtable">
              <div className="leadhead">
                <span>Lead email</span>
                <span>Variant</span>
                <span>Current step</span>
                <span>Status</span>
                <span>Last sent</span>
                <span>Next send</span>
              </div>
              {listRows.map((row) => {
                const state = leadStatus(row, bounced);
                return (
                  <div className="leadrowline" key={row.lead_id}>
                    <span className="truncate">{row.email}</span>
                    <span className="truncate">{variantLabel(row.subject_variant, subjects)}</span>
                    <span>{stepLabel(row.step_position ?? 0)}</span>
                    <span>
                      <span className={`chipstatus ${state.toLowerCase().replace(" ", "-")}`}>
                        {state}
                      </span>
                    </span>
                    <span className="truncate">{whenAt(row.sent_at)}</span>
                    <span className="truncate">
                      {row.next_due_at ? (
                        <>
                          {whenAt(row.next_due_at)}
                          <small className="muted">{away(row.next_due_at)}</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                );
              })}
              {listRows.length === 0 && (
                <p className="muted">
                  {listQuery.trim() || listStatus !== "All"
                    ? `No leads here match${listQuery.trim() ? ` “${listQuery.trim()}”` : ""}${
                        listStatus !== "All" ? ` with status ${listStatus}` : ""
                      }.`
                    : "No leads have been enrolled yet."}
                </p>
              )}
            </div>
            <Pager
              offset={listPage}
              size={LEAD_PAGE}
              total={listMatches.length}
              onPage={setListPage}
            />
          </section>
            </div>
          )}
        </>
      )}

      {!analytics && tab === "leads" && (
        <div className="stack">
          <section className="sectioncard">
            <header>
              <h2>Leads</h2>
              <div className="leadfilters">
                <Input
                  value={query}
                  placeholder="Search leads…"
                  aria-label="Search leads"
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Select
                  label="Status filter"
                  prefix="Status:"
                  value={statusFilter}
                  options={["All", "Pending", "Sent", "Replied", "Bounced", "Unsubscribed", "Skipped"].map(
                    (one) => ({ value: one, label: one })
                  )}
                  onChange={setStatusFilter}
                />
              </div>
            </header>

            {picked.length > 0 && (
              <div className="listbar">
                <span className="listbarcount">{picked.length} selected</span>
                <Button variant="ghost" type="button" onClick={() => setPicked([])}>
                  Clear
                </Button>
              </div>
            )}

            <div className="leadtable">
              <div className="leadhead">
                <span />
                <span>Name</span>
                <span>Email</span>
                <span>Company</span>
                <span>Status</span>
                <span>Step</span>
                <span>Next send</span>
                <span />
              </div>
              {filtered.map((row) => (
                <div className="leadrowline" key={row.lead_id}>
                  <Checkbox
                    checked={picked.includes(row.lead_id)}
                    label={`Select ${row.email}`}
                    onChange={(on) =>
                      setPicked((current) =>
                        on ? [...current, row.lead_id] : current.filter((id) => id !== row.lead_id)
                      )
                    }
                  />
                  <span className="truncate">{row.first_name || "—"}</span>
                  <span className="truncate">{row.email}</span>
                  <span className="truncate">{row.company || "—"}</span>
                  <span>
                    <span className={`chipstatus ${audienceStatus(row, bounced, emails).toLowerCase()}`}>
                      {audienceStatus(row, bounced, emails)}
                    </span>
                  </span>
                  <span>
                    {(row.sent_steps ?? 0) === 0
                      ? "—"
                      : (row.sent_steps ?? 0) >= emails
                        ? "Done"
                        : row.sent_steps === 1
                          ? "Email 1"
                          : `Follow-up ${(row.sent_steps ?? 1) - 1}`}
                  </span>
                  <span>{row.next_due_at ? `in ${away(row.next_due_at)}` : "—"}</span>
                  <span>
                    <OverflowMenu
                      label={`Actions for ${row.email}`}
                      items={[
                        ...(row.next_due_at || row.state === "queued"
                          ? [{ label: "Skip lead", onSelect: () => actOn(row, "skip") }]
                          : []),
                        ...(row.state === "queued"
                          ? [{ label: "Pause lead", onSelect: () => actOn(row, "pause") }]
                          : []),
                        ...(row.last_message_id
                          ? [
                              {
                                label: "Open thread",
                                onSelect: () => onOpenThread(row.last_message_id as string),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </span>
                </div>
              ))}
              {filtered.length === 0 && <p className="muted">No leads match that.</p>}
            </div>
          </section>
        </div>
      )}

      {mappingOpen && pending && (
        <div className="confirm" onMouseDown={() => setMappingOpen(false)}>
          <div className="confirm-card mapcard" onMouseDown={(event) => event.stopPropagation()}>
            <h3>Map columns</h3>
            <p>
              Pick which column is which. Every other column still reaches a message as a{" "}
              <code>{"{{variable}}"}</code>.
            </p>
            {(
              [
                ["email", "Email"],
                ["first_name", "First name"],
                ["last_name", "Last name"],
                ["company", "Company"],
                ["title", "Title"],
              ] as [keyof LeadMapping, string][]
            ).map(([field, label]) => (
              <div className="srow" key={field}>
                <label htmlFor={`map-${field}`}>{label}</label>
                <Select
                  className="wide"
                  label={label}
                  value={mapping[field] ?? ""}
                  options={[
                    { value: "", label: "Not in this sheet" },
                    ...pending.headers.map((header) => ({ value: header, label: header })),
                  ]}
                  onChange={(value) => setMapping((current) => ({ ...current, [field]: value || undefined }))}
                />
              </div>
            ))}
            <div className="confirm-actions">
              <button type="button" onClick={() => setMapping(detectMapping(pending.headers))}>
                Sync from headings
              </button>
              <button type="button" onClick={() => setMappingOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!mapping.email || busy === "import"}
                onClick={doImport}
              >
                Import {pending.records.length} leads
              </button>
            </div>
          </div>
        </div>
      )}

      {launching && (
        <div className="confirm" onMouseDown={() => setLaunching(false)}>
          <div className="confirm-card mapcard" onMouseDown={(event) => event.stopPropagation()}>
            <h3>Launch “{name.trim() || "this campaign"}”</h3>
            <div className="segmented">
              <button
                type="button"
                className={schedMode === "now" ? "on" : undefined}
                onClick={() => setSchedMode("now")}
              >
                Now
              </button>
              <button
                type="button"
                className={schedMode === "later" ? "on" : undefined}
                onClick={() => setSchedMode("later")}
              >
                Schedule
              </button>
            </div>
            {schedMode === "later" && (
              <>
                <div className="srow">
                  <label htmlFor="start-date">Starts on</label>
                  <Input
                    id="start-date"
                    type="date"
                    value={schedDate}
                    onChange={(event) => setSchedDate(event.target.value)}
                  />
                </div>
                <div className="srow">
                  <label htmlFor="start-time">At</label>
                  <Input
                    id="start-time"
                    type="time"
                    value={schedTime}
                    onChange={(event) => setSchedTime(event.target.value)}
                  />
                </div>
                <div className="srow">
                  <label htmlFor="start-zone">Timezone</label>
                  <Select
                    className="wide"
                    label="Timezone"
                    value={schedZone}
                    options={zoneOptions.map((zone) => ({ value: zone.id, label: zoneLabel(zone.id) }))}
                    onChange={setSchedZone}
                  />
                </div>
              </>
            )}
            <p>{summary}</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setLaunching(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={launch}
                disabled={busy === "launch" || (schedMode === "later" && !schedDate)}
              >
                {schedMode === "later" ? "Schedule campaign" : "Launch campaign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sending by hand goes out immediately and cannot be called back, so it is asked for
          rather than done on the click — the same overlay grammar the launch uses. */}
      {confirmingSend && (
        <div className="confirm" onMouseDown={() => setConfirmingSend(null)}>
          <div className="confirm-card" onMouseDown={(event) => event.stopPropagation()}>
            <h3>Send now?</h3>
            <p>
              Send {stepLabel(confirmingSend.step_position)} to {confirmingSend.email} now? It
              goes out immediately instead of waiting for its turn, and this cannot be taken back.
            </p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirmingSend(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const row = confirmingSend;
                  setConfirmingSend(null);
                  sendFollowupNow(row);
                }}
              >
                Send now
              </button>
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <Confirm
          title={`Delete “${name.trim() || campaign.name}”?`}
          message="Its queue and send history are removed. This cannot be undone."
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
