import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { dashboardStats } from "../lib/api";
import type { Campaign, DashboardStats } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FilterChip } from "../ui/FilterChip";
import { HeroNumber } from "../ui/HeroNumber";
import { LineChart } from "../ui/LineChart";
import { Stat } from "../ui/Stat";
import { Topbar } from "../ui/Topbar";

const RANGES = ["Week", "Month", "Year"];

type HomeProps = {
  campaigns: Campaign[];
  open: (kind: string) => void;
  onNewCampaign: () => void;
  onOpenCampaign: (campaign: Campaign) => void;
};

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const delta = (now: number, before: number) =>
  before > 0 ? Math.round(((now - before) / before) * 100) : now > 0 ? 100 : 0;

export function Home({ campaigns, open, onNewCampaign, onOpenCampaign }: HomeProps) {
  const [range, setRange] = useState("Week");
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    let live = true;
    dashboardStats(range.toLowerCase())
      .then((s) => live && setStats(s))
      .catch(() => live && setStats(null));
    return () => {
      live = false;
    };
  }, [range]);

  const series = stats?.series ?? [];
  const totals = stats?.totals ?? { sent: 0, replied: 0, positive: 0, failed: 0 };
  const previous = stats?.previous ?? { sent: 0, replied: 0, positive: 0, failed: 0 };
  const activeCampaigns = campaigns.filter((c) => c.status === "active");

  const cards = [
    { label: "Sent", value: totals.sent, delta: delta(totals.sent, previous.sent), spark: series.map((p) => p.sent) },
    {
      label: "Reply rate",
      value: pct(totals.replied, totals.sent),
      suffix: "%",
      delta: delta(totals.replied, previous.replied),
      spark: series.map((p) => p.replied),
    },
    {
      label: "Positive replies",
      value: totals.positive,
      delta: delta(totals.positive, previous.positive),
      spark: series.map((p) => p.positive),
    },
    { label: "Failed", value: totals.failed, delta: delta(totals.failed, previous.failed), spark: series.map((p) => p.failed) },
  ];

  return (
    <>
      <Topbar
        status={stats ? `${totals.sent} sent` : "Local"}
        action={<Button onClick={onNewCampaign}>New</Button>}
      />

      <div className="hero">
        <div>
          <label>REPLIES THIS {range.toUpperCase()}</label>
          <HeroNumber value={totals.replied} />
          <p className="muted">
            {totals.positive} positive · {pct(totals.replied, totals.sent)}% of {totals.sent} sent
          </p>
        </div>
        <div className="chips">
          {RANGES.map((r) => (
            <FilterChip key={r} label={r} active={range === r} onClick={() => setRange(r)} />
          ))}
        </div>
      </div>

      <Card className="chartcard">
        <LineChart series={series} />
      </Card>

      <div className="metrics">
        {cards.map((c) => (
          <Stat key={c.label} label={c.label} value={c.value} suffix={c.suffix} delta={c.delta} spark={c.spark} />
        ))}
      </div>

      <div className="boards">
        <Card as="section">
          <header>
            <div>
              <label>NEEDS ATTENTION</label>
              <h3>{stats?.needsAttention ?? 0} replies waiting</h3>
            </div>
            <Button variant="ghost" onClick={() => open("lead")}>
              Open <ChevronRight />
            </Button>
          </header>
          <p className="muted">
            {(stats?.needsAttention ?? 0) > 0
              ? "Uncategorised replies are queued for classification."
              : "Nothing waiting — every reply is classified."}
          </p>
        </Card>
        <Card as="section" className="limecard">
          <header>
            <div>
              <label>ACTIVE CAMPAIGNS</label>
              <h3>{stats?.activeCampaigns ?? 0} running</h3>
            </div>
            <Button variant="ghost" onClick={onNewCampaign}>
              New <ChevronRight />
            </Button>
          </header>
          {activeCampaigns.length ? (
            <div className="rows">
              {activeCampaigns.slice(0, 3).map((c) => (
                <div key={c.id}>
                  <span className="rowname">
                    <b>{c.name}</b>
                  </span>
                  <small>{c.leads} leads · {c.mode}</small>
                  <Badge>{c.status}</Badge>
                  <Button variant="ghost" onClick={() => onOpenCampaign(c)}>
                    Edit <ChevronRight />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No campaign is running right now.</p>
          )}
        </Card>
      </div>
    </>
  );
}
