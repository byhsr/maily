import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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

export function Leads({ leads, open, onEdit, reload, tell }: LeadsProps) {
  const [query, setQuery] = useState("");
  const [listName, setListName] = useState("Imported");
  const [listFilter, setListFilter] = useState("");
  const [killLead, setKillLead] = useState<Lead | null>(null);
  const [killList, setKillList] = useState<string | null>(null);

  const importFile = async (file: File) => {
    try {
      const target = listName.trim() || "Imported";
      const n = await importLeads(file, target);
      tell(`${n} leads imported into “${target}”; duplicates were updated.`);
      reload();
    } catch (e) {
      tell(`Could not import file: ${String(e)}`);
    }
  };

  const lists = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of leads) {
      const name = l.list_name || "Unassigned";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [leads]);

  const q = query.trim().toLowerCase();
  const shown = leads.filter(
    (l) =>
      (!listFilter || (l.list_name || "Unassigned") === listFilter) &&
      (!q ||
        l.email.toLowerCase().includes(q) ||
        (l.first_name || "").toLowerCase().includes(q) ||
        (l.company || "").toLowerCase().includes(q))
  );

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
              placeholder="List name"
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

        {lists.length > 1 && (
          <div className="listchips">
            {lists.map((list) => (
              <span className={listFilter === list.name ? "listchip on" : "listchip"} key={list.name}>
                <button
                  type="button"
                  className="listchip-main"
                  onClick={() => setListFilter(listFilter === list.name ? "" : list.name)}
                >
                  {list.name} <i>{list.count}</i>
                </button>
                <button
                  type="button"
                  className="listchip-kill"
                  onClick={() => setKillList(list.name)}
                  aria-label={`Delete list ${list.name}`}
                  title="Delete this list"
                >
                  <Trash2 />
                </button>
              </span>
            ))}
          </div>
        )}

        {shown.length ? (
          <div className="leadrows">
            {shown.map((l) => (
              <div className="leadrow" key={l.id}>
                <button className="leadmain" onClick={() => onEdit(l)}>
                  <b>{(l.first_name || l.email)[0]}</b>
                  <span>
                    {l.first_name || l.email}
                    <small>
                      {l.company || "Needs enrichment"}
                      {l.list_name ? ` · ${l.list_name}` : ""}
                    </small>
                  </span>
                  <em>{l.title || "Research pending"}</em>
                  <Badge>{l.status}</Badge>
                </button>
                <button
                  type="button"
                  className="rowkill"
                  onClick={() => setKillLead(l)}
                  aria-label={`Delete ${l.email}`}
                  title="Delete lead"
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
        ) : leads.length ? (
          <p className="muted">No leads match this filter.</p>
        ) : (
          <EmptyState text="Import a CSV/XLSX or add one prospect to begin." action={() => open("lead")} />
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
          message={`All ${lists.find((l) => l.name === killList)?.count ?? 0} leads in it are removed. This cannot be undone.`}
          onConfirm={removeList}
          onCancel={() => setKillList(null)}
        />
      )}
    </>
  );
}
