-- Scheduling belongs to the campaign, not to the machine. A campaign may name a timezone
-- and send inside that zone's working hours; without one it sends whenever its pace
-- allows. The offset is stored alongside the name because the browser resolves it from
-- its own timezone database — the sender keeps none.
--
-- `daily_cap` is the campaign's own ceiling. It sits on top of the account limits, so the
-- lower of the two decides and a mailbox can never be pushed past what it is set to send.
ALTER TABLE campaigns ADD COLUMN timezone TEXT;
ALTER TABLE campaigns ADD COLUMN utc_offset_minutes INTEGER;
ALTER TABLE campaigns ADD COLUMN daily_cap INTEGER;
