import { Bot, CircleUserRound, FileText, Mail, Send, Settings2, Sparkles, Users } from "lucide-react";

const NAV = [
  ["Home", Sparkles],
  ["Campaigns", Send],
  ["Leads", Users],
  ["Templates", FileText],
  ["Agents", Bot],
] as const;

type RailProps = {
  page: string;
  onNavigate: (page: string) => void;
  onOpenSettings: () => void;
};

export function Rail({ page, onNavigate, onOpenSettings }: RailProps) {
  return (
    <aside className="rail">
      <div className="wordmark">
        <i>
          <Mail />
        </i>
        maily
      </div>
      {NAV.map(([label, Icon]) => (
        <button className={page === label ? "current" : ""} onClick={() => onNavigate(label)} key={label}>
          <Icon />
          {label}
        </button>
      ))}
      <div className="railfoot">
        <button onClick={onOpenSettings}>
          <Settings2 />Settings
        </button>
        <p>
          <CircleUserRound />Local workspace <b />
        </p>
      </div>
    </aside>
  );
}
