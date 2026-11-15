-- The Inbox becomes a real mail surface: it reads whole messages, files them into
-- views, and remembers what the composer sent.

-- Inbound. `raw_excerpt` stays the one-line list preview; these carry the message
-- itself, which the reading pane renders and a reply quotes.
ALTER TABLE inbox_messages ADD COLUMN body_html TEXT;
ALTER TABLE inbox_messages ADD COLUMN body_text TEXT;
-- Archive is a view, not a delete; `deleted_at` hides a row without destroying it.
ALTER TABLE inbox_messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_messages ADD COLUMN deleted_at TEXT;

-- Outbound. send_logs never recorded a recipient, so a hand-written message to
-- someone who is not a lead lost its `To:` entirely; and the Sent view needs the
-- body as it was written (markdown) and as it was actually delivered (html).
ALTER TABLE send_logs ADD COLUMN to_email TEXT;
ALTER TABLE send_logs ADD COLUMN cc TEXT;
ALTER TABLE send_logs ADD COLUMN bcc TEXT;
ALTER TABLE send_logs ADD COLUMN markdown TEXT;
ALTER TABLE send_logs ADD COLUMN html TEXT;

-- One row per composing session, so a half-written message survives leaving the
-- page. `reply_to` is an inbox_messages id when the draft is an answer.
CREATE TABLE IF NOT EXISTS message_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  reply_to TEXT,
  to_email TEXT,
  cc TEXT,
  bcc TEXT,
  subject TEXT,
  markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The classification dot colours the rail and the chips draw. These are the only
-- colours the Inbox uses beyond the accent, and they resolve to tokens.
UPDATE channels SET color='green'  WHERE id='ch-interested';
UPDATE channels SET color='blue'   WHERE id='ch-question';
UPDATE channels SET color='amber'  WHERE id='ch-not-now';
UPDATE channels SET color='gray'   WHERE id IN ('ch-not-interested','ch-ooo');
UPDATE channels SET color='purple' WHERE id='ch-referral';
UPDATE channels SET color='red'    WHERE id IN ('ch-unsubscribe','ch-bounce');
UPDATE channels SET color='orange' WHERE id='ch-review';
