-- A campaign becomes a sequence: step 0 is the initial email (campaigns.template_id),
-- each `sequence_steps` row is a follow-up (position >= 1) that waits `delay_minutes`
-- or fires on a fixed `send_date` (the date wins when both are set).
ALTER TABLE sequence_steps ADD COLUMN send_date TEXT;

-- Per-lead progress through the sequence, persisted so an app restart catches up on
-- anything that came due while it was closed.
ALTER TABLE campaign_leads ADD COLUMN step_position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads ADD COLUMN next_due_at TEXT;
ALTER TABLE campaign_leads ADD COLUMN thread_ref TEXT;

-- One lead can now produce several sends, so record which step each send was.
ALTER TABLE send_logs ADD COLUMN step_position INTEGER NOT NULL DEFAULT 0;
