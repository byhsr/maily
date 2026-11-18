import { useEffect, useState } from "react";
import { campaignActivity } from "../lib/api";
import {
  ACTIVITY_FILTERS,
  activityNote,
  activityText,
  activityTone,
  agoText,
  groupByDay,
  whenAt,
} from "../lib/followups";
import type { CampaignActivityItem } from "../lib/types";
import { Button } from "./Button";
import { FilterChip } from "./FilterChip";

/**
 * The Activity tab: one campaign's own history, newest first, a page at a time. Every line was
 * written by the thing it describes — the sender, the inbox, the skip, the hand-send — rather
 * than reconstructed here from timestamps, so the order is the order it happened in.
 *
 * The relative half of each timestamp moves on its own, because a feed frozen at "2m ago" is
 * worse than no relative time at all.
 */

export function CampaignActivity({
  campaignId,
  onOpenThread,
}: {
  campaignId: string;
  onOpenThread?: (messageId: string) => void;
}) {
  const [kind, setKind] = useState<string>("all");
  const [items, setItems] = useState<CampaignActivityItem[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    setBusy(true);
    campaignActivity(campaignId, kind, 0)
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setMore(page.has_more);
        setError("");
      })
      .catch((e) => live && setError(String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [campaignId, kind]);

  const loadMore = async () => {
    setBusy(true);
    try {
      const page = await campaignActivity(campaignId, kind, items.length);
      setItems((current) => [...current, ...page.items]);
      setMore(page.has_more);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const days = groupByDay(items);
  const filterLabel = ACTIVITY_FILTERS.find((one) => one.value === kind)?.label ?? "All";

  return (
    <div className="stack">
      <section className="sectioncard">
        <header>
          <h2>Activity</h2>
          <p>Everything this campaign has done, newest first.</p>
        </header>

        <div className="leadfilters">
          {ACTIVITY_FILTERS.map((one) => (
            <FilterChip
              key={one.value}
              label={one.label}
              active={kind === one.value}
              onClick={() => setKind(one.value)}
            />
          ))}
        </div>

        {error && <p className="muted">{error}</p>}

        {!error && items.length === 0 && (
          <div className="blank">
            <p>
              <b>Nothing here yet</b>
            </p>
            <small>
              {kind === "all"
                ? "Launch the campaign and its sends, replies and skips are recorded here."
                : `Nothing of this kind yet under ${filterLabel}.`}
            </small>
          </div>
        )}

        {days.map((day) => (
          <div className="feedgroup" key={day.key}>
            <h3 className="feedday">{day.label}</h3>
            <div className="feedrows">
              {day.items.map((item) => {
                const open = item.metadata?.message_id;
                const row = (
                  <>
                    <span className={`feeddot ${activityTone(item)}`} />
                    <span className="feedtext">
                      {activityText(item)}
                      {activityNote(item) && (
                        <small className="feednote">{activityNote(item)}</small>
                      )}
                    </span>
                    <span className="feedtime">
                      {whenAt(item.at)}
                      <small>{agoText(item.at, clock)}</small>
                    </span>
                  </>
                );
                return open && onOpenThread ? (
                  <button
                    type="button"
                    className="feedrow"
                    key={item.id}
                    onClick={() => onOpenThread(open)}
                  >
                    {row}
                  </button>
                ) : (
                  <div className="feedrow" key={item.id}>
                    {row}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {more && (
          <Button variant="secondary" type="button" disabled={busy} onClick={loadMore}>
            {busy ? "Loading…" : "Load more"}
          </Button>
        )}
      </section>
    </div>
  );
}
