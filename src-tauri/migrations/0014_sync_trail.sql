-- The inbox stops being a window and becomes a trail. A provider hands out a marker for
-- "everything after this point" — Gmail a history id, Microsoft a delta link — and
-- keeping that marker is what lets a reply to a follow-up sent months ago still arrive.
-- Without it a sync can only ever see the last few days, because the position lives in
-- the request and nowhere else.
ALTER TABLE accounts ADD COLUMN sync_cursor TEXT;
ALTER TABLE accounts ADD COLUMN last_synced_at TEXT;

-- Both halves of a conversation carry the provider's name for the thread they belong to,
-- so a reply can be read against the message it answers — a campaign step or a follow-up
-- written by hand, which is the case a campaign-only trail would miss.
ALTER TABLE inbox_messages ADD COLUMN thread_id TEXT;
ALTER TABLE send_logs ADD COLUMN thread_id TEXT;
CREATE INDEX IF NOT EXISTS inbox_messages_thread ON inbox_messages(account_id, thread_id);
