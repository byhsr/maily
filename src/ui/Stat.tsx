import { Sparkline } from "./Sparkline";

type StatProps = {
  label: string;
  value: number;
  suffix?: string;
  delta?: number;
  spark?: number[];
};

export function Stat({ label, value, suffix, delta, spark }: StatProps) {
  return (
    <article>
      <small>{label}</small>
      <strong>
        {value}
        {suffix}
      </strong>
      <div className="statfoot">
        {typeof delta === "number" && (
          <span className={delta >= 0 ? "deltaup" : "deltadown"}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%
          </span>
        )}
        {spark && spark.length > 1 && <Sparkline points={spark} />}
      </div>
    </article>
  );
}
