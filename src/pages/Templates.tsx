import { ChevronRight, Plus, Sparkles } from "lucide-react";
import { seedTemplates } from "../lib/api";
import type { Template } from "../lib/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

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
  const seed = async () => {
    try {
      const count = await seedTemplates();
      tell(`${count} starter templates added`);
      reload();
    } catch (e) {
      tell(String(e));
    }
  };

  return (
    <section className="sheet">
      <header>
        <div>
          <label>MESSAGE LIBRARY</label>
          <h2>Templates</h2>
        </div>
        <div className="actions">
          {templates.length === 0 && (
            <Button variant="ghost" onClick={seed}>
              <Sparkles />Load starter library
            </Button>
          )}
          <Button onClick={() => open("template")}>
            <Plus />Create template
          </Button>
        </div>
      </header>
      {templates.length ? (
        <div className="templatecards">
          {templates.map((t) => (
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
      ) : (
        <EmptyState text="Start from the starter library, or write a template once and reuse it." action={() => open("template")} />
      )}
    </section>
  );
}
