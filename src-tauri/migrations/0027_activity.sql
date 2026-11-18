-- The campaign's own history, kept in the events table that already holds the app's log: a
-- send, a follow-up scheduled, an answer, a bounce, a skip, a hand-send and a pause all write
-- a row here, and the Activity tab reads one campaign's rows back in order. The columns are
-- nullable because the same table keeps events that belong to no campaign at all.
ALTER TABLE events ADD COLUMN campaign_id TEXT;
ALTER TABLE events ADD COLUMN lead_id TEXT;
ALTER TABLE events ADD COLUMN step_position INTEGER;
-- Whatever else the row is worth reading: why a lead was skipped, which line a send carried.
ALTER TABLE events ADD COLUMN metadata TEXT;
CREATE INDEX IF NOT EXISTS events_campaign ON events(campaign_id, created_at);

-- Backfill, as far as the existing rows can be read back. A send is exact: the log kept the
-- lead, the step and the moment. An answer is recoverable by the thread it arrived on. The
-- classifier that separates a bounce from a reply runs in Rust, so an old bounce is filed as
-- a reply here rather than guessed at.
INSERT INTO events(id,level,event_type,detail,created_at,workspace_id,campaign_id,lead_id,step_position)
SELECT lower(hex(randomblob(16))),'info','sent','',s.created_at,COALESCE(c.workspace_id,'ws-default'),s.campaign_id,s.lead_id,s.step_position
FROM send_logs s LEFT JOIN campaigns c ON c.id=s.campaign_id
WHERE s.campaign_id IS NOT NULL AND s.lead_id IS NOT NULL AND s.status='sent';

INSERT INTO events(id,level,event_type,detail,created_at,workspace_id,campaign_id,lead_id,step_position)
SELECT lower(hex(randomblob(16))),'info','replied',COALESCE(m.subject,''),COALESCE(m.received_at,c.created_at),COALESCE(c.workspace_id,'ws-default'),cl.campaign_id,cl.lead_id,cl.step_position
FROM inbox_messages m
JOIN campaign_leads cl ON cl.thread_ref=m.thread_id
JOIN campaigns c ON c.id=cl.campaign_id
WHERE m.ours=0 AND m.deleted_at IS NULL;
