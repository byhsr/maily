import { useMemo, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { deleteLead, deleteLeadList } from "../lib/api";
import { importLeads } from "../lib/leadImport";
import type { Lead } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";

type LeadsProps = {
  leads: Lead[];
  open: (kind: string) => void;
  onEdit: (lead: Lead) => void;
  reload: () => void;
  tell: (message: string) => void;
};

/** One person, as the sheet shows them whichever list they belong to. */
function LeadRow({
  lead,
  onEdit,
  onKill,
}: {
  lead: Lead;
  onEdit: (lead: Lead) => void;
  onKill: (lead: Lead) => void;
}) {
  return (
    <div className="leadrow">
      <button className="leadmain" onClick={() => onEdit(lead)}>
        <b>{(lead.first_name || lead.email)[0]}</b>
        <span>
          {lead.first_name || lead.email}
          <small>
            {lead.company || "Needs enrichment"}
            {lead.list_name ? ` · ${lead.list_name}` : ""}
          </small>
        </span>
        <em>{lead.title || "Research pending"}</em>
        <Badge>{lead.status}</Badge>
      </button>
      <button
        type="button"
        className="rowkill"
        onClick={() => onKill(lead)}
        aria-label={`Delete ${lead.email}`}
        title="Delete lead"
      >
        <Trash2 />
      </button>
    </div>
  );
}

/** One imported file's people, as a single row holding its count and the way in. */
function ListRow({
  name,
  count,
  onOpen,
  onKill,
}: {
  name: string;
  count: number;
  onOpen: () => void;
  onKill: () => void;
}) {
  return (
    <div className="leadrow">
      <button className="leadmain" onClick={onOpen}>
        <b>{name.slice(0, 1).toUpperCase()}</b>
        <span>
          {name}
          <small>Imported list</small>
        </span>
        <em>
          {count} {count === 1 ? "lead" : "leads"}
        </em>
        <ChevronRight size={14} />
      </button>
      <button
        type="button"
        className="rowkill"
        onClick={onKill}
        aria-label={`Delete the ${name} list`}
        title="Delete this list"
      >
        <Trash2 />
      </button>
    </div>
  );
}

/**
 * Leads, told apart by how they arrived. A file arrives whole, so it is a list: one row
 * holding its count and the way in, because two thousand imported people are a list and not
 * two thousand rows. Someone typed in one at a time is their own row.
 *
 * A search looks through everyone, lists included — asking for a person has to find them
 * wherever they are — and opening a list or running a search narrows the sheet to those
 * people, with the way back above them.
 */
export function Leads({ leads, open, onEdit, reload, tell }: LeadsProps) {
  const [query, setQuery] = useState("");
  const [listName, setListName] = useState("");
  const [listFilter, setListFilter] = useState("");
  const [killLead, setKillLead] = useState<Lead | null>(null);
  const [killList, setKillList] = useState<string | null>(null);

  const importFile = async (file: File) => {
    try {
      // Each file becomes a list of its own, named after it: two sheets imported one after
      // the other are two lists in a campaign's audience picker, not one that grew. A typed
      // name overrides that, which is how a file is deliberately added to a list — so the
      // box is cleared after every import and cannot carry over by accident.
      const target = listName.trim() || file.name.replace(/\.[^.]+$/, "").trim() || "Imported";
      const n = await importLeads(file, target);
      setListName("");
      tell(`${n} leads imported into “${target}”; duplicates were updated.`);
      reload();
    } catch (e) {
      tell(`Could not import file: ${String(e)}`);
    }
  };

  /** The imported lists, one row each: what the people in a file add up to. */
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of leads) {
      if (l.source !== "import") continue;
      const name = l.list_name || "Unassigned";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [leads]);

  const q = query.trim().toLowerCase();
  const matches = (l: Lead) =>
    !q ||
    l.email.toLowerCase().includes(q) ||
    (l.first_name || "").toLowerCase().includes(q) ||
    (l.company || "").toLowerCase().includes(q);

  /** A list opened, or a search running: either way the sheet narrows to people. */
  const opened = listFilter
    ? {
        label: listFilter,
        rows: leads.filter((l) => (l.list_name || "Unassigned") === listFilter && matches(l)),
      }
    : q
      ? { label: `Matching “${query.trim()}”`, rows: leads.filter(matches) }
      : null;
  const individuals = leads.filter((l) => l.source !== "import" && matches(l));

  const removeLead = async () => {
    if (!killLead) return;
    const target = killLead;
    setKillLead(null);
    try {
      await deleteLead(target.id);
      tell(`${target.email} deleted`);
      reload();
    } catch (e) {
      tell(String(e));
    }
  };

  const removeList = async () => {
    if (!killList) return;
    const target = killList;
    setKillList(null);
    try {
      const n = await deleteLeadList(target);
      tell(`${n} lead${n === 1 ? "" : "s"} removed from “${target}”`);
      if (listFilter === target) setListFilter("");
      reload();
    } catch (e) {
      tell(String(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Leads"
        status={`${leads.length} lead${leads.length === 1 ? "" : "s"}`}
        search={{ value: query, onChange: setQuery, placeholder: "Search leads..." }}
        tools={
          <>
            <Input
              className="listname"
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="List name — blank names it after the file"
              aria-label="Lead list name"
            />
            <label className="btn-secondary">
              Import
              <Input type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            </label>
          </>
        }
        action={
          <Button onClick={() => open("lead")}>
            <Plus />Add
          </Button>
        }
      />

      <section className="sheet">
        {opened ? (
          <>
            <div className="sheetlead">
              <button
                type="button"
                className="link"
                onClick={() => {
                  setListFilter("");
                  setQuery("");
                }}
              >
                ← All leads
              </button>
              <span className="raillabel">{opened.label}</span>
            </div>
            {opened.rows.length ? (
              <div className="leadrows">
                {opened.rows.map((l) => (
                  <LeadRow key={l.id} lead={l} onEdit={onEdit} onKill={setKillLead} />
                ))}
              </div>
            ) : (
              <p className="muted">Nobody here matches that.</p>
            )}
          </>
        ) : (
          <>
            {groups.length > 0 && (
              <div className="leadrows">
                {groups.map((group) => (
                  <ListRow
                    key={group.name}
                    name={group.name}
                    count={group.count}
                    onOpen={() => setListFilter(group.name)}
                    onKill={() => setKillList(group.name)}
                  />
                ))}
              </div>
            )}

            {individuals.length > 0 && (
              <>
                <div className="sheetlead">
                  <span className="raillabel">Added one at a time</span>
                </div>
                <div className="leadrows">
                  {individuals.map((l) => (
                    <LeadRow key={l.id} lead={l} onEdit={onEdit} onKill={setKillLead} />
                  ))}
                </div>
              </>
            )}

            {groups.length === 0 && individuals.length === 0 && (
              <EmptyState text="Import a CSV/XLSX or add one prospect to begin." action={() => open("lead")} />
            )}
          </>
        )}
      </section>

      {killLead && (
        <Confirm
          title={`Delete ${killLead.email}?`}
          message="The lead is removed from this workspace, along with any campaign enrolment and drafts."
          onConfirm={removeLead}
          onCancel={() => setKillLead(null)}
        />
      )}
      {killList && (
        <Confirm
          title={`Delete the “${killList}” list?`}
          message={`All ${groups.find((g) => g.name === killList)?.count ?? 0} leads in it are removed. This cannot be undone.`}
          onConfirm={removeList}
          onCancel={() => setKillList(null)}
        />
      )}
    </>
  );
}
