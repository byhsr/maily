import { Mail, Mailbox, MoreVertical, Send, Star } from "lucide-react";
import { useState } from "react";
import type { Campaign } from "../lib/types";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  throttled: "Paused",
  done: "Finished",
};

const relTime = (iso?: string) => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0].toUpperCase());

type CampaignCardProps = {
  campaign: Campaign;
  favourite: boolean;
  onToggleFavourite: () => void;
  onOpen: () => void;
  onDelete: () => void;
};

export function CampaignCard({ campaign, favourite, onToggleFavourite, onOpen, onDelete }: CampaignCardProps) {
  const [menu, setMenu] = useState(false);
  const active = campaign.status === "active";
  const when = relTime(campaign.approved_at);
  const avatars = initials(campaign.name);

  return (
    <article className="campaigncard">
      <div className="cardhead">
        <span className="cardsource">
          <i className="cardsource-icon">
            <Send />
          </i>
          <span>{campaign.list_name?.trim() || "All leads"}</span>
        </span>
        <div className="cardactions">
          <button
            className="pin"
            onClick={onToggleFavourite}
            aria-label={favourite ? "Unpin campaign" : "Pin campaign"}
            title={favourite ? "Unpin" : "Pin to favourites"}
          >
            <Star fill={favourite ? "currentColor" : "none"} />
          </button>
          <div className="kebabwrap">
            <button
              className="kebab"
              onClick={() => setMenu((open) => !open)}
              aria-label="Campaign actions"
              title="More"
            >
              <MoreVertical />
            </button>
            {menu && (
              <>
                <div className="menuscrim" onClick={() => setMenu(false)} />
                <div className="cardmenu" role="menu">
                  <button
                    onClick={() => {
                      setMenu(false);
                      onOpen();
                    }}
                  >
                    Open campaign
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setMenu(false);
                      onDelete();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <button className="cardbody" onClick={onOpen}>
        <span className="cardtitle">
          <h3>{campaign.name}</h3>
          {campaign.leads > 0 && <i className="countbadge">{campaign.leads}</i>}
        </span>
        <span className="chiprow">
          <span className="chip">
            <i className={active ? "dot" : "dot is-idle"} />
            {STATUS_LABEL[campaign.status] ?? campaign.status}
          </span>
          {campaign.followups ? (
            <span className="chip">
              {campaign.followups} follow-up{campaign.followups === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
        <span className="cardmeta">
          <span>
            {campaign.sent}/{campaign.leads} sent
          </span>
          {when && <span>· {when}</span>}
        </span>
        <span className="cardfoot">
          <span className="avatars">
            {avatars.map((a, i) => (
              <i key={i}>{a}</i>
            ))}
          </span>
          <span className="accounts" title="Gmail / Outlook">
            <Mail />
            <Mailbox />
          </span>
        </span>
      </button>
    </article>
  );
}
