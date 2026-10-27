import { ChevronRight, Plus } from "lucide-react";
import type { Campaign } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

type CampaignsProps = {
  campaigns: Campaign[];
  open: (kind: string) => void;
};

export function Campaigns({ campaigns, open }: CampaignsProps) {
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
              <b>{c.name}</b>
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
