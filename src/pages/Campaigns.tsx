import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Campaign } from "../lib/types";
import { Button } from "../ui/Button";
import { CampaignCard } from "../ui/CampaignCard";
import { Card } from "../ui/Card";
import { Confirm } from "../ui/Confirm";
import { EmptyState } from "../ui/EmptyState";
import { FilterChip } from "../ui/FilterChip";
import { PageHeader } from "../ui/PageHeader";

const STATUS_OPTIONS = ["All", "Active", "Draft", "Paused", "Finished"];
const DATE_OPTIONS = ["Any time", "This week", "This month"];

/** What each filter picks, by the labels the cards show: a throttled campaign reads as
 *  Paused, and a done one as Finished. */
const STATUS_MATCH: Record<string, string[]> = {
  Active: ["active"],
  Draft: ["draft"],
  Paused: ["paused", "throttled"],
  Finished: ["done"],
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  throttled: "Paused",
  done: "Finished",
};

type View = "cards" | "list";

/** The view the page was last left in, so it comes back the way it was. */
function readView(): View {
  try {
    return localStorage.getItem("mailyCampaignView") === "list" ? "list" : "cards";
  } catch {
    return "cards";
  }
}

type CampaignsProps = {
  campaigns: Campaign[];
  onNew: () => void;
  favourites: string[];
  onToggleFavourite: (id: string) => void;
  onOpenCampaign: (campaign: Campaign) => void;
  /** Opens a campaign straight on its Activity tab. */
  onOpenAnalytics: (campaign: Campaign) => void;
  onDelete: (id: string) => Promise<void>;
  tell: (message: string) => void;
};

export function Campaigns({
  campaigns,
  onNew,
  favourites,
  onToggleFavourite,
  onOpenCampaign,
  onOpenAnalytics,
  onDelete,
  tell,
}: CampaignsProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [range, setRange] = useState("Any time");
  const [view, setView] = useState<View>(readView);
  const [pending, setPending] = useState<Campaign>();

  const chooseView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem("mailyCampaignView", next);
    } catch {
      /* storage may be unavailable */
    }
  };

  const q = query.trim().toLowerCase();
  const days = range === "This week" ? 7 : range === "This month" ? 30 : 0;
  const shown = campaigns.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    const wanted = STATUS_MATCH[status];
    if (wanted && !wanted.includes(c.status)) return false;
    if (days && c.approved_at) {
      const at = new Date(c.approved_at).getTime();
      if (!Number.isNaN(at) && Date.now() - at > days * 86400000) return false;
    }
    return true;
  });

  return (
    <section>
      <PageHeader
        title="Campaigns"
        status={`${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`}
        search={{ value: query, onChange: setQuery, placeholder: "Search campaigns..." }}
        tools={
          <div className="segmented">
            <button
              type="button"
              className={view === "cards" ? "on" : undefined}
              aria-pressed={view === "cards"}
              onClick={() => chooseView("cards")}
            >
              Cards
            </button>
            <button
              type="button"
              className={view === "list" ? "on" : undefined}
              aria-pressed={view === "list"}
              onClick={() => chooseView("list")}
            >
              List
            </button>
          </div>
        }
        action={
          <Button onClick={onNew}>
            <Plus />New
          </Button>
        }
      />

      <div className="chips">
        <FilterChip label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <FilterChip label="Account" value="All" disabled />
        <FilterChip label="Date" value={range} options={DATE_OPTIONS} onChange={setRange} />
        <FilterChip label="Tags" value="All" disabled />
      </div>

      {shown.length ? (
        view === "cards" ? (
          <div className="cardgrid">
            {shown.map((campaign) => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                favourite={favourites.includes(campaign.id)}
                onToggleFavourite={() => onToggleFavourite(campaign.id)}
                onOpen={() => onOpenCampaign(campaign)}
                onAnalytics={() => onOpenAnalytics(campaign)}
                onDelete={() => setPending(campaign)}
              />
            ))}
          </div>
        ) : (
          <div className="camplist">
            <div className="camphead">
              <span>Name</span>
              <span>Audience</span>
              <span>Status</span>
              <span>Sent</span>
              <span />
            </div>
            {shown.map((campaign) => (
              <div className="camprowline" key={campaign.id}>
                <button type="button" className="camplink truncate" onClick={() => onOpenCampaign(campaign)}>
                  {campaign.name}
                </button>
                <span className="truncate">{campaign.list_name?.trim() || "All leads"}</span>
                <span>
                  <span className={`chipstatus ${campaign.status === "active" ? "sent" : ""}`}>
                    {STATUS_LABEL[campaign.status] ?? campaign.status}
                  </span>
                </span>
                <span className="truncate">
                  {campaign.sent}/{campaign.leads}
                  {campaign.followups
                    ? ` · ${campaign.followups} follow-up${campaign.followups === 1 ? "" : "s"}`
                    : ""}
                </span>
                <span className="camprowactions">
                  <button type="button" className="camplink" onClick={() => onOpenAnalytics(campaign)}>
                    Analytics
                  </button>
                  <Button variant="ghost" type="button" onClick={() => onOpenCampaign(campaign)}>
                    Open
                  </Button>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`Delete ${campaign.name}`}
                    onClick={() => setPending(campaign)}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )
      ) : campaigns.length ? (
        <Card className="emptycard">
          <p className="muted">No campaigns match these filters.</p>
        </Card>
      ) : (
        <EmptyState text="No campaign sequences yet." action={onNew} />
      )}

      {pending && (
        <Confirm
          title="Delete campaign?"
          message={`“${pending.name}” and its queue and send history are removed. This cannot be undone.`}
          onCancel={() => setPending(undefined)}
          onConfirm={() => {
            const target = pending;
            setPending(undefined);
            onDelete(target.id)
              .then(() => tell("Campaign deleted"))
              .catch((e) => tell(String(e)));
          }}
        />
      )}
    </section>
  );
}
