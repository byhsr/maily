import type { CampaignActivityItem, CampaignFollowupRow, CampaignLeadRow } from "./types";

/**
 * The campaign page's arithmetic, kept away from its markup: what one enrolment reads as, when
 * it is due, whether a hand can send it, how far the campaign has got, and what its history
 * says happened. Every function here is pure, so the page's rules can be read and tested without
 * a database or a browser.
 */

/** What the panel calls one row. Five values, whatever the enrolment underneath is doing: a
 *  lead nothing will ever go out to reads as Skipped rather than as the particular reason,
 *  which is the row's own business to explain. */
export type FollowupStatus = "Scheduled" | "Sending" | "Sent" | "Skipped" | "Failed";

/** The rows the panel shows when it is not asked for the settled ones. */
const OPEN: FollowupStatus[] = ["Scheduled", "Sending", "Failed"];

/** "Email 1" for the first touch, "Follow-up 2" after it — the labels the funnel and the
 *  leads table already use, because a step has never had a name of its own. */
export function stepLabel(position: number): string {
  return position === 0 ? "Email 1" : `Follow-up ${position}`;
}

/** What a row is, in one word. Order matters: a send under way outranks the state it left
 *  behind, and a lead nothing will ever go out to is skipped whatever the enrolment says. */
export function followupStatus(row: CampaignFollowupRow): FollowupStatus {
  if (row.state === "sending") return "Sending";
  if (row.state === "failed") return "Failed";
  if (row.state === "done") return "Sent";
  if (row.state === "paused") return "Skipped";
  // Still queued, and still nothing will be sent: an answer came back, the lead is on the
  // suppression list, or the lead itself is no longer active.
  if (row.replied || row.suppressed || row.lead_status !== "active") return "Skipped";
  return "Scheduled";
}

/** What the campaign's own pace means for one row, worked out once for the whole queue.
 *
 *  A campaign sends one email at a time, so a row whose moment has passed while the send in
 *  front of it is still being spaced out is not late — it is waiting its turn. Whether a row is
 *  late is a question about the campaign, never about the row, which is why nothing here can be
 *  worked out from the row alone. */
export type QueuePace = {
  /** Whether the campaign sends at all right now. Throttled counts: it is a stale flag by the
   *  time it matters, and the scheduler keeps looking at it, so a row on one is waiting its turn
   *  like any other. Only the states a person chose stop it sending. */
  running: boolean;
  /** Why it does not, in the row's own words — "held — the campaign is paused". */
  heldWhy: string;
  /** The soonest a send could leave: the last one plus the pace. Null before the first send. */
  slotAt: number | null;
  /** The enrolment the scheduler would take next. */
  nextId: string | null;
};

/** What a row's time means while the campaign itself is not sending. */
export function heldWhy(campaignStatus: string): string {
  switch (campaignStatus) {
    case "paused":
      return "held — the campaign is paused";
    case "draft":
      return "held — not launched yet";
    case "done":
      return "held — the campaign has finished";
    default:
      return "held";
  }
}

/** How far off a moment is, coarsely, against the clock the page is drawn with: "in 3h 12m",
 *  "now", and, once it has passed, what that actually means — which is the campaign's business
 *  rather than the row's. A row with no stored time is due now, which is what the scheduler
 *  reads it as. */
export function dueText(row: CampaignFollowupRow, now: number, pace: QueuePace): string {
  const seconds = row.scheduled_at ? (Date.parse(row.scheduled_at) - now) / 1000 : 0;
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 60) return "now";
  const minutes = Math.abs(Math.round(seconds / 60));
  let distance: string;
  if (minutes < 60) {
    distance = `${minutes}m`;
  } else if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    distance = rest ? `${hours}h ${rest}m` : `${hours}h`;
  } else {
    distance = `${Math.round(minutes / 1440)}d`;
  }
  if (seconds > 0) return `in ${distance}`;
  // Past its moment. Nothing is holding it back but the campaign's own pace, or the campaign
  // not running at all — and neither is the row's fault, so neither reads as lateness.
  if (!pace.running) return pace.heldWhy;
  const itsTurn = row.lead_id === pace.nextId;
  if (pace.slotAt !== null && pace.slotAt > now) {
    return itsTurn ? "next up" : "waiting for its turn";
  }
  return itsTurn ? "due now" : "waiting for its turn";
}

/** An instant as the reader's own date and time, in full: "Nov 19, 2026, 10:00 AM IST". Stored
 *  UTC, shown in this machine's zone, with the zone named — a time is not a time without one,
 *  and the scheduler works in UTC whatever the reader's clock says. */
