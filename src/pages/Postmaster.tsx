import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { domainPosture, listAccounts, postmasterReport } from "../lib/api";
import { LEVEL_LABEL } from "../lib/spam";
import type { DomainPosture, PostmasterReport } from "../lib/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";

type PostmasterProps = {
  tell: (message: string) => void;
};

const CHECK_LABEL: Record<string, string> = { pass: "Pass", warn: "Warn", fail: "Missing" };

/** Google's statistics are ratios, so they are shown as percentages. */
function pct(value?: number | null): string {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "—";
}

/**
 * The Postmaster: two independent reads of the same domain. The checks are ours — what
 * the DNS records say, worked out locally. Gmail's statistics are Google's own
 * measurement, for a domain verified in Postmaster Tools. One click runs both.
 */
export function Postmaster({ tell }: PostmasterProps) {
  const [domain, setDomain] = useState("");
  const [result, setResult] = useState<DomainPosture | null>(null);
  const [google, setGoogle] = useState<PostmasterReport | null>(null);
  const [busy, setBusy] = useState(false);

  // Default to the domain mail is actually sent from, so the first check is useful.
  useEffect(() => {
    listAccounts()
      .then((accounts) => {
        const address = accounts[0]?.email ?? "";
        const at = address.lastIndexOf("@");
        if (at > -1) setDomain(address.slice(at + 1));
      })
      .catch(() => {
        /* the connected-account list is best-effort */
      });
  }, []);

  const check = async () => {
    const target = domain.trim();
    if (!target) {
      tell("Enter a domain to check");
      return;
    }
    setBusy(true);
    try {
      // The local checks and Google's telemetry are independent; one failing must not
      // hide the other.
      setResult(await domainPosture(target));
    } catch (error) {
      tell(String(error));
    }
    try {
      setGoogle(await postmasterReport(target));
    } catch (error) {
      setGoogle({ available: false, reason: String(error) });
    }
    setBusy(false);
  };

  const spamRate = google?.spam_rate;
  const spamTone = typeof spamRate !== "number" ? "none" : spamRate > 0.003 ? "bad" : spamRate > 0.001 ? "warn" : "good";
  const errorRate = google?.delivery_error_rate;
  const errorTone = typeof errorRate !== "number" ? "none" : errorRate > 0.02 ? "bad" : errorRate > 0.005 ? "warn" : "good";

  return (
    <section>
      <PageHeader
        title="Postmaster"
        status={result ? `${result.domain} · ${LEVEL_LABEL[result.level]}` : "Domain deliverability"}
        tools={
          <Input
            value={domain}
            aria-label="Domain to check"
            placeholder="example.com"
            onChange={(event) => setDomain(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void check();
            }}
          />
        }
        action={
          <Button onClick={() => void check()} disabled={busy}>
            <ShieldCheck size={16} />
            {busy ? "Checking…" : "Check domain"}
          </Button>
        }
      />

      <div className="postmaster">
        {result ? (
          <>
            <article className="pmscore" data-level={result.level}>
              <div>
                <small>Spam score</small>
                <strong>{result.score}</strong>
                <span className="pmlevel">{LEVEL_LABEL[result.level]}</span>
              </div>
              <p>
                {result.domain} · 0–100, lower is better. Scores SPF, DKIM, DMARC and MX — the
                four things a receiving provider checks before it trusts mail from a domain.
              </p>
            </article>

            <section className="sheet">
              <header>
                <h2>Checks</h2>
                <span className="quota">
                  {result.checks.filter((c) => c.status === "pass").length} of {result.checks.length} passing
                </span>
              </header>
              <div className="pmchecks">
                {result.checks.map((c) => (
                  <div className={`pmcheck st-${c.status}`} key={c.id}>
                    <div className="pmcheckhead">
                      <i className="pmdot" />
                      <b>{c.label}</b>
                      <span className="pmstate">{CHECK_LABEL[c.status] ?? c.status}</span>
                    </div>
                    <code>{c.detail}</code>
                    <small>{c.hint}</small>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : (
          <Card className="emptycard">
            <p className="muted">
              Check a sending domain to see how a receiving provider is likely to treat mail from it.
            </p>
          </Card>
        )}

        {google && (
          <section className="sheet">
            <header>
              <h2>Gmail statistics</h2>
              <span className="quota">{google.account ?? "Google Postmaster"}</span>
            </header>

            {!google.available || !google.reported ? (
              <>
                <p className="pmnote">{google.reason ?? "Google has nothing for this domain yet."}</p>
                {/* The facts behind the message: what Google actually granted. */}
                {google.granted && google.granted.length > 0 && (
                  <p className="pmnote">
                    Granted to this account: <code>{google.granted.join(" · ")}</code>
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="pmgrid">
                  <div className="pmmetric">
                    <small>User-reported spam</small>
                    <b className={`tone-${spamTone}`}>{pct(spamRate)}</b>
                    <span>Under 0.1% is healthy; over 0.3% gets throttled.</span>
                  </div>
                  <div className="pmmetric">
                    <small>SPF success</small>
                    <b>{pct(google.spf_success)}</b>
                  </div>
                  <div className="pmmetric">
                    <small>DKIM success</small>
                    <b>{pct(google.dkim_success)}</b>
                  </div>
                  <div className="pmmetric">
                    <small>DMARC success</small>
                    <b>{pct(google.dmarc_success)}</b>
                  </div>
                  <div className="pmmetric">
                    <small>Delivery errors</small>
                    <b className={`tone-${errorTone}`}>{pct(errorRate)}</b>
                  </div>
                </div>

                <p className="pmnote">
                  Measured by Gmail for {google.domain} over {google.start} – {google.end}. Gmail
                  only reports domains that send to at least 50 users a day, and only for a domain
                  verified in Postmaster Tools.
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
