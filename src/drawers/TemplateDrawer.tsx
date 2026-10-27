import { Check } from "lucide-react";
import type { FormEvent } from "react";
import { saveTemplate } from "../lib/api";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type TemplateDrawerProps = {
  close: () => void;
  reload: () => void;
  tell: (message: string) => void;
};

export function TemplateDrawer({ close, reload, tell }: TemplateDrawerProps) {
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await saveTemplate(Object.fromEntries(new FormData(e.currentTarget)));
      tell("Template added to your library");
      reload();
      close();
    } catch (x) {
      tell(String(x));
    }
  };

  return (
    <form className="templatefull" onSubmit={save}>
      <label>
        Template name
        <Input name="name" required placeholder="Founder intro — concise" />
      </label>
      <label>
        Email subject
        <Input name="subject" required placeholder="A quick idea for {{Company Name}}" />
      </label>
      <label>
        Message
        <textarea name="body" required placeholder={"Hi {{First Name}},\n\nI noticed {{Company Name}}…\n\nBest,"} />
      </label>
      <p>
        Use any header from an imported CSV/XLSX column exactly as written, for example <code>{"{{Company Name}}"}</code>, <code>{"{{Industry}}"}</code>, or <code>{"{{Website}}"}</code>. The standard fields also work.
      </p>
      <Button>
        Save reusable template <Check />
      </Button>
    </form>
  );
}
