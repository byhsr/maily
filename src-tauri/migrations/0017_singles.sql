-- A single email with follow-ups is a campaign that happens to have one lead and no
-- template. `kind` is what keeps it out of the Campaigns list while letting the one
-- scheduler drive it exactly like any other sequence.
ALTER TABLE campaigns ADD COLUMN kind TEXT NOT NULL DEFAULT 'campaign';
-- How a single's follow-ups behave when a reply, a bounce or an out-of-office lands.
ALTER TABLE campaigns ADD COLUMN stop_rules TEXT;

-- A single's step carries its own message instead of pointing at a template, and it
-- carries its own state because there is exactly one lead to send it to: `pending`
-- until it goes, then `sent`, `skipped` (a guard said no), `cancelled` or `failed`.
-- `template_id` therefore has to admit NULL, which SQLite only allows by rebuilding.
CREATE TABLE sequence_steps_new (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  delay_days INTEGER,
  template_id TEXT,
  body_md TEXT,
  body_html TEXT,
  body_text TEXT,
  subject_override TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  send_date TEXT,
  UNIQUE(campaign_id, position),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY(template_id) REFERENCES templates(id)
);

INSERT INTO sequence_steps_new(id,campaign_id,position,delay_minutes,template_id,status,enabled,send_date)
  SELECT id,campaign_id,position,delay_minutes,template_id,'pending',enabled,send_date FROM sequence_steps;

DROP TABLE sequence_steps;
ALTER TABLE sequence_steps_new RENAME TO sequence_steps;
