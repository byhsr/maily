import { useState } from "react";
import { Plus } from "lucide-react";
import type { Campaign } from "../lib/types";
import { Button } from "../ui/Button";
import { CampaignCard } from "../ui/CampaignCard";
import { EmptyState } from "../ui/EmptyState";
import { FilterChip } from "../ui/FilterChip";
import { Topbar } from "../ui/Topbar";

const STATUS_OPTIONS = ["All", "Active", "Draft", "Paused"];
const DATE_OPTIONS = ["Any time", "This week", "This month"];

type CampaignsProps = {
  campaigns: Campaign[];
  onNew: () => void;
  favourites: string[];
  onToggleFavourite: (id: string) => void;
  onOpenCanvas: (campaign: Campaign) => void;
};

export function Campaigns({ campaigns, onNew, favourites, onToggleFavourite, onOpenCanvas }: CampaignsProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [range, setRange] = useState("Any time");

  const q = query.trim().toLowerCase();
  const days = range === "This week" ? 7 : range === "This month" ? 30 : 0;
  const shown = campaigns.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (status !== "All" && c.status !== status.toLowerCase()) return false;
    if (days && c.approved_at) {
      const at = new Date(c.approved_at).getTime();
      if (!Number.isNaN(at) && Date.now() - at > days * 86400000) return false;
    }
    return true;
  });

  return (
    <section>
      <Topbar
        search={{ value: query, onChange: setQuery, placeholder: "Search campaigns..." }}
        status={`${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`}
        action={
          <Button onClick={onNew}>
            <Plus />New
          </Button>
        }
      />

      <header className="pagehead">
        <h2>Campaigns</h2>
      </header>

      <div className="chips">
        <FilterChip label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <FilterChip label="Account" value="All" disabled />
        <FilterChip label="Date" value={range} options={DATE_OPTIONS} onChange={setRange} />
        <FilterChip label="Tags" value="All" disabled />
      </div>

      {shown.length ? (
        <div className="cardgrid">
          {shown.map((campaign) => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              favourite={favourites.includes(campaign.id)}
              onToggleFavourite={() => onToggleFavourite(campaign.id)}
              onOpen={() => onOpenCanvas(campaign)}
            />
          ))}
        </div>
      ) : campaigns.length ? (
        <p className="muted">No campaigns match these filters.</p>
      ) : (
        <EmptyState text="No campaign sequences yet." action={onNew} />
      )}
    </section>
  );
}
