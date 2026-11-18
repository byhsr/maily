import { describe, expect, it } from "vitest";
import type { CampaignActivityItem, CampaignFollowupRow, CampaignLeadRow } from "./types";
import {
  ACTIVITY_FILTERS,
  activityNote,
  activityText,
  activityTone,
  agoText,
  campaignProgress,
  canSend,
  claimRow,
  dayLabel,
  dueText,
  followupStatus,
  groupByDay,
  heldWhy,
  leadStatus,
  minutesText,
  noFollowupsText,
  numberText,
  pageText,
  percentText,
  progressText,
  sendBlockedReason,
  stepFilters,
  stepLabel,
  visibleFollowups,
  whenAt,
  type QueuePace,
} from "./followups";

const NOW = Date.parse("2026-11-09T12:00:00Z");
/** A moment `minutes` away from `NOW`, as the stored timestamps are written. */
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function row(over: Partial<CampaignFollowupRow> = {}): CampaignFollowupRow {
  return {
    lead_id: "lead-1",
    email: "ada@acme.test",
    state: "queued",
    step_position: 1,
    lead_status: "active",
    ...over,
  };
}

describe("what a follow-up row reads as", () => {
  it("names a step the way the funnel and the leads table do", () => {
    expect(stepLabel(0)).toBe("Email 1");
    expect(stepLabel(1)).toBe("Follow-up 1");
    expect(stepLabel(3)).toBe("Follow-up 3");
  });

  it("reads the five panel statuses off the enrolment", () => {
    expect(followupStatus(row())).toBe("Scheduled");
    expect(followupStatus(row({ state: "sending" }))).toBe("Sending");
    expect(followupStatus(row({ state: "failed" }))).toBe("Failed");
    expect(followupStatus(row({ state: "done" }))).toBe("Sent");
    expect(followupStatus(row({ state: "paused" }))).toBe("Skipped");
  });

  it("never offers to send to a lead that answered", () => {
    // The one rule the panel has to get right on its own: no Send now is ever drawn for a
    // lead that has replied, been suppressed, or stopped being active.
    expect(followupStatus(row({ replied: true }))).toBe("Skipped");
    expect(followupStatus(row({ suppressed: true }))).toBe("Skipped");
    expect(followupStatus(row({ lead_status: "needs_attention" }))).toBe("Skipped");
    expect(canSend(row({ replied: true }))).toBe(false);
    expect(canSend(row({ suppressed: true }))).toBe(false);
    expect(visibleFollowups([row({ replied: true })], { step: "All", settled: false })).toEqual([]);
  });

  it("lets a send under way outrank what the row was doing", () => {
    expect(followupStatus(row({ state: "sending", replied: true }))).toBe("Sending");
  });
});

