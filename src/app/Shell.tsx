import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check } from "lucide-react";
import { listCampaigns, listLeads, listTemplates } from "../lib/api";
import type { Campaign, Lead, Template } from "../lib/types";
import { Home } from "../pages/Home";
import { Campaigns } from "../pages/Campaigns";
import { Leads } from "../pages/Leads";
import { Templates } from "../pages/Templates";
import { Agents } from "../pages/Agents";
import { CampaignCanvas } from "../canvas/Canvas";
import { Drawer } from "../drawers/Drawer";
import { CampaignDrawer } from "../drawers/CampaignDrawer";
import { TemplateDrawer } from "../drawers/TemplateDrawer";
import { LeadDrawer } from "../drawers/LeadDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { SettingsDrawer } from "../drawers/SettingsDrawer";
import { CommandBar } from "../ui/CommandBar";
import { Rail } from "./Rail";
import { Topbar } from "./Topbar";

function readFavourites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("mailyFavourites") || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function Shell() {
  const [page, setPage] = useState("Home");
  const [drawer, setDrawer] = useState<string | undefined>();
  const [dark, setDark] = useState(localStorage.mailyTheme !== "light");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("All");
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useState<string[]>(readFavourites);
  const [editingTemplate, setEditingTemplate] = useState<Template | undefined>();
  const [canvasId, setCanvasId] = useState<string | undefined>();

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
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.mailyTheme = dark ? "dark" : "light";
  }, [dark]);

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
  const openCampaign = () => setDrawer("campaign");
  const openLead = () => setDrawer("lead");

  const q = query.trim().toLowerCase();
  const visibleCampaigns = campaigns.filter(
    (c) => (status === "All" || c.status === status.toLowerCase()) && (!q || c.name.toLowerCase().includes(q))
  );
  const visibleLeads = leads.filter(
    (l) => !q || l.email.toLowerCase().includes(q) || (l.first_name || "").toLowerCase().includes(q) || (l.company || "").toLowerCase().includes(q)
  );
  const favouriteCampaigns = campaigns.filter((c) => favourites.includes(c.id));

  return (
    <div className="newapp">
      <Rail
        page={page}
        onNavigate={setPage}
        onOpenSettings={() => setDrawer("settings")}
        favourites={favouriteCampaigns}
        onOpenFavourites={() => setPage("Campaigns")}
      />
      <main className="workspace">
        <Topbar page={page} status={status} onStatus={setStatus} onNewCampaign={openCampaign} />
        {page === "Home" && <Home campaigns={visibleCampaigns} open={setDrawer} />}
        {page === "Campaigns" && (
          <Campaigns
            campaigns={visibleCampaigns}
            open={setDrawer}
            favourites={favourites}
            onToggleFavourite={toggleFavourite}
            onOpenCanvas={(c) => {
              setCanvasId(c.id);
              setPage("Canvas");
            }}
          />
        )}
        {page === "Leads" && <Leads leads={visibleLeads} open={setDrawer} reload={load} tell={tell} />}
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
          <CampaignCanvas campaigns={campaigns} initialCampaignId={canvasId} templates={templates} leads={leads} tell={tell} />
        )}
      </main>
      <CommandBar value={query} onChange={setQuery} onNewCampaign={openCampaign} onAddLead={openLead} />
      <AnimatePresence>
        {drawer && (
          <Drawer kind={drawer} close={closeDrawer}>
            {drawer === "campaign" && <CampaignDrawer templates={templates} close={closeDrawer} reload={load} tell={tell} />}
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
  );
}
