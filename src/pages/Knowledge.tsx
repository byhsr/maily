import { Plus } from "lucide-react";
import { useState } from "react";
import { categoryMeta, KNOWLEDGE_CATEGORIES } from "../lib/knowledge";
import type { KnowledgeEntry } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { FilterChip } from "../ui/FilterChip";
import { Topbar } from "../ui/Topbar";

type KnowledgeProps = {
  entries: KnowledgeEntry[];
  open: (kind: string) => void;
  onEdit: (entry: KnowledgeEntry) => void;
};

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

export function Knowledge({ entries, open, onEdit }: KnowledgeProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const q = query.trim().toLowerCase();
  const shown = entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      (!q || entry.title.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q))
  );
  const approved = entries.filter((entry) => entry.approved).length;

  return (
    <>
      <Topbar
        search={{ value: query, onChange: setQuery, placeholder: "Search knowledge..." }}
        status={`${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${approved} in prompts`}
        action={
          <Button onClick={() => open("knowledge")}>
            <Plus />Add
          </Button>
        }
      />

      <section className="sheet">
        <header>
          <h2>Knowledge</h2>
          <div className="actions">
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
        </header>

        {shown.length ? (
          <div className="knowrows">
            {shown.map((entry) => (
              <button key={entry.id} onClick={() => onEdit(entry)} title={categoryMeta(entry.category).hint}>
                <i className={entry.approved ? "knowmark on" : "knowmark"} />
                <span>
                  <b>{entry.title}</b>
                  <small>{excerpt(entry.content)}</small>
                </span>
                <em>{categoryMeta(entry.category).singular}</em>
                <Badge>{entry.approved ? "in prompts" : "not used"}</Badge>
              </button>
            ))}
          </div>
        ) : entries.length ? (
          <p className="muted">Nothing matches this filter.</p>
        ) : (
          <EmptyState
            text={`Add what the models should know — ${categoryMeta(category).hint.toLowerCase()}`}
            action={() => open("knowledge")}
          />
        )}
      </section>
    </>
  );
}
