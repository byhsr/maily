-- The activity feed sits on Home beside the charts, so it is analytics and has to belong to
-- a workspace like the numbers next to it. Without this it listed every workspace's events,
-- and its `detail` carries addresses.
ALTER TABLE events ADD COLUMN workspace_id TEXT;
CREATE INDEX IF NOT EXISTS events_workspace ON events(workspace_id, created_at);

-- Rows written before there was more than one workspace are attributed to the oldest one,
-- which is the one 0018 named from the old `workspace_name` setting and therefore the only
-- workspace any of this history can have come from.
UPDATE events
   SET workspace_id = (SELECT id FROM workspaces ORDER BY created_at, rowid LIMIT 1);
