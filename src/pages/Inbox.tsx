import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock,
  CornerUpLeft,
  Inbox as InboxIcon,
  MailOpen,
  Maximize2,
  Minimize2,
  PenLine,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useNav } from "../app/nav";
import {
  cancelAllFollowups,
  classifyInbox,
  deleteDraft,
  followupCancel,
  followupSendNow,
  followupUpdate,
  inboxBulk,
  inboxCounts,
  inboxThread,
  listAccounts,
  listChannels,
  listDrafts,
  listInbox,
  listScheduled,
  listSent,
  pauseFollowups,
  resumeFollowups,
  setInboxChannel,
  snoozeInbox,
  suppressLead,
  syncInbox,
  threadFollowups,
} from "../lib/api";
import { renderEmailMarkdown, renderMessageBody } from "../lib/email";
import type {
  Account,
  Channel,
  Draft,
  FollowupStep,
  InboxMessage,
  InboxThread,
  ScheduledItem,
  SentMessage,
  ThreadFollowups,
} from "../lib/types";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Composer } from "../ui/Composer";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Tooltip } from "../ui/Tooltip";

type InboxProps = {
  tell: (message: string) => void;
  /** The mailbox the whole page is narrowed to; `undefined` is every account. Held by the
   *  shell so the sidebar switcher and the rail stay on the same account. */
  account?: string;
  onAccount: (account?: string) => void;
  /** A conversation to open on arrival, so a campaign's leads tab can link into it. */
  initialMessageId?: string;
};

type View = "inbox" | "new" | "sent" | "scheduled" | "drafts" | "archived";
type BulkAction = "archive" | "unarchive" | "read" | "unread" | "delete";

const VIEWS: { id: View; label: string; icon?: typeof Clock }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "new", label: "New" },
  { id: "sent", label: "Sent" },
  { id: "scheduled", label: "Scheduled", icon: Clock },
  { id: "drafts", label: "Drafts" },
  { id: "archived", label: "Archived" },
];

const SORTS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "sender", label: "Sender" },
];

const LIST_MIN = 300;
const LIST_MAX = 480;

/** One row of the thread list, whichever table it came from. */
type Row = {
  id: string;
  name: string;
  subject: string;
  preview: string;
  when?: string;
  unread: boolean;
  category?: string;
  dot?: string;
  /** Only a held message can be filed, moved or deleted in bulk. */
  fillable: boolean;
  /** A scheduled send: its time reads forward, "in 2 days", not back. */
  schedule?: boolean;
};

function relative(value?: string): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.round(minutes / 1440)}d`;
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A due time read forward — "in 2 days" — the way the Scheduled view needs it. */
function dueIn(value?: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.round((at.getTime() - Date.now()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 1440) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / 1440)} days`;
}

