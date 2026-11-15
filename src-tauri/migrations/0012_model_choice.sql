-- The seeded agents pinned one hardcoded local model that most machines do not have
-- installed. Clear the placeholder so an agent with no model of its own follows the
-- model chosen in Settings → AI models.
UPDATE agent_defs SET model = '' WHERE model = 'ollama:llama3.2';
