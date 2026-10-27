ALTER TABLE templates ADD COLUMN purpose TEXT NOT NULL DEFAULT 'first_touch';
ALTER TABLE templates ADD COLUMN variants TEXT NOT NULL DEFAULT '[]';
