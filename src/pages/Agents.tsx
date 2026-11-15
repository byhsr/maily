import { Bot, Pencil, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { analyzeStyle, listAgentRuns } from "../lib/api";
import { agentKindLabel, usageLabel, whenLabel } from "../lib/agents";
import type { AgentDef, AgentRun } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader } from "../ui/PageHeader";

type AgentsProps = {
  agents: AgentDef[];
  open: (kind: string) => void;
  onEdit: (agent: AgentDef) => void;
  tell: (message: string) => void;
};

export function Agents({ agents, open, onEdit, tell }: AgentsProps) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);

  const loadRuns = useCallback(() => {
    listAgentRuns(25)
      .then(setRuns)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadRuns();
    const timer = setInterval(loadRuns, 4000);
    return () => clearInterval(timer);
  }, [loadRuns]);

  const learnStyle = async () => {
    setBusy(true);
    try {
      await analyzeStyle();
      tell("Style profile written to the knowledge base");
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy(false);
      loadRuns();
    }
  };

  return (
    <>
      <PageHeader
        title="Agents"
        status={`${agents.length} agent${agents.length === 1 ? "" : "s"}`}
        tools={
          <Button variant="secondary" onClick={learnStyle} disabled={busy}>
            <Sparkles />
            {busy ? "Analysing…" : "Learn my style"}
          </Button>
        }
        action={
          <Button onClick={() => open("agent")}>
            <Plus />New agent
          </Button>
        }
      />

      <section className="sheet">

        {agents.length ? (
          <div className="agentgrid">
            {agents.map((agent) => (
              <article className="agentcard" key={agent.id}>
                <span className="agenticon">
                  <Bot />
                </span>
                <h3>{agent.name}</h3>
                <p className="muted">{agentKindLabel(agent.kind)}</p>
                <code>{agent.model || "no model set"}</code>
                <div className="agentmeta">
                  <Badge>{agent.enabled ? "enabled" : "disabled"}</Badge>
                  {agent.knowledge_categories.length > 0 && (
                    <span title={agent.knowledge_categories.join(", ")}>
                      {agent.knowledge_categories.length} KB group{agent.knowledge_categories.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {typeof agent.runs === "number" && <span>{agent.runs} run{agent.runs === 1 ? "" : "s"}</span>}
                  {!!agent.cost && <span>${agent.cost.toFixed(3)}</span>}
                </div>
                <button className="btn-icon agentedit" onClick={() => onEdit(agent)} aria-label={`Edit ${agent.name}`}>
                  <Pencil />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState text="No agents configured yet." action={() => open("agent")} />
        )}
      </section>

      <section className="sheet">
        <div className="sectiontitle">
          <h2>Recent runs</h2>
          <span>Newest first · refreshes every few seconds</span>
        </div>
        {runs.length ? (
          <div className="runrows">
            {runs.map((run) => (
              <div className={`runrow state-${run.state}`} key={run.id}>
                <i className="runstate" />
                <span>
                  <b>{agentKindLabel(run.kind)}</b>
                  <small>{run.error ? run.error : usageLabel(run) || "no usage reported"}</small>
                </span>
                <em>{run.model}</em>
                <span className="runwhen">{whenLabel(run.finished_at ?? run.created_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Card className="emptycard">
            <p className="muted">Nothing has run yet.</p>
          </Card>
        )}
      </section>
    </>
  );
}
