import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check } from "lucide-react";
import { listCampaigns, listChannels, listLeads, listTemplates } from "../lib/api";
import type { Campaign, Lead, Template } from "../lib/types";
import { Home } from "../pages/Home";
import { Campaigns } from "../pages/Campaigns";
import { Leads } from "../pages/Leads";
import { Inbox } from "../pages/Inbox";
import { Templates } from "../pages/Templates";
import { Agents } from "../pages/Agents";
import { CampaignCanvas } from "../canvas/Canvas";
import { Drawer } from "../drawers/Drawer";
import { TemplateDrawer } from "../drawers/TemplateDrawer";
import { LeadDrawer } from "../drawers/LeadDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { SettingsDrawer } from "../drawers/SettingsDrawer";
import { Sidebar } from "./Sidebar";
import { Titlebar } from "./Titlebar";
import { NavContext } from "./nav";

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
  const [page, setPage] = useState("Home");
  const [drawer, setDrawer] = useState<string | undefined>();
  const [dark, setDark] = useState(localStorage.mailyTheme !== "light");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [note, setNote] = useState("");
  const [favourites, setFavourites] = useState<string[]>(readFavourites);
  const [editingTemplate, setEditingTemplate] = useState<Template | undefined>();
  const [canvasId, setCanvasId] = useState<string | undefined>();
  const [unread, setUnread] = useState(0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobile, setMobile] = useState(isNarrow);
  const [navOpen, setNavOpen] = useState(false);

  const tell = (message: string) => {
    setNote(message);
    setTimeout(() => setNote(""), 4000);
  };

  const load = async () => {
    try {
      const [c, l, t] = await Promise.all([listCampaigns(), listLeads(), listTemplates()]);
      setCampaigns(c);
      setLeads(l);
      setTemplates(t);
    } catch (e) {
      tell(String(e));
    }
    try {
      const channels = await listChannels();
      setUnread(channels.reduce((sum, channel) => sum + channel.unread, 0));
    } catch {
      /* notifications are best-effort */
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.mailyTheme = dark ? "dark" : "light";
  }, [dark]);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile]);

  const nav = useMemo(() => ({ mobile, openNav: () => setNavOpen(true) }), [mobile]);

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
  };

  const openCampaign = (campaign: Campaign) => {
    setCanvasId(campaign.id);
    setPage("Canvas");
  };

  const startNewCampaign = () => {
    setCanvasId(undefined);
    setPage("Canvas");
  };

  const favouriteCampaigns = campaigns.filter((c) => favourites.includes(c.id));

  return (
    <NavContext.Provider value={nav}>
      <div className="desktop">
        <Titlebar collapsed={collapsed && !mobile} onToggle={toggleSidebar} />
        <div className="app">
        <Sidebar
          page={page}
          onNavigate={setPage}
          onOpenSettings={() => setDrawer("settings")}
          favourites={favouriteCampaigns}
          onOpenFavourites={() => setPage("Campaigns")}
          campaigns={campaigns}
          onOpenCampaign={openCampaign}
          activeCampaignId={page === "Canvas" ? canvasId : undefined}
          collapsed={collapsed}
          mobile={mobile}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          notifications={unread}
        />
        {mobile && navOpen && <div className="app-scrim" onClick={() => setNavOpen(false)} />}
        <main className="app-main">
          {page === "Home" && (
            <Home campaigns={campaigns} open={setDrawer} onNewCampaign={startNewCampaign} onOpenCampaign={openCampaign} />
          )}
          {page === "Campaigns" && (
            <Campaigns
              campaigns={campaigns}
              onNew={startNewCampaign}
              favourites={favourites}
              onToggleFavourite={toggleFavourite}
              onOpenCanvas={openCampaign}
            />
          )}
          {page === "Leads" && <Leads leads={leads} open={setDrawer} reload={load} tell={tell} />}
          {page === "Inbox" && <Inbox tell={tell} />}
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
          {page === "Agents" && <Agents open={setDrawer} />}
          {page === "Canvas" && (
            <CampaignCanvas
              campaigns={campaigns}
              initialCampaignId={canvasId}
              templates={templates}
              tell={tell}
              onSelect={setCanvasId}
              reload={load}
              onBack={() => setPage("Campaigns")}
            />
          )}
        </main>
        </div>
        <AnimatePresence>
          {drawer && (
            <Drawer kind={drawer} close={closeDrawer}>
              {drawer === "template" && (
                <TemplateDrawer close={closeDrawer} reload={load} tell={tell} leads={leads} template={editingTemplate} />
              )}
              {drawer === "settings" && <SettingsDrawer tell={tell} dark={dark} setDark={setDark} />}
              {drawer === "agent" && <AgentDrawer tell={tell} />}
              {drawer === "lead" && <LeadDrawer close={closeDrawer} reload={load} tell={tell} />}
            </Drawer>
          )}
        </AnimatePresence>
        {note && (
          <div className="notice">
            <Check />
            {note}
          </div>
        )}
      </div>
    </NavContext.Provider>
  );
}
