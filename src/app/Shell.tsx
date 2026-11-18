import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence } from "motion/react";
import { Check } from "lucide-react";
import { createWorkspace, deleteCampaign, inboxCounts, listAccounts, listAgents, listCampaigns, listInbox, listKnowledge, listLeads, listTemplates, listWorkspaces, renameWorkspace, saveCampaign, switchWorkspace } from "../lib/api";
import type { Account, AgentDef, Campaign, InboxMessage, KnowledgeEntry, Lead, Template, Workspace } from "../lib/types";
import { Home } from "../pages/Home";
import { Campaigns } from "../pages/Campaigns";
import { Campaign as CampaignPage } from "../pages/Campaign";
import { Leads } from "../pages/Leads";
import { Inbox } from "../pages/Inbox";
import { Templates } from "../pages/Templates";
import { Knowledge } from "../pages/Knowledge";
import { Agents } from "../pages/Agents";
import { Postmaster } from "../pages/Postmaster";
import { Drawer } from "../drawers/Drawer";
import { TemplateDrawer } from "../drawers/TemplateDrawer";
import { LeadDrawer } from "../drawers/LeadDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { Settings } from "../pages/Settings";
import { KnowledgeDrawer } from "../drawers/KnowledgeDrawer";
import { Sidebar } from "./Sidebar";
import { Titlebar } from "./Titlebar";
import { NavContext } from "./nav";
import { Prompt } from "../ui/Prompt";
import { UpdateNotice } from "../ui/UpdateNotice";

/** Where the app is, as one value: a page plus whatever that page needs to render. */
type Location = { page: string; campaignId?: string; settingsTab?: string; tab?: string; messageId?: string };

const HOME: Location = { page: "Home" };

function readFavourites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("mailyFavourites") || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("mailySidebar") === "collapsed";
  } catch {
    return false;
  }
}

function isNarrow() {
  return window.matchMedia("(max-width: 900px)").matches;
}

