import { ChevronRight, Plus, Star } from "lucide-react";
import type { Campaign } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

type CampaignsProps = {
  campaigns: Campaign[];
  open: (kind: string) => void;
  favourites: string[];
  onToggleFavourite: (id: string) => void;
};

export function Campaigns({ campaigns, open, favourites, onToggleFavourite }: CampaignsProps) {
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
      {campaigns.length ? (
        <div className="rows">
          {campaigns.map((c) => (
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
              <Button variant="ghost" onClick={() => open("campaign")}>
                Edit <ChevronRight />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text="No campaign sequences yet." action={() => open("campaign")} />
      )}
    </section>
  );
}
