import { Check, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { saveCampaign, saveTemplate } from "../lib/api";
import type { Template } from "../lib/types";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type CampaignDrawerProps = {
  templates: Template[];
  close: () => void;
  reload: () => void;
  tell: (message: string) => void;
};

export function CampaignDrawer({ templates, close, reload, tell }: CampaignDrawerProps) {
  const [showTemplate, setShowTemplate] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await saveCampaign({
        name: f.get("name"),
        template_id: f.get("template_id"),
        mode: f.get("mode"),
        schedule: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
      tell("Campaign saved as a draft");
      reload();
      close();
    } catch (x) {
      tell(String(x));
    }
  };

  const saveNestedTemplate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await saveTemplate(Object.fromEntries(new FormData(e.currentTarget)));
      tell("Template saved");
      reload();
      setShowTemplate(false);
    } catch (x) {
      tell(String(x));
    }
  };

  return (
    <form className="drawerform sequenceform" onSubmit={submit}>
      <div>
        <p>Configure the first sequence step and message. Autonomous campaigns always need explicit approval before any provider send job can run.</p>
        <label>
          Campaign name
          <Input name="name" required placeholder="Q3 founder outreach" />
        </label>
        <label>
          First-step template
          <select name="template_id" required>
            <option value="">Select a saved template</option>
            {templates.map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="icon" type="button" onClick={() => setShowTemplate(!showTemplate)}>
          <Plus />Create template
        </Button>
      </div>
      {showTemplate && (
        <section className="templateeditor">
          <h3>New reusable template</h3>
          <label>
            Name
            <Input name="template_name" form="template-form" required placeholder="Founder introduction" />
          </label>
          <form id="template-form" onSubmit={saveNestedTemplate}>
            <label>
              Subject
              <Input name="subject" required placeholder="Quick idea for {{company}}" />
            </label>
            <label>
              Message
              <textarea name="body" required placeholder="Hi {{first_name}}, …" />
            </label>
            <Button variant="ink">
              Save template <Check />
            </Button>
          </form>
        </section>
      )}
      <div className="sequencepanel">
        <h3>Sequence timing</h3>
        <label>
          Delay before first send
          <select name="delay">
            <option>Send when scheduled</option>
            <option>Wait 1 day</option>
            <option>Wait 3 days</option>
          </select>
        </label>
        <label>
          Sending mode
          <select name="mode">
            <option value="draft">Draft-only</option>
            <option value="autonomous">Autonomous after approval</option>
          </select>
        </label>
        <Button>
          Save campaign & sequence <Check />
        </Button>
      </div>
    </form>
  );
}
