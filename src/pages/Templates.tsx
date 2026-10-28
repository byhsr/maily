import { useState } from "react";
import { ChevronRight, Plus, Sparkles } from "lucide-react";
import { seedTemplates } from "../lib/api";
import type { Template } from "../lib/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Topbar } from "../ui/Topbar";

const PURPOSE_LABEL: Record<string, string> = {
  first_touch: "First touch",
  follow_up: "Follow-up",
  breakup: "Breakup",
  reply_positive: "Reply — positive",
  reply_question: "Reply — question",
  reply_not_now: "Reply — not now",
};

type TemplatesProps = {
  templates: Template[];
  open: (kind: string) => void;
  onEdit: (template: Template) => void;
  reload: () => void;
  tell: (message: string) => void;
};

export function Templates({ templates, open, onEdit, reload, tell }: TemplatesProps) {
  const [query, setQuery] = useState("");

  const seed = async () => {
    try {
      const count = await seedTemplates();
      tell(`${count} starter templates added`);
      reload();
    } catch (e) {
      tell(String(e));
    }
  };

  const q = query.trim().toLowerCase();
  const shown = templates.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q)
  );

  return (
    <>
      <Topbar
        search={{ value: query, onChange: setQuery, placeholder: "Search templates..." }}
        status={`${templates.length} template${templates.length === 1 ? "" : "s"}`}
        action={
          <Button onClick={() => open("template")}>
            <Plus />New
          </Button>
        }
      />

      <section className="sheet">
        <header>
          <h2>Templates</h2>
          <div className="actions">
            {templates.length === 0 && (
              <Button variant="ghost" onClick={seed}>
                <Sparkles />Load starters
              </Button>
            )}
          </div>
        </header>
        {shown.length ? (
          <div className="templatecards">
            {shown.map((t) => (
              <button key={t.id} onClick={() => onEdit(t)}>
                <label>{PURPOSE_LABEL[t.purpose] ?? t.purpose}</label>
                <h3>{t.subject}</h3>
                <p>{t.body}</p>
                <span>
                  {t.name} · Edit <ChevronRight />
                </span>
              </button>
            ))}
          </div>
        ) : templates.length ? (
          <p className="muted">No templates match this search.</p>
        ) : (
          <EmptyState text="Start from the starter library, or write a template once and reuse it." action={() => open("template")} />
        )}
      </section>
    </>
  );
}
