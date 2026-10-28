-- The classifier node judges a reply into one of five labels, each of which is
-- its own output port, so both the node-type and the edge-label CHECKs have to
-- widen. SQLite cannot alter a CHECK, so both tables are rebuilt and copied.
CREATE TABLE campaign_nodes_new (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('start','audience','email','delay','condition','action','classifier','end')),
  config_json TEXT NOT NULL DEFAULT '{}',
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
INSERT INTO campaign_nodes_new(id,campaign_id,type,config_json,x,y)
  SELECT id,campaign_id,type,config_json,x,y FROM campaign_nodes;
DROP TABLE campaign_nodes;
ALTER TABLE campaign_nodes_new RENAME TO campaign_nodes;
CREATE INDEX IF NOT EXISTS campaign_nodes_campaign ON campaign_nodes(campaign_id);

CREATE TABLE campaign_edges_new (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'next' CHECK(label IN ('next','yes','no','positive','negative','question','ooo','unsubscribe')),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
INSERT INTO campaign_edges_new(id,campaign_id,from_node,to_node,label)
  SELECT id,campaign_id,from_node,to_node,label FROM campaign_edges;
DROP TABLE campaign_edges;
ALTER TABLE campaign_edges_new RENAME TO campaign_edges;
CREATE INDEX IF NOT EXISTS campaign_edges_campaign ON campaign_edges(campaign_id);

-- Every judgement is kept, including the unusable ones, so a model that keeps
-- guessing wrong is visible rather than silent.
CREATE TABLE IF NOT EXISTS reply_judgements (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  message_id TEXT,
  node_id TEXT,
  model TEXT NOT NULL,
  label TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reply_judgements_lead ON reply_judgements(campaign_id, lead_id);
