import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Circle,
  Copy,
  Download,
  FileUp,
  Pause,
  Pencil,
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
import { previewEmailMarkdown } from "../lib/email";
import { detectMapping, importMapped, readSheet, type LeadMapping } from "../lib/leadImport";
import { missingVariables } from "../lib/logic";
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
import { Input } from "../ui/Input";
import { OverflowMenu } from "../ui/OverflowMenu";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Tooltip } from "../ui/Tooltip";

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
  onBack: () => void;
  onDeleted: () => void;
  onDuplicated: (id: string) => void;
  onOpenThread: (messageId: string) => void;
};

const TABS = ["setup", "activity", "leads"] as const;
type Tab = (typeof TABS)[number];

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
  onBack,
  onDeleted,
  onDuplicated,
  onOpenThread,
}: CampaignProps) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [name, setName] = useState(campaign.name);
  const [listName, setListName] = useState(campaign.list_name ?? "");
  const [templateId, setTemplateId] = useState(campaign.template_id ?? "");
  const [subject, setSubject] = useState(campaign.subject ?? "");
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
  const [firstOpen, setFirstOpen] = useState(false);
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

  const seeded = useRef("");
  const skipSave = useRef(true);
  const dragFrom = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
    setSubject(detail.campaign.subject ?? "");
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
      subject: subject.trim() || null,
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
    [campaign.id, name, templateId, subject, body, listName, interval, accountId, stopRules, capText, scheduledAt, schedZone]
  );

  const persist = useCallback(
    async (extra?: { scheduled_at?: string | null; timezone?: string | null }) => {
      await saveCampaign({ ...payload(), ...extra });
      await saveSteps(
        campaign.id,
        steps.map((step) => ({
          template_id: step.template_id || null,
          subject: step.subject || null,
          body: step.body || null,
          delay_minutes: Math.max(0, Math.round(step.delay_minutes)),
          send_date: step.send_date,
        }))
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

  const addStep = () =>
    setSteps((current) => [
      ...current,
      { template_id: "", subject: "", body: "", delay_minutes: 3 * DAY_MINUTES, send_date: null },
    ]);

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

  /** Variables the messages ask for with no fallback — the ones a lead must supply. */
  const missing = useMemo(() => {
    const asked = new Set<string>();
    for (const text of [subject, body, ...steps.map((step) => `${step.subject}\n${step.body}`)]) {
      for (const key of missingVariables(text, {})) asked.add(key);
    }
    return [...asked];
  }, [subject, body, steps]);

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

  const checks = [
    {
      id: "audience",
      label: `Audience selected — ${audience.length} lead${audience.length === 1 ? "" : "s"}`,
      ok: audience.length > 0,
    },
    { id: "first", label: "Email 1 has a subject and a message", ok: !!subject.trim() && !!body.trim() },
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
  // pace, its cap and the start it was given.
  const perHour = Math.max(1, Math.round(60 / (Number(interval) || 5)));
  const cap = Number(capText) || 0;
  const accountCap = accounts.reduce((total, account) => total + (account.daily_limit || 0), 0);
  // The campaign's own cap and the account's cap both apply, so the lower one decides.
  const perDay = Math.max(
    1,
    Math.min(perHour * 24, cap || Number.MAX_SAFE_INTEGER, accountCap || Number.MAX_SAFE_INTEGER)
  );
  const days = audience.length / perDay;
  const estimate = days < 1 ? `${Math.max(1, Math.round(days * 24))}h` : `${Math.ceil(days)}d`;
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
      setMapping(detectMapping(headers));
      // Without an email column nothing can be addressed, so go straight to the mapping.
      setMappingOpen(!headers.some((header) => header.trim().toLowerCase() === "email"));
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

  const tab: Tab =
    wantedTab === "setup" || wantedTab === "activity" || wantedTab === "leads"
      ? wantedTab
      : status === "draft"
        ? "setup"
        : "activity";

  const showText = (value: string) => (value.trim() ? value.split("\n")[0] : "No message yet");

  const filtered = rows.filter((row) => {
    const state = leadStatus(row, bounced, emails);
    if (statusFilter !== "All" && state !== statusFilter) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return [row.first_name, row.email, row.company].some((field) =>
      (field ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="campaignpage">
      <PageHeader
        back={
          <button className="linkback" type="button" onClick={onBack}>
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
          <div className="segmented">
            {TABS.map((one) => (
              <button
                key={one}
                type="button"
                className={tab === one ? "on" : undefined}
                onClick={() => onTab(one)}
              >
                {one === "setup" ? "Setup" : one === "activity" ? "Activity" : "Leads"}
                {one === "activity" && running && counts.queued ? <em>{counts.queued}</em> : null}
              </button>
            ))}
          </div>
        }
        action={
          status === "draft" ? (
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

      {tab === "setup" && (
        <div className="setupcols">
          <div className="setupmain">
            {locked && (
              <p className="locknote">
                This campaign has started. Only the pace, the sending account and the steps nothing has
                been sent to yet can still change.
              </p>
            )}

            <section className="sectioncard">
              <header>
                <h2>Audience</h2>
                <p>Who this campaign writes to.</p>
              </header>
              <div className="srow">
                <label htmlFor="audience-list">Lead list</label>
                <Select
                  className="wide"
                  label="Lead list"
                  value={listName}
                  disabled={locked}
                  options={[
                    { value: "", label: `All leads · ${leads.length}` },
                    ...lists.map((list) => ({ value: list.name, label: `${list.name} · ${list.count}` })),
                  ]}
                  onChange={setListName}
                />
              </div>
              <div className="srow">
                <span />
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
              </div>
            </section>

            <section className="sectioncard">
              <header>
                <h2>Sequence</h2>
                <p>What goes out, and how long it waits.</p>
              </header>
              <div className="timeline">
                <div className="tstep">
                  <span className="tdot" />
                  <div className="tcard">
                    <div className="tcardhead">
                      <b>Email 1 · First touch</b>
                      <Tooltip label={firstOpen ? "Close the editor" : "Write this email"}>
                        <button type="button" className="btn-ghost" onClick={() => setFirstOpen((open) => !open)}>
                          <Pencil size={13} />
                          {firstOpen ? "Done" : "Edit"}
                        </button>
                      </Tooltip>
                    </div>
                    {firstOpen ? (
                      <div className="tcardbody">
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
                              setSubject(chosen.subject);
                              setBody(chosen.body);
                            }
                          }}
                        />
                        <Input
                          value={subject}
                          disabled={firstLocked}
                          aria-label="Email 1 subject"
                          placeholder="Subject — a quick idea for {{company}}"
                          onChange={(event) => setSubject(event.target.value)}
                        />
                        <textarea
                          className="seqbody"
                          value={body}
                          disabled={firstLocked}
                          aria-label="Email 1 message"
                          placeholder={"Hi {{first_name|there}},\n\nI noticed {{company}}…"}
                          onChange={(event) => setBody(event.target.value)}
                        />
                        {sentFirst > 0 && !firstLocked && (
                          <small className="tnote">
                            Already sent to {sentFirst} {sentFirst === 1 ? "lead" : "leads"} — every lead still
                            queued gets this version.
                          </small>
                        )}
                      </div>
                    ) : (
                      <p className="tpreview">
                        <b>{subject.trim() || "No subject yet"}</b>
                        <small>{showText(body)}</small>
                      </p>
                    )}
                  </div>
                </div>

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
                        label={stepLocked ? `Follow-up ${index + 1} · already sent` : `Follow-up ${index + 1}`}
                        subject={subject}
                        values={sampleValues}
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

              <div className="srow">
                <span />
                <Button
                  variant="ghost"
                  type="button"
                  disabled={steps.length >= MAX_FOLLOWUPS}
                  onClick={addStep}
                >
                  <Plus />
                  Add follow-up
                </Button>
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
            </section>

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

          <aside className="setupside">
            <section className="sectioncard checklist">
              <header>
                <h2>{locked ? "Sending" : ready ? "Ready to launch" : "Ready to launch"}</h2>
              </header>
              {checks.map((check) => (
                <div className={`checkrow${check.ok ? " ok" : ""}`} key={check.id}>
                  {check.ok ? <Check size={16} /> : <Circle size={16} />}
                  <span>{check.label}</span>
                </div>
              ))}
              <p className="checksum">{summary}</p>
              {status === "draft" ? (
                // The header holds the page's one primary button; this one repeats the
                // action, so it stays a ghost rather than competing with it.
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
        </div>
      )}

      {tab === "activity" && (
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

      {tab === "leads" && (
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
