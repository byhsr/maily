import { ChevronRight, Plus } from "lucide-react";
import type { Campaign, DashboardData, Lead } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";

type HomeProps = {
  dash: DashboardData;
  campaigns: Campaign[];
  leads: Lead[];
  open: (kind: string) => void;
};

export function Home({ dash, campaigns, leads, open }: HomeProps) {
  return (
    <>
      <div className="overview">
        <div>
          <label>WORKSPACE OVERVIEW</label>
          <h2>Today’s outreach</h2>
        </div>
        <Button onClick={() => open("campaign")}>
          <Plus />
          Create campaign
        </Button>
      </div>
      <div className="metrics">
        {[
          ["Ready to send", dash.queued || 0],
          ["Sent", dash.sent || 0],
          ["Replies", dash.replies || 0],
          ["Interested", dash.interested || 0],
        ].map((x) => (
          <Card key={x[0] as string}>
            <small>{x[0]}</small>
            <strong>{x[1]}</strong>
            <span>this week</span>
          </Card>
        ))}
      </div>
      <div className="boards">
        <Card as="section">
          <header>
            <div>
              <label>CAMPAIGN PULSE</label>
              <h3>Your active work</h3>
            </div>
            <Button variant="ghost" onClick={() => open("campaign")}>
              All campaigns <ChevronRight />
            </Button>
          </header>
          {campaigns.length ? (
            <div className="rows">
              {campaigns.slice(0, 3).map((c) => (
                <div key={c.id}>
                  <b>{c.name}</b>
                  <small>{c.leads} people · {c.mode}</small>
                  <Badge>{c.status}</Badge>
                  <span>
                    <em style={{ width: c.status === "active" ? "70%" : "18%" }} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="A clear message is a good place to start." action={() => open("campaign")} />
          )}
        </Card>
        <Card as="section" className="limecard">
          <label>QUEUE</label>
          <h3>{dash.queued || 0} emails<br />scheduled</h3>
          <div>↗　✉　✦</div>
          <Button variant="ghost" onClick={() => open("campaign")}>
            Review queue <ChevronRight />
          </Button>
        </Card>
        <Card as="section">
          <label>LEAD PIPELINE</label>
          <h3>{leads.length} prospects</h3>
          <p>Review research and give each conversation a more relevant opening.</p>
          <Button variant="ghost" onClick={() => open("lead")}>
            Explore leads <ChevronRight />
          </Button>
        </Card>
      </div>
    </>
  );
}
