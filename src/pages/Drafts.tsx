import { ArrowLeft, Check, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { approveDraft, generateDrafts, listDrafts, loadCampaignGraph, rejectDraft } from "../lib/api";
import { whenLabel } from "../lib/agents";
import type { EmailDraft, GraphNode } from "../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { Topbar } from "../ui/Topbar";

type DraftsProps = {
  campaignId: string;
  tell: (message: string) => void;
  onBack: () => void;
};

export function Drafts({ campaignId, tell, onBack }: DraftsProps) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    listDrafts(campaignId)
      .then(setDrafts)
      .catch((e) => tell(String(e)));
  }, [campaignId, tell]);

  useEffect(() => {
    load();
    loadCampaignGraph(campaignId)
      .then((graph) => {
        const emailNodes = graph.nodes.filter((node) => node.type === "email");
        setNodes(emailNodes);
        setNodeId(emailNodes[0]?.id ?? "");
      })
      .catch(() => setNodes([]));
  }, [campaignId, load]);

  const generate = async () => {
    if (!nodeId) {
      tell("Add an email node to this campaign first");
      return;
    }
    setBusy("generate");
    try {
      const queued = await generateDrafts(campaignId, nodeId, 10);
      tell(queued ? `Drafting ${queued} email(s) — they will appear here shortly` : "Every enrolled lead already has a draft");
      // Give the queued runs a moment, then refresh.
      setTimeout(load, 4000);
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const approve = async (draft: EmailDraft) => {
    setBusy(draft.id);
    try {
      await approveDraft(draft.id, draft.subject, draft.body);
      tell("Draft approved — the campaign may send it");
      load();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const reject = async (draft: EmailDraft) => {
    setBusy(draft.id);
    try {
      await rejectDraft(draft.id);
      tell("Draft rejected");
      load();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const edit = (id: string, patch: Partial<EmailDraft>) => {
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  };

  const proposed = drafts.filter((draft) => draft.state === "proposed");
  const approved = drafts.filter((draft) => draft.state === "approved");

  return (
    <>
      <Topbar
        status={`${proposed.length} awaiting review · ${approved.length} approved`}
        action={
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft />
            Campaigns
          </Button>
        }
      />

      <section className="sheet">
        <header>
          <h2>Drafts</h2>
          <div className="actions">
            {nodes.length > 1 && (
              <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="Email node">
                {nodes.map((node, index) => (
                  <option key={node.id} value={node.id}>
                    Email node {index + 1}
                  </option>
                ))}
              </select>
            )}
            <Button variant="ink" onClick={generate} disabled={busy === "generate"}>
              <Sparkles />
              {busy === "generate" ? "Queueing…" : "Write drafts for this node"}
            </Button>
          </div>
        </header>

        {drafts.length ? (
          <div className="draftlist">
            {drafts.map((draft) => (
              <article className={`draftcard state-${draft.state}`} key={draft.id}>
                <header>
                  <span>
                    <b>{draft.first_name || draft.email}</b>
                    <small>
                      {draft.company || draft.email} · {whenLabel(draft.created_at)}
                    </small>
                  </span>
                  <Badge>{draft.state}</Badge>
                </header>
                <Input
                  value={draft.subject}
                  onChange={(e) => edit(draft.id, { subject: e.target.value })}
                  aria-label="Draft subject"
                  disabled={draft.state !== "proposed"}
                />
                <textarea
                  value={draft.body}
                  onChange={(e) => edit(draft.id, { body: e.target.value })}
                  aria-label="Draft body"
                  disabled={draft.state !== "proposed"}
                />
                {draft.rationale && <p className="muted">{draft.rationale}</p>}
                {draft.state === "proposed" && (
                  <div className="settingsrow">
                    <Button variant="ink" onClick={() => approve(draft)} disabled={busy === draft.id}>
                      <Check />
                      Approve
                    </Button>
                    <Button variant="ghost" onClick={() => reject(draft)} disabled={busy === draft.id}>
                      <X />
                      Reject
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            text="No drafts for this campaign yet. Write a batch, then review the wording before anything sends."
            action={generate}
          />
        )}
      </section>
    </>
  );
}
