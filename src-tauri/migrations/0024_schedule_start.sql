-- Scheduling is a start, and nothing else. A campaign can be launched now or held until a
-- date and time in a chosen zone; the daily 9-to-5 window is gone, so a campaign that is not
-- scheduled sends whenever its pace allows.
--
-- The instant is stored resolved (UTC), worked out by the browser from the date, time and
-- zone that were picked, so the sender needs no timezone database. `campaigns.timezone`
-- stays as the label for showing that schedule back.
ALTER TABLE campaigns ADD COLUMN scheduled_at TEXT;

-- The offset only ever existed to work out whether a send was inside the window. With the
-- window gone nothing reads it: the cap now counts UTC days, like the account counters do.
ALTER TABLE campaigns DROP COLUMN utc_offset_minutes;
