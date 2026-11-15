import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { deleteTemplate, messageVariables, saveTemplate } from "../lib/api";
import { previewEmailMarkdown } from "../lib/email";
import { missingVariables, renderVariables } from "../lib/logic";
import { LEVEL_LABEL, scoreMessage } from "../lib/spam";
import type { Lead, Template } from "../lib/types";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SpamChip } from "../ui/SpamScore";

const PURPOSES = [
  ["first_touch", "First touch"],
  ["follow_up", "Follow-up"],
  ["breakup", "Breakup"],
  ["reply_positive", "Reply — positive"],
  ["reply_question", "Reply — question"],
  ["reply_not_now", "Reply — not now"],
] as const;

type TemplateDrawerProps = {
  close: () => void;
  reload: () => void;
  tell: (message: string) => void;
  leads: Lead[];
  template?: Template;
};

/**
 * The template editor, for one reusable message. A sequence lives on the campaign that
 * sends it, so this is deliberately not a sequence builder: it writes one subject and one
 * body, and a campaign that copies it keeps its own copy from then on.
 */
export function TemplateDrawer({ close, reload, tell, leads, template }: TemplateDrawerProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [purpose, setPurpose] = useState(template?.purpose ?? "first_touch");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [leadIndex, setLeadIndex] = useState(-1);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const lead = leadIndex >= 0 ? leads[leadIndex] : undefined;
  const custom = lead?.custom_fields ?? {};
  const values: Record<string, string | undefined> = {
    ...Object.fromEntries(Object.entries(custom).map(([key, value]) => [key, value == null ? undefined : String(value)])),
    first_name: lead?.first_name,
    company: lead?.company,
    title: lead?.title,
    email: lead?.email,
    list_name: lead?.list_name,
  };

  /** What a message may interpolate, as the one place that resolves it defines it. Asked
   *  for rather than listed here, so a chip can never offer something that sends blank. */
  const [resolvable, setResolvable] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    messageVariables()
      .then((found) => {
        if (live) setResolvable([...found.standard, ...found.custom]);
      })
      .catch(() => setResolvable([]));
    return () => {
      live = false;
    };
  }, []);

  // The lead's own columns, then any header the leads on hand carry — so a column from a
  // list that has not been imported yet is still offered.
  const variables = useMemo(() => {
    const keys = new Set(resolvable);
    for (const row of leads) for (const key of Object.keys(row.custom_fields ?? {})) keys.add(key);
    return [...keys].sort();
  }, [resolvable, leads]);

  const insertVariable = (key: string) => {
    const token = `{{${key}}}`;
    const field = bodyRef.current;
    if (!field) {
      setBody((current) => current + token);
      return;
    }
    const start = field.selectionStart ?? body.length;
    const end = field.selectionEnd ?? start;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    if (!name.trim()) {
      tell("Give the template a name");
      return;
    }
    if (!subject.trim() || !body.trim()) {
      tell("A template needs a subject and a message");
      return;
    }
    setBusy(true);
    try {
      await saveTemplate({
        id: template?.id ?? null,
        name: name.trim(),
        subject: subject.trim(),
        body,
        purpose,
        variants: template?.variants ?? [],
      });
      tell(template ? "Template updated" : "Template added to your library");
      reload();
      close();
    } catch (error) {
      tell(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirming(false);
    if (!template) return;
    try {
      await deleteTemplate(template.id);
      tell("Template deleted");
      reload();
      close();
    } catch (error) {
      tell(String(error));
    }
  };

  const subjectPreview = renderVariables(subject, values);
  const bodyPreview = previewEmailMarkdown(body, values);
  const spam = scoreMessage(subject, body, values);
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const links = (body.match(/https?:\/\//g) ?? []).length;
  const optOut = /(stop|unsubscribe|opt out)/i.test(body);
  const unresolved = missingVariables(`${subject}\n${body}`, values);
  const flags = [
    { ok: words >= 30 && words <= 120, label: `${words} words (aim 30–120)` },
    { ok: links <= 1, label: `${links} link${links === 1 ? "" : "s"} (max 1)` },
    { ok: optOut, label: optOut ? "Has an opt-out line" : "Missing an opt-out line" },
    { ok: spam.score < 35, label: `Spam score ${spam.score} — ${LEVEL_LABEL[spam.level]}` },
    {
      ok: unresolved.length === 0,
      label: unresolved.length ? `No fallback for: ${unresolved.join(", ")}` : "Every variable resolves",
    },
  ];

  return (
    <div className="seqbuilder">
      <div className="seqmain">
        <div className="seqhead">
          <label className="seqname">
            <span>Template</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Founder intro — concise"
            />
          </label>
          <div className="seqheadmeta">
            <Select
              ghost
              className="seqpurpose"
              label="Purpose"
              value={purpose}
              options={PURPOSES.map(([value, label]) => ({ value, label }))}
              onChange={setPurpose}
            />
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : template ? "Save changes" : "Save template"}
            </Button>
            {template && (
              <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
                <Trash2 size={15} />
                Delete
              </Button>
            )}
          </div>
        </div>

        <div className="seqsteps">
          <section className="seqstep on">
            <Input
              className="seqsubject"
              value={subject}
              placeholder="Subject — a quick idea for {{company}}"
              aria-label="Subject"
              onChange={(event) => setSubject(event.target.value)}
            />
            <textarea
              ref={bodyRef}
              className="seqbody"
              value={body}
              placeholder={"Hi {{first_name|there}},\n\nI noticed {{company}}…\n\n— {{sender_name}}"}
              aria-label="Message"
              onChange={(event) => setBody(event.target.value)}
            />
            <div className="varchips">
              {variables.map((variable) => (
                <button type="button" className="chip" key={variable} onClick={() => insertVariable(variable)}>
                  {`{{${variable}}}`}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      <aside className="seqaside">
        <div className="seqpreviewhead">
          <span className="raillabel">Preview</span>
          <Select
            ghost
            label="Preview lead"
            value={String(leadIndex)}
            options={[
              { value: "-1", label: "No lead selected" },
              ...leads.map((row, index) => ({ value: String(index), label: row.email })),
            ]}
            onChange={(value) => setLeadIndex(Number(value))}
          />
        </div>

        <div className="seqpreview">
          <p className="seqsubjectview">{subjectPreview || "Subject preview"}</p>
          <div
            className="mdarticle seqbodyview"
            dangerouslySetInnerHTML={{ __html: bodyPreview || "<p>Message preview</p>" }}
          />
        </div>

        <div className="seqflags">
          <SpamChip score={spam} />
          <ul>
            {flags.map((flag) => (
              <li key={flag.label} className={flag.ok ? "ok" : "bad"}>
                <i className="seqdot" />
                {flag.label}
              </li>
            ))}
          </ul>
        </div>
        <p className="seqhint">
          A campaign copies this message when you pick it, so editing the template later never changes a campaign
          that already uses it.
        </p>
      </aside>

      {confirming && (
        <Confirm
          title={`Delete “${name || "this template"}”?`}
          message="It is removed from your library. Campaigns already built from it keep the copy they took."
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
