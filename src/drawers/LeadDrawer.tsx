import { Check, Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { updateLead, upsertLeads } from "../lib/api";
import type { Lead } from "../lib/types";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Input } from "../ui/Input";

type LeadDrawerProps = {
  close: () => void;
  reload: () => void;
  tell: (message: string) => void;
  leads: Lead[];
  lead?: Lead;
};

type Values = Record<string, unknown>;

/** The columns the app itself reads — an address to send to and the parts of a name a
 *  message may use. A field with one of these keys edits that column; anything else is a
 *  variable carried alongside the lead. */
const STANDARD = ["email", "first_name", "last_name", "company", "title", "website"];

/** One field of a lead: its variable name and the value a message interpolates. */
type Row = { key: string; value: string; added?: boolean };

/** The fields a lead already has, as editable rows. An imported lead carries the whole sheet
 *  row; one with no imported row falls back to its own columns; a brand new lead starts with
 *  the one field a send must have, and more can be typed in. */
function initialRows(lead?: Lead): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: unknown) => {
    const name = String(key).trim();
    const lower = name.toLowerCase();
    if (!name || seen.has(lower)) return;
    seen.add(lower);
    rows.push({ key: name, value: value == null ? "" : String(value) });
  };
  const custom = Object.entries(lead?.custom_fields ?? {});
  if (custom.length) {
    for (const [key, value] of custom) push(key, value);
  } else if (lead) {
    push("email", lead.email);
    push("first_name", lead.first_name);
    push("last_name", lead.last_name);
    push("company", lead.company);
    push("title", lead.title);
    push("website", lead.website);
  } else {
    push("email", "");
  }
  return rows;
}

export function LeadDrawer({ close, reload, tell, leads, lead }: LeadDrawerProps) {
  const [rows, setRows] = useState<Row[]>(() => initialRows(lead));
  const [pending, setPending] = useState<{ values: Values; custom: Record<string, unknown> } | null>(
    null
  );

  const firstKey = rows.find((row) => row.key.trim())?.key ?? "company";

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const addRow = () => setRows((current) => [...current, { key: "", value: "", added: true }]);
  const removeRow = (index: number) => setRows((current) => current.filter((_, at) => at !== index));

  /** The rows as a lead: a field named for a column edits that column, the rest become the
   *  row a message can interpolate. An oddly-cased column key is kept as a variable too. */
  const collect = () => {
    const values: Values = {};
    const custom: Record<string, unknown> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      const lower = key.toLowerCase();
      if (STANDARD.includes(lower)) {
        values[lower] = row.value;
        if (key !== lower) custom[key] = row.value;
      } else {
        custom[key] = row.value;
      }
    }
    return { values, custom };
  };

  const commitNew = async (values: Values, custom: Record<string, unknown>) => {
    try {
      // Typed in one at a time, so it is a person on the Leads page, not a list.
      await upsertLeads([{ ...values, custom_fields: custom, source: "manual" }]);
      tell("Lead saved locally");
      reload();
      close();
    } catch (x) {
      tell(String(x));
    }
  };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { values, custom } = collect();
    const email = String(values.email ?? lead?.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      tell("A lead needs an email address");
      return;
    }
    if (lead) {
      try {
        await updateLead({ id: lead.id, ...values, email, custom_fields: custom });
        tell("Lead updated");
        reload();
        close();
      } catch (x) {
        tell(String(x));
      }
      return;
    }
    // A lead is unique by email, so saving this would overwrite the existing one.
    if (leads.some((l) => l.email.toLowerCase() === email)) {
      setPending({ values: { ...values, email }, custom });
      return;
    }
    await commitNew({ ...values, email }, custom);
  };

  return (
    <>
      <form className="drawerform" onSubmit={save}>
        <p>
          {lead
            ? "Editing this lead in place. Changes stay in this local workspace."
            : "Lead information stays in this local workspace. Research remains evidence-bound."}
        </p>
        <section className="leadfields">
          <span className="raillabel">From the file</span>
          <small>
            Every field this lead carries is a variable a message can use, e.g.{" "}
            <b>
              {"{{"}
              {firstKey}
              {"}}"}
            </b>
            . Edit the values, add a field the file did not have, or remove one you do not want.
          </small>
          <div className="fieldlist">
            {rows.map((row, index) => (
              <div className="fieldpair" key={index}>
                {row.added ? (
                  <Input
                    className="fieldkeyinput"
                    value={row.key}
                    placeholder="variable"
                    aria-label={`Field ${index + 1} name`}
                    onChange={(event) => setRow(index, { key: event.target.value })}
                  />
                ) : (
                  <span className="fieldkey">
                    {"{{"}
                    {row.key}
                    {"}}"}
                  </span>
                )}
                <Input
                  value={row.value}
                  aria-label={`${row.key || "field"} value`}
                  onChange={(event) => setRow(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Remove ${row.key || "field"}`}
                  onClick={() => removeRow(index)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <Button variant="ghost" type="button" onClick={addRow}>
            <Plus />
            Add field
          </Button>
        </section>
        <Button>
          {lead ? "Update lead" : "Save lead"} <Check />
        </Button>
      </form>

      {pending && (
        <Confirm
          title="That email is already a lead"
          message={`${String(pending.values.email)} already exists, so saving updates it instead of adding a new lead. Add it anyway?`}
          confirmLabel="Update lead"
          onConfirm={() => {
            const held = pending;
            setPending(null);
            commitNew(held.values, held.custom);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
