-- A workspace is a tenant: its own leads, templates, campaigns, knowledge, agents,
-- accounts and mail. `workspace_id` is added to every table that holds any of those, and
-- every list query filters on the active workspace.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Everything that already exists belongs to one workspace. Its name is whatever the old
-- `workspace_name` setting held, so the switcher looks unchanged after upgrading.
INSERT OR IGNORE INTO workspaces(id,name,created_at,updated_at)
  VALUES(
    'ws-default',
    REPLACE(COALESCE((SELECT value FROM app_settings WHERE key='workspace_name'), 'Maily'), '"', ''),
    datetime('now'),
    datetime('now')
  );

ALTER TABLE leads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE accounts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE templates ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE campaigns ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE knowledge ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE agent_defs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE agent_runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE inbox_messages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE send_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE message_drafts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws-default';

CREATE INDEX IF NOT EXISTS leads_workspace ON leads(workspace_id);
CREATE INDEX IF NOT EXISTS accounts_workspace ON accounts(workspace_id);
CREATE INDEX IF NOT EXISTS templates_workspace ON templates(workspace_id);
CREATE INDEX IF NOT EXISTS campaigns_workspace ON campaigns(workspace_id);
CREATE INDEX IF NOT EXISTS knowledge_workspace ON knowledge(workspace_id);
CREATE INDEX IF NOT EXISTS agent_defs_workspace ON agent_defs(workspace_id);
CREATE INDEX IF NOT EXISTS agent_runs_workspace ON agent_runs(workspace_id);
CREATE INDEX IF NOT EXISTS inbox_messages_workspace ON inbox_messages(workspace_id);
CREATE INDEX IF NOT EXISTS send_logs_workspace ON send_logs(workspace_id);
CREATE INDEX IF NOT EXISTS message_drafts_workspace ON message_drafts(workspace_id);

-- The workspace the UI is currently in. Single-user and local, so it is one setting
-- rather than an argument threaded through every command.
INSERT OR IGNORE INTO app_settings(key,value,updated_at)
  VALUES('current_workspace', '"ws-default"', datetime('now'));