/** The exact moment a follow-up goes out, for the ghost rows and the chip. */
function whenAt(value?: string | null): string {
  if (!value) return "unscheduled";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "unscheduled";
  return at.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function readListWidth(): number {
  const stored = Number(localStorage.getItem("mailyInboxListW"));
  return stored >= LIST_MIN && stored <= LIST_MAX ? stored : 360;
}

/**
 * The Inbox: a rail of views and classifications, the thread list, and the reading pane.
 * The page fills the window and each pane scrolls on its own, so nothing here sets a
 * page scroll. `Composer` covers both cases — a new message docked over the page, and a
 * reply inline under the message it answers.
 */
export function Inbox({ tell, account, onAccount, initialMessageId }: InboxProps) {
  const [view, setView] = useState<View>("inbox");
  const [channelId, setChannelId] = useState<string | undefined>();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");

  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [sent, setSent] = useState<SentMessage[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [counts, setCounts] = useState({ inbox: 0, unread: 0, archived: 0, sent: 0, drafts: 0, scheduled: 0 });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** The follow-ups hanging off the open conversation, when it has a single behind it. */
  const [followups, setFollowups] = useState<ThreadFollowups | null>(null);
  /** The step being edited in place, and the fields its editor holds. */
  const [editing, setEditing] = useState<string>();
  const [editDays, setEditDays] = useState("3");
  const [editBody, setEditBody] = useState("");

  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(initialMessageId);
  const [thread, setThread] = useState<InboxThread | null>(null);
  /** The reader on its own, with the rail and the list given back to the message. */
  const [wide, setWide] = useState(false);
  const [docked, setDocked] = useState<{ draft?: Draft | null } | null>(null);
  const [replying, setReplying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [listWidth, setListWidth] = useState(readListWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  /** What the sidebar was before a conversation took it away, or `null` when it is ours. */
  const handedBack = useRef<boolean | null>(null);
  const { mobile, collapsed, setCollapsed } = useNav();

  const q = query.trim().toLowerCase();
  const mailbox = view === "inbox" || view === "new" || view === "archived";
  /** The classification the list is narrowed to, when there is one. */
  const channelName = channels.find((channel) => channel.id === channelId)?.name;

  const load = useCallback(async () => {
    if (view === "sent") setSent(await listSent(100, account));
    else if (view === "drafts") setDrafts(await listDrafts(account));
    else if (view === "scheduled") setScheduled(await listScheduled());
    else setMessages(await listInbox(view, channelId, unreadOnly, sort, account));
    setCounts(await inboxCounts(account));
  }, [view, channelId, unreadOnly, sort, account]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (error) {
      tell(String(error));
    }
  }, [load, tell]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The backend keeps reading each mailbox on its own, so a reply can arrive with nobody
  // pressing anything. This is how it reaches the list when it does.
  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen<number>("inbox:new", () => void refresh());
    return () => {
      void subscription.then((off) => off());
    };
  }, [refresh]);

  // Both lists follow the account switch: the classification counts are per mailbox too.
  useEffect(() => {
    listChannels(account)
      .then(setChannels)
      .catch((error) => tell(String(error)));
  }, [account, tell]);

  useEffect(() => {
    listAccounts()
      .then(setAccounts)
      .catch((error) => tell(String(error)));
  }, [tell]);

  useEffect(() => {
    setEditing(undefined);
    if (!selected || !mailbox) {
      setThread(null);
      setFollowups(null);
      return;
    }
    inboxThread(selected)
      .then(setThread)
      .catch((error) => tell(String(error)));
    // The scheduled follow-ups of whatever single wrote into this conversation, if any.
    threadFollowups(selected)
      .then(setFollowups)
      .catch(() => setFollowups(null));
  }, [selected, mailbox, tell]);

  // Selecting a different conversation closes a reply that belonged to the old one, and
  // gives the list back: a reader expanded over one message should not stay expanded
  // over the next.
  useEffect(() => {
    setReplying(false);
    setWide(false);
  }, [selected]);

  // A reply opens above the message, so the pane goes back to the top with it — otherwise
  // the writer would still be looking at wherever they had scrolled to.
  useEffect(() => {
    if (replying) pane.current?.scrollTo({ top: 0 });
  }, [replying]);

  // Leaving the page with a conversation open is still leaving it: the sidebar comes back
  // rather than staying away on whatever page is next.
  useEffect(
    () => () => {
      if (handedBack.current !== null) setCollapsed(handedBack.current);
    },
    [setCollapsed]
  );

  // A conversation is worth more width than the sidebar is, so opening one puts the
  // sidebar away and closing it hands the sidebar back exactly as it was found. A
  // deliberate collapse is never overruled — only remembered.
  useEffect(() => {
    if (mobile) return;
    if (selected && handedBack.current === null) {
      handedBack.current = collapsed;
      if (!collapsed) setCollapsed(true);
    } else if (!selected && handedBack.current !== null) {
      setCollapsed(handedBack.current);
      handedBack.current = null;
    }
  }, [selected, mobile, collapsed, setCollapsed]);

  // Dragging the separator resizes the thread list within its allowed band.
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!drag.current) return;
      const next = drag.current.width + event.clientX - drag.current.x;
      setListWidth(Math.min(LIST_MAX, Math.max(LIST_MIN, next)));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setListWidth((width) => {
        localStorage.setItem("mailyInboxListW", String(width));
        return width;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const all: Row[] =
      view === "sent"
        ? sent.map((item) => ({
            id: item.id,
            name: item.to_email || item.lead_name || "Unknown recipient",
            subject: item.subject || "(no subject)",
            preview: item.text?.split("\n")[0] ?? "",
            when: item.created_at,
            unread: false,
            fillable: false,
          }))
        : view === "scheduled"
          ? scheduled.map((item) => ({
              id: item.id,
              name: item.lead_name || item.lead_email || "Unknown recipient",
              subject: item.kind === "single" ? "Follow-up" : item.campaign || "Campaign step",
              preview: item.body_md?.split("\n")[0] || "Scheduled send",
              when: item.due_at ?? undefined,
              unread: false,
              fillable: false,
              schedule: true,
            }))
        : view === "drafts"
          ? drafts.map((item) => ({
              id: item.id,
              name: item.to_email || "No recipient yet",
              subject: item.subject || "(no subject)",
              preview: item.markdown.split("\n")[0] ?? "",
              when: item.updated_at,
              unread: false,
              fillable: false,
            }))
          : messages.map((item) => ({
              id: item.id,
              name: item.lead_name || item.from_email || "Unknown",
              subject: item.subject || "(no subject)",
              preview: item.raw_excerpt ?? "",
              when: item.received_at,
              unread: !item.read,
              category: item.category?.replace(/_/g, " "),
              dot: channels.find((channel) => channel.id === item.channel_id)?.color,
              fillable: true,
            }));
    if (!q) return all;
    return all.filter(
      (row) =>
        row.subject.toLowerCase().includes(q) || row.name.toLowerCase().includes(q) || row.preview.toLowerCase().includes(q)
    );
  }, [view, sent, drafts, scheduled, messages, channels, q]);

  const openRow = (row: Row) => {
    setSelected(row.id);
    if (view === "drafts") setDocked({ draft: drafts.find((item) => item.id === row.id) ?? null });
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const added = await syncInbox(account);
      // "No new replies" reads like a failure. Nothing to fetch is the normal answer for a
      // mailbox already read up to the moment of the click.
      tell(added ? `${added} new ${added === 1 ? "reply" : "replies"}` : "Already up to date");
      await refresh();
    } catch (error) {
      tell(String(error));
    } finally {
      setSyncing(false);
    }
  };

  const runClassify = async () => {
    try {
      const done = await classifyInbox(false);
      tell(`${done} replies classified`);
      await refresh();
    } catch (error) {
      tell(String(error));
    }
  };

  /** Files a selection, or one message when the reader asks for it. */
  const act = async (action: BulkAction, ids?: string[]) => {
    const targets = ids ?? picked;
    if (targets.length === 0) return;
    try {
      await inboxBulk(targets, action);
      if (!ids) setPicked([]);
      if (selected && targets.includes(selected) && action !== "read" && action !== "unread") setSelected(undefined);
      await refresh();
    } catch (error) {
      tell(String(error));
    }
  };

  const moveTo = async (target: string) => {
    if (picked.length === 0) return;
    try {
      await Promise.all(picked.map((id) => setInboxChannel(id, target)));
      setPicked([]);
      await refresh();
    } catch (error) {
      tell(String(error));
    }
  };

  const reclassify = async (target: string) => {
    if (!selected) return;
    try {
      await setInboxChannel(selected, target);
      await refresh();
      setThread(await inboxThread(selected));
    } catch (error) {
      tell(String(error));
    }
  };

  const snoozeThread = async () => {
    if (!selected) return;
    try {
      await snoozeInbox(selected, new Date(Date.now() + 86400000).toISOString());
      await refresh();
    } catch (error) {
      tell(String(error));
    }
  };

  const suppressThread = async () => {
    const email = thread?.from_email;
    if (!email) return;
    try {
      await suppressLead(email, "from inbox");
      tell(`${email} suppressed`);
    } catch (error) {
      tell(String(error));
    }
  };

  const countOf = (id: View) =>
    id === "inbox"
      ? counts.inbox
      : id === "new"
        ? counts.unread
        : id === "sent"
          ? counts.sent
          : id === "scheduled"
            ? counts.scheduled
            : id === "drafts"
              ? counts.drafts
              : counts.archived;

  /** Switching mailbox drops the selection: a conversation in one mailbox is not in the
      next one, so leaving the reader pointing at it would be a lie. */
  const switchAccount = (id?: string) => {
    setSelected(undefined);
    setPicked([]);
    onAccount(id);
  };

  const totalUnread = accounts.reduce((sum, one) => sum + (one.unread ?? 0), 0);

  /** Digits 1-9 jump straight to a classification; j/k walk the list. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (/^[1-9]$/.test(event.key)) {
        const channel = channels[Number(event.key) - 1];
        if (channel) setChannelId(channel.id);
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const at = rows.findIndex((row) => row.id === selected);
      const next = event.key === "j" ? at + 1 : at - 1;
      const row = rows[Math.min(Math.max(next, 0), rows.length - 1)];
      if (row) openRow(row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Puts the reading pane away, which hands its width back to the list. */
  const closeReader = () => setSelected(undefined);

  const closeButton = (
    <Tooltip label="Close">
      <button type="button" className="btn-icon" onClick={closeReader}>
        <X size={15} />
      </button>
    </Tooltip>
  );

  /** On every reader, so a conversation, a sent message and a draft can all be put away
      or given the whole window the same way. */
  const readerTools = (
    <>
      <Tooltip label={wide ? "Show the list" : "Expand"}>
        <button type="button" className="btn-icon" aria-pressed={wide} onClick={() => setWide(!wide)}>
          {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </Tooltip>
      {closeButton}
    </>
  );

  /** A selection that no longer resolves. The one thing a reader can always do is close,
      so even this state is not a dead end. */
  const missing = (
    <div className="readempty">
      <p>That message is no longer here</p>
      {closeButton}
    </div>
  );

  /** Re-reads the open conversation's follow-ups after one of them changes. */
  const reloadFollowups = async () => {
    if (selected) setFollowups(await threadFollowups(selected));
  };

  /** Brings one pending follow-up forward so the scheduler sends it on its next pass. */
  const sendStepNow = async (step: FollowupStep) => {
    try {
      await followupSendNow(step.id);
      tell(`Follow-up ${step.position} is due now`);
      await reloadFollowups();
    } catch (error) {
      tell(String(error));
    }
  };

  const cancelStep = async (step: FollowupStep) => {
    try {
      await followupCancel(step.id);
      await reloadFollowups();
    } catch (error) {
      tell(String(error));
    }
  };

  const beginEdit = (step: FollowupStep) => {
    setEditing(step.id);
    setEditDays(String(step.delay_days ?? 3));
    setEditBody(step.body_md ?? "");
  };

  const saveStepEdit = async (step: FollowupStep) => {
    if (!editBody.trim()) {
      tell("Write the follow-up first");
      return;
    }
    try {
      // Edited through the one renderer, so the stored html and text stay its output.
      const parts = renderEmailMarkdown(editBody, {
        first_name: thread?.lead.name ?? "",
        company: thread?.lead.company ?? "",
      });
      await followupUpdate({
        id: step.id,
        delay_days: Number(editDays) || 0,
        body_md: editBody,
        body_html: parts.html,
        body_text: parts.text,
        subject_override: step.subject_override ?? null,
      });
      setEditing(undefined);
      await reloadFollowups();
    } catch (error) {
      tell(String(error));
    }
  };

  const setAllFollowups = async (pause: boolean) => {
    if (!followups?.campaign_id) return;
    try {
      if (pause) await pauseFollowups(followups.campaign_id);
      else await resumeFollowups(followups.campaign_id);
      await reloadFollowups();
    } catch (error) {
      tell(String(error));
    }
  };

  const dropAllFollowups = async () => {
    if (!followups?.campaign_id) return;
    try {
      await cancelAllFollowups(followups.campaign_id);
      await reloadFollowups();
    } catch (error) {
      tell(String(error));
    }
  };

  const reader = () => {
    if (view === "sent") {
      const item = sent.find((one) => one.id === selected);
      if (!item) return missing;
      return (
        <>
          <header className="readhead">
            <h2 className="readsubject">{item.subject || "(no subject)"}</h2>
            <p className="readfrom">
              <span>To {item.to_email || "—"}</span>
              {item.cc ? <span className="muted">Cc {item.cc}</span> : null}
              <span className="muted">
                {item.account_email} · {new Date(item.created_at).toLocaleString()} ·{" "}
                {item.campaign ?? "Direct message"}
              </span>
            </p>
            <div className="readtools">{readerTools}</div>
          </header>
          <div
            className="readbody mdarticle"
            // Stored markup goes through the same sanitizer the preview uses.
            dangerouslySetInnerHTML={{
              __html: item.html?.trim() ? renderMessageBody(item.html) : renderMessageBody(null, item.text),
            }}
          />
        </>
      );
    }

    if (view === "scheduled") {
      const item = scheduled.find((one) => one.id === selected);
      if (!item) return missing;
      return (
        <>
          <header className="readhead">
            <h2 className="readsubject">{item.kind === "single" ? "Follow-up" : item.campaign || "Scheduled send"}</h2>
            <p className="readfrom">
              <span>{item.lead_name || item.lead_email || "Unknown recipient"}</span>
              <span className="muted">Sends {whenAt(item.due_at)}</span>
            </p>
            <div className="readtools">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await followupSendNow(item.id);
                    tell("Sent now");
                    await refresh();
                  } catch (error) {
                    tell(String(error));
                  }
                }}
              >
                <Send size={15} />
                Send now
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await followupCancel(item.id);
                    setSelected(undefined);
                    await refresh();
                  } catch (error) {
                    tell(String(error));
                  }
                }}
              >
                Cancel
              </Button>
              {readerTools}
            </div>
          </header>
          <div
            className="readbody mdarticle"
            dangerouslySetInnerHTML={{ __html: renderMessageBody(null, item.body_md) }}
          />
        </>
      );
    }

    if (view === "drafts") {
      const item = drafts.find((one) => one.id === selected);
      if (!item) return missing;
      return (
        <>
          <header className="readhead">
            <h2 className="readsubject">{item.subject || "(no subject)"}</h2>
            <p className="readfrom">
              <span>To {item.to_email || "—"}</span>
              <span className="muted">Saved {new Date(item.updated_at).toLocaleString()}</span>
            </p>
            <div className="readtools">
              <Button variant="secondary" onClick={() => setDocked({ draft: item })}>
                <PenLine size={15} />
                Resume
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await deleteDraft(item.id);
                    setSelected(undefined);
                    await refresh();
                  } catch (error) {
                    tell(String(error));
                  }
                }}
              >
                Discard
              </Button>
              {readerTools}
            </div>
          </header>
          <div
            className="readbody mdarticle"
            dangerouslySetInnerHTML={{ __html: renderMessageBody(null, item.markdown) }}
          />
        </>
      );
    }

    if (!thread) return missing;

    return (
      <>
        <header className="readhead">
          <h2 className="readsubject">{thread.subject || "(no subject)"}</h2>
          <p className="readfrom">
            <span>{thread.lead.name || thread.from_email}</span>
            <span className="muted">{thread.from_email}</span>
          </p>
          <div className="readtools">
            <Select
              ghost
              label="Classify as"
              value={thread.channel_id ?? ""}
              placeholder={thread.category?.replace(/_/g, " ") ?? "Classify"}
              options={channels.map((channel) => ({ value: channel.id, label: channel.name, dot: channel.color }))}
              onChange={(target) => void reclassify(target)}
            />
            <Tooltip label={thread.archived ? "Move back to the inbox" : "Archive"}>
              <button
                type="button"
                className="btn-icon"
                onClick={() => void act(thread.archived ? "unarchive" : "archive", [thread.id])}
              >
                <Archive size={15} />
              </button>
            </Tooltip>
            <Tooltip label="Reply">
              <button type="button" className="btn-icon" onClick={() => setReplying(true)}>
                <CornerUpLeft size={15} />
              </button>
            </Tooltip>
            <Select
              ghost
              label="More actions"
              value=""
              placeholder="More"
              options={[
                { value: "unread", label: "Mark unread" },
                { value: "snooze", label: "Snooze a day" },
                { value: "suppress", label: "Suppress the sender" },
                { value: "delete", label: "Delete" },
              ]}
              onChange={(action) => {
                if (action === "snooze") void snoozeThread();
                else if (action === "suppress") void suppressThread();
                else void act(action as BulkAction, [thread.id]);
              }}
            />
            {readerTools}
          </div>
        </header>

        {/* The follow-ups this conversation's sender still has waiting. A single keeps
            them here rather than on a campaign page, so the thread is where they are
            read, paused and edited. */}
        {followups && followups.steps.some((step) => step.status === "pending") && (
          <div className="fufthread">
            <div className="fufthreadhead">
              <span className={`classchip fufchip${followups.paused ? "" : " pending"}`}>
                <i className={`dot ${followups.paused ? "dot-gray" : "dot-amber"}`} />
                {followups.paused
                  ? "Follow-ups paused"
                  : `${followups.pending} follow-up${followups.pending === 1 ? "" : "s"} pending`}
              </span>
              <Select
                ghost
                label="Follow-up actions"
                value=""
                placeholder="…"
                options={
                  followups.paused
                    ? [
                        { value: "resume", label: "Resume all" },
                        { value: "cancel", label: "Cancel all" },
                      ]
                    : [
                        { value: "pause", label: "Pause all" },
                        { value: "cancel", label: "Cancel all" },
                      ]
                }
                onChange={(action) => {
                  if (action === "pause") void setAllFollowups(true);
                  else if (action === "resume") void setAllFollowups(false);
                  else void dropAllFollowups();
                }}
              />
            </div>

            {followups.steps
              .filter((step) => step.status === "pending")
              .map((step) => (
                <div className="ghoststep" key={step.id}>
                  <Clock size={14} />
                  {editing === step.id ? (
                    <div className="ghostedit">
                      <label className="ghostedit-delay">
                        <span>Send after</span>
                        <input
                          type="number"
                          min={0}
                          value={editDays}
                          aria-label="Days to wait"
                          onChange={(event) => setEditDays(event.target.value)}
                        />
                        <span>days</span>
                      </label>
                      <textarea
                        value={editBody}
                        aria-label={`Follow-up ${step.position} message`}
                        onChange={(event) => setEditBody(event.target.value)}
                      />
                      <div className="ghostedit-actions">
                        <Button variant="secondary" onClick={() => void saveStepEdit(step)}>
                          Save
                        </Button>
                        <Button variant="ghost" onClick={() => setEditing(undefined)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="ghoststep-when">
                        Follow-up {step.position} · scheduled {whenAt(step.due_at ?? step.scheduled_at)}
                      </span>
                      <div className="ghoststep-actions">
                        <button type="button" className="linkback" onClick={() => beginEdit(step)}>
                          Edit
                        </button>
                        <button type="button" className="linkback" onClick={() => void sendStepNow(step)}>
                          Send now
                        </button>
                        <button type="button" className="linkback" onClick={() => void cancelStep(step)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
          </div>
        )}

        {/* The reply opens above the message rather than after it, so it is in view the
            moment it is asked for instead of at the end of a scroll. */}
        {replying && (
          <Composer
            variant="inline"
            mode="reply"
            thread={thread}
            accounts={accounts}
            tell={tell}
            onClose={() => setReplying(false)}
            onSent={async (note) => {
              setReplying(false);
              tell(note);
              await refresh();
              if (selected) setThread(await inboxThread(selected));
            }}
          />
        )}

        <div
          className="readbody mdarticle"
          dangerouslySetInnerHTML={{ __html: renderMessageBody(thread.body_html, thread.body_text) }}
        />

        {thread.conversation.length > 0 && (
          <div className="conversation">
            <span className="raillabel">Conversation</span>
            {thread.conversation.map((entry) => (
              <div key={entry.id} className={`conventry${entry.opened ? " open" : ""}`}>
                {/* The sign: where this message came from. An exchange of ours and theirs
                    cannot be read without it. */}
                {entry.origin === "maily" ? (
                  <span
                    className="classchip convorigin maily"
                    title={entry.campaign ? `Sent from Maily by “${entry.campaign}”` : "Sent from Maily"}
                  >
                    <i className="dot dot-green" />
                    Maily
                  </span>
                ) : entry.origin === "you" ? (
                  <span className="classchip convorigin" title="Sent from your mailbox, not through Maily">
                    <i className="dot dot-gray" />
                    You
                  </span>
                ) : (
                  <span className="classchip convorigin" title={entry.from_email ?? ""}>
                    <i className="dot dot-blue" />
                    {entry.from_email}
                  </span>
                )}
                <span className="convtext">
                  {entry.campaign && <span className="convcampaign">{entry.campaign}</span>}
                  {entry.status && entry.status !== "sent" && (
                    <span className="convstatus">{entry.status}</span>
                  )}
                  <span className="convpreview">{entry.preview}</span>
                </span>
                <time className="convtime">{relative(entry.at ?? undefined)}</time>
              </div>
            ))}
          </div>
        )}

        {!replying && (
          <button type="button" className="replybox" onClick={() => setReplying(true)}>
            Reply...
          </button>
        )}
      </>
    );
  };

  return (
    <section className="inboxpage">
      <PageHeader
        flush
        title="Inbox"
        status={`${counts.unread} unread`}
        search={{ value: query, onChange: setQuery, placeholder: "Search replies", hint: "/" }}
        tools={
          <>
            <Tooltip label="Sync now">
              <button
                type="button"
                className={`btn-icon${syncing ? " spinning" : ""}`}
                onClick={runSync}
                aria-label="Sync now"
              >
                <RefreshCw size={16} />
              </button>
            </Tooltip>
            <Button variant="secondary" onClick={runClassify}>
              <Sparkles size={16} />
              Classify
            </Button>
          </>
        }
        action={
          <Button onClick={() => setDocked({})}>
            <PenLine size={16} />
            New message
          </Button>
        }
      />

      <div
        className={["inboxpanes", selected ? "" : "without-reader", selected && wide ? "reader-only" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        <aside className="inboxrail">
          {/* Which mailbox is on screen. Only worth a group when there is a choice. */}
          {accounts.length > 1 && (
            <>
              <p className="railgroup">Accounts</p>
              <button
                type="button"
                className={`railitem${!account ? " on" : ""}`}
                onClick={() => switchAccount(undefined)}
              >
                <i className="dot dot-blue" />
                <span className="railtitle">All mailboxes</span>
                {totalUnread > 0 && <i className="railcount">{totalUnread}</i>}
              </button>
              {accounts.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  className={`railitem${account === one.id ? " on" : ""}`}
                  onClick={() => switchAccount(one.id)}
                  title={one.email}
                >
                  <i className={`dot ${one.health === "healthy" ? "dot-green" : "dot-gray"}`} />
                  <span className="railtitle">{one.email}</span>
                  {!!one.unread && <i className="railcount">{one.unread}</i>}
                </button>
              ))}
            </>
          )}

          <p className="railgroup">Views</p>
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`railitem${view === id ? " on" : ""}`}
              onClick={() => {
                setView(id);
                setSelected(undefined);
                setPicked([]);
              }}
            >
              {Icon && <Icon size={14} />}
              <span className="railtitle">{label}</span>
              {countOf(id) > 0 && <i className={`railcount${id === "new" ? " accent" : ""}`}>{countOf(id)}</i>}
            </button>
          ))}

          <p className="railgroup">Classification</p>
          <button
            type="button"
            className={`railitem${channelId === undefined ? " on" : ""}`}
            onClick={() => setChannelId(undefined)}
          >
            <span className="railtitle">All replies</span>
          </button>
          {channels.map((channel, index) => (
            <button
              key={channel.id}
              type="button"
              className={`railitem${channelId === channel.id ? " on" : ""}`}
              onClick={() => setChannelId(channel.id)}
            >
              <i className={`dot dot-${channel.color}`} />
              <span className="railtitle">{channel.name}</span>
              {index < 9 && <kbd className="railkbd">{index + 1}</kbd>}
              {channel.unread > 0 && <i className="railcount">{channel.unread}</i>}
            </button>
          ))}
        </aside>

        <div className="threadlist" style={selected && !wide ? { width: listWidth } : undefined}>
          <div className="listbar">
            {picked.length > 0 ? (
              <>
                <span className="listbarcount">{picked.length} selected</span>
                <div className="listbarpush">
                  <Select
                    ghost
                    label="Move to a classification"
                    value=""
                    placeholder="Move to"
                    options={channels.map((channel) => ({ value: channel.id, label: channel.name, dot: channel.color }))}
                    onChange={(target) => void moveTo(target)}
                  />
                  <Tooltip label="Archive">
                    <button type="button" className="btn-icon" onClick={() => void act("archive")}>
                      <Archive size={15} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Mark read">
                    <button type="button" className="btn-icon" onClick={() => void act("read")}>
                      <MailOpen size={15} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Delete">
                    <button type="button" className="btn-icon" onClick={() => void act("delete")}>
                      <Trash2 size={15} />
                    </button>
                  </Tooltip>
                </div>
              </>
            ) : (
              <>
                {mailbox && (
                  <Switch checked={unreadOnly} onChange={setUnreadOnly} label="Unread only">
                    Unread only
                  </Switch>
                )}
                <div className="listbarpush">
                  {mailbox && <Select ghost label="Sort" value={sort} options={SORTS} onChange={setSort} />}
                </div>
              </>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="listempty">
              <InboxIcon size={32} />
              {/* An empty list is nearly always a filter rather than an empty mailbox, and
                  "no replies yet" is a lie when there are messages one click away. Say
                  what is filtering, and how to undo it. */}
              {channelName ? (
                <>
                  <p>Nothing filed as {channelName}</p>
                  <small>
                    {counts.inbox === 1
                      ? "1 message is in the inbox, filed under none of the classifications"
                      : `${counts.inbox} messages are in the inbox, filed under none of the classifications`}
                  </small>
                  <Button variant="secondary" onClick={() => setChannelId(undefined)}>
                    Show all replies
                  </Button>
                </>
              ) : query.trim() ? (
                <>
                  <p>Nothing matches “{query.trim()}”</p>
                  <Button variant="secondary" onClick={() => setQuery("")}>
                    Clear the search
                  </Button>
                </>
              ) : unreadOnly && mailbox ? (
                <>
                  <p>Nothing unread here</p>
                  <Button variant="secondary" onClick={() => setUnreadOnly(false)}>
                    Show everything
                  </Button>
                </>
              ) : (
                <>
                  <p>
                    {view === "sent"
                      ? "Nothing sent yet"
                      : view === "scheduled"
                        ? "Nothing scheduled"
                        : view === "drafts"
                          ? "No drafts"
                          : "No replies yet"}
                  </p>
                  <small>
                    {view === "sent"
                      ? "Campaign and hand-written sends both land here"
                      : view === "scheduled"
                        ? "Follow-ups you schedule wait here until they go out"
                        : view === "drafts"
                          ? "Messages you start are kept here until you send them"
                          : "Replies from your campaigns land here"}
                  </small>
                  {mailbox && (
                    <Button variant="secondary" onClick={runSync}>
                      Sync now
                    </Button>
                  )}
                </>
              )}
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className={`threadrow${selected === row.id ? " on" : ""}${row.unread ? " unread" : ""}`}
                onClick={() => openRow(row)}
              >
                <span className="rowlead">
                  {row.fillable && (
                    <Checkbox
                      checked={picked.includes(row.id)}
                      label={`Select ${row.name}`}
                      onChange={(on) =>
                        setPicked((current) => (on ? [...current, row.id] : current.filter((id) => id !== row.id)))
                      }
                    />
                  )}
                  <i className="rowunread" />
                </span>
                <div className="rowmain">
                  <div className="rowtop">
                    <span className="rowname">{row.name}</span>
                    <time className="rowtime">{row.schedule ? dueIn(row.when) : relative(row.when)}</time>
                  </div>
                  <span className="rowsubject">{row.subject}</span>
                  <div className="rowpreview">
                    <span>{row.preview}</span>
                    {row.category && (
                      <span className="classchip">
                        <i className={`dot dot-${row.dot ?? "gray"}`} />
                        {row.category}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {selected && (
          <div
            className="threadsplit"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the thread list"
            onMouseDown={(event) => {
              drag.current = { x: event.clientX, width: listWidth };
            }}
          />
        )}

        {/* No conversation open means no reading pane: the list takes the whole width
            until one is picked, which is what closing one gives back. */}
        {selected && (
          <div className="inboxreader" ref={pane}>
            {reader()}
          </div>
        )}
      </div>

      {docked && (
        <Composer
          mode="new"
          draft={docked.draft ?? null}
          accounts={accounts}
          tell={tell}
          onClose={() => setDocked(null)}
          onSent={async (note) => {
            setDocked(null);
            tell(note);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