describe("when a follow-up is due", () => {
  /** A running campaign that sent a moment ago, with this row at the front of the queue. */
  const ready: QueuePace = { running: true, heldWhy: "held", slotAt: null, nextId: "lead-1" };
  /** The same, but the pace has not allowed the next send yet. */
  const spacing = (minutes: number): QueuePace => ({ ...ready, slotAt: NOW + minutes * 60_000 });

  it("reads a stored time coarsely while it is still ahead", () => {
    expect(dueText(row({ scheduled_at: at(240) }), NOW, ready)).toBe("in 4h");
    expect(dueText(row({ scheduled_at: at(192) }), NOW, ready)).toBe("in 3h 12m");
    expect(dueText(row({ scheduled_at: at(30) }), NOW, ready)).toBe("in 30m");
    expect(dueText(row({ scheduled_at: at(1.5 * 1440) }), NOW, ready)).toBe("in 2d");
    // Half a minute either side of now is the tick's own wobble, not lateness.
    expect(dueText(row({ scheduled_at: at(-0.5) }), NOW, ready)).toBe("now");
    expect(dueText(row({ scheduled_at: at(0.5) }), NOW, ready)).toBe("now");
  });

  /** The row whose time has passed is only late if the campaign is not the reason. A campaign
   *  sends one email at a time, so the ones behind the send in front of them are waiting. */
  it("calls a row past its time what the campaign is doing to it", () => {
    const past = row({ scheduled_at: at(-120) });
    // At the front of a queue the pace is spacing out: this is the one going next.
    expect(dueText(past, NOW, spacing(3))).toBe("next up");
    // Behind it, the same time, and the same campaign.
    expect(dueText(past, NOW, ready)).toBe("due now");
    expect(dueText(past, NOW, { ...spacing(-1), nextId: "lead-2" })).toBe("waiting for its turn");
    expect(dueText(past, NOW, { ...ready, nextId: "lead-2" })).toBe("waiting for its turn");
    // A paused campaign holds every row, however long it has been waiting.
    expect(dueText(past, NOW, { ...ready, running: false, heldWhy: heldWhy("paused") })).toBe(
      "held — the campaign is paused"
    );
    // A row with no stored time is due, and due is the tick's reading of it: not held.
    expect(dueText(row(), NOW, { ...ready, running: false, heldWhy: heldWhy("draft") })).toBe("now");
  });

  it("never calls a row late, whatever state the campaign is in", () => {
    const past = row({ scheduled_at: at(-300) });
    for (const status of ["active", "throttled", "paused", "draft", "done"]) {
      const pace: QueuePace = {
        running: status === "active",
        heldWhy: heldWhy(status),
        slotAt: null,
        nextId: "lead-1",
      };
      const text = dueText(past, NOW, pace);
      expect(text).not.toMatch(/overdue/i);
      expect(text).not.toBe("");
    }
  });

  /** The column used to read "next tick" for a row with nothing stored, which is not a time and
   *  told the reader nothing. Every path now writes one. */
  it("never says anything but a time", () => {
    const written = [
      dueText(row(), NOW, ready),
      dueText(row({ scheduled_at: at(-120) }), NOW, ready),
      whenAt(at(240)),
      whenAt(null),
    ];
    for (const text of written) {
      expect(text.toLowerCase()).not.toContain("tick");
      expect(text.toLowerCase()).not.toContain("nan");
      expect(text.toLowerCase()).not.toContain("infinity");
    }
  });

  it("writes an instant in full, in this machine's zone and its own words", () => {
    const soon = whenAt(at(240));
    // The order is the reader's locale's business; what the page promises is the date, the time
    // to the minute, and the zone's name. The name is asked of the platform rather than written
    // here, so this holds wherever the tests run.
    const zone = new Date(at(240))
      .toLocaleString([], { timeZoneName: "short" })
      .replace(/.*\s/, "");
    expect(soon).toContain("2026");
    expect(soon).toMatch(/\d{1,2}:\d{2}/);
    expect(soon).toContain(zone);
    expect(whenAt(null)).toBe("—");
    expect(whenAt("not a date")).toBe("—");
  });

  it("counts backwards for the feed", () => {
    expect(agoText(at(-17), NOW)).toBe("17m ago");
    expect(agoText(at(-180), NOW)).toBe("3h ago");
    expect(agoText(at(-2880), NOW)).toBe("2d ago");
    expect(agoText(at(0), NOW)).toBe("just now");
    expect(agoText(null, NOW)).toBe("");
  });
});

describe("sending one by hand", () => {
  it("claims a waiting row exactly once, which is what a double click meets", () => {
    const rows = [row()];
    const claimed = claimRow(rows, "lead-1");
    expect(claimed?.[0].state).toBe("sending");
    // The second click of the same double click is looking at the claimed rows.
    expect(claimRow(claimed ?? [], "lead-1")).toBeNull();
  });

  it("clears the last error when it retries a failed row, and refuses the settled ones", () => {
    const failed = claimRow([row({ state: "failed", last_error: "No sending account had capacity" })], "lead-1");
    expect(failed?.[0].state).toBe("sending");
    expect(failed?.[0].last_error).toBeNull();
    expect(claimRow([row({ state: "done" })], "lead-1")).toBeNull();
    expect(claimRow([row({ state: "paused" })], "lead-1")).toBeNull();
    expect(claimRow([row()], "someone-else")).toBeNull();
  });

  it("leaves the rows it was given alone when it cannot claim", () => {
    const rows = [row({ state: "done" })];
    expect(claimRow(rows, "lead-1")).toBeNull();
    expect(rows[0].state).toBe("done");
  });

  it("offers a send only for a step that still has somewhere to go", () => {
    expect(canSend(row())).toBe(true);
    expect(canSend(row({ state: "failed", last_error: "boom" }))).toBe(true);
    expect(canSend(row({ state: "sending" }))).toBe(false);
    expect(canSend(row({ state: "done" }))).toBe(false);
    expect(canSend(row({ state: "paused" }))).toBe(false);
  });

  it("says what the sender would say about the campaign, and only when it is not running", () => {
    expect(sendBlockedReason("active")).toBeNull();
    // Throttled is still running: capacity is looked at again on the way out.
    expect(sendBlockedReason("throttled")).toBeNull();
    expect(sendBlockedReason("paused")).toContain("paused");
    expect(sendBlockedReason("done")).toBe("This campaign has finished");
    expect(sendBlockedReason("draft")).toContain("Launch");
  });
});

