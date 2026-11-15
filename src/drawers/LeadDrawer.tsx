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

  const commitNew = async (values: Values) => {
    try {
      await upsertLeads([values]);
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
