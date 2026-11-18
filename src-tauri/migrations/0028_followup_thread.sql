-- What each email actually was, so the email after it can answer it. A follow-up carrying
-- `In-Reply-To` and `References` for the message it answers lands in the same conversation at
-- the other end; without them it is a new email with a familiar subject, which is how a
-- campaign's follow-ups were arriving.
--
-- `thread_id` already holds the provider's own name for the conversation — Gmail's `threadId`,
-- and for Microsoft the conversation id, which is the same idea under another name. `message_id`
-- is the RFC 5322 Message-ID as the provider settled on it, read back after the send rather than
-- assumed: a relay is allowed to rewrite the one it was handed, and the rewritten id is the one
-- the next step has to answer.
--
-- Nothing can be backfilled. The id was never kept anywhere, so a lead whose earlier emails went
-- out before this has no chain to answer: its next step goes out as a plain email with a warning
-- in the log rather than as a broken reply.
ALTER TABLE send_logs ADD COLUMN message_id TEXT;

-- The chain is read one lead at a time, oldest first, and always for the steps before one.
CREATE INDEX IF NOT EXISTS send_logs_chain ON send_logs(campaign_id, lead_id, step_position);
