import { Bot, CircleUserRound, FileText, Mail, Send, Settings2, Sparkles, Star, Users } from "lucide-react";
import type { Campaign } from "../lib/types";

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
  favourites: Campaign[];
  onOpenFavourites: () => void;
};

export function Rail({ page, onNavigate, onOpenSettings, favourites, onOpenFavourites }: RailProps) {
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
      <span className="raillabel">Favourites</span>
      <div className="favlist">
        {favourites.length ? (
          favourites.map((c) => (
            <button className="favitem" key={c.id} onClick={onOpenFavourites} title={c.name}>
              <Star size={14} />
              {c.name}
            </button>
          ))
        ) : (
          <span className="favempty">Star a campaign to pin it here</span>
        )}
      </div>
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
