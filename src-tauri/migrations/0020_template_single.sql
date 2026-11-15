-- The campaign is now the only place a sequence exists. Its first touch and its follow-ups
-- each carry their own message, copied in when the campaign was set up, so sending never
-- reads a template. A template goes back to being one reusable message — which also means
-- editing or deleting one can no longer change what an approved campaign puts on the wire.
--
-- The first touch lives on the campaign itself, because that is already where
-- `campaign_leads.step_position` 0 points; positions 1..n stay in `sequence_steps` with
-- their bodies inline, exactly as a single's follow-ups already were.
ALTER TABLE campaigns ADD COLUMN subject TEXT;
ALTER TABLE campaigns ADD COLUMN body TEXT;

-- Take the copy before the reference stops being the source of truth. A campaign that is
-- mid-flight must keep sending the message it was approved with.
UPDATE campaigns SET
  subject = (SELECT t.subject FROM templates t WHERE t.id = campaigns.template_id),
  body    = (SELECT t.body    FROM templates t WHERE t.id = campaigns.template_id)
WHERE template_id IS NOT NULL;

UPDATE sequence_steps SET
  subject_override = COALESCE(subject_override, (SELECT t.subject FROM templates t WHERE t.id = sequence_steps.template_id)),
  body_md          = COALESCE(body_md,          (SELECT t.body    FROM templates t WHERE t.id = sequence_steps.template_id))
WHERE template_id IS NOT NULL;

-- `template_id` on both tables stays as provenance only: it is a label for where the copy
-- came from, and nothing on the send path reads it. Hence the dangling-reference guards
-- that used to be needed to delete a template are gone.
DROP INDEX IF EXISTS templates_sequence;
ALTER TABLE templates DROP COLUMN sequence_id;
ALTER TABLE templates DROP COLUMN step_position;
ALTER TABLE templates DROP COLUMN delay_days;
