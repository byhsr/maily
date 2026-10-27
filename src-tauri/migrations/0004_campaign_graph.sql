CREATE TABLE IF NOT EXISTS campaign_nodes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('start','email','delay','condition','action','end')),
  config_json TEXT NOT NULL DEFAULT '{}',
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS campaign_nodes_campaign ON campaign_nodes(campaign_id);

CREATE TABLE IF NOT EXISTS campaign_edges (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'next' CHECK(label IN ('next','yes','no')),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS campaign_edges_campaign ON campaign_edges(campaign_id);

ALTER TABLE campaign_leads ADD COLUMN current_node_id TEXT;
ALTER TABLE campaign_leads ADD COLUMN entered_node_at TEXT;
ALTER TABLE campaign_leads ADD COLUMN outcome TEXT;
