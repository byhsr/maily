-- Knowledge entries gain tags, a provenance marker and an ordering weight so the
-- same table can hold offers, ICPs, style profiles, proof points and objections,
-- and so order in the prompt block is controllable.
ALTER TABLE knowledge ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE knowledge ADD COLUMN weight INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS knowledge_category ON knowledge(category);
