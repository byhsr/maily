import { Plus } from "lucide-react";
import * as XLSX from "xlsx";
import { upsertLeads } from "../lib/api";
import type { Lead } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";

type LeadsProps = {
  leads: Lead[];
  open: (kind: string) => void;
  reload: () => void;
  tell: (message: string) => void;
};

export function Leads({ leads, open, reload, tell }: LeadsProps) {
  const importFile = async (file: File) => {
    try {
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
            list_name: "Imported",
            custom_fields: row,
          };
        })
        .filter((x) => x.email);
      const n = await upsertLeads(mapped);
      tell(`${n} leads imported; duplicates were updated.`);
      reload();
    } catch (e) {
      tell(`Could not import file: ${String(e)}`);
    }
  };
  return (
    <section className="sheet">
      <header>
        <div>
          <label>PEOPLE</label>
          <h2>Lead pipeline</h2>
        </div>
        <div className="actions">
          <label className="round">
            Import CSV / XLSX
            <Input type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
          <Button onClick={() => open("lead")}>
            <Plus />Add lead
          </Button>
        </div>
      </header>
      {leads.length ? (
        <div className="leadrows">
          {leads.map((l) => (
            <button onClick={() => open("lead")} key={l.id}>
              <b>{(l.first_name || l.email)[0]}</b>
              <span>
                {l.first_name || l.email}
                <small>{l.company || "Needs enrichment"}</small>
              </span>
              <em>{l.title || "Research pending"}</em>
              <Badge>{l.status}</Badge>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState text="Import a CSV/XLSX or add one prospect to begin." action={() => open("lead")} />
      )}
    </section>
  );
}
