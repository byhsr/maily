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
import { detectMapping, importMapped, readSheet, type LeadMapping } from "../lib/leadImport";
import { missingVariables, sendEstimate } from "../lib/logic";
import { inZone, ZONES, zonedInstant, zoneLabel } from "../lib/timezones";
import type {
  Account,
  Campaign as CampaignType,
  CampaignDetail,
  CampaignEvent,
  CampaignLeadRow,
  Lead,
  LeadList,
  StopRules,
  Template,
} from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Confirm } from "../ui/Confirm";
import { FollowupCard } from "../ui/FollowupCard";
import { FormatToolbar } from "../ui/FormatToolbar";
import { Input } from "../ui/Input";
import { OverflowMenu } from "../ui/OverflowMenu";
import { PageHeader } from "../ui/PageHeader";
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

function when(iso?: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const today = new Date();
  return at.toDateString() === today.toDateString()
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString([], { month: "short", day: "numeric" });
}

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

/** What a lead row is, as one word. Order matters: a suppression outranks everything. */
function leadStatus(row: CampaignLeadRow, bounced: string[], emails: number): string {
  if (row.suppressed) return "Unsubscribed";
  if (bounced.includes(row.lead_id)) return "Bounced";
  if (row.replied) return "Replied";
  if (row.outcome === "skipped") return "Skipped";
  if (row.state === "paused") return "Paused";
  if ((row.sent_steps ?? 0) >= emails) return "Sent";
  return (row.sent_steps ?? 0) > 0 ? "Sent" : "Pending";
}

