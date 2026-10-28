import { Bot } from "lucide-react";
import { Button } from "../ui/Button";
import { Topbar } from "../ui/Topbar";

type AgentsProps = {
  open: (kind: string) => void;
};

export function Agents({ open }: AgentsProps) {
  return (
    <>
      <Topbar status="Local" />
      <section className="agentpage">
        <h2>
          Small jobs.<br />
          <i>Better context.</i>
        </h2>
        <p>Research, qualify, draft and classify in isolated local work units.</p>
        <Button variant="ink" onClick={() => open("agent")}>
          Run a task <Bot />
        </Button>
      </section>
    </>
  );
}
