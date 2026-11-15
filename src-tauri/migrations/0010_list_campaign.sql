-- A campaign stops being a graph and becomes a simple list send: pick a lead list,
-- a template and a spacing, then send one email per lead. The graph tables stay for
-- history but are no longer written. `accounts.sent_date` is the day the `sent_today`
-- counter belongs to, so the counter can be reset once per day.
ALTER TABLE campaigns ADD COLUMN list_name TEXT;
ALTER TABLE campaigns ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE campaigns ADD COLUMN account_id TEXT;
ALTER TABLE campaigns ADD COLUMN last_sent_at TEXT;
ALTER TABLE accounts ADD COLUMN sent_date TEXT;
