import { useEffect, useState } from "react";
import { campaignSeries } from "../lib/api";
import {
  campaignProgress,
  minutesText,
  numberText,
  percentText,
  progressText,
  stepLabel,
} from "../lib/followups";
import type { CampaignMetrics, StatsPoint } from "../lib/types";
import { LineChart } from "./LineChart";

/**
 * The Analytics tab: what the campaign has done, in numbers counted over the leads it wrote to
 * rather than over the rows it wrote. Four thousand emails to two leads is two leads contacted,
 * and a ratio over the emails would say something else entirely.
 *
 * The chart's series is the only thing fetched here — the counts arrive with the campaign
 * itself, so the cards and the progress bar can never disagree with the rest of the page.
 */

/** The two ranges the chart offers, in days. */
const RANGES = [14, 30] as const;

export function CampaignAnalytics({
  campaignId,
  metrics,
}: {
  campaignId: string;
  metrics: CampaignMetrics;
}) {
  const [days, setDays] = useState<number>(RANGES[0]);
  const [series, setSeries] = useState<StatsPoint[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    campaignSeries(campaignId, days)
      .then((points) => live && setSeries(points))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [campaignId, days]);

  const progress = campaignProgress(metrics.contacted, metrics.total);
  const funnel = metrics.funnel ?? [];
  const subjects = metrics.subject_stats ?? [];

  return (
    <div className="stack">
      <div className="metrics">
        <article>
          <small>Leads contacted</small>
          <strong>{progress.contacted}</strong>
          <em>of {progress.total}</em>
        </article>
        <article>
          <small>Replied</small>
          <strong>{metrics.replied}</strong>
          <em>{percentText(metrics.reply_rate)} of contacted</em>
        </article>
        <article>
          <small>Positive</small>
          <strong>{metrics.positive}</strong>
          <em>interested</em>
        </article>
        <article>
          <small>Bounced</small>
          <strong>{metrics.bounced}</strong>
          <em>{percentText(metrics.bounce_rate)} of contacted</em>
        </article>
      </div>
      {/* Emails are the secondary figure: they say how hard the audience was worked, not how
          many people were reached. */}
      <p className="muted statnote">
        {metrics.emails_sent} emails sent
        {metrics.unsubscribed > 0 ? ` · ${metrics.unsubscribed} unsubscribed` : ""}
      </p>

      <section className="sectioncard">
        <header>
          <h2>Progress</h2>
          <p>Leads written to, out of everyone enrolled.</p>
        </header>
        <div
          className="progressbar"
          role="img"
          aria-label={`${progress.percent}% of the audience contacted`}
        >
          <em style={{ width: `${progress.percent}%` }} />
        </div>
        <p className="muted">
          {progressText(metrics.contacted, metrics.total)}
          {` · ${percentText(progress.percent)}`}
        </p>
        <div className="funnelrow">
          <span className="funnelname">Sequence completion</span>
          <span className="funnelbar">
            <em style={{ width: `${Math.min(100, Math.max(0, metrics.completion_rate))}%` }} />
          </span>
          <span className="funnelcount">
            {metrics.completed_sequence} of {metrics.total} leads got all {metrics.steps} step
            {metrics.steps === 1 ? "" : "s"} · {percentText(metrics.completion_rate)}
          </span>
        </div>
        <p className="muted statnote">
          {metrics.in_sequence} still in the sequence · {metrics.finished} finished
        </p>
      </section>

      <div className="metrics">
        <article>
          <small>Median time to first reply</small>
          <strong>{minutesText(metrics.median_reply_minutes)}</strong>
          <em>from the email they answered</em>
        </article>
        <article>
          <small>Emails per reply</small>
          <strong>{numberText(metrics.emails_per_reply)}</strong>
          <em>sent for each answer</em>
        </article>
        <article>
          <small>Bounce rate</small>
          <strong>{percentText(metrics.bounce_rate)}</strong>
          <em>of leads contacted</em>
        </article>
        <article>
          <small>Unsubscribe rate</small>
          <strong>{percentText(metrics.unsubscribe_rate)}</strong>
          <em>of leads contacted</em>
        </article>
      </div>

      <section className="sectioncard">
        <header>
          <h2>Sends and replies</h2>
          <div className="segmented">
            {RANGES.map((range) => (
              <button
                key={range}
                type="button"
                className={days === range ? "on" : ""}
                onClick={() => setDays(range)}
              >
                {range} days
              </button>
            ))}
          </div>
        </header>
        {error ? <p className="muted">{error}</p> : <LineChart series={series} />}
      </section>

      <section className="sectioncard">
        <header>
          <h2>Subject lines</h2>
          <p>Every reply is credited to the line its lead was given, not to whichever went out.</p>
        </header>
        {subjects.length > 1 ? (
          subjects.map((stat) => (
            <div className="funnelrow" key={stat.position}>
              <span className="funnelname">
                {String.fromCharCode(65 + stat.position)} · {stat.subject || "—"}
              </span>
              <span className="funnelbar">
                <em style={{ width: `${Math.min(100, Math.max(0, stat.rate))}%` }} />
              </span>
              <span className="funnelcount">
                {stat.leads} leads · {stat.contacted} contacted · {stat.replied} replied (
                {percentText(stat.rate)})
              </span>
            </div>
          ))
        ) : (
          <p className="muted">
            One subject line. Add a second and the audience is split across them, so they can be
            compared.
          </p>
        )}
      </section>

      <section className="sectioncard">
        <header>
          <h2>Step funnel</h2>
          <p>
            How far each step got. The bar is the share of the leads it reached that answered;
            the counts beside it are leads, except the emails sent.
          </p>
        </header>
        {funnel.some((row) => row.leads > 0) ? (
          funnel.map((row) => (
            <div className="funnelrow" key={row.position}>
              <span className="funnelname">{stepLabel(row.position)}</span>
              <span className="funnelbar">
                <em
                  style={{
                    width: `${Math.min(100, Math.max(0, percentOf(row.replied, row.leads)))}%`,
                  }}
                />
              </span>
              <span className="funnelcount">
                {row.leads} leads · {row.sent} sent · {row.replied} replied (
                {percentText(percentOf(row.replied, row.leads))}) · {row.waiting} waiting
              </span>
            </div>
          ))
        ) : (
          <p className="muted">Nothing has gone out yet, so there is no funnel to draw.</p>
        )}
      </section>
    </div>
  );
}

/** A step's rate, over the leads that reached it rather than over the emails it carried. Kept
 *  here rather than imported because it is the one ratio the backend does not send. */
function percentOf(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}
