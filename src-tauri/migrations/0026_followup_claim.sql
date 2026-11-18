-- A follow-up sent by hand goes straight to the sender instead of waiting for the tick, so
-- the row has to be claimed first: the claim is what stops a second click, or the tick
-- itself, from putting two emails in the same thread. That needs one more state on the
-- enrolment — `sending` — and somewhere to keep why a send did not get through, because a
-- failed row stays in the list and stays retryable rather than quietly disappearing.
--
-- The states an enrolment is in, after this: queued (waiting its turn), sending (claimed by
-- a send that is under way), paused (stopped by a reply, a bounce, an unsubscribe or by
-- hand), done (the sequence finished), failed (a hand-sent step did not get through).
ALTER TABLE campaign_leads ADD COLUMN last_error TEXT;
