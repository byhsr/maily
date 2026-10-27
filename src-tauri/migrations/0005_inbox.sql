CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT 'blue',
  sort INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE inbox_messages ADD COLUMN category TEXT;
ALTER TABLE inbox_messages ADD COLUMN confidence REAL;
ALTER TABLE inbox_messages ADD COLUMN classified_by TEXT;
ALTER TABLE inbox_messages ADD COLUMN channel_id TEXT;
ALTER TABLE inbox_messages ADD COLUMN read_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_messages ADD COLUMN snoozed_until TEXT;

INSERT OR IGNORE INTO channels(id,name,color,sort,is_system) VALUES
  ('ch-interested','Interested','mint',1,1),
  ('ch-question','Question','blue',2,1),
  ('ch-not-now','Not now','lilac',3,1),
  ('ch-not-interested','Not interested','peach',4,1),
  ('ch-referral','Wrong person / referral','lilac',5,1),
  ('ch-ooo','Out of office','peach',6,1),
  ('ch-unsubscribe','Unsubscribe','peach',7,1),
  ('ch-bounce','Bounce','peach',8,1),
  ('ch-review','Needs review','blue',9,1);
