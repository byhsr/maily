-- Agents stop being anonymous runs: agent_defs holds the configuration, and a
-- run can point at the agent, lead and campaign it belongs to.
CREATE TABLE IF NOT EXISTS agent_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  knowledge_categories TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE agent_runs ADD COLUMN agent_id TEXT;
ALTER TABLE agent_runs ADD COLUMN lead_id TEXT;
ALTER TABLE agent_runs ADD COLUMN campaign_id TEXT;
ALTER TABLE agent_runs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cost REAL NOT NULL DEFAULT 0;

-- An agent writes a draft; nothing is sent until a human approves it.
CREATE TABLE IF NOT EXISTS email_drafts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  node_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','sent','failed')),
  rationale TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS email_drafts_pending ON email_drafts(campaign_id, state);

-- Style analysis needs a corpus of what was actually written; until now the
-- rendered message was never stored.
ALTER TABLE send_logs ADD COLUMN subject TEXT;
ALTER TABLE send_logs ADD COLUMN body TEXT;

INSERT OR IGNORE INTO agent_defs(id,name,kind,model,system_prompt,knowledge_categories,enabled,created_at,updated_at) VALUES
  ('agent-first-touch','First-touch drafter','draft','ollama:llama3.2','You write a first cold email that earns a reply. Keep it under 120 words, no buzzwords, one clear ask, and sign off plainly.','["offer","icp","style","proof"]',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
  ('agent-followup','Follow-up drafter','followup','ollama:llama3.2','You write a short follow-up that adds one new angle rather than repeating the first email. Two or three sentences.','["offer","icp","style"]',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
  ('agent-style','Style analyst','style_analysis','ollama:llama3.2','You read the operator''s own writing and describe its voice precisely, with concrete do and do-not rules.','[]',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
  ('agent-classify','Reply classifier','classify_reply','ollama:llama3.2','You judge cold-email replies into exactly one allowed label, and never invent intent that is not present.','[]',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
