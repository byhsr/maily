import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Mail, Play, Plus, Trash2 } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  deleteCampaign,
  launchCampaign,
  loadCampaignGraph,
  pauseCampaign,
  saveCampaign,
  saveCampaignGraph,
  validateCampaignGraph,
} from "../lib/api";
import type { Campaign, NodeType, Template } from "../lib/types";
import { Input } from "../ui/Input";
import {
  NODE_META,
  PALETTE,
  defaultConfig,
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
import { canvasVars, nodeAccent, theme } from "./theme";

const nodeTypes = { campaign: NodeCard };
const DRAG_TYPE = "application/maily-node";
const CARD_HALF_WIDTH = 134;
const CARD_HALF_HEIGHT = 18;

type FlowSurfaceProps = {
  nodes: Node<CampaignNodeData>[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<CampaignNodeData>>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: (connection: Connection) => void;
  onSelectNode: (id?: string) => void;
  onDropNode: (type: NodeType, position: { x: number; y: number }) => void;
};

/** The React Flow surface plus the drop target for nodes dragged from the bar. */
function FlowSurface({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onSelectNode, onDropNode }: FlowSurfaceProps) {
  const { screenToFlowPosition } = useReactFlow();

  return (
    <div
      className="cv-flow"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData(DRAG_TYPE) as NodeType;
        if (!type || !NODE_META[type]) return;
        const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        onDropNode(type, { x: point.x - CARD_HALF_WIDTH, y: point.y - CARD_HALF_HEIGHT });
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(undefined)}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={theme.canvas.dot} />
        <MiniMap pannable zoomable maskColor="rgba(11,11,12,0.72)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

type CampaignCanvasProps = {
  campaigns: Campaign[];
  initialCampaignId?: string;
  templates: Template[];
  tell: (message: string) => void;
  onSelect: (campaignId?: string) => void;
  reload: () => void;
  onBack: () => void;
};

export function CampaignCanvas({ campaigns, initialCampaignId, templates, tell, onSelect, reload, onBack }: CampaignCanvasProps) {
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? "");
  const [creating, setCreating] = useState(!initialCampaignId);
  const [draftName, setDraftName] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CampaignNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(
    async (id: string) => {
      if (!id) {
        setNodes([]);
        setEdges([]);
        return;
      }
      const graph = await loadCampaignGraph(id);
      setNodes(toFlow({ nodes: graph.nodes, edges: graph.edges }, graph.counts, templates, []));
      setEdges(toEdges(graph.edges));
      setIssues([]);
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
      tell("Campaign created — add your first node");
    } catch (e) {
      tell(String(e));
    }
  };

  const removeCampaign = async () => {
    try {
      await deleteCampaign(campaignId);
      setConfirming(false);
      setCampaignId("");
      onSelect(undefined);
      reload();
      onBack();
      tell("Campaign deleted");
    } catch (e) {
      tell(String(e));
    }
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      const label = connection.sourceHandle && connection.sourceHandle !== "out" ? connection.sourceHandle : "next";
      setEdges((current) =>
        addEdge({ ...connection, id: newId("edge"), data: { label }, label: label === "next" ? undefined : label }, current)
      );
    },
    [setEdges]
  );

  const addNodeAt = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      const config = defaultConfig(type);
      setNodes((current) => [
        ...current,
        {
          id: newId(type),
          type: "campaign",
          position,
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
    },
    [setNodes, templates]
  );

  const addNode = (type: NodeType) => {
    const y = nodes.reduce((max, n) => Math.max(max, n.position.y), 0) + 160;
    addNodeAt(type, { x: 120, y });
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

  const selectedNode = nodes.find((node) => node.id === selected);

  return (
    <section className="canvaspage" style={canvasVars()}>
      <div className="cv-topbar">
        <button className="cv-back" onClick={onBack} title="Back to campaigns" aria-label="Back to campaigns">
          <ArrowLeft />
        </button>
        <span className="cv-logo">
          <i>
            <Mail />
          </i>
          maily
        </span>
        <span className="cv-divider" />
        <div className="cv-nodes">
          {PALETTE.map((type) => (
            <button
              className="cv-node-add"
              key={type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, type);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => addNode(type)}
              title={`Drag ${NODE_META[type].label} onto the canvas, or click to add`}
            >
              <i className="cv-dot" style={{ background: nodeAccent(type) }} />
              {NODE_META[type].label}
            </button>
          ))}
        </div>
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
            <button className="cv-pill" onClick={autoLayout}>
              Layout
            </button>
            <button className="cv-pill" onClick={runValidate}>
              Validate
            </button>
            <button className="cv-pill" onClick={() => setConfirming(true)}>
              <Trash2 />
              Delete
            </button>
            {running ? (
              <button className="cv-run" onClick={runPause}>
                Pause
              </button>
            ) : (
              <button className="cv-run" onClick={runLaunch} disabled={!campaignId} title="Validate, then start sending">
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
          <ReactFlowProvider>
            <FlowSurface
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onSelectNode={setSelected}
              onDropNode={addNodeAt}
            />
          </ReactFlowProvider>
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
          </div>
        </div>
      ) : (
        <div className="cv-wrap">
          <div className="cv-flow" />
          <div className="cv-panel">
            <h4>Get started</h4>
            <p>Name a campaign in the bar above, then drag nodes from the palette onto the canvas.</p>
          </div>
        </div>
      )}

      {confirming && (
        <div className="cv-confirm" onMouseDown={() => setConfirming(false)}>
          <div className="cv-confirm-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Delete this campaign?</h3>
            <p>
              The sequence, its enrolled leads and any pending sends are removed. This cannot be undone.
            </p>
            <div className="cv-confirm-actions">
              <button className="cv-pill" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="cv-run danger" onClick={removeCampaign}>
                Delete campaign
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
