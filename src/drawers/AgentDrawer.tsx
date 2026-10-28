import { useEffect, useState } from "react";
import { deleteAgent, listAgentRuns, listOpenrouterModels, runAgent, saveAgent } from "../lib/api";
import { AGENT_KIND_LABELS, usageLabel } from "../lib/agents";
import { KNOWLEDGE_CATEGORIES } from "../lib/knowledge";
import type { AgentDef, AgentRun, LlmModel } from "../lib/types";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Input } from "../ui/Input";
import { ModelPicker } from "../ui/ModelPicker";

type AgentDrawerProps = {
  close: () => void;
  agent?: AgentDef;
  reload: () => void;
  tell: (message: string) => void;
};

export function AgentDrawer({ close, agent, reload, tell }: AgentDrawerProps) {
  const [name, setName] = useState(agent?.name ?? "");
  const [kind, setKind] = useState(agent?.kind ?? "draft");
  const [model, setModel] = useState(agent?.model ?? "");
  const [prompt, setPrompt] = useState(agent?.system_prompt ?? "");
  const [categories, setCategories] = useState<string[]>(agent?.knowledge_categories ?? []);
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [catalog, setCatalog] = useState<LlmModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runInput, setRunInput] = useState('{"lead":""}');
  const [run, setRun] = useState<AgentRun | undefined>();

  useEffect(() => {
    listOpenrouterModels()
      .then(setCatalog)
      .catch(() => {});
  }, []);

  const toggleCategory = (id: string) => {
    setCategories((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const save = async () => {
    if (!name.trim()) {
      tell("Give the agent a name");
      return;
    }
    setBusy(true);
    try {
      await saveAgent({
        id: agent?.id ?? null,
        name,
        kind,
        model,
        system_prompt: prompt,
        knowledge_categories: categories,
        enabled,
      });
      reload();
      tell(agent ? "Agent updated" : "Agent created");
      close();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      await deleteAgent(agent.id);
      reload();
      tell("Agent deleted");
      close();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  /** Runs the agent once and polls until it leaves the queue, so errors surface. */
  const test = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(runInput);
    } catch {
      tell("That input is not valid JSON");
      return;
    }
    setBusy(true);
    setRun(undefined);
    try {
      const id = await runAgent({ kind, model, input: parsed, agent_id: agent?.id ?? null });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const runs = await listAgentRuns(5);
        const match = runs.find((item) => item.id === id);
        if (match && match.state !== "queued" && match.state !== "running") {
          setRun(match);
          tell(match.error ? "Run failed" : "Run completed");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      tell("Run is taking longer than a minute; check Recent runs");
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawerform">
      <p>An agent is instructions plus a model plus the knowledge it may read.</p>
      <label>
        Name
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="First-touch drafter" />
      </label>
      <label>
        Task
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(AGENT_KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <ModelPicker
          value={model}
          onChange={setModel}
          catalog={catalog}
          placeholder="anthropic/claude-3.5-haiku or ollama:llama3.2"
        />
      </label>
      <label>
        Instructions
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="How this agent should write or judge. Layered on top of the task's base rules."
        />
      </label>

      <h3>Knowledge this agent may read</h3>
      <div className="knowpick">
        {KNOWLEDGE_CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            className={categories.includes(entry.id) ? "pick on" : "pick"}
            onClick={() => toggleCategory(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <small>
        {categories.length
          ? "Only approved entries in these groups are added to the prompt."
          : "Nothing selected — every approved entry is added to the prompt."}
      </small>

      <label className="knowtoggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>
          <b>Enabled</b>
          <small>Disabled agents are skipped when drafts are generated.</small>
        </span>
      </label>

      <div className="settingsrow">
        <Button variant="ink" onClick={save} disabled={busy}>
          {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
        </Button>
        {agent && (
          <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
            Delete
          </Button>
        )}
      </div>

      {agent && (
        <>
          <hr />
          <h3>Run once</h3>
          <label>
            Input JSON
            <textarea value={runInput} onChange={(e) => setRunInput(e.target.value)} />
          </label>
          <Button variant="ghost" onClick={test} disabled={busy}>
            {busy ? "Running…" : "Run this agent"}
          </Button>
          {run && (
            <div className={`runresult state-${run.state}`}>
              {run.error ? (
                <p>{run.error}</p>
              ) : (
                <>
                  <small>{usageLabel(run)}</small>
                  <pre className="promptpreview">{JSON.stringify(run.output, null, 2)}</pre>
                </>
              )}
            </div>
          )}
        </>
      )}

      {confirming && (
        <Confirm
          title={`Delete ${agent?.name}?`}
          message="Its configuration is removed. Past runs stay in the history."
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
