import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bold,
  Braces,
  Code,
  Eye,
  EyeOff,
  Italic,
  Link2,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Plus,
  Quote,
  Trash2,
  X,
} from "lucide-react";
import { deleteDraft, saveDraft, sendMessage } from "../lib/api";
import { emailHtmlToText, previewEmailMarkdown, renderEmailMarkdown } from "../lib/email";
import { scoreMessage } from "../lib/spam";
import type { Account, Draft, FollowupDraft, InboxThread, StopRules } from "../lib/types";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { ChipsInput } from "./ChipsInput";
import { FollowupCard } from "./FollowupCard";
import { Select } from "./Select";
import { SpamChip, SpamPanel } from "./SpamScore";
import { Tooltip } from "./Tooltip";

export type ComposerProps = {
  mode: "reply" | "new";
  accounts: Account[];
  /** The message being answered: supplies the recipient, the subject and the quote. */
  thread?: InboxThread | null;
  /** A stored draft to resume instead of starting empty. */
  draft?: Draft | null;
  variant?: "docked" | "inline";
  onClose: () => void;
  onSent: (note: string) => void;
  tell: (message: string) => void;
};

/** A reply answers below the message, quoted, the way every mail client does it. */
function quoteOf(thread: InboxThread): string {
  const body = thread.body_text?.trim() || (thread.body_html ? emailHtmlToText(thread.body_html).trim() : "");
  const source = body || thread.raw_excerpt?.trim() || "";
  if (!source) return "";
  const when = thread.received_at ? new Date(thread.received_at).toLocaleString() : "";
  const from = thread.from_email ?? "them";
  const quoted = source
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `On ${when}, ${from} wrote:\n${quoted}`;
}

function subjectOf(thread?: InboxThread | null): string {
  const theirs = thread?.subject?.trim() ?? "";
  if (!theirs) return "Re:";
  return theirs.toLowerCase().startsWith("re:") ? theirs : `Re: ${theirs}`;
}

/** The wait a new follow-up starts with, and the message it starts holding. The three
 *  seeded steps are the cadence the sequence is designed around; a fourth and fifth fall
 *  back to a week apart. */
const FOLLOWUP_DEFAULTS: { delay_days: number; body_md: string }[] = [
  { delay_days: 3, body_md: "Just bumping this to the top of your inbox, {{first_name}}." },
  {
    delay_days: 4,
    body_md: "One more thought for {{company}} — happy to send a short example if that helps.",
  },
  { delay_days: 7, body_md: "Last note from me, {{first_name}}. If the timing is off, I'll leave it here." },
];

const MAX_FOLLOWUPS = 5;

const DAY = 86400000;

/** Where a dragged composer was left, or null to sit in its default corner. */
function readComposerPos(): { x: number; y: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem("mailyComposerPos") || "null");
    if (raw && typeof raw.x === "number" && typeof raw.y === "number") return { x: raw.x, y: raw.y };
  } catch {
    /* storage may be unavailable */
  }
  return null;
}

/** The date a follow-up falls due, shown the moment it is typed, at the window's opening
 *  hour. `days` is counted from the previous step, which is the original for the first. */