export function Shell() {
  /** Every page visited and where along it we are. Back and forward only move the cursor,
   *  and `page` and the selectors below all read the current entry, so they cannot drift
   *  out of step with what is on screen. */
  const [trail, setTrail] = useState<Location[]>([HOME]);
  const [at, setAt] = useState(0);
  const here = trail[at];
  const page = here.page;
  const editingCampaignId = here.campaignId;
  const settingsTab = here.settingsTab ?? "accounts";
  /** Which tab of a campaign is open, and the conversation the Inbox should be showing. */
  const campaignTab = here.tab;
  const inboxMessageId = here.messageId;
  const [drawer, setDrawer] = useState<string | undefined>();
  const [workspace, setWorkspace] = useState("Maily");
  /** Every workspace, and the one that is open. Everything the app lists is gated by it. */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState("");
  const [namingWorkspace, setNamingWorkspace] = useState(false);
  /** The mailbox the Inbox is narrowed to; `undefined` is every account. Held here so the
   *  sidebar switcher and the Inbox rail cannot disagree. */
  const [mailAccount, setMailAccount] = useState<string | undefined>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [note, setNote] = useState("");
  const [favourites, setFavourites] = useState<string[]>(readFavourites);
  const [editingTemplate, setEditingTemplate] = useState<Template | undefined>();
  const [editingKnowledge, setEditingKnowledge] = useState<KnowledgeEntry | undefined>();
  const [editingAgent, setEditingAgent] = useState<AgentDef | undefined>();
  const [editingLead, setEditingLead] = useState<Lead | undefined>();
  const [unread, setUnread] = useState(0);
  /** What has arrived and not been read, newest first: the rows the bell's panel lists. */
  const [arrived, setArrived] = useState<InboxMessage[]>([]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobile, setMobile] = useState(isNarrow);
  const [navOpen, setNavOpen] = useState(false);
  const [naming, setNaming] = useState(false);

  // A stable identity: `tell` is handed to every page, and one that changed on each
  // render would make any effect that depends on it re-run with every render of the shell.
  const tell = useCallback((message: string) => {
    setNote(message);
    setTimeout(() => setNote(""), 4000);
  }, []);

  /** What has come in and not been read: the bell's number, and the replies its panel lists.
   *
   *  One loader for both, because they are the same question asked twice and a panel that
   *  disagreed with the number beside it would be worse than no panel. The count is the Inbox's
   *  own — every unread message in the workspace, whether it was ever classified into a channel
   *  or not, which is what the old sum over the channels quietly left out. Best effort: new mail
   *  arriving is not worth a toast when the reading of it fails. */
  const loadNotifications = useCallback(async () => {
    try {
      const [counts, unreadMail] = await Promise.all([
        inboxCounts(),
        listInbox("new", undefined, true, "newest"),
      ]);
      setUnread(counts.unread);
      setArrived(unreadMail);
    } catch {
      /* notifications are best-effort */
    }
  }, []);

  /** Moves to a page, appending it as a step and dropping anything ahead of it — the same
   *  rule a browser follows. Re-entering the page you are already on records nothing. */
  const go = useCallback(
    (next: Partial<Location> & { page: string }) => {
      const current = trail[at];
      const merged: Location = { ...current, ...next };
      // A campaign belongs to the campaign page alone; leaving its id on another page
      // would reopen that campaign the next time the page was reached.
      if (merged.page !== "Campaign") merged.campaignId = undefined;
      if (
        merged.page === current.page &&
        merged.campaignId === current.campaignId &&
        merged.settingsTab === current.settingsTab &&
        merged.tab === current.tab &&
        merged.messageId === current.messageId
      ) {
        return;
      }
      setTrail([...trail.slice(0, at + 1), merged]);
      setAt(at + 1);
    },
    [trail, at]
  );

  const step = useCallback(
    (delta: number) => setAt((value) => Math.min(Math.max(value + delta, 0), trail.length - 1)),
    [trail.length]
  );

  const load = async () => {
    try {
      const [c, l, t, k, a] = await Promise.all([
        listCampaigns(),
        listLeads(),
        listTemplates(),
        listKnowledge(),
        listAgents(),
      ]);
      setCampaigns(c);
      setLeads(l);
      setTemplates(t);
      setKnowledge(k);
      setAgents(a);
    } catch (e) {
      tell(String(e));
    }
    await loadNotifications();
  };

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
    } catch {
      /* the connected-account list is best-effort */
    }
  }, []);

  /** Reads the workspaces and names the open one, which is what the switcher shows. */
  const loadWorkspaces = useCallback(async () => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list.workspaces);
      setActiveWorkspace(list.active);
      const open = list.workspaces.find((one) => one.id === list.active);
      if (open) setWorkspace(open.name);
    } catch (e) {
      tell(String(e));
    }
  }, [tell]);

  /** Switches workspace, then reloads everything: none of it carries across. */
  const openWorkspace = useCallback(
    async (id: string) => {
      if (id === activeWorkspace) return;
      try {
        await switchWorkspace(id);
      } catch (e) {
        tell(String(e));
        return;
      }
      setActiveWorkspace(id);
      setMailAccount(undefined);
      // The trail was walked inside one workspace: another workspace's campaigns are not
      // ours to reopen, and a campaign view cannot survive the switch. Start it again here.
      setTrail([page === "Campaign" ? { page: "Campaigns" } : { page }]);
      setAt(0);
      await Promise.all([load(), loadAccounts()]);
      await loadWorkspaces();
    },
    [activeWorkspace, page, tell]
  );

  useEffect(() => {
    load();
    loadAccounts();
    loadWorkspaces();
  }, []);

  // New mail arrives on its own — the poller behind the app is what finds it — so the bell hears
  // about it from there rather than waiting for the next thing anyone clicks. The Inbox listens
  // to the same signal for its own list.
  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen<number>("inbox:new", () => void loadNotifications());
    return () => {
      void subscription.then((off) => off());
    };
  }, [loadNotifications]);

  // Reading a reply is what clears it, and the reading happens in the Inbox, which emits nothing
  // of its own. So the bell is brought up to date when the page changes rather than left holding
  // a number for something that has already been dealt with.
  useEffect(() => {
    void loadNotifications();
  }, [page, loadNotifications]);

  // An account that has been disconnected must not leave the Inbox stuck on an empty
  // mailbox nothing can ever fill.
  useEffect(() => {
    if (mailAccount && accounts.length && !accounts.some((one) => one.id === mailAccount)) {
      setMailAccount(undefined);
    }
  }, [accounts, mailAccount]);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("mailySidebar", collapsed ? "collapsed" : "open");
    } catch {
      /* storage may be unavailable */
    }
  }, [collapsed]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const onChange = () => {
      setMobile(query.matches);
      if (!query.matches) setNavOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (mobile) setNavOpen((open) => !open);
    else setCollapsed((value) => !value);
  }, [mobile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (mobile) setNavOpen((open) => !open);
        else setCollapsed((value) => !value);
      }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        step(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile, step]);

  const nav = useMemo(
    () => ({ mobile, openNav: () => setNavOpen(true), collapsed, setCollapsed }),
    [mobile, collapsed]
  );

  const toggleFavourite = (id: string) => {
    setFavourites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem("mailyFavourites", JSON.stringify(next));
      return next;
    });
  };

  const closeDrawer = () => {
    setDrawer(undefined);
    setEditingTemplate(undefined);
    setEditingKnowledge(undefined);
    setEditingAgent(undefined);
    setEditingLead(undefined);
  };

  const openNewLead = () => {
    setEditingLead(undefined);
    setDrawer("lead");
  };

  const openLead = (lead: Lead) => {
    setEditingLead(lead);
    setDrawer("lead");
  };

  // Opening a campaign lands on its setup, never on the analytics view left open before — so
  // it says so rather than leaving the tab empty for the page to fill in from what it remembers.
  const openCampaignEditor = (id: string) => go({ page: "Campaign", campaignId: id, tab: "sequence" });

  // The sidebar's own list is how a running campaign is checked on rather than written, so it
  // opens on what has happened to it. The other ways in — the campaigns page, Home, a campaign
  // just created — still land on the setup, which is where something gets written.
  const openCampaignActivity = (id: string) =>
    go({ page: "Campaign", campaignId: id, tab: "activity" });

  const startNewCampaign = () => setNaming(true);

  const createCampaign = async (name: string) => {
    const created = await saveCampaign({ name });
    await load();
    openCampaignEditor(created);
  };

  const removeCampaign = async (id: string) => {
    await deleteCampaign(id);
    await load();
  };

  const favouriteCampaigns = campaigns.filter((c) => favourites.includes(c.id));
  const editingCampaign = campaigns.find((c) => c.id === editingCampaignId);

  return (
    <NavContext.Provider value={nav}>
      <div className="desktop">
        <UpdateNotice />
        <Titlebar
          collapsed={collapsed && !mobile}
          onToggle={toggleSidebar}
          onBack={() => step(-1)}
          onForward={() => step(1)}
          canBack={at > 0}
          canForward={at < trail.length - 1}
        />
        <div className="app">
        <Sidebar
          page={page}
          onNavigate={(next) => go({ page: next })}
          onOpenSettings={() => go({ page: "Settings" })}
          accounts={accounts}
          onOpenAccounts={() => go({ page: "Settings", settingsTab: "accounts" })}
          mailAccount={mailAccount}
          onPickAccount={(account) => {
            setMailAccount(account);
            go({ page: "Inbox" });
          }}
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          onSwitchWorkspace={(id) => void openWorkspace(id)}
          onCreateWorkspace={() => setNamingWorkspace(true)}
          favourites={favouriteCampaigns}
          onOpenFavourites={() => go({ page: "Campaigns" })}
          campaigns={campaigns}
          onOpenCampaign={(campaign) => openCampaignActivity(campaign.id)}
          onNewCampaign={startNewCampaign}
          workspace={workspace}
          activeCampaignId={page === "Campaign" ? editingCampaignId : undefined}
          collapsed={collapsed}
          mobile={mobile}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          notifications={unread}
          arrived={arrived}
          // A notification opens the conversation it is about, where it is, rather than the Inbox
          // at the top of a list: what arrived is the thing worth showing.
          onOpenNotification={(messageId) => go({ page: "Inbox", messageId })}
        />
        {mobile && navOpen && <div className="app-scrim" onClick={() => setNavOpen(false)} />}
        {/* The Inbox owns its own full-height panes, so it takes the column without the
            page padding or the column's scroll. */}
        <main className={page === "Inbox" ? "app-main app-main-flush" : "app-main"}>
          {/* Keyed by the workspace: switching refetches the figures against the new one,
              rather than leaving the last workspace's analytics on screen. */}
          {page === "Home" && (
            <Home
              key={activeWorkspace}
              campaigns={campaigns}
              open={setDrawer}
              onNewCampaign={startNewCampaign}
              onOpenCampaign={(campaign) => openCampaignEditor(campaign.id)}
            />
          )}
          {page === "Campaigns" && (
            <Campaigns
              campaigns={campaigns}
              onNew={startNewCampaign}
              favourites={favourites}
              onToggleFavourite={toggleFavourite}
              onOpenCampaign={(campaign) => openCampaignEditor(campaign.id)}
              onOpenAnalytics={(campaign) =>
                // The reading half of a campaign, which the page keeps three views of. It opens
                // on the numbers; the other two are a click away and in the URL.
                go({ page: "Campaign", campaignId: campaign.id, tab: "analytics" })
              }
              onDelete={removeCampaign}
              tell={tell}
            />
          )}
          {page === "Leads" && <Leads leads={leads} open={openNewLead} onEdit={openLead} reload={load} tell={tell} />}
          {/* Keyed by the workspace: switching remounts the Inbox against the new one. */}
          {page === "Inbox" && (
            <Inbox
              key={activeWorkspace}
              tell={tell}
              account={mailAccount}
              onAccount={setMailAccount}
              initialMessageId={inboxMessageId}
            />
          )}
          {page === "Templates" && (
            <Templates
              templates={templates}
              open={setDrawer}
              onEdit={(t) => {
                setEditingTemplate(t);
                setDrawer("template");
              }}
              reload={load}
              tell={tell}
            />
          )}
          {page === "Knowledge" && (
            <Knowledge
              entries={knowledge}
              open={setDrawer}
              onEdit={(entry) => {
                setEditingKnowledge(entry);
                setDrawer("knowledge");
              }}
              reload={load}
              tell={tell}
            />
          )}
          {page === "Agents" && (
            <Agents
              agents={agents}
              open={setDrawer}
              onEdit={(agent) => {
                setEditingAgent(agent);
                setDrawer("agent");
              }}
              tell={tell}
            />
          )}
          {page === "Postmaster" && <Postmaster tell={tell} />}
          {page === "Settings" && (
            <Settings
              tell={tell}
              workspace={workspace}
              onWorkspaceChange={(next) => {
                setWorkspace(next);
                renameWorkspace(activeWorkspace, next)
                  .then(() => loadWorkspaces())
                  .catch((e) => tell(String(e)));
              }}
              section={settingsTab}
              onAccountsChange={loadAccounts}
              onWorkspaceCleaned={async () => {
                // Everything the shell was holding for this workspace is gone: the list, the
                // audience, and the counts the sidebar shows beside each workspace.
                await load();
                await loadWorkspaces();
                // So is every page behind this one — a back step would land on a campaign that no
                // longer exists — and the history starts again from here, where the result is.
                setTrail([{ page: "Settings", settingsTab: "danger" }]);
                setAt(0);
              }}
            />
          )}
          {page === "Campaign" && editingCampaign && (
            <CampaignPage
              key={editingCampaign.id}
              campaign={editingCampaign}
              templates={templates}
              leads={leads}
              reload={load}
              tell={tell}
              tab={campaignTab}
              onTab={(tab) => go({ page: "Campaign", tab })}
              onBackToCampaigns={() => go({ page: "Campaigns" })}
              onDeleted={() => go({ page: "Campaigns" })}
              onDuplicated={(id) => go({ page: "Campaign", campaignId: id, tab: "sequence" })}
              onOpenThread={(messageId) => go({ page: "Inbox", messageId })}
            />
          )}
        </main>
        </div>
        <AnimatePresence>
          {drawer && (
            <Drawer kind={drawer} close={closeDrawer}>
              {drawer === "template" && (
                <TemplateDrawer
                  close={closeDrawer}
                  reload={load}
                  tell={tell}
                  leads={leads}
                  template={editingTemplate}
                />
              )}
              {drawer === "agent" && (
                <AgentDrawer close={closeDrawer} agent={editingAgent} reload={load} tell={tell} />
              )}
              {drawer === "knowledge" && (
                <KnowledgeDrawer close={closeDrawer} entry={editingKnowledge} reload={load} tell={tell} />
              )}
              {drawer === "lead" && <LeadDrawer close={closeDrawer} reload={load} tell={tell} leads={leads} lead={editingLead} />}
            </Drawer>
          )}
        </AnimatePresence>
        {note && (
          <div className="notice">
            <Check />
            {note}
          </div>
        )}
        {naming && (
          <Prompt
            title="New campaign"
            placeholder="Q3 founder outreach"
            onSubmit={(name) => {
              setNaming(false);
              createCampaign(name).catch((e) => tell(String(e)));
            }}
            onCancel={() => setNaming(false)}
          />
        )}
        {namingWorkspace && (
          <Prompt
            title="New workspace"
            placeholder="Acme — Q3 outbound"
            onSubmit={(name) => {
              setNamingWorkspace(false);
              createWorkspace(name)
                .then(async () => {
                  // Creating one switches to it, so the lists reload against the new one.
                  setMailAccount(undefined);
                  await Promise.all([load(), loadAccounts()]);
                  await loadWorkspaces();
                  tell(`Workspace “${name}” created`);
                })
                .catch((e) => tell(String(e)));
            }}
            onCancel={() => setNamingWorkspace(false)}
          />
        )}
      </div>
    </NavContext.Provider>
  );
}
