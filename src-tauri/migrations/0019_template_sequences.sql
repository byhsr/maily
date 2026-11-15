-- A template can be one step of a sequence: the first touch and the follow-ups that
-- chase it are saved together, share a `sequence_id`, and carry their order and their
-- default wait. A standalone template simply has no sequence.
ALTER TABLE templates ADD COLUMN sequence_id TEXT;
ALTER TABLE templates ADD COLUMN step_position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN delay_days INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS templates_sequence ON templates(sequence_id);
