import { useState } from "react";
import { BarChart3 } from "lucide-react";
import type { StatsPoint } from "../lib/types";

const SERIES = [
  { key: "sent", label: "Sent", cls: "s-sent" },
  { key: "replied", label: "Replied", cls: "s-replied" },
  { key: "positive", label: "Positive", cls: "s-positive" },
] as const;

const W = 720;
const H = 200;
const PAD = 24;

export function LineChart({ series }: { series: StatsPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  // Drawing a flat line across an empty range reads as data; show the empty
  // state instead, inside the chart card.
  const empty = !series.length || series.every((p) => !p.sent && !p.replied && !p.positive);
  if (empty) {
    return (
      <div className="chartempty">
        <BarChart3 />
        <b>No data yet</b>
        <span>Sent, replied and positive counts appear here once a campaign runs.</span>
      </div>
    );
  }

  const max = Math.max(1, ...series.flatMap((p) => [p.sent, p.replied, p.positive]));
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, series.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const path = (key: "sent" | "replied" | "positive") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const point = hover === null ? null : series[hover];

  return (
    <div className="chart">
      <div className="chartlegend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i className={s.cls} />
            {s.label}
          </span>
        ))}
        {point && (
          <em className="charttip">
            {point.label} · {point.sent} sent · {point.replied} replied · {point.positive} positive
          </em>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          const index = Math.round(((rel - PAD) / (W - PAD * 2)) * (series.length - 1));
          setHover(Math.max(0, Math.min(series.length - 1, index)));
        }}
      >
        {SERIES.map((s) => (
          <path className={s.cls} key={s.key} d={path(s.key)} />
        ))}
        {point && <circle className="pt" cx={x(hover ?? 0)} cy={y(point.sent)} r="3.5" />}
      </svg>
    </div>
  );
}
