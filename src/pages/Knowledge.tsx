import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { deleteKnowledge } from "../lib/api";
import { categoryMeta, KNOWLEDGE_CATEGORIES } from "../lib/knowledge";
import type { KnowledgeEntry } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Confirm } from "../ui/Confirm";
import { EmptyState } from "../ui/EmptyState";
import { FilterChip } from "../ui/FilterChip";
import { PageHeader } from "../ui/PageHeader";

type KnowledgeProps = {
  entries: KnowledgeEntry[];
  open: (kind: string) => void;
  onEdit: (entry: KnowledgeEntry) => void;
  reload: () => void;
  tell: (message: string) => void;
};

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

export function Knowledge({ entries, open, onEdit, reload, tell }: KnowledgeProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [kill, setKill] = useState<KnowledgeEntry | null>(null);

  const q = query.trim().toLowerCase();
  const shown = entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      (!q || entry.title.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q))
  );
  const approved = entries.filter((entry) => entry.approved).length;

  const remove = async () => {
    if (!kill) return;
    const target = kill;
    setKill(null);
    try {
      await deleteKnowledge(target.id);
      tell("Entry deleted");
      reload();
    } catch (e) {
      tell(String(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Knowledge"
        status={`${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${approved} in prompts`}
        search={{ value: query, onChange: setQuery, placeholder: "Search knowledge..." }}
        action={
          <Button onClick={() => open("knowledge")}>
            <Plus />Add
          </Button>
        }
      />

      <div className="chips">
        <FilterChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
        {KNOWLEDGE_CATEGORIES.map((entry) => {
          const count = entries.filter((item) => item.category === entry.id).length;
          return (
            <FilterChip
              key={entry.id}
              label={count ? `${entry.label} ${count}` : entry.label}
              active={category === entry.id}
              onClick={() => setCategory(entry.id)}
            />
          );
        })}
      </div>

      <section className="sheet">
        {shown.length ? (
          <div className="knowrows">
            {shown.map((entry) => (
              <div className="knowrow" key={entry.id}>
                <button className="knowmain" onClick={() => onEdit(entry)} title={categoryMeta(entry.category).hint}>
                  <i className={entry.approved ? "knowmark on" : "knowmark"} />
                  <span>
                    <b>{entry.title}</b>
                    <small>{excerpt(entry.content)}</small>
                  </span>
                  <em>{categoryMeta(entry.category).singular}</em>
                  <Badge>{entry.approved ? "in prompts" : "not used"}</Badge>
                </button>
                <button
                  type="button"
                  className="rowkill"
                  onClick={() => setKill(entry)}
                  aria-label={`Delete ${entry.title}`}
                  title="Delete entry"
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
        ) : entries.length ? (
          <Card className="emptycard">
            <p className="muted">Nothing matches this filter.</p>
          </Card>
        ) : (
          <EmptyState
            text={`Add what the models should know — ${categoryMeta(category).hint.toLowerCase()}`}
            action={() => open("knowledge")}
          />
        )}
      </section>

      {kill && (
        <Confirm
          title={`Delete “${kill.title}”?`}
          message="The entry is removed from the knowledge base and stops appearing in prompts."
          onConfirm={remove}
          onCancel={() => setKill(null)}
        />
      )}
    </>
  );
}
