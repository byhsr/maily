-- Subject lines a campaign's first touch can go out with, tested against each other.
-- Position 0 is the original; the rest are challengers. Follow-ups thread with "Re:" into
-- the first email, so only the first touch is split.
CREATE TABLE IF NOT EXISTS campaign_subjects (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS campaign_subjects_campaign ON campaign_subjects(campaign_id, position);

-- Which subject a lead was given, so one person reads the same line all the way through and
-- the tally per variant is exact rather than inferred from send order.
ALTER TABLE campaign_leads ADD COLUMN subject_variant INTEGER;

-- Every subject line ever written, so one that worked can be found again. Unique per
-- workspace: the same line written twice is one entry, not two.
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_line ON subjects(workspace_id, subject);
