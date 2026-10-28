import { Bell, BookOpen, Bot, CircleUserRound, FileText, Home, Inbox as InboxIcon, MoreHorizontal, Send, Star, Users } from "lucide-react";
import type { Campaign } from "../lib/types";

const NAV = [
  ["Home", Home],
  ["Campaigns", Send],
  ["Leads", Users],
  ["Templates", FileText],
  ["Knowledge", BookOpen],
  ["Inbox", InboxIcon],
  ["Agents", Bot],
] as const;

const SWATCHES = ["blue", "lilac", "peach", "mint"];

type SidebarProps = {
  page: string;
  onNavigate: (page: string) => void;
  onOpenSettings: () => void;
  favourites: Campaign[];
  onOpenFavourites: () => void;
  campaigns: Campaign[];
  onOpenCampaign: (campaign: Campaign) => void;
  activeCampaignId?: string;
  collapsed: boolean;
  mobile: boolean;
  open: boolean;
  onClose: () => void;
  notifications: number;
};

export function Sidebar({
  page,
  onNavigate,
  onOpenSettings,
  favourites,
  onOpenFavourites,
  campaigns,
  onOpenCampaign,
  activeCampaignId,
  collapsed,
  mobile,
  open,
  onClose,
  notifications,
}: SidebarProps) {
  const rail = collapsed && !mobile;
  // The canvas and draft review are reached from Campaigns, so keep it lit.
  const active = page === "Canvas" || page === "Drafts" ? "Campaigns" : page;
  const go = (target: string) => {
    onNavigate(target);
    if (mobile) onClose();
  };
  const openCampaign = (campaign: Campaign) => {
    onOpenCampaign(campaign);
    if (mobile) onClose();
  };

  return (
    <aside className={`sidebar${rail ? " collapsed" : ""}${mobile && open ? " open" : ""}`}>
      <nav className="navlist">
        {NAV.map(([label, Icon]) => (
          <button
            className={active === label ? "navlink on" : "navlink"}
            onClick={() => go(label)}
            title={rail ? label : undefined}
            key={label}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <hr className="navdivider" />

      <button className="navlink" onClick={() => go("Inbox")} title={rail ? "Notifications" : undefined}>
        <Bell />
        <span>Notifications</span>
        {notifications > 0 && <i className="navcount">{notifications}</i>}
        {notifications > 0 && <i className="navdot" />}
      </button>

      {!rail && (
        <>
          <span className="sidelabel">Favourites</span>
          <div className="favlist">
            {favourites.length ? (
              favourites.map((c, i) => (
                <button className="favitem" key={c.id} onClick={onOpenFavourites} title={c.name}>
                  <i className={`favicon swatch-${SWATCHES[i % SWATCHES.length]}`}>{c.name.slice(0, 1).toUpperCase()}</i>
                  <span>{c.name}</span>
                  <Star size={14} fill="currentColor" />
                </button>
              ))
            ) : (
              <span className="favempty">Star a campaign to pin it</span>
            )}
          </div>

          <span className="sidelabel">Campaigns</span>
          <div className="sidecampaigns">
            {campaigns.length ? (
              campaigns.map((c) => (
                <button
                  className={activeCampaignId === c.id ? "campaignrow on" : "campaignrow"}
                  key={c.id}
                  onClick={() => openCampaign(c)}
                  title={c.name}
                >
                  <i className={c.status === "active" ? "cdot active" : "cdot"} />
                  <span>{c.name}</span>
                  {c.leads > 0 && <i className="cnum">{c.leads}</i>}
                </button>
              ))
            ) : (
              <span className="favempty">No campaigns yet</span>
            )}
          </div>
        </>
      )}

      <div className="sidefoot">
        <button className="navlink" onClick={onOpenSettings} title={rail ? "More" : undefined}>
          <MoreHorizontal />
          <span>More</span>
        </button>
        <p className="workspace-note">
          <CircleUserRound />
          <span>Local</span>
          <b />
        </p>
      </div>
    </aside>
  );
}
