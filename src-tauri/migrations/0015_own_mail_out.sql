-- An inbox holds mail somebody sent you. Two rounds of syncing put our own outgoing
-- copies in here instead: the first read the mailbox without asking which folder a
-- message sat in — which returns Sent alongside Inbox — and Gmail's history reports
-- sent mail next to received mail as well. They arrived looking like replies, and a
-- reply from yourself is a reply to nothing.
--
-- The Sent view already holds these, and the provider still holds them, so the copies
-- here are removed rather than kept. `store_message` refuses to file them from now on.
DELETE FROM inbox_messages
WHERE lower(from_email) IN (SELECT lower(email) FROM accounts)
   OR provider_message_id IN (
        SELECT provider_message_id FROM send_logs WHERE provider_message_id IS NOT NULL
      );
