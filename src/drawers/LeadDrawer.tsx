import { Check } from "lucide-react";
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

export function LeadDrawer({ close, reload, tell, leads, lead }: LeadDrawerProps) {
  const [pending, setPending] = useState<Values | null>(null);

  /** Every column the import kept, spelled the way the sheet spelled it. The fields above
   *  are the lifted copies a send has to have; this is the row they were lifted from, and it
   *  is what a message can interpolate. */
  const fields = Object.entries(lead?.custom_fields ?? {}).map(
    ([key, value]) => [key, value == null ? "" : String(value)] as const
  );

  const commitNew = async (values: Values) => {
    try {
      // Typed in one at a time, so it is a person on the Leads page, not a list.
      await upsertLeads([{ ...values, source: "manual" }]);
      tell("Lead saved locally");
      reload();
      close();
    } catch (x) {
      tell(String(x));
    }
  };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget)) as Values;
    if (lead) {
      try {
        await updateLead({ id: lead.id, ...values });
        tell("Lead updated");
        reload();
        close();
      } catch (x) {
        tell(String(x));
      }
      return;
    }
    const email = String(values.email ?? "").trim().toLowerCase();
    // A lead is unique by email, so saving this would overwrite the existing one.
    if (email && leads.some((l) => l.email.toLowerCase() === email)) {
      setPending(values);
      return;
    }
    await commitNew(values);
  };

  return (
    <>
      <form className="drawerform" onSubmit={save}>
        <p>
          {lead
            ? "Editing this lead in place. Changes stay in this local workspace."
            : "Lead information stays in this local workspace. Research remains evidence-bound."}
        </p>
        <label>
          Email
          <Input name="email" type="email" required defaultValue={lead?.email ?? ""} />
        </label>
        <label>
          First name
          <Input name="first_name" defaultValue={lead?.first_name ?? ""} />
        </label>
        <label>
          Company
          <Input name="company" defaultValue={lead?.company ?? ""} />
        </label>
        <label>
          Role
          <Input name="title" defaultValue={lead?.title ?? ""} />
        </label>
        <Button>
          {lead ? "Update lead" : "Save lead"} <Check />
        </Button>
      </form>

      {fields.length > 0 && (
        <section className="leadfields">
          <span className="raillabel">From the sheet</span>
          <small>
            The imported row, kept whole — every column it had, not only the ones a send needs.
            Any of them can go in a message as a variable, e.g.{" "}
            <b>
              {"{{"}
              {fields[0][0]}
              {"}}"}
            </b>
            . They are read from the file, so they are not edited here.
          </small>
          <dl>
            {fields.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value || "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {pending && (
        <Confirm
          title="That email is already a lead"
          message={`${String(pending.email)} already exists, so saving updates it instead of adding a new lead. Add it anyway?`}
          confirmLabel="Update lead"
          onConfirm={() => {
            const values = pending;
            setPending(null);
            commitNew(values);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
