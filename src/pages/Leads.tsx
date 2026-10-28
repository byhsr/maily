import { useState } from "react";
import { Plus } from "lucide-react";
import * as XLSX from "xlsx";
import { upsertLeads } from "../lib/api";
import type { Lead } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { Topbar } from "../ui/Topbar";

type LeadsProps = {
  leads: Lead[];
  open: (kind: string) => void;
  reload: () => void;
  tell: (message: string) => void;
};

export function Leads({ leads, open, reload, tell }: LeadsProps) {
  const [query, setQuery] = useState("");
  const [listName, setListName] = useState("Imported");

  const importFile = async (file: File) => {
    try {
      const target = listName.trim() || "Imported";
      const raw = await file.arrayBuffer();
      const book = XLSX.read(raw, { type: "array" });
      const first = book.Sheets[book.SheetNames[0]];
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(first, { defval: "" });
      const mapped = records
        .map((row) => {
          const get = (...keys: string[]) => String(keys.map((k) => row[k]).find(Boolean) || "");
          return {
            email: get("email", "Email", "EMAIL"),
            first_name: get("first_name", "First Name", "FirstName"),
            last_name: get("last_name", "Last Name", "LastName"),
            company: get("company", "Company"),
            title: get("title", "Title"),
            website: get("website", "Website"),
            list_name: target,
            custom_fields: row,
          };
        })
        .filter((x) => x.email);
      const n = await upsertLeads(mapped);
      tell(`${n} leads imported into “${target}”; duplicates were updated.`);
      reload();
    } catch (e) {
      tell(`Could not import file: ${String(e)}`);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = leads.filter(
    (l) =>
      !q ||
      l.email.toLowerCase().includes(q) ||
      (l.first_name || "").toLowerCase().includes(q) ||
      (l.company || "").toLowerCase().includes(q)
  );

  return (
    <>
      <Topbar
        search={{ value: query, onChange: setQuery, placeholder: "Search leads..." }}
        status={`${leads.length} lead${leads.length === 1 ? "" : "s"}`}
        action={
          <Button onClick={() => open("lead")}>
            <Plus />Add
          </Button>
        }
      />

      <section className="sheet">
        <header>
          <h2>Leads</h2>
          <div className="actions">
            <Input
              className="listname"
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="List name"
              aria-label="Lead list name"
            />
            <label className="round">
              Import
              <Input type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            </label>
          </div>
        </header>
        {shown.length ? (
          <div className="leadrows">
            {shown.map((l) => (
              <button onClick={() => open("lead")} key={l.id}>
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
            ))}
          </div>
        ) : leads.length ? (
          <p className="muted">No leads match this search.</p>
        ) : (
          <EmptyState text="Import a CSV/XLSX or add one prospect to begin." action={() => open("lead")} />
        )}
      </section>
    </>
  );
}
