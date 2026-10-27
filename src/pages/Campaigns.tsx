import { useState } from "react";
import { ChevronRight, Plus, Star } from "lucide-react";
import type { Campaign } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { FilterChip } from "../ui/FilterChip";

const STATUS_FILTERS = ["All", "Active", "Draft", "Paused"];

type CampaignsProps = {
  campaigns: Campaign[];
  open: (kind: string) => void;
  favourites: string[];
  onToggleFavourite: (id: string) => void;
  onOpenCanvas: (campaign: Campaign) => void;
};

export function Campaigns({ campaigns, open, favourites, onToggleFavourite, onOpenCanvas }: CampaignsProps) {
  const [status, setStatus] = useState("All");
  const shown = campaigns.filter((c) => status === "All" || c.status === status.toLowerCase());

  return (
    <section className="sheet">
      <header>
        <div>
          <label>SEQUENCES</label>
          <h2>Campaigns</h2>
        </div>
        <Button onClick={() => open("campaign")}>
          <Plus />New campaign
        </Button>
      </header>
      <div className="chips">
        {STATUS_FILTERS.map((s) => (
          <FilterChip key={s} label={s} active={status === s} onClick={() => setStatus(s)} />
        ))}
      </div>
      {shown.length ? (
        <div className="rows">
          {shown.map((c) => (
            <div key={c.id}>
              <span className="rowname">
                <button
                  className="star"
                  aria-label={favourites.includes(c.id) ? "Unpin campaign" : "Pin campaign"}
                  onClick={() => onToggleFavourite(c.id)}
                >
                  <Star size={14} fill={favourites.includes(c.id) ? "currentColor" : "none"} />
                </button>
                <b>{c.name}</b>
              </span>
              <small>{c.leads} leads · {c.mode}</small>
              <Badge>{c.status}</Badge>
              <Button variant="ghost" onClick={() => onOpenCanvas(c)}>
                Canvas <ChevronRight />
              </Button>
            </div>
          ))}
        </div>
      ) : campaigns.length ? (
        <p className="muted">No campaigns are {status.toLowerCase()}.</p>
      ) : (
        <EmptyState text="No campaign sequences yet." action={() => open("campaign")} />
      )}
    </section>
  );
}
