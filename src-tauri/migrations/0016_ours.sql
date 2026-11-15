-- The reading pane is about to show both halves of an exchange, so it has to hold our
-- half. `ours` marks a copy of something one of our own accounts sent: kept out of the
-- Inbox and its counts, and shown in the conversation, signed as ours.
ALTER TABLE inbox_messages ADD COLUMN ours INTEGER NOT NULL DEFAULT 0;

-- 0015 removed those copies before there was anywhere to keep them, so the next read
-- takes the recent window again and files them properly this time. Clearing the position
-- costs one extra pass per account; everything already held is matched on its provider id
-- and left alone, so nothing is duplicated and no reply is disturbed. Our own mail sent
-- from here on is stored as it arrives and needs no repair.
UPDATE accounts SET sync_cursor = NULL;