describe("what the table shows", () => {
  const rows = [
    row({ lead_id: "a", step_position: 0 }),
    row({ lead_id: "b", state: "sending" }),
    row({ lead_id: "c", state: "failed" }),
    row({ lead_id: "d", state: "done" }),
    row({ lead_id: "e", replied: true }),
  ];

  it("defaults to the rows that still have work in them", () => {
    const shown = visibleFollowups(rows, { step: "All", settled: false }).map((one) => one.lead_id);
    expect(shown).toEqual(["a", "b", "c"]);
  });

  it("shows only what has settled when the history filter is on", () => {
    const shown = visibleFollowups(rows, { step: "All", settled: true }).map((one) => one.lead_id);
    // The two nothing more will happen to: one sent, one answered.
    expect(shown).toEqual(["d", "e"]);
  });

  it("narrows to one step", () => {
    const shown = visibleFollowups(rows, { step: "0", settled: false }).map((one) => one.lead_id);
    expect(shown).toEqual(["a"]);
    // The same step under the history filter is empty: that lead is still waiting.
    expect(visibleFollowups(rows, { step: "0", settled: true })).toEqual([]);
  });

  it("offers every step the campaign has an enrolment on, in order", () => {
    expect(stepFilters(rows)).toEqual(["All", "0", "1"]);
  });

  it("says which filter left the table empty rather than blaming the campaign", () => {
    expect(noFollowupsText({ step: "All", settled: false })).toBe("No follow-ups waiting.");
    expect(noFollowupsText({ step: "4", settled: false })).toBe(
      "No follow-ups for Follow-up 4 waiting."
    );
    expect(noFollowupsText({ step: "4", settled: true })).toBe(
      "No sent or skipped follow-ups for Follow-up 4."
    );
  });
});

describe("how far the campaign has got", () => {
  it("counts the leads written to over the leads enrolled", () => {
    expect(progressText(2, 2)).toBe("2 / 2 leads contacted");
    expect(progressText(0, 0)).toBe("0 / 0 leads contacted");
    expect(campaignProgress(1, 4).percent).toBe(25);
  });

  /** The numerator can never beat the denominator: two halves of one campaign that disagree —
   *  a send logged against a lead since taken off the list — must not read as 150% done. */
  it("caps the numerator at the denominator", () => {
    expect(campaignProgress(6, 4)).toEqual({ contacted: 4, total: 4, percent: 100 });
    expect(progressText(6, 4)).toBe("4 / 4 leads contacted");
    expect(campaignProgress(-2, 4).contacted).toBe(0);
  });

  it("has no percentage without an audience, rather than a division by nothing", () => {
    expect(campaignProgress(0, 0).percent).toBe(0);
    expect(percentText(Number.NaN)).toBe("0%");
    expect(percentText(Number.POSITIVE_INFINITY)).toBe("0%");
  });

  it("writes a duration, and a dash where there is nothing to write", () => {
    expect(minutesText(45)).toBe("45m");
    expect(minutesText(192)).toBe("3h 12m");
    expect(minutesText(120)).toBe("2h");
    expect(minutesText(2880)).toBe("2d");
    expect(minutesText(null)).toBe("—");
    expect(numberText(2)).toBe("2");
    expect(numberText(1.25)).toBe("1.3");
    expect(numberText(null)).toBe("—");
  });

  it("pages a list by what is on screen", () => {
    expect(pageText(0, 50, 214)).toBe("1–50 of 214");
    expect(pageText(200, 50, 214)).toBe("201–214 of 214");
    expect(pageText(0, 50, 0)).toBe("0 of 0");
  });
});