const EVENT_LABEL: Record<string, string> = {
  sent: "Sent",
  replied: "Replied",
  bounced: "Bounced",
};

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

  const loadLists = () => listLeadLists().then(setLists).catch((e) => tell(String(e)));

  useEffect(() => {
    refresh();
    loadLists();
    listAccounts().then(setAccounts).catch(() => {});
  }, [campaign.id]);

  const status = detail?.campaign.status ?? campaign.status;
  const running = status === "active" || status === "throttled";
  /** Everything goes read-only once it is sending, except the pace, the account, and the
   *  bodies of steps nothing has been sent to yet. */
  const locked = status !== "draft";

  // Keep the numbers live while it sends.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

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
      await refresh();
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
  const funnel = detail?.funnel ?? [];
  const subjectStats = detail?.subject_stats ?? [];
  const recent = detail?.recent ?? [];
  const stats = detail?.stats ?? { sent: 0, replied: 0, positive: 0, bounced: 0 };
  const counts = detail?.counts ?? {};
  const total = rows.length;
  const done = counts.done ?? 0;
  const percent = total ? Math.round((done / total) * 100) : 0;
  /** How many leads email 1 has already gone to — the funnel counts it as position 0. */
  const sentFirst = funnel.find((one) => one.position === 0)?.sent ?? 0;
  /** The campaign's own copy of the template stays editable while there is still something
   *  to send to it, kept or not. It is read at send time, so a correction reaches the leads
   *  still queued and leaves the ones already sent with what they got. A finished campaign
   *  has nothing left for it to change. */
  const firstLocked = status === "done";
  const nextDue = rows
    .map((row) => row.next_due_at)
    .filter((at): at is string => !!at)
    .sort()[0];
  const replyRate = stats.sent ? Math.round((stats.replied / stats.sent) * 100) : 0;

  /** Analytics is a view of its own, reached from a campaign's Analytics button rather than
   *  sitting among the setup tabs. Everything else on this page is setup. */
  const analytics = wantedTab === "activity";
  const tab: Tab = TABS.includes(wantedTab as Tab) ? (wantedTab as Tab) : "sequence";

  const filtered = rows.filter((row) => {
    const state = leadStatus(row, bounced, emails);
    if (statusFilter !== "All" && state !== statusFilter) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return [row.first_name, row.email, row.company].some((field) =>
      (field ?? "").toLowerCase().includes(needle)
    );
  });

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
            <span className="pagestatus">
              {done} / {total} sent
            </span>
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
                  onClick={() => onTab(one)}
                >
                  {TAB_LABEL[one]}
                </button>
              ))}
            </div>
          )
        }
        action={
          analytics ? (
            <Button variant="secondary" type="button" onClick={() => onTab("sequence")}>
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

            <section className="sectioncard">
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
                <div className="seqstep on">
                  <div className="seqstephead">
                    <b>Email 1 · First touch</b>
                  </div>
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
              ) : (
                <>
                  <div className="timeline">
                    {steps.length === 0 && (
                      <p className="muted">
                        No follow-ups yet. Add one and it goes out in the first email's thread once the wait is
                        up.
                      </p>
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
                </>
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
        <div className="stack">
          <div className="metrics">
            <article>
              <small>Sent</small>
              <strong>{stats.sent}</strong>
            </article>
            <article>
              <small>Replied</small>
              <strong>{stats.replied}</strong>
              <em>{replyRate}%</em>
            </article>
            <article>
              <small>Positive</small>
              <strong>{stats.positive}</strong>
            </article>
            <article>
              <small>Failed / bounced</small>
              <strong>{stats.bounced}</strong>
            </article>
          </div>

          <section className="sectioncard">
            <div className="progressbar" role="img" aria-label={`${percent}% sent`}>
              <em style={{ width: `${percent}%` }} />
            </div>
            <p className="muted">
              {done} / {total} sent
              {nextDue ? ` · next send in ${away(nextDue)}` : ""}
            </p>
          </section>

          {subjectStats.length > 1 && (
            <section className="sectioncard">
              <header>
                <h2>Subject lines</h2>
                <p>How each line is doing. Every reply is credited to the line its lead was given.</p>
              </header>
              {subjectStats.map((stat) => (
                <div className="funnelrow" key={stat.position}>
                  <span className="funnelname">
                    {String.fromCharCode(65 + stat.position)} · {stat.subject || "—"}
                  </span>
                  <span className="funnelbar">
                    <em
                      style={{
                        width: `${(stat.sent / Math.max(1, ...subjectStats.map((one) => one.sent))) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="funnelcount">
                    {stat.leads} leads · {stat.sent} sent · {stat.replied} replied
                    {stat.sent ? ` (${Math.round((stat.replied / stat.sent) * 100)}%)` : ""}
                  </span>
                </div>
              ))}
            </section>
          )}

          {recent.length === 0 ? (
            <section className="sectioncard">
              <div className="blank">
                <BarChart3 size={20} />
                <p>
                  <b>No activity yet</b>
                </p>
                <small>Launch the campaign to start sending.</small>
              </div>
            </section>
          ) : (
            <>
              <section className="sectioncard">
                <header>
                  <h2>Step funnel</h2>
                  <p>What each step sent, earned, and still has waiting.</p>
                </header>
                {funnel.map((row) => {
                  const widest = Math.max(1, ...funnel.map((one) => one.sent));
                  return (
                    <div className="funnelrow" key={row.position}>
                      <span className="funnelname">
                        {row.position === 0 ? "Email 1" : `Follow-up ${row.position}`}
                      </span>
                      <span className="funnelbar">
                        <em style={{ width: `${(row.sent / widest) * 100}%` }} />
                      </span>
                      <span className="funnelcount">
                        {row.sent} sent · {row.replied} replied · {row.pending} waiting
                      </span>
                    </div>
                  );
                })}
              </section>

              <section className="sectioncard">
                <header>
                  <h2>Recent activity</h2>
                </header>
                <div className="feedrows">
                  {recent.slice(0, 20).map((event: CampaignEvent, index) => (
                    <button
                      type="button"
                      className="feedrow"
                      key={`${event.kind}-${event.lead_id}-${index}`}
                      disabled={!event.message_id}
                      onClick={() => event.message_id && onOpenThread(event.message_id)}
                    >
                      <span className="feedname">{event.name || event.lead_id}</span>
                      <span className={`chipchip ${event.kind}`}>
                        {event.kind === "sent" && event.step !== null && event.step !== undefined
                          ? event.step === 0
                            ? "Sent"
                            : `Follow-up ${event.step}`
                          : EVENT_LABEL[event.kind] ?? event.kind}
                      </span>
                      <span className="feedtime">{when(event.at)}</span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
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
                    <span className={`chipstatus ${leadStatus(row, bounced, emails).toLowerCase()}`}>
                      {leadStatus(row, bounced, emails)}
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
