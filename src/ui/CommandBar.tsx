import { Plus, Search } from "lucide-react";
import { Button } from "./Button";

type CommandBarProps = {
  value: string;
  onChange: (value: string) => void;
  onNewCampaign: () => void;
  onAddLead: () => void;
};

export function CommandBar({ value, onChange, onNewCampaign, onAddLead }: CommandBarProps) {
  return (
    <div className="commandbar">
      <Search size={16} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search campaigns and leads…" />
      <span className="hint">⌘K</span>
      <Button onClick={onNewCampaign}>New campaign</Button>
      <Button variant="icon" onClick={onAddLead}>
        <Plus />
      </Button>
    </div>
  );
}
