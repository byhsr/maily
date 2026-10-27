import { Bot } from "lucide-react";
import { Button } from "../ui/Button";

type AgentsProps = {
  open: (kind: string) => void;
};

export function Agents({ open }: AgentsProps) {
  return (
    <section className="agentpage">
      <span>✦ AGENT WORKBENCH</span>
      <h2>
        Small jobs.<br />
        <i>Better context.</i>
      </h2>
      <p>Research, qualify, draft and classify in isolated local work units.</p>
      <Button variant="ink" onClick={() => open("agent")}>
        Run a task <Bot />
      </Button>
    </section>
  );
}