describe("what a lead row says about itself", () => {
  function lead(over: Partial<CampaignLeadRow> = {}): CampaignLeadRow {
    return { lead_id: "lead-1", email: "ada@acme.test", state: "queued", ...over };
  }

  it("puts what stopped the lead ahead of where it got to", () => {
    expect(leadStatus(lead({ suppressed: true, replied: true }), [])).toBe("Unsubscribed");
    expect(leadStatus(lead({ replied: true }), [])).toBe("Replied");
    expect(leadStatus(lead({ replied: true, state: "done" }), [])).toBe("Replied");
    expect(leadStatus(lead({ state: "done" }), ["lead-1"])).toBe("Bounced");
    expect(leadStatus(lead({ state: "done" }), [])).toBe("Finished");
  });

  it("separates a lead nothing has gone to from one mid-sequence", () => {
    expect(leadStatus(lead(), [])).toBe("Queued");
    expect(leadStatus(lead({ sent_at: "2026-11-09T12:00:00Z", step_position: 1 }), [])).toBe(
      "In sequence"
    );
    // Held by a skip or a reply: still enrolled, so still in the sequence.
    expect(leadStatus(lead({ state: "paused", sent_at: "2026-11-09T12:00:00Z" }), [])).toBe(
      "In sequence"
    );
  });
});

describe("what the activity feed says", () => {
  function item(over: Partial<CampaignActivityItem> = {}): CampaignActivityItem {
    return {
      id: "event-1",
      type: "sent",
      at: at(0),
      email: "ada@acme.test",
      step_position: 0,
      detail: "",
      ...over,
    };
  }

  it("names the lead and the step in every line", () => {
    expect(activityText(item())).toBe("Sent Email 1 to ada@acme.test");
    expect(activityText(item({ type: "scheduled", step_position: 1 }))).toBe(
      "Scheduled Follow-up 1 for ada@acme.test"
    );
    expect(activityText(item({ type: "send_now", step_position: 1 }))).toBe(
      "Sent Follow-up 1 to ada@acme.test by hand"
    );
    expect(activityText(item({ type: "paused", email: null, step_position: null }))).toBe(
      "Campaign paused"
    );
  });

  it("tags an answer with what it sounded like, and says why a skip happened", () => {
    expect(activityText(item({ type: "replied", metadata: { positive: true } }))).toContain(
      "Positive reply"
    );
    expect(activityText(item({ type: "replied", metadata: { positive: false } }))).toContain(
      "Reply from"
    );
    expect(activityText(item({ type: "skipped", metadata: { reason: "replied" } }))).toBe(
      "Skipped Email 1 for ada@acme.test — they replied"
    );
    expect(activityText(item({ type: "skipped", metadata: { reason: "manual" } }))).toContain(
      "by hand"
    );
    expect(activityText(item({ type: "skipped", detail: "That lead has unsubscribed." }))).toContain(
      "unsubscribed"
    );
  });

  it("keeps the subject as the quiet half of the line", () => {
    expect(activityNote(item({ detail: "ok" }))).toBe("ok");
    expect(activityNote(item({ type: "paused" }))).toBe("");
    expect(activityTone(item({ type: "bounced" }))).toBe("bad");
    expect(activityTone(item({ type: "replied", metadata: { positive: true } }))).toBe("good");
    expect(activityTone(item({ type: "replied", metadata: { positive: false } }))).toBe("neutral");
  });

  it("groups the feed by the reader's own days, newest first", () => {
    const today = new Date(NOW).toISOString();
    const yesterday = new Date(NOW - 86_400_000).toISOString();
    const days = groupByDay(
      [
        item({ id: "a", at: today }),
        item({ id: "b", at: today }),
        item({ id: "c", at: yesterday }),
      ],
      NOW
    );
    expect(days).toHaveLength(2);
    expect(days[0].label).toBe("Today");
    expect(days[0].items.map((one) => one.id)).toEqual(["a", "b"]);
    expect(days[1].label).toBe("Yesterday");
    expect(dayLabel(null)).toBe("Unknown");
  });

  it("offers a filter for every kind of line it can draw", () => {
    expect(ACTIVITY_FILTERS[0]).toEqual({ label: "All", value: "all" });
    expect(ACTIVITY_FILTERS.map((one) => one.value)).toContain("send_now");
    // The campaign pausing and resuming is one story, filtered as one.
    expect(ACTIVITY_FILTERS.map((one) => one.value)).toContain("paused,resumed");
  });
});
