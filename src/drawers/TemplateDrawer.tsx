import { Check } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { saveTemplate } from "../lib/api";
import { missingVariables, renderVariables } from "../lib/logic";
import type { Lead, Template } from "../lib/types";
import { Button } from "../ui/Button";

const PURPOSES = [
  ["first_touch", "First touch"],
  ["follow_up", "Follow-up"],
  ["breakup", "Breakup"],
  ["reply_positive", "Reply — positive"],
  ["reply_question", "Reply — question"],
  ["reply_not_now", "Reply — not now"],
] as const;

const VARIABLES = ["first_name", "last_name", "company", "email", "sender_name", "signal", "topic", "proof_point"];

type TemplateDrawerProps = {
  close: () => void;
  reload: () => void;
  tell: (message: string) => void;
  leads: Lead[];
  template?: Template;
};

export function TemplateDrawer({ close, reload, tell, leads, template }: TemplateDrawerProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [purpose, setPurpose] = useState(template?.purpose ?? "first_touch");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [leadIndex, setLeadIndex] = useState(-1);

  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastField = useRef<"subject" | "body">("body");

  const insertVariable = (key: string) => {
    const token = `{{${key}}}`;
    const field = lastField.current === "subject" ? subjectRef.current : bodyRef.current;
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const next = field.value.slice(0, start) + token + field.value.slice(end);
    if (lastField.current === "subject") setSubject(next);
    else setBody(next);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await saveTemplate({ name, subject, body, purpose, variants: template?.variants ?? [] });
      tell(template ? "Template updated" : "Template added to your library");
      reload();
      close();
    } catch (x) {
      tell(String(x));
    }
  };

  const lead = leadIndex >= 0 ? leads[leadIndex] : undefined;
  const values: Record<string, string | undefined> = {
    first_name: lead?.first_name,
    company: lead?.company,
    email: lead?.email,
  };
  const unresolved = missingVariables(`${subject}\n${body}`, {});

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const links = (body.match(/https?:\/\//g) ?? []).length;
  const shouty = /\b[A-Z]{4,}\b/.test(body);
  const optOut = /(stop|unsubscribe|opt out)/i.test(body);
  const checks = [
    { ok: words >= 30 && words <= 120, label: `${words} words (aim 30–120)` },
    { ok: links <= 1, label: `${links} link${links === 1 ? "" : "s"} (max 1)` },
    { ok: !shouty, label: shouty ? "Contains ALL-CAPS shouting" : "No ALL-CAPS shouting" },
    { ok: optOut, label: optOut ? "Has an opt-out line" : "Missing an opt-out line" },
    {
      ok: unresolved.length === 0,
      label: unresolved.length ? `No fallback for: ${unresolved.join(", ")}` : "Every variable has a value or fallback",
    },
  ];

  return (
    <form className="templatefull" onSubmit={save}>
      <div className="tsplit">
        <div className="teditor">
          <label>
            Template name
            <input name="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Founder intro — concise" />
          </label>
          <label>
            Purpose
            <select name="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSES.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Email subject
            <input
              name="subject"
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onFocus={() => (lastField.current = "subject")}
              required
              placeholder="A quick idea for {{company}}"
            />
          </label>
          <label>
            Message
            <textarea
              name="body"
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onFocus={() => (lastField.current = "body")}
              required
              placeholder={"Hi {{first_name|there}},\n\nI noticed {{company}}…\n\n— {{sender_name}}"}
            />
          </label>
          <div className="varchips">
            {VARIABLES.map((v) => (
              <button type="button" className="chip" key={v} onClick={() => insertVariable(v)}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <p className="muted">
            Plain text first. Use any imported CSV/XLSX header, and add a fallback with <code>{"{{first_name|there}}"}</code> so a
            missing value never blocks a send.
          </p>
        </div>
        <div className="tpreview">
          <div className="tpreviewhead">
            <label>Preview</label>
            <select value={leadIndex} onChange={(e) => setLeadIndex(Number(e.target.value))}>
              <option value={-1}>No lead selected</option>
              {leads.map((l, i) => (
                <option value={i} key={l.id}>
                  {l.email}
                </option>
              ))}
            </select>
          </div>
          <h4>{renderVariables(subject, values) || "Subject preview"}</h4>
          <pre>{renderVariables(body, values) || "Message preview"}</pre>
          <ul className="checklist">
            {checks.map((c) => (
              <li className={c.ok ? "ok" : "bad"} key={c.label}>
                {c.ok ? "✓" : "✗"} {c.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Button>
        Save reusable template <Check />
      </Button>
    </form>
  );
}
