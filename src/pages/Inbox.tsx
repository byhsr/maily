import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox as InboxIcon, RefreshCw, Sparkles } from "lucide-react";
import {
  classifyInbox,
  inboxThread,
  listChannels,
  listInbox,
  markInboxRead,
  setInboxChannel,
  snoozeInbox,
  suppressLead,
  syncInbox,
} from "../lib/api";
import type { Channel, InboxMessage, InboxThread } from "../lib/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Topbar } from "../ui/Topbar";

type InboxProps = {
  tell: (message: string) => void;
};

const when = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
};

export function Inbox({ tell }: InboxProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [channel, setChannel] = useState<string | undefined>();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      messages.filter(
        (m) => !q || (m.subject || "").toLowerCase().includes(q) || (m.from_email || "").toLowerCase().includes(q)
      ),
    [messages, q]
  );
  const unread = channels.reduce((sum, c) => sum + c.unread, 0);

  const loadChannels = useCallback(async () => setChannels(await listChannels()), []);
  const loadMessages = useCallback(async () => setMessages(await listInbox(channel, unreadOnly)), [channel, unreadOnly]);

  useEffect(() => {
    loadChannels().catch((e) => tell(String(e)));
  }, [loadChannels, tell]);

  useEffect(() => {
    loadMessages().catch((e) => tell(String(e)));
  }, [loadMessages, tell]);

  useEffect(() => {
    if (!selected) {
      setThread(null);
      return;
    }
    inboxThread(selected)
      .then(setThread)
      .catch((e) => tell(String(e)));
  }, [selected, tell]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "j") {
        const next = Math.min(index + 1, shown.length - 1);
        setIndex(next);
        setSelected(shown[next]?.id);
      } else if (e.key === "k") {
        const next = Math.max(index - 1, 0);
        setIndex(next);
        setSelected(shown[next]?.id);
      } else if (e.key === "e" && selected) {
        markInboxRead(selected, true)
          .then(() => Promise.all([loadMessages(), loadChannels()]))
          .catch((err) => tell(String(err)));
      } else if (/^[1-9]$/.test(e.key)) {
        const target = channels[Number(e.key) - 1];
        if (target && selected) {
          setInboxChannel(selected, target.id)
            .then(() => Promise.all([loadMessages(), loadChannels()]))
            .catch((err) => tell(String(err)));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, shown, channels, selected, loadMessages, loadChannels, tell]);

  const refresh = () => Promise.all([loadChannels(), loadMessages()]).catch((e) => tell(String(e)));

  const runSync = async () => {
    try {
      const added = await syncInbox();
      tell(added ? `${added} new replies` : "No new replies");
      await refresh();
    } catch (e) {
      tell(String(e));
    }
  };

  const runClassify = async () => {
    try {
      const count = await classifyInbox(false);
      tell(`${count} replies classified`);
      await refresh();
    } catch (e) {
      tell(String(e));
    }
  };

  const moveSelectedTo = async (channelId: string) => {
    const targets = picked.length ? picked : selected ? [selected] : [];
    if (!targets.length) {
      tell("Select at least one message");
      return;
    }
    try {
      await Promise.all(targets.map((id) => setInboxChannel(id, channelId)));
      setPicked([]);
      await refresh();
    } catch (e) {
      tell(String(e));
    }
  };

  const snoozeSelected = async () => {
    if (!selected) return;
    const until = new Date(Date.now() + 86400000).toISOString();
    try {
      await snoozeInbox(selected, until);
      await refresh();
    } catch (e) {
      tell(String(e));
    }
  };

  const suppressSelected = async () => {
    const email = thread?.from_email;
    if (!email) {
      tell("No reply selected");
      return;
    }
    try {
      await suppressLead(email, "from inbox");
      tell(`${email} suppressed`);
      await refresh();
    } catch (e) {
      tell(String(e));
    }
  };

  return (
    <>
      <Topbar
        search={{ value: query, onChange: setQuery, placeholder: "Search replies..." }}
        status={`${unread} unread`}
        action={
          <Button onClick={runSync}>
            <RefreshCw size={15} />Sync
          </Button>
        }
      />

      <section className="inboxpage">
      <header className="pagehead">
        <h2>Inbox</h2>
      </header>
      <div className="inboxtools">
        <Button variant="ghost" onClick={runClassify}>
          <Sparkles size={15} />Classify
        </Button>
        <label className="unreadtoggle">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
        {picked.length > 0 && <span className="muted">{picked.length} selected</span>}
        <select defaultValue="" onChange={(e) => e.target.value && moveSelectedTo(e.target.value)}>
          <option value="">Move to channel…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="inboxwrap">
        <aside className="channellist">
          <button className={channel === undefined ? "channel on" : "channel"} onClick={() => setChannel(undefined)}>
            <span>All replies</span>
            <i>{channels.reduce((sum, c) => sum + c.unread, 0)}</i>
          </button>
          {channels.map((c, i) => (
            <button className={channel === c.id ? `channel tint-${c.color} on` : `channel tint-${c.color}`} key={c.id} onClick={() => setChannel(c.id)}>
              <span>
                <em>{i + 1 <= 9 ? i + 1 : "·"}</em>
                {c.name}
              </span>
              {c.unread > 0 && <i>{c.unread}</i>}
            </button>
          ))}
        </aside>

        <div className="messagelist">
          {shown.length ? (
            shown.map((m, i) => (
              <div className={selected === m.id ? "messagerow on" : "messagerow"} key={m.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(m.id)}
                  onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id)))}
                />
                <button
                  className="messagebody"
                  onClick={() => {
                    setSelected(m.id);
                    setIndex(i);
                  }}
                >
                  <b>{m.subject || "(no subject)"}</b>
                  <small>
                    {m.from_email} {m.company ? `· ${m.company}` : ""}
                  </small>
                  <span className="msgmeta">
                    {m.category && <em className="catbadge">{m.category.replace(/_/g, " ")}</em>}
                    <time>{when(m.received_at)}</time>
                    {!m.read && <i className="unreaddot" />}
                  </span>
                </button>
              </div>
            ))
          ) : (
            <EmptyState text="No replies in this channel yet." action={runSync} label="Sync now" />
          )}
        </div>

        <div className="threadview">
          {thread ? (
            <>
              <div className="leadcard">
                <span className="raillabel">Lead</span>
                <b>{thread.lead.name || thread.from_email}</b>
                <small>
                  {thread.lead.title || "Role unknown"} · {thread.lead.company || "Company unknown"}
                </small>
                <p className="muted">
                  {thread.category ? `Classified as ${thread.category.replace(/_/g, " ")}` : "Unclassified"}
                  {thread.classified_by ? ` · by ${thread.classified_by}` : ""}
                  {typeof thread.confidence === "number" && thread.confidence > 0 ? ` · ${Math.round(thread.confidence * 100)}%` : ""}
                </p>
              </div>
              <article className="threadmessage">
                <h3>{thread.subject || "(no subject)"}</h3>
                <small>{thread.received_at ? new Date(thread.received_at).toLocaleString() : ""}</small>
                <p>{thread.raw_excerpt || "No preview available."}</p>
              </article>
              {thread.history.length > 0 && (
                <div className="threadhistory">
                  <span className="raillabel">Sent to this lead</span>
                  {thread.history.map((h, i) => (
                    <div key={i}>
                      <b>{h.campaign || "Campaign"}</b>
                      <small>
                        {h.status} · {when(h.created_at)}
                      </small>
                    </div>
                  ))}
                </div>
              )}
              <div className="threadactions">
                <Button onClick={() => selected && markInboxRead(selected, true).then(refresh)}>Done</Button>
                <Button variant="ghost" onClick={snoozeSelected}>
                  Snooze
                </Button>
                <Button variant="ghost" onClick={suppressSelected}>
                  Suppress
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">
              <InboxIcon size={16} /> Select a reply to see the thread and quick actions.
            </p>
          )}
        </div>
      </div>
      </section>
    </>
  );
}
