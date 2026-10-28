-- The entry node for a campaign is now "audience" (which lead list to enroll)
-- rather than "start", so the node-type CHECK has to admit the new kind.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt and copied.
CREATE TABLE campaign_nodes_new (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('start','audience','email','delay','condition','action','end')),
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
