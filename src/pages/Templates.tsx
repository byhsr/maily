import { useMemo, useState } from "react";
import { ChevronRight, Plus, Sparkles } from "lucide-react";
import { seedTemplates } from "../lib/api";
import type { Template } from "../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader } from "../ui/PageHeader";

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

/** The library of reusable messages. A campaign copies one when it picks it, so nothing
 *  here is a live reference — which is why this page is a flat list and not a builder. */
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
  const shown = useMemo(
    () =>
      templates.filter(
        (template) =>
          !q ||
          template.name.toLowerCase().includes(q) ||
          template.subject.toLowerCase().includes(q) ||
          template.body.toLowerCase().includes(q)
      ),
    [templates, q]
  );

  return (
    <>
      <PageHeader
        title="Templates"
        status={`${shown.length} message${shown.length === 1 ? "" : "s"}`}
        search={{ value: query, onChange: setQuery, placeholder: "Search templates..." }}
        tools={
          templates.length === 0 ? (
            <Button variant="secondary" onClick={seed}>
              <Sparkles />Load starters
            </Button>
          ) : null
        }
        action={
          <Button onClick={() => open("template")}>
            <Plus />New template
          </Button>
        }
      />

      <section className="sheet">
        {shown.length ? (
          <div className="templatecards">
            {shown.map((template) => (
              <button key={template.id} onClick={() => onEdit(template)}>
                <div className="seqcardhead">
                  <i className="chip">{PURPOSE_LABEL[template.purpose] ?? template.purpose}</i>
                </div>
                <h3>{template.subject || "(no subject)"}</h3>
                <p>{template.body || "Empty template"}</p>
                <span className="seqcardfoot">
                  {template.name} · Edit <ChevronRight />
                </span>
              </button>
            ))}
          </div>
        ) : templates.length ? (
          <Card className="emptycard">
            <p className="muted">No templates match this search.</p>
          </Card>
        ) : (
          <EmptyState
            text="Write one reusable message, then drop it into any campaign — the campaign keeps its own copy."
            action={() => open("template")}
          />
        )}
      </section>
    </>
  );
}
