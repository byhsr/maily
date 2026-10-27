import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check } from "lucide-react";
import { getDashboard, listCampaigns, listLeads, listTemplates } from "../lib/api";
import type { Campaign, DashboardData, Lead, Template } from "../lib/types";
import { Home } from "../pages/Home";
import { Campaigns } from "../pages/Campaigns";
import { Leads } from "../pages/Leads";
import { Templates } from "../pages/Templates";
import { Agents } from "../pages/Agents";
import { Drawer } from "../drawers/Drawer";
import { CampaignDrawer } from "../drawers/CampaignDrawer";
import { TemplateDrawer } from "../drawers/TemplateDrawer";
import { LeadDrawer } from "../drawers/LeadDrawer";
import { AgentDrawer } from "../drawers/AgentDrawer";
import { SettingsDrawer } from "../drawers/SettingsDrawer";
import { Rail } from "./Rail";
import { Topbar } from "./Topbar";

export function Shell() {
  const [page, setPage] = useState("Home");
  const [drawer, setDrawer] = useState<string | undefined>();
  const [dark, setDark] = useState(localStorage.mailyTheme !== "light");
  const [dash, setDash] = useState<DashboardData>({});
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [note, setNote] = useState("");

  const tell = (message: string) => {
    setNote(message);
    setTimeout(() => setNote(""), 4000);
  };

  const load = async () => {
    try {
      const [d, c, l, t] = await Promise.all([getDashboard(), listCampaigns(), listLeads(), listTemplates()]);
      setDash(d);
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

  const closeDrawer = () => setDrawer(undefined);

  return (
    <div className="newapp">
      <Rail page={page} onNavigate={setPage} onOpenSettings={() => setDrawer("settings")} />
      <main className="workspace">
        <Topbar page={page} />
        {page === "Home" && <Home dash={dash} campaigns={campaigns} leads={leads} open={setDrawer} />}
        {page === "Campaigns" && <Campaigns campaigns={campaigns} open={setDrawer} />}
        {page === "Leads" && <Leads leads={leads} open={setDrawer} reload={load} tell={tell} />}
        {page === "Templates" && <Templates templates={templates} open={setDrawer} />}
        {page === "Agents" && <Agents open={setDrawer} />}
      </main>
      <AnimatePresence>
        {drawer && (
          <Drawer kind={drawer} close={closeDrawer}>
            {drawer === "campaign" && <CampaignDrawer templates={templates} close={closeDrawer} reload={load} tell={tell} />}
            {drawer === "template" && <TemplateDrawer close={closeDrawer} reload={load} tell={tell} />}
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
