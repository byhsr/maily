import { Check } from "lucide-react";
import type { FormEvent } from "react";
import { upsertLeads } from "../lib/api";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type LeadDrawerProps = {
  close: () => void;
  reload: () => void;
  tell: (message: string) => void;
};

export function LeadDrawer({ close, reload, tell }: LeadDrawerProps) {
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await upsertLeads([Object.fromEntries(new FormData(e.currentTarget))]);
      tell("Lead saved locally");
      reload();
      close();
    } catch (x) {
      tell(String(x));
    }
  };

  return (
    <form className="drawerform" onSubmit={save}>
      <p>Lead information stays in this local workspace. Research remains evidence-bound.</p>
      <label>
        Email
        <Input name="email" type="email" required />
      </label>
      <label>
        First name
        <Input name="first_name" />
      </label>
      <label>
        Company
        <Input name="company" />
      </label>
      <label>
        Role
        <Input name="title" />
      </label>
      <Button>
        Save lead <Check />
      </Button>
    </form>
  );
}