function dueLabel(daysFromNow: number): string {
  const at = new Date(Date.now() + daysFromNow * DAY);
  at.setHours(10, 14, 0, 0);
  const when = at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${when}, ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The message composer: the same component docked over the page for a new message and
 * inline under the message it answers. It renders through `renderEmailMarkdown`, so the
 * Preview tab and the mail that leaves are the same function, and it autosaves to Drafts
 * while it is open. A message that carries follow-ups becomes a hidden campaign, so the
 * one scheduler sends them in-thread — there is no second engine.
 */
export function Composer({ mode, accounts, thread, draft, variant = "docked", onClose, onSent, tell }: ComposerProps) {
  const [accountId, setAccountId] = useState(draft?.account_id ?? thread?.account_id ?? "");
  const [to, setTo] = useState<string[]>(() =>
    (draft?.to_email ?? (mode === "reply" ? thread?.from_email ?? "" : ""))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const [cc, setCc] = useState<string[]>(() => (draft?.cc ?? "").split(",").map((v) => v.trim()).filter(Boolean));
  const [bcc, setBcc] = useState<string[]>(() => (draft?.bcc ?? "").split(",").map((v) => v.trim()).filter(Boolean));
  const [showCc, setShowCc] = useState(cc.length > 0);
  const [showBcc, setShowBcc] = useState(bcc.length > 0);
  const [subject, setSubject] = useState(draft?.subject ?? (mode === "reply" ? subjectOf(thread) : ""));
  const [markdown, setMarkdown] = useState(draft?.markdown ?? "");
  // Held apart from what the sender types so the quoted original never gets edited by
  // accident; the preview shows it, and both halves join the message on the way out.
  const [quote, setQuote] = useState(() => (draft ? "" : mode === "reply" && thread ? quoteOf(thread) : ""));
  // The preview is live and shown alongside the writing, the way a markdown editor
  // works; the toggle only takes it away when the whole width is wanted for typing.
  const [showPreview, setShowPreview] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [draftId, setDraftId] = useState(draft?.id ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // Follow-ups: the schedule a single carries. They get a tab of their own rather than a
  // strip crammed under the message, so a follow-up has the whole body to be written in.
  const [followups, setFollowups] = useState<
    { delay_days: number; body_md: string; subject_override: string; send_date: string | null }[]
  >([]);
  const [tab, setTab] = useState<"message" | "followups">("message");
  const [stopRules, setStopRules] = useState<StopRules>({ reply: true, bounce: true, ooo: true });
  /** Whether the reasons behind the live spam score are showing. */
  const [spamOpen, setSpamOpen] = useState(false);
  const dragFrom = useRef<number | null>(null);

  // A docked composer can be dragged anywhere by its header and is left where it lands.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(readComposerPos);
  const panel = useRef<HTMLElement>(null);
  const moving = useRef<{ dx: number; dy: number } | null>(null);

  const body = useRef<HTMLTextAreaElement>(null);

  const source = quote ? `${markdown}\n\n${quote}` : markdown;
  const values = useMemo(
    () => ({
      first_name: thread?.lead.name ?? "",
      last_name: thread?.lead.last_name ?? "",
      company: thread?.lead.company ?? "",
      title: thread?.lead.title ?? "",
      website: thread?.lead.website ?? "",
      email: thread?.lead.email ?? "",
    }),
    [thread]
  );
  // Recomputed on every keystroke: this is the live preview.
  const preview = useMemo(() => previewEmailMarkdown(source, values), [source, values]);
  // The written message only — a quoted original is not the sender's words to score. The
  // variables are scored against what this lead would fill them with, so writing one is not
  // itself a fault.
  const spam = useMemo(() => scoreMessage(subject, markdown, values), [subject, markdown, values]);

  /** Writes the draft row every couple of seconds, so leaving the page loses nothing. */
  const persist = async () => {
    try {
      const id = await saveDraft({
        id: draftId || null,
        account_id: accountId || null,
        reply_to: mode === "reply" ? thread?.id ?? null : null,
        to_email: to.join(", "),
        cc: cc.join(", "),
        bcc: bcc.join(", "),
        subject,
        markdown: source,
      });
      setDraftId(id);
      setSaved(true);
    } catch {
      // Autosave is a convenience; a failure must never interrupt writing.
      setSaved(false);
    }
  };

  useEffect(() => {
    if (!markdown.trim() && !draftId) return;
    const timer = setTimeout(() => void persist(), 2000);
    return () => clearTimeout(timer);
    // `persist` closes over the same fields listed here.
  }, [markdown, quote, subject, accountId, to, cc, bcc]);

  // Dragging the header moves the whole panel; the position is clamped to the window and
  // remembered, so a composer put somewhere stays there next time.
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!moving.current) return;
      const rect = panel.current?.getBoundingClientRect();
      const width = rect?.width ?? 560;
      const height = rect?.height ?? 200;
      const maxX = Math.max(8, window.innerWidth - width - 8);
      // Keep the whole panel on screen; a drag upward still cannot push it off the top.
      const maxY = Math.max(8, window.innerHeight - height - 8);
      setPos({
        x: Math.min(Math.max(8, event.clientX - moving.current.dx), maxX),
        y: Math.min(Math.max(8, event.clientY - moving.current.dy), maxY),
      });
    };
    const up = () => {
      if (!moving.current) return;
      moving.current = null;
      setPos((current) => {
        try {
          localStorage.setItem("mailyComposerPos", JSON.stringify(current));
        } catch {
          /* storage may be unavailable */
        }
        return current;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const edit = (before: string, after: string, seed = "") => {
    const element = body.current;
    // The format tools belong to the message; on another tab they bring it back first.
    if (!element) {
      setTab("message");
      return;
    }
    const { selectionStart, selectionEnd } = element;
    const chosen = markdown.slice(selectionStart, selectionEnd) || seed;
    setMarkdown(markdown.slice(0, selectionStart) + before + chosen + after + markdown.slice(selectionEnd));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(selectionStart + before.length, selectionStart + before.length + chosen.length);
    });
  };

  const prefixLines = (marker: string) => {
    const element = body.current;
    if (!element) {
      setTab("message");
      return;
    }
    const { selectionStart, selectionEnd } = element;
    const from = markdown.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const block = markdown
      .slice(from, selectionEnd)
      .split("\n")
      .map((line) => marker + line)
      .join("\n");
    setMarkdown(markdown.slice(0, from) + block + markdown.slice(selectionEnd));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(from, from + block.length);
    });
  };

  const insert = (text: string) => edit("", "", text);

  /* ---------- Follow-ups ---------- */

  const addFollowup = () => {
    setFollowups((current) => {
      if (current.length >= MAX_FOLLOWUPS) return current;
      const preset = FOLLOWUP_DEFAULTS[current.length] ?? { delay_days: 7, body_md: "" };
      return [...current, { ...preset, subject_override: "", send_date: null }];
    });
    // The plus opens the tab it created, which is where the follow-up is written.
    setTab("followups");
  };

  const patchFollowup = (
    index: number,
    patch: Partial<{ delay_days: number; body_md: string; subject_override: string; send_date: string | null }>
  ) => setFollowups((current) => current.map((step, at) => (at === index ? { ...step, ...patch } : step)));

  const removeFollowup = (index: number) =>
    setFollowups((current) => current.filter((_, at) => at !== index));

  const moveFollowup = (from: number, to: number) =>
    setFollowups((current) => {
      if (to < 0 || to >= current.length || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  // The running day total behind each step: what the timeline and the row summarise.
  const cumulativeDays = useMemo(() => {
    let total = 0;
    return followups.map((step) => (total += Math.max(0, step.delay_days || 0)));
  }, [followups]);

  const followupSummary = followups.length
    ? `${followups.length} follow-up${followups.length === 1 ? "" : "s"} · day ${followups
        .map((_, index) => cumulativeDays[index])
        .join(", day ")}`
    : "";

  const send = async () => {
    if (!markdown.trim()) {
      tell("Write the message first");
      return;
    }
    if (mode === "new" && to.length === 0) {
      tell("Add a recipient");
      return;
    }
    if (followups.some((step) => !step.body_md.trim())) {
      tell("Every follow-up needs a message");
      setTab("followups");
      return;
    }
    setBusy(true);
    try {
      const parts = renderEmailMarkdown(source, values);
      // Each follow-up is rendered by the same function the Preview tab uses, so a
      // follow-up that is previewed is a follow-up that is sent.
      const scheduled: FollowupDraft[] = followups.map((step) => {
        const rendered = renderEmailMarkdown(step.body_md, values);
        return {
          delay_days: step.delay_days,
          // A step pinned to a day goes out that day instead of after the wait.
          send_date: step.send_date,
          body_md: step.body_md,
          body_html: rendered.html,
          body_text: rendered.text,
          subject_override: step.subject_override.trim() || null,
        };
      });
      const sent = await sendMessage({
        account_id: accountId || null,
        lead_id: thread?.lead.id ?? null,
        to: mode === "new" ? to.join(", ") : null,
        cc: cc.length ? cc : null,
        bcc: bcc.length ? bcc : null,
        subject,
        markdown: source,
        html: parts.html,
        text: parts.text,
        reply_to: mode === "reply" ? thread?.id ?? null : null,
        draft_id: draftId || null,
        followups: scheduled,
        stop_rules: stopRules,
      });
      onSent(
        sent.followups
          ? `Sent to ${sent.to} · ${sent.followups} follow-up${sent.followups === 1 ? "" : "s"} scheduled`
          : `Sent to ${sent.to}`
      );
    } catch (error) {
      tell(String(error));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (draftId) {
      try {
        await deleteDraft(draftId);
      } catch (error) {
        tell(String(error));
      }
    }
    onClose();
  };

  // Only the docked, unexpanded panel is dragged; expanded fills the window regardless.
  const draggable = variant === "docked" && !expanded;

  return (
    <section
      ref={panel}
      className={`composer ${variant}${expanded ? " expanded" : ""}`}
      aria-label={mode === "reply" ? "Reply" : "New message"}
      style={draggable && pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined}
      onKeyDown={(event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key === "Enter") {
          event.preventDefault();
          void send();
        } else if (mod && event.shiftKey && event.key.toLowerCase() === "p") {
          event.preventDefault();
          setShowPreview((shown) => !shown);
        } else if (mod && event.key.toLowerCase() === "b") {
          event.preventDefault();
          edit("**", "**", "bold");
        } else if (mod && event.key.toLowerCase() === "i") {
          event.preventDefault();
          edit("*", "*", "italic");
        } else if (mod && event.key.toLowerCase() === "k") {
          event.preventDefault();
          edit("[", "](https://)", "text");
        }
      }}
    >
      <header
        className={`composerhead${draggable ? " draggable" : ""}`}
        onMouseDown={(event) => {
          if (!draggable) return;
          // A press on the expand or close button is a click, not the start of a drag.
          if ((event.target as HTMLElement).closest("button")) return;
          const rect = panel.current?.getBoundingClientRect();
          if (!rect) return;
          moving.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
          event.preventDefault();
        }}
        onDoubleClick={() => {
          // Double-click puts it back in its corner and forgets where it was.
          if (!draggable) return;
          setPos(null);
          try {
            localStorage.removeItem("mailyComposerPos");
          } catch {
            /* storage may be unavailable */
          }
        }}
        title={draggable ? "Drag to move — double-click to reset" : undefined}
      >
        <span className="raillabel">{mode === "reply" ? `Reply to ${thread?.from_email ?? ""}` : "New message"}</span>
        <div className="composerheadtools">
          <Tooltip label={expanded ? "Collapse" : "Expand"}>
            <button type="button" className="btn-icon" onClick={() => setExpanded(!expanded)}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </Tooltip>
          <Tooltip label="Close">
            <button type="button" className="btn-icon" onClick={onClose}>
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="composerrow">
        <span className="composerlabel">From</span>
        <Select
          ghost
          label="Send from"
          value={accountId}
          options={accounts.map((account) => ({ value: account.id, label: account.email }))}
          placeholder={accounts.length ? "Choose an account" : "No account connected"}
          onChange={setAccountId}
        />
        <span className="composerlinks">
          {!showCc && (
            <button type="button" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
          {!showBcc && (
            <button type="button" onClick={() => setShowBcc(true)}>
              Bcc
            </button>
          )}
        </span>
      </div>

      <div className="composerrow">
        <span className="composerlabel">To</span>
        <ChipsInput values={to} onChange={setTo} label="To" placeholder="someone@company.com" />
      </div>

      {showCc && (
        <div className="composerrow">
          <span className="composerlabel">Cc</span>
          <ChipsInput values={cc} onChange={setCc} label="Cc" />
        </div>
      )}
      {showBcc && (
        <div className="composerrow">
          <span className="composerlabel">Bcc</span>
          <ChipsInput values={bcc} onChange={setBcc} label="Bcc" />
        </div>
      )}

      <div className="composerrow">
        <input
          className="composersubject"
          value={subject}
          placeholder="Subject"
          aria-label="Subject"
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>

      <div className="composerbody">
        <div className="composerbodyhead">
          <div className="composertabs" role="tablist" aria-label="Composer">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "message"}
              className={`composertab${tab === "message" ? " on" : ""}`}
              onClick={() => setTab("message")}
            >
              Message
            </button>
            {(followups.length > 0 || tab === "followups") && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "followups"}
                className={`composertab${tab === "followups" ? " on" : ""}`}
                title={followupSummary || undefined}
                onClick={() => setTab("followups")}
              >
                Follow-ups{followups.length ? ` (${followups.length})` : ""}
              </button>
            )}
            {followups.length < MAX_FOLLOWUPS && (
              // The plus is what creates the tab: it adds a step and opens it.
              <Tooltip label="Add a follow-up">
                <button type="button" className="composertabadd" aria-label="Add a follow-up" onClick={addFollowup}>
                  <Plus size={14} />
                </button>
              </Tooltip>
            )}
          </div>

          {tab === "message" && (
            <div className="composerheadright">
              <SpamChip score={spam} active={spamOpen} onClick={() => setSpamOpen((open) => !open)} />
              <button
                type="button"
                className={`composerpreviewtoggle${showPreview ? " on" : ""}`}
                aria-pressed={showPreview}
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
                {showPreview ? "Hide preview" : "Preview"}
              </button>
            </div>
          )}
        </div>

        {/* The score is only worth showing with its reasons, so they sit right under it. */}
        {tab === "message" && spamOpen && (
          <div className="spampanel">
            <SpamPanel score={spam} />
          </div>
        )}

        {tab === "message" ? (
          <div className="composerpanes">
            <textarea
              ref={body}
              className="composertext"
              value={markdown}
              aria-label="Message"
              placeholder="Write in markdown..."
              onChange={(event) => setMarkdown(event.target.value)}
            />

            {showPreview && (
              <div
                className="composerpreview mdarticle"
                aria-label="What the recipient will see"
                dangerouslySetInnerHTML={{ __html: preview }}
              />
            )}
          </div>
        ) : (
          // The follow-ups get the whole body: one timeline, the step cards and the stop
          // rules, with room to write rather than a strip crammed under the message.
          <div className="fufpane">
            <div className="fuftimeline" aria-label="Follow-up timeline">
              <span className="fufdot">
                <i />
                Now
              </span>
              {cumulativeDays.map((day, index) => (
                <span className="fufdot" key={index}>
                  <i />
                  Day {day}
                </span>
              ))}
            </div>

            {followups.length === 0 && (
              <p className="muted fufblank">
                No follow-ups yet. Add one and it sends in this thread once the wait is up.
              </p>
            )}

            {followups.map((step, index) => (
              <FollowupCard
                key={index}
                step={step}
                label={`Follow-up ${index + 1}`}
                subject={subject}
                dueLabel={dueLabel(cumulativeDays[index])}
                onChange={(patch) => patchFollowup(index, patch)}
                onRemove={() => removeFollowup(index)}
                onDragStart={() => (dragFrom.current = index)}
                onDrop={() => {
                  if (dragFrom.current !== null) moveFollowup(dragFrom.current, index);
                  dragFrom.current = null;
                }}
              />
            ))}

            {followups.length > 0 && (
              <div className="fufrules">
                <span className="raillabel">Stop rules</span>
                <label className="fufrule">
                  <Checkbox checked={stopRules.reply} onChange={(on) => setStopRules((r) => ({ ...r, reply: on }))} label="Stop on reply" />
                  Stop on reply
                </label>
                <label className="fufrule">
                  <Checkbox
                    checked={stopRules.bounce}
                    onChange={(on) => setStopRules((r) => ({ ...r, bounce: on }))}
                    label="Stop on bounce or unsubscribe"
                  />
                  Stop on bounce / unsubscribe
                </label>
                <label className="fufrule">
                  <Checkbox
                    checked={stopRules.ooo}
                    onChange={(on) => setStopRules((r) => ({ ...r, ooo: on }))}
                    label="Pause on out-of-office"
                  />
                  Pause on out-of-office
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="composerfoot">
        <div className="composerformat">
          <Tooltip label="Bold">
            <button type="button" className="btn-icon" onClick={() => edit("**", "**", "bold")}>
              <Bold size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Italic">
            <button type="button" className="btn-icon" onClick={() => edit("*", "*", "italic")}>
              <Italic size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Link">
            <button type="button" className="btn-icon" onClick={() => edit("[", "](https://)", "text")}>
              <Link2 size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Bullet list">
            <button type="button" className="btn-icon" onClick={() => prefixLines("- ")}>
              <List size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Numbered list">
            <button type="button" className="btn-icon" onClick={() => prefixLines("1. ")}>
              <ListOrdered size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Quote">
            <button type="button" className="btn-icon" onClick={() => prefixLines("> ")}>
              <Quote size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Code">
            <button type="button" className="btn-icon" onClick={() => edit("`", "`", "code")}>
              <Code size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Insert a variable">
            <button type="button" className="btn-icon" onClick={() => insert("{{first_name}}")}>
              <Braces size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Insert the company variable">
            <button type="button" className="btn-icon" onClick={() => insert("{{company}}")}>
              <span className="composervar">company</span>
            </button>
          </Tooltip>
        </div>

        <div className="composerfootright">
          {saved && !busy && <span className="composersaved">Saved</span>}
          <Button variant="ghost" onClick={discard} disabled={busy}>
            Discard
          </Button>
          <span className="composerhint">Cmd+Enter</span>
          <Button onClick={send} disabled={busy || !markdown.trim()}>
            {busy
              ? "Sending..."
              : followups.length
                ? `Send + schedule ${followups.length} follow-up${followups.length === 1 ? "" : "s"}`
                : mode === "reply"
                  ? "Send reply"
                  : "Send"}
          </Button>
        </div>
      </footer>
    </section>
  );
}
