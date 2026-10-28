import { Mail, Mailbox, MoreVertical, Star } from "lucide-react";
import type { Campaign } from "../lib/types";

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
};

export function CampaignCard({ campaign, favourite, onToggleFavourite, onOpen }: CampaignCardProps) {
  const active = campaign.status === "active";
  const when = relTime(campaign.approved_at);
  const avatars = initials(campaign.name);

  return (
    <article className="campaigncard">
      <div className="cardhead">
        <button
          className="pin"
          onClick={onToggleFavourite}
          aria-label={favourite ? "Unpin campaign" : "Pin campaign"}
          title={favourite ? "Unpin" : "Pin to favourites"}
        >
          <Star fill={favourite ? "currentColor" : "none"} />
        </button>
        <button className="kebab" onClick={onOpen} aria-label="Open campaign canvas" title="Open campaign">
          <MoreVertical />
        </button>
      </div>
      <button className="cardbody" onClick={onOpen}>
        <span className="meta">
          {when && (
            <>
              <time>{when}</time>
              <span>·</span>
            </>
          )}
          {active && <i className="dot" />}
          <span>{active ? "Active" : campaign.status}</span>
        </span>
        <h3>{campaign.name}</h3>
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
