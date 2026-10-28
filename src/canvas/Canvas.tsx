import { useCallback, useEffect, useState } from "react";
import { Mail, Play, Plus } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  launchCampaign,
  loadCampaignGraph,
  pauseCampaign,
  previewPath,
  saveCampaign,
  saveCampaignGraph,
  validateCampaignGraph,
} from "../lib/api";
import type { Campaign, Lead, NodeType, Template } from "../lib/types";
import { Input } from "../ui/Input";
import {
  NODE_META,
  defaultConfig,
  defaultFlow,
  fromFlow,
  layoutGraph,
  newId,
  summarize,
  toEdges,
  toFlow,
  type CampaignNodeData,
} from "./graph";
import { Inspector } from "./Inspector";
import { NodeCard } from "./NodeCard";
import { Palette } from "./Palette";
import { canvasVars, theme } from "./theme";

const nodeTypes = { campaign: NodeCard };

type CampaignCanvasProps = {
  campaigns: Campaign[];
  initialCampaignId?: string;
  templates: Template[];
  leads: Lead[];
  tell: (message: string) => void;
  onSelect: (campaignId?: string) => void;
  reload: () => void;
};

export function CampaignCanvas({ campaigns, initialCampaignId, templates, leads, tell, onSelect, reload }: CampaignCanvasProps) {
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? "");
  const [creating, setCreating] = useState(!initialCampaignId);
  const [draftName, setDraftName] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CampaignNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [previewLead, setPreviewLead] = useState("");
  const [selected, setSelected] = useState<string>();
  const [running, setRunning] = useState(false);

  const refresh = useCallback(
    async (id: string) => {
      if (!id) {
        setNodes([]);
        setEdges([]);
        return;
      }
      const graph = await loadCampaignGraph(id);
      const base = graph.nodes.length ? { nodes: graph.nodes, edges: graph.edges } : defaultFlow();
      setNodes(toFlow(base, graph.counts, templates, []));
      setEdges(toEdges(base.edges));
      setIssues([]);
      setPath([]);
      setSelected(undefined);
    },
    [setNodes, setEdges, templates]
  );

  useEffect(() => {
    refresh(campaignId).catch((e) => tell(String(e)));
  }, [campaignId, refresh, tell]);

  useEffect(() => {
    if (initialCampaignId) {
      setCampaignId(initialCampaignId);
      setCreating(false);
    }
  }, [initialCampaignId]);

  useEffect(() => {
    const current = campaigns.find((c) => c.id === campaignId);
    setRunning(current?.status === "active");
  }, [campaigns, campaignId]);

  const startCreating = () => {
    setCampaignId("");
    setDraftName("");
    setCreating(true);
    onSelect(undefined);
  };

  const cancelCreating = () => {
    const fallback = initialCampaignId ?? campaigns[0]?.id ?? "";
    setCreating(false);
    setDraftName("");
    setCampaignId(fallback);
    onSelect(fallback);
  };

  const createCampaign = async () => {
    const name = draftName.trim();
    if (!name) {
      tell("Name the campaign first");
      return;
    }
    try {
      const created = await saveCampaign({
        name,
        template_id: null,
        mode: "draft",
        schedule: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
      setCreating(false);
      setDraftName("");
      setCampaignId(created);
      onSelect(created);
      reload();
      tell("Campaign created — build the sequence");
    } catch (e) {
      tell(String(e));
    }
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      const label = connection.sourceHandle && connection.sourceHandle !== "out" ? connection.sourceHandle : "next";
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: newId("edge"),
            data: { label },
            label: label === "next" ? undefined : label,
            animated: false,
          },
          current
        )
      );
    },
    [setEdges]
  );

  const addNode = (type: NodeType) => {
    const y = nodes.reduce((max, n) => Math.max(max, n.position.y), 0) + 160;
    const config = defaultConfig(type);
    setNodes((current) => [
      ...current,
      {
        id: newId(type),
        type: "campaign",
        position: { x: 320, y },
        data: {
          nodeType: type,
          kind: NODE_META[type].label,
          label: NODE_META[type].label,
          summary: summarize(type, config, templates),
          count: 0,
          invalid: false,
          branches: Boolean(NODE_META[type].branches),
          config,
        },
      },
    ]);
  };

  const updateConfig = (id: string, patch: Record<string, unknown>) => {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== id) return node;
        const config = { ...node.data.config, ...patch };
        return { ...node, data: { ...node.data, config, summary: summarize(node.data.nodeType, config, templates) } };
      })
    );
  };

  const deleteSelected = () => {
    if (!selected) return;
    setNodes((current) => current.filter((node) => node.id !== selected));
    setEdges((current) => current.filter((edge) => edge.source !== selected && edge.target !== selected));
    setSelected(undefined);
  };

  const persist = () => {
    const graph = fromFlow(nodes, edges);
    return saveCampaignGraph(campaignId, graph.nodes, graph.edges);
  };

  const autoLayout = () => {
    const graph = fromFlow(nodes, edges);
    const laid = layoutGraph(graph.nodes, graph.edges);
    setNodes((current) =>
      current.map((node) => {
        const found = laid.find((n) => n.id === node.id);
        return found ? { ...node, position: { x: found.x, y: found.y } } : node;
      })
    );
  };

  const runValidate = async () => {
    try {
      await persist();
      const result = await validateCampaignGraph(campaignId);
      setIssues(result.issues);
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, invalid: result.node_ids.includes(node.id) } })));
      tell(result.valid ? "Graph is valid" : `${result.issues.length} issue(s) to fix`);
      return result.valid;
    } catch (e) {
      tell(String(e));
      return false;
    }
  };

  const runLaunch = async () => {
    try {
      await persist();
      const enrolled = await launchCampaign(campaignId);
      setRunning(true);
      tell(`Running — ${enrolled} lead(s) enrolled`);
      await refresh(campaignId);
    } catch (e) {
      tell(String(e));
    }
  };

  const runPause = async () => {
    try {
      await pauseCampaign(campaignId);
      setRunning(false);
      tell("Campaign paused");
    } catch (e) {
      tell(String(e));
    }
  };

  const runPreview = async () => {
    if (!previewLead) {
      tell("Pick a lead to preview the path");
      return;
    }
    try {
      const steps = await previewPath(campaignId, previewLead);
      setPath(steps.map((step) => `${NODE_META[step.type].label}${step.detail ? ` · ${step.detail}` : ""}`));
    } catch (e) {
      tell(String(e));
    }
  };

  const selectedNode = nodes.find((node) => node.id === selected);

  return (
    <section className="canvaspage" style={canvasVars()}>
      <div className="cv-topbar">
        <span className="cv-logo">
          <i>
            <Mail />
          </i>
          maily
        </span>
        <button className="cv-pill on">Workflow</button>
        <button className="cv-pill" onClick={() => setPath([])}>
          Campaign
        </button>
        <button className="cv-pill" onClick={() => tell("Wire a node to its ports, then Run.")}>
          Help
        </button>
        <span className="cv-spacer" />
        {creating ? (
          <>
            <Input
              className="cv-inset"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createCampaign();
              }}
              placeholder="Campaign name"
              autoFocus
            />
            <button className="cv-run" onClick={createCampaign}>
              <Plus />
              Create
            </button>
            {campaigns.length > 0 && (
              <button className="cv-pill" onClick={cancelCreating}>
                Cancel
              </button>
            )}
          </>
        ) : (
          <>
            <select
              className="cv-pill"
              value={campaignId}
              onChange={(e) => {
                setCampaignId(e.target.value);
                onSelect(e.target.value);
              }}
            >
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="cv-pill" onClick={startCreating}>
              <Plus />
              New
            </button>
            <select className="cv-pill" value={previewLead} onChange={(e) => setPreviewLead(e.target.value)}>
              <option value="">Preview as…</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.email}
                </option>
              ))}
            </select>
            <button className="cv-pill" onClick={autoLayout}>
              Layout
            </button>
            <button className="cv-pill" onClick={runValidate}>
              Validate
            </button>
            <button className="cv-pill" onClick={runPreview}>
              Preview
            </button>
            {running ? (
              <button className="cv-run" onClick={runPause}>
                Pause
              </button>
            ) : (
              <button
                className="cv-run"
                onClick={runLaunch}
                disabled={!campaignId}
                title="Validate, then start sending"
              >
                <Play />
                Run
              </button>
            )}
            <button
              className="cv-pill"
              onClick={() => {
                persist()
                  .then(() => tell("Graph saved"))
                  .catch((e) => tell(String(e)));
              }}
            >
              Save
            </button>
          </>
        )}
      </div>

      {campaignId ? (
        <div className="cv-wrap">
          <Palette onAdd={addNode} />
          <div className="cv-flow">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(undefined)}
              proOptions={{ hideAttribution: false }}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={theme.canvas.dot} />
              <MiniMap pannable zoomable maskColor="rgba(11,11,12,0.72)" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <div className="cv-panel">
            <Inspector
              node={selectedNode}
              templates={templates}
              onChange={(patch) => selected && updateConfig(selected, patch)}
              onDelete={deleteSelected}
            />
            {issues.length > 0 && (
              <div className="cv-panel">
                <h4>Issues</h4>
                <ul className="cv-issues">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            {path.length > 0 && (
              <div className="cv-panel">
                <h4>Preview path</h4>
                <ol className="cv-path">
                  {path.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="cv-wrap">
          <div className="cv-panel">
            <h4>Add node</h4>
            <p>Name a campaign in the bar above to start building.</p>
          </div>
          <div className="cv-flow" />
          <div className="cv-panel" />
        </div>
      )}
    </section>
  );
}
