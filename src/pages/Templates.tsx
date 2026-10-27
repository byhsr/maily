import { ChevronRight, Plus } from "lucide-react";
import type { Template } from "../lib/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

type TemplatesProps = {
  templates: Template[];
  open: (kind: string) => void;
};

export function Templates({ templates, open }: TemplatesProps) {
  return (
    <section className="sheet">
      <header>
        <div>
          <label>MESSAGE LIBRARY</label>
          <h2>Templates</h2>
        </div>
        <Button onClick={() => open("template")}>
          <Plus />Create template
        </Button>
      </header>
      {templates.length ? (
        <div className="templatecards">
          {templates.map((t) => (
            <button key={t.id} onClick={() => open("template")}>
              <label>{t.name}</label>
              <h3>{t.subject}</h3>
              <p>{t.body}</p>
              <span>
                Edit template <ChevronRight />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState text="Create a template once, then reuse it across campaign sequences." action={() => open("template")} />
      )}
    </section>
  );
}
