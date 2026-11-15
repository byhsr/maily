import { useState } from "react";
import {
  Bell,
  BookOpen,
  Bot,
  ChevronsUpDown,
  FileText,
  Home,
  Inbox as InboxIcon,
  Plus,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  Users,
} from "lucide-react";
import type { Account, Campaign, Workspace } from "../lib/types";
import { Button } from "../ui/Button";

const NAV = [
  ["Home", Home],
  ["Campaigns", Send],
  ["Leads", Users],
  ["Templates", FileText],
  ["Knowledge", BookOpen],
  ["Inbox", InboxIcon],
  ["Agents", Bot],
  ["Postmaster", ShieldCheck],
] as const;

/** Green running, amber draft, grey for everything else (paused/throttled/done). */
function statusClass(status: string): string {
  if (status === "active") return "cdot is-active";
  if (status === "draft") return "cdot is-draft";
  return "cdot";
}

type SidebarProps = {
  page: string;
  onNavigate: (page: string) => void;
  onOpenSettings: () => void;
  accounts: Account[];
  onOpenAccounts: () => void;
  /** Which mailbox the Inbox is showing, and how to change it from here. */
  mailAccount?: string;
  onPickAccount: (account?: string) => void;
  /** Every workspace, which one is open, and how to change or add one. */
  workspaces: Workspace[];
  activeWorkspace: string;
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  favourites: Campaign[];
  onOpenFavourites: () => void;
  campaigns: Campaign[];
  onOpenCampaign: (campaign: Campaign) => void;
  onNewCampaign: () => void;
  activeCampaignId?: string;
  workspace: string;
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
  accounts,
  onOpenAccounts,
  mailAccount,
  onPickAccount,
  workspaces,
  activeWorkspace,
  onSwitchWorkspace,
  onCreateWorkspace,
  favourites,
  onOpenFavourites,
  campaigns,
  onOpenCampaign,
  onNewCampaign,
  activeCampaignId,
  workspace,
  collapsed,
  mobile,
  open,
  onClose,
  notifications,
}: SidebarProps) {
  const rail = collapsed && !mobile;
  const [menu, setMenu] = useState(false);
  const active = page === "Campaign" ? "Campaigns" : page;
  const go = (target: string) => {
    onNavigate(target);
    if (mobile) onClose();
  };
  const openCampaign = (campaign: Campaign) => {
    onOpenCampaign(campaign);
    if (mobile) onClose();
  };
  const pick = (action: () => void) => {
    setMenu(false);
    action();
    if (mobile) onClose();
  };

  return (
    <aside className={`sidebar${rail ? " collapsed" : ""}${mobile && open ? " open" : ""}`}>
      {/* ---- Workspace / user switcher ---- */}
      <div className="wsswitch-wrap">
        <button className="wsswitch" onClick={() => setMenu((openMenu) => !openMenu)} title={rail ? workspace : undefined}>
          <i className="wsavatar">{workspace.trim().slice(0, 1).toUpperCase() || "M"}</i>
          {!rail && (
            <span className="wsmeta">
              <b>{workspace}</b>
              <small>
                {accounts.length
                  ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}`
                  : "No account connected"}
              </small>
            </span>
          )}
          {!rail && <ChevronsUpDown />}
        </button>

        {menu && !rail && (
          <>
            <div className="menuscrim" onClick={() => setMenu(false)} />
            <div className="wsmenu" role="menu">
              {/* The workspace is the outer scope: everything below it belongs to one. */}
              <span className="wsmenulabel">Workspaces</span>
              {workspaces.map((one) => (
                <button
                  key={one.id}
                  className={activeWorkspace === one.id ? "on" : ""}
                  title={`${one.leads} leads · ${one.campaigns} campaigns`}
                  onClick={() => pick(() => onSwitchWorkspace(one.id))}
                >
                  <span className="wsmenumail">{one.name}</span>
                  {!!one.leads && <i className="navcount">{one.leads}</i>}
                </button>
              ))}
              <button onClick={() => pick(onCreateWorkspace)}>
                <Plus size={14} />
                New workspace
              </button>

              {accounts.length > 0 && (
                <>
                  <hr />
                  {/* Switching mailbox from the switcher lands on the Inbox, narrowed. */}
                  <span className="wsmenulabel">Mailbox</span>
                  <button className={mailAccount ? "" : "on"} onClick={() => pick(() => onPickAccount(undefined))}>
                    All mailboxes
                  </button>
                  {accounts.map((one) => (
                    <button
                      key={one.id}
                      className={mailAccount === one.id ? "on" : ""}
                      title={one.email}
                      onClick={() => pick(() => onPickAccount(one.id))}
                    >
                      <i className={`statusdot${one.health === "healthy" ? " is-healthy" : ""}`} />
                      <span className="wsmenumail">{one.email}</span>
                      {!!one.unread && <i className="navcount">{one.unread}</i>}
                    </button>
                  ))}
                </>
              )}

              <hr />
              <button onClick={() => pick(onOpenSettings)}>Workspace settings</button>
              <button onClick={() => pick(onOpenAccounts)}>Connect email</button>
            </div>
          </>
        )}
      </div>

      {/* ---- Primary nav ---- */}
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

      {!rail && (
        <>
          <div className="grouplabel">
            <span>Campaigns</span>
            <button className="groupadd" onClick={onNewCampaign} title="New campaign" aria-label="New campaign">
              <Plus />
            </button>
          </div>
          <div className="sidecampaigns">
            {campaigns.length ? (
              campaigns.map((c) => (
                <button
                  className={activeCampaignId === c.id ? "navlink on" : "navlink"}
                  key={c.id}
                  onClick={() => openCampaign(c)}
                  title={c.name}
                >
                  <i className={statusClass(c.status)} />
                  <span>{c.name}</span>
                  {c.leads > 0 && <i className="cnum">{c.leads}</i>}
                </button>
              ))
            ) : (
              <span className="groupempty">No campaigns yet</span>
            )}
          </div>

          {favourites.length > 0 && (
            <>
              <div className="grouplabel">
                <span>Favourites</span>
              </div>
              <div className="sidecampaigns">
                {favourites.map((c) => (
                  <button className="navlink" key={c.id} onClick={onOpenFavourites} title={c.name}>
                    <Star size={14} fill="currentColor" />
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className="sidespacer" />

      {/* ---- Bottom block ---- */}
      <div className="sidefoot">
        <button
          className={active === "Inbox" ? "navlink on" : "navlink"}
          onClick={() => go("Inbox")}
          title={rail ? "Notifications" : undefined}
        >
          <Bell />
          <span>Notifications</span>
          {notifications > 0 && <i className="navcount">{notifications}</i>}
          {notifications > 0 && <i className="navdot" />}
        </button>
        <button
          className={page === "Settings" ? "navlink on" : "navlink"}
          onClick={onOpenSettings}
          title={rail ? "Settings" : undefined}
        >
          <SettingsIcon />
          <span>Settings</span>
        </button>

        {!rail && accounts.length === 0 && (
          <div className="connectcard">
            <b>No email connected</b>
            <small>Add one to start sending</small>
            <Button variant="secondary" onClick={onOpenAccounts}>
              Connect email
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
