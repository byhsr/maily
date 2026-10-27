import { Bot } from "lucide-react";
import { useState } from "react";
import { runAgent } from "../lib/api";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

const TASKS = ["research", "qualify", "draft", "classify_reply", "followup_decision"];

type AgentDrawerProps = {
  tell: (message: string) => void;
};

export function AgentDrawer({ tell }: AgentDrawerProps) {
  const [kind, setKind] = useState("research");
  const [model, setModel] = useState("ollama:llama3.2");
  const [input, setInput] = useState('{"prospect":""}');

  return (
    <div className="drawerform">
      <p>Each agent run is bounded, isolated and stored as structured output.</p>
      <label>
        Task
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {TASKS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Model
        <Input value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        Input JSON
        <textarea value={input} onChange={(e) => setInput(e.target.value)} />
      </label>
      <Button
        onClick={async () => {
          try {
            await runAgent({ kind, model, input: JSON.parse(input) });
            tell("Agent task queued");
          } catch (e) {
            tell(String(e));
          }
        }}
      >
        Run task <Bot />
      </Button>
    </div>
  );
}