export function whenAt(iso?: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** How long ago something happened, against the clock the page is drawn with: "17m ago". The
 *  absolute time is beside it; this is the half that saves the reader the arithmetic. */
export function agoText(iso?: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/** Whether this row is one Send now is drawn for: the two states that still have a step to
 *  go out. Everything else — a step under way, one already sent, one nothing will be sent
 *  to — has nothing left to send, so no button is offered rather than an inert one. */
export function canSend(row: CampaignFollowupRow): boolean {
  const status = followupStatus(row);
  return status === "Scheduled" || status === "Failed";
}

/** Why the campaign itself will not accept a hand-sent follow-up, or null when it will. The
 *  sender only accepts a campaign that is running, so the button says the same thing the send
 *  would say rather than failing quietly. Throttled is still running: capacity is looked at
 *  again on the way out, and a send that finds none is left exactly as it was. */
export function sendBlockedReason(campaignStatus: string): string | null {
  if (campaignStatus === "done") return "This campaign has finished";
  if (campaignStatus === "paused") return "This campaign is paused — resume it to send";
  if (campaignStatus === "draft") return "Launch this campaign before sending";
  return null;
}

/** Which rows the table is showing: one step or all of them, and either what is still to go out
 *  or the history of what has settled. The two are alternatives rather than one list with the
 *  settled rows folded in — what is still to go out is the point of the panel. */
export function visibleFollowups(
  rows: CampaignFollowupRow[],
  filter: { step: string; settled: boolean }
): CampaignFollowupRow[] {
  return rows.filter((row) => {
    if (filter.step !== "All" && String(row.step_position) !== filter.step) return false;
    const open = OPEN.includes(followupStatus(row));
    return filter.settled ? !open : open;
  });
}

/** What the table says when it has nothing to show. Which is the filter's business rather than
 *  the campaign's: an empty list under "Follow-up 1" is not an empty campaign, and the reader
 *  who filtered is the one who needs telling. */
export function noFollowupsText(filter: { step: string; settled: boolean }): string {
  const step = filter.step === "All" ? "" : ` for ${stepLabel(Number(filter.step))}`;
  return filter.settled
    ? `No sent or skipped follow-ups${step}.`
    : `No follow-ups${step} waiting.`;
}

/** The choices the step filter offers, as the values it compares: every step the campaign has
 *  an enrolment on, whatever state that enrolment is in. "All" leads, so the panel opens on the
 *  whole queue rather than on whichever step happens to be first. */
export function stepFilters(rows: CampaignFollowupRow[]): string[] {
  const positions = [...new Set(rows.map((row) => row.step_position))].sort((one, two) => one - two);
  return ["All", ...positions.map(String)];
}

/** How far a campaign has got through its audience: the leads written to over the leads
 *  enrolled. The numerator is capped at the denominator, because a lead can only be written to
 *  once — a campaign whose two halves disagree, through a lead removed from the list after the
 *  send, must not read as more than complete. */
export function campaignProgress(
  contacted: number,
  total: number
): { contacted: number; total: number; percent: number } {
  const whole = Math.max(0, Math.round(total));
  const done = Math.min(Math.max(0, Math.round(contacted)), whole);
  return { contacted: done, total: whole, percent: whole ? Math.round((done / whole) * 100) : 0 };
}

/** The header's "2 / 2 leads contacted" — the same pair, and the same cap, as the progress bar. */
export function progressText(contacted: number, total: number): string {
  const progress = campaignProgress(contacted, total);
  return `${progress.contacted} / ${progress.total} leads contacted`;
}

/** What a lead row in the list says about itself. Six words, and where two of them could apply
 *  the one that stopped the lead wins: a reply or a bounce is what happened to it, and the step
 *  it had reached is the step it had reached. A lead nothing has gone out to yet is queued
 *  rather than in the sequence; one held by a skip, a reply or a suppression is still enrolled,
 *  so it reads as in the sequence rather than as finished. */
export type LeadStatus =
  | "Queued"
  | "In sequence"
  | "Replied"
  | "Bounced"
  | "Unsubscribed"
  | "Finished";

export function leadStatus(row: CampaignLeadRow, bounced: string[]): LeadStatus {
  if (row.suppressed) return "Unsubscribed";
  if (bounced.includes(row.lead_id)) return "Bounced";
  if (row.replied) return "Replied";
  if (row.state === "done") return "Finished";
  if (!row.sent_at) return "Queued";
  return "In sequence";
}

/** Minutes as the page writes them: "45m", "3h 12m", "2d". Null — nothing to average, or nothing
 *  answered — is a dash rather than a zero, which would read as instantaneous. */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${Math.round(minutes / 1440)}d`;
}

/** A rate as the page writes it. Never "NaN%": a rate with nothing under it is nothing. */
export function percentText(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "0%";
  return `${Math.round(percent)}%`;
}

/** A number with at most one decimal, and a dash when there is no number at all. */
export function numberText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The kinds of history the feed can be filtered to. The last one is two event types at once:
 *  the campaign pausing and resuming is one story, and reading it in halves helps nobody. */
export const ACTIVITY_FILTERS = [
  { label: "All", value: "all" },
  { label: "Sent", value: "sent" },
  { label: "Scheduled", value: "scheduled" },
  { label: "Replied", value: "replied" },
  { label: "Bounced", value: "bounced" },
  { label: "Skipped", value: "skipped" },
  { label: "Sent by hand", value: "send_now" },
  { label: "Campaign", value: "paused,resumed" },
] as const;

/** Why a step was skipped, in the words of whoever skipped it. */
function skipReason(item: CampaignActivityItem): string {
  if (item.metadata?.reason === "manual") return "by hand";
  if (item.metadata?.reason === "replied") return "they replied";
  return item.detail || "held";
}

/** One line of the feed: what happened, to whom, at which step. */
export function activityText(item: CampaignActivityItem): string {
  const who = item.email ?? "the campaign";
  const step =
    item.step_position === null || item.step_position === undefined
      ? ""
      : ` ${stepLabel(item.step_position)}`;
  switch (item.type) {
    case "sent":
      return `Sent${step} to ${who}`;
    case "scheduled":
      return `Scheduled${step} for ${who}`;
    case "replied":
      return item.metadata?.positive ? `Positive reply from ${who}` : `Reply from ${who}`;
    case "bounced":
      return `Bounced — ${who}`;
    case "skipped":
      return `Skipped${step} for ${who} — ${skipReason(item)}`;
    case "send_now":
      return `Sent${step} to ${who} by hand`;
    case "paused":
      return "Campaign paused";
    case "resumed":
      return "Campaign resumed";
    default:
      return `${item.type}${step} for ${who}`;
  }
}

/** The muted half of a feed line: the subject that went out or came back, when there is one. */
export function activityNote(item: CampaignActivityItem): string {
  if (item.type === "sent" || item.type === "replied" || item.type === "bounced") {
    return item.detail || "";
  }
  return "";
}

/** The colour a feed row's dot wears. Positive and bounced are the two verdicts worth seeing
 *  from across the room; everything else is neutral chrome. */
export function activityTone(item: CampaignActivityItem): string {
  if (item.type === "bounced") return "bad";
  if (item.type === "replied") return item.metadata?.positive ? "good" : "neutral";
  return "neutral";
}

/** A day heading, as it reads: today and yesterday by name, anything else by its date. */
export function dayLabel(iso?: string | null, now = Date.now()): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "Unknown";
  const midnight = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

/** The feed's items under day headings, in the order they arrived. The heading is the reader's
 *  own date, so a line written at 11pm belongs to the evening it was written rather than to
 *  tomorrow in UTC. */
export function groupByDay(
  items: CampaignActivityItem[],
  now = Date.now()
): { key: string; label: string; items: CampaignActivityItem[] }[] {
  const days = new Map<string, CampaignActivityItem[]>();
  for (const item of items) {
    const at = new Date(item.at);
    const key = Number.isNaN(at.getTime())
      ? "unknown"
      : `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
    const list = days.get(key) ?? [];
    list.push(item);
    days.set(key, list);
  }
  return [...days].map(([key, list]) => ({
    key,
    label: dayLabel(list[0]?.at, now),
    items: list,
  }));
}

/** The half of one page of a list the reader is looking at: "1–50 of 214". */
export function pageText(offset: number, size: number, total: number): string {
  if (total <= 0) return "0 of 0";
  const first = Math.min(offset + 1, total);
  const last = Math.min(offset + size, total);
  return `${first}–${last} of ${total}`;
}

/** The optimistic half of the claim the backend makes before it sends, so a second click in
 *  the same breath has nothing to claim. Mirrors the SQL's `state IN ('queued','failed')` and
 *  returns null when the row cannot be had — already on its way, already gone, or stopped. */
export function claimRow(rows: CampaignFollowupRow[], leadId: string): CampaignFollowupRow[] | null {
  const row = rows.find((one) => one.lead_id === leadId);
  if (!row || (row.state !== "queued" && row.state !== "failed")) return null;
  return rows.map((one) =>
    one.lead_id === leadId ? { ...one, state: "sending", last_error: null } : one
  );
}
