import { useCallback, useEffect, useState } from "react";
import {
  Background,
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
  saveCampaignGraph,
  validateCampaignGraph,
} from "../lib/api";
import type { Campaign, Lead, NodeType, Template } from "../lib/types";
import { Button } from "../ui/Button";
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

const nodeTypes = { campaign: NodeCard };

type CampaignCanvasProps = {
  campaigns: Campaign[];
  initialCampaignId?: string;
  templates: Template[];
  leads: Lead[];
  tell: (message: string) => void;
};

export function CampaignCanvas({ campaigns, initialCampaignId, templates, leads, tell }: CampaignCanvasProps) {
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? campaigns[0]?.id ?? "");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CampaignNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [previewLead, setPreviewLead] = useState("");
  const [selected, setSelected] = useState<string>();

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

  const onConnect = useCallback(
    (connection: Connection) => {
      const label = connection.sourceHandle === "yes" ? "yes" : connection.sourceHandle === "no" ? "no" : "next";
      setEdges((current) =>
        addEdge(
          { ...connection, id: newId("edge"), data: { label }, label: label === "next" ? undefined : label, animated: label !== "next" },
          current
        )
      );
    },
    [setEdges]
  );

  const addNode = (type: NodeType) => {
    const y = nodes.reduce((max, n) => Math.max(max, n.position.y), 0) + 150;
    const config = defaultConfig(type);
    setNodes((current) => [
      ...current,
      {
        id: newId(type),
        type: "campaign",
        position: { x: 320, y },
        data: {
          nodeType: type,
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
    } catch (e) {
      tell(String(e));
    }
  };

  const runLaunch = async () => {
    try {
      await persist();
      const enrolled = await launchCampaign(campaignId);
      tell(`Launched for ${enrolled} lead(s)`);
      await refresh(campaignId);
    } catch (e) {
      tell(String(e));
    }
  };

  const runPause = async () => {
    try {
      await pauseCampaign(campaignId);
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
    <section className="canvaspage">
      <div className="canvastools">
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={autoLayout}>
          Auto-layout
        </Button>
        <Button variant="ghost" onClick={runValidate}>
          Validate
        </Button>
        <select value={previewLead} onChange={(e) => setPreviewLead(e.target.value)}>
          <option value="">Preview as…</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.email}
            </option>
          ))}
        </select>
        <Button variant="ghost" onClick={runPreview}>
          Preview path
        </Button>
        <Button onClick={runLaunch}>Launch</Button>
        <Button variant="ghost" onClick={runPause}>
          Pause
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            persist()
              .then(() => tell("Graph saved"))
              .catch((e) => tell(String(e)));
          }}
        >
          Save
        </Button>
      </div>
      <div className="canvaswrap">
        <Palette onAdd={addNode} />
        <div className="canvasflow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelected(node.id)}
            onPaneClick={() => setSelected(undefined)}
            fitView
          >
            <Background />
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>
        <div className="canvaspanel">
          <Inspector
            node={selectedNode}
            templates={templates}
            onChange={(patch) => selected && updateConfig(selected, patch)}
            onDelete={deleteSelected}
          />
          {issues.length > 0 && (
            <div className="canvasissues">
              <span className="raillabel">Issues</span>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {path.length > 0 && (
            <div className="canvaspath">
              <span className="raillabel">Preview path</span>
              <ol>
                {path.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
